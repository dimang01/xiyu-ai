/**
 * proactive_deadman.mjs —— proactive 死人开关（v1.21.2 PR-C，#263 后续；2026-06-13 信号分离重写）。
 *
 * #263 的失败形状：proactive 全部抛错被 tick 的 catch 吞掉——进程不崩、health 200、冒烟全绿，
 * 活跃用户的主动消息静默断供半天。本模块是针对这个形状的心跳。
 *
 * v1 旧法只读 DB last_proactive_sent_at，把三类 sent=0（未到点 / 正当克制 / 真断供）混为一谈，
 * 对单活跃用户密聊期的正当克制误报 CRITICAL（2026-06-13 终判 B=正当克制误报，非 #263、非 W2）。
 * 修法 = 引擎自报三桶（proactive_health）+ tick 心跳，deadman 据此分桶，**仅「错误 / 无心跳」计
 * strike**（克制/已发送/无活跃皆不计）：
 *
 *   桶1 sent>0             → 健康（清零）
 *   桶2 restrained>0       → 正当克制（永不计 strike；digest 🟡 行可见、不发邮件）
 *   桶3 errored>0 / tick 死 → 疑似 #263 → 计 strike → 连 2 周期 CRITICAL + 运维告警邮件
 *
 * tick 死含「心跳从未写入 + 过启动宽限(30min)」的最深 #263 变体（tick 线程因启动 bug 从未跑起）。
 *
 * 边界（2026-06-13 拍板·诚实代价）：本开关覆盖 {错误吞没、tick 死}；「tick 活但零产出无报错」
 * 类（如静默空 due）不归本开关邮件告警，靠 digest 🟡 行（人眼）+ 通电冒烟（CI）覆盖——不让监控
 * 再自造假警报。
 *
 * 红线：**纯报警零自愈**——不重启、不改配置、不调参、不写 companion。告警邮件复用 ops 通道
 * （不依赖 bot 自身回复链路）；ADMIN_ALERT_EMAIL 未配置时仅 CRITICAL 日志 + 显式 WARN。
 * 全链 fail-open：心跳自身任何异常只打 warn（错误签名段会抓到它——闭环）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { getDb, getAppSetting, setAppSetting } from './db.mjs';
import { sendOpsAlertEmail } from './email.mjs';
import { log } from './logger.mjs';
import { drainProactiveHealth } from './proactive_health.mjs';
import { formatDeadmanCycle } from './proactive_heartbeat.mjs';

const STRIKES_KEY = 'proactive_deadman_strikes';
const LAST_ALERT_KEY = 'proactive_deadman_last_alert';
const LAST_CLASS_KEY = 'proactive_deadman_last_class';   // digest 读：上周期分桶快照（三桶全量 + 克制细分）
const ACTIVE_WINDOW_H = Number(process.env.DEADMAN_ACTIVE_WINDOW_H || 6);
const STRIKES_TO_ALERT = Number(process.env.DEADMAN_STRIKES || 2);
const ALERT_COOLDOWN_H = Number(process.env.DEADMAN_ALERT_COOLDOWN_H || 6);
const TICK_DEAD_MS = Number(process.env.DEADMAN_TICK_DEAD_MS || 15 * 60_000);    // 心跳超此=tick 死
const BOOT_GRACE_MS = Number(process.env.DEADMAN_BOOT_GRACE_MS || 30 * 60_000);  // 启动宽限：心跳从未写也不立判

/**
 * 核心判定（可注入 now / uptimeS / 邮件函数，红色验证用）。
 * @returns { skipped, active, sent, restrained, errored, bucket, tickAgeMs, strikes, alerted } —— 纯诊断
 */
export async function checkProactiveDeadman({ now = new Date(), uptimeS = process.uptime(), sendAlert = sendOpsAlertEmail } = {}) {
  const out = { skipped: false, active: 0, sent: 0, restrained: 0, errored: 0, bucket: null, tickAgeMs: null, strikes: 0, alerted: false };
  try {
    // 夜间不判定（沪 23:00–09:00）：quiet hours 里 proactive 本来安静，sent=0 是正常的。
    const shHour = (now.getUTCHours() + 8) % 24;
    if (shHour >= 23 || shHour < 9) { out.skipped = true; return out; }

    const sinceIso = new Date(now.getTime() - ACTIVE_WINDOW_H * 3600e3).toISOString();

    // 活跃集合（闸门）：近 6h 有用户消息 + proactive 开 + 微信绑定活跃（与 #263 受害面同口径）。
    const rows = getDb().prepare(`
      SELECT c.id FROM companions c
      JOIN users u ON u.id = c.user_id
      JOIN wechat_accounts wa ON wa.wechat_user_id = u.wechat_user_id AND wa.bot_id = c.bot_id
      WHERE wa.is_active = 1 AND c.proactive_enabled = 1
        AND c.last_user_reply_at IS NOT NULL
        AND datetime(REPLACE(c.last_user_reply_at, ' ', 'T')) >= datetime(?)
    `).all(sinceIso);
    out.active = rows.length;

    // 引擎自报三桶（drain 本周期计数）+ 心跳。窗口=自上次 drain（≈1 deadman 周期），与活跃 6h
    // 闸门配合：闸门答"有没有人在乎"，三桶答"引擎这周期做了啥"（req4 自洽）。
    const health = drainProactiveHealth();
    out.sent = health.sent;
    out.restrained = health.restrained;
    out.errored = health.errored;
    out.tickAgeMs = health.tickLastRun == null ? null : (now.getTime() - health.tickLastRun);

    // tick 死判定（补充①：心跳"从未写入"盲区必堵）——
    //   · 心跳有值且超 TICK_DEAD_MS → 死
    //   · 心跳从未写入：进程启动宽限期(BOOT_GRACE_MS)内不判；过宽限仍无心跳 = tick 线程从未跑起
    //     （#263 最深变体，启动期 bug 让心跳永不出现）→ 视同死。uptimeS 可注入供红验第四向。
    const tickDead = health.tickLastRun == null
      ? (uptimeS * 1000 >= BOOT_GRACE_MS)
      : (out.tickAgeMs > TICK_DEAD_MS);

    // ── 三桶分桶：仅「错误 / 无心跳」计 strike（克制/已发送/无活跃皆不计）──
    let strikes = Number(getAppSetting(STRIKES_KEY) || 0);
    let bucket;
    if (out.active === 0)        { bucket = 'idle_no_active'; strikes = 0; }   // 无活跃用户：silence 正常
    else if (tickDead)           { bucket = 'tick_dead';      strikes += 1; }   // 桶3：无心跳（含从未写入+过宽限）
    else if (out.sent > 0)       { bucket = 'sent';           strikes = 0; }    // 桶1：已发送
    else if (out.errored > 0)    { bucket = 'error';          strikes += 1; }   // 桶3：发送路径抛错（#263 形态）
    else if (out.restrained > 0) { bucket = 'restrained';     strikes = 0; }    // 桶2：正当克制（永不计 strike）
    else                         { bucket = 'idle_no_due';    strikes = 0; }    // tick 活·本周期无 due（密聊中/未到点）
    out.bucket = bucket;
    out.strikes = strikes;
    setAppSetting(STRIKES_KEY, String(strikes));

    // digest 快照（补充②③：三桶全量 + per-companion 克制细分）；arc-digest 读此 + 扫 cycle 日志行。
    const snap = {
      at: now.toISOString(), active: out.active, sent: out.sent, restrained: out.restrained,
      errored: out.errored, bucket, strikes, tickAgeMs: out.tickAgeMs, restrainedBy: health.restrainedBy,
    };
    try { setAppSetting(LAST_CLASS_KEY, JSON.stringify(snap)); } catch { /* digest 快照非关键，吞 */ }
    // 结构化 cycle 心跳日志行（digest 扫描源；emit↔parse round-trip smoke 锁，防 regex 漂移假警报）。
    log('info', `[Deadman] ${formatDeadmanCycle(snap)}`);

    const strikingBucket = bucket === 'tick_dead' || bucket === 'error';
    if (strikingBucket && strikes >= STRIKES_TO_ALERT) {
      const detail = bucket === 'tick_dead'
        ? `proactive tick 心跳停摆（${out.tickAgeMs == null ? '心跳从未写入 + 过启动宽限' : Math.round(out.tickAgeMs / 60000) + 'min 未跑'}）`
        : `近 ${ACTIVE_WINDOW_H}h 有 ${out.active} 个活跃 companion、本周期 proactive 发送=0 但发送路径报错 ${out.errored} 次`;
      log('error', `[Deadman] ★ CRITICAL：${detail}，已连续 ${strikes} 个周期——疑似 #263 形态静默断供，请立即查 error 日志（npm run arc:digest）`);
      const r = await emitDeadmanAlert({ active: out.active, strikes, bucket, now, sendAlert });
      out.alerted = r.sent;
      if (r.id) out.alertId = r.id;
    }
    return out;
  } catch (e) {
    // fail-open：心跳自身异常绝不影响 plan_tasks 批；这条 warn 会被错误签名段看见。
    log('warn', `[Deadman] 心跳检查异常（已忽略）: ${e.message}`);
    out.skipped = true;
    return out;
  }
}

/**
 * 告警出口（v1.21.6）：从 env 读收件人 → 发送 → 返回投递凭据 { sent, id?, reason? }。
 * 抽出供 scripts/deadman_test_alert.mjs 走「真实取址 + 真实发送」端到端验证——收件人一律由
 * 代码从 ADMIN_ALERT_EMAIL 读，绝不写死。空收件人走显式 WARN（报警器自己哑了——本次 P1 根因形态）。
 */
export async function emitDeadmanAlert({ active = 0, strikes = STRIKES_TO_ALERT, bucket = 'error', now = new Date(), sendAlert = sendOpsAlertEmail, ignoreCooldown = false } = {}) {
  const to = String(process.env.ADMIN_ALERT_EMAIL || '').trim();
  if (!to) {
    log('warn', '[Deadman] ⚠ ADMIN_ALERT_EMAIL 未配置——告警出口无收件人，CRITICAL 日志打了、邮件没发出去（这正是本次 P1 的根因形态：报警器自己哑了）。请配置生产 .env 的 ADMIN_ALERT_EMAIL。');
    return { sent: false, reason: 'no_recipient' };
  }
  // 告警风暴控制：冷却期内不重复发（CRITICAL 日志照打）。--test 用 ignoreCooldown 绕过。
  const lastAlert = Number(getAppSetting(LAST_ALERT_KEY) || 0);
  if (!ignoreCooldown && now.getTime() - lastAlert < ALERT_COOLDOWN_H * 3600e3) {
    return { sent: false, reason: 'cooldown' };
  }
  try {
    const cause = bucket === 'tick_dead'
      ? 'proactive tick 心跳停摆（调度线程疑似没跑/已死）'
      : `近 ${ACTIVE_WINDOW_H} 小时内有 ${active} 个活跃 companion，但本周期 proactive 发送=0 且发送路径报错`;
    const id = await sendAlert(to, 'proactive 疑似静默断供',
      `${cause}，已连续 ${strikes} 个检查周期。\n\n`
      + `这与 #263 事故形态一致（错误被 catch 吞掉、进程不崩、health 正常）。\n`
      + `请上服务器跑：npm run arc:digest 看 proactive 健康段 + 错误签名段；journalctl -u zhaohy-wechat 查日志。\n\n`
      + `本告警纯报警零自愈：未做任何重启/配置变更。检查时间：${now.toISOString()}`);
    setAppSetting(LAST_ALERT_KEY, String(now.getTime()));
    if (id) log('info', `[Deadman] 告警邮件已发出 通道=ops(sendOpsAlertEmail) message-id=${id}`);
    else log('info', '[Deadman] 告警邮件已发出 通道=ops(sendOpsAlertEmail)（dev_stdout 模式，无 message-id）');
    return { sent: true, id: id || null };
  } catch (e) {
    log('warn', `[Deadman] 告警邮件发送失败（CRITICAL 日志已打，不阻塞）: ${e.message}`);
    return { sent: false, reason: 'send_failed', error: e.message };
  }
}
