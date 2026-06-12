/**
 * proactive_deadman.mjs —— proactive 死人开关（v1.21.2 PR-C，#263 后续）。
 *
 * #263 的失败形状：proactive 全部抛错被 tick 的 catch 吞掉——进程不崩、health 200、
 * 冒烟全绿，活跃用户的主动消息静默断供半天。本模块是针对这个形状的心跳：
 *
 *   每小时统计「近 6h 有活跃对话的 companion」的 proactive 成功发送数；
 *   活跃 > 0 且成功 = 0 连续 2 个周期 → CRITICAL 日志 + 运维告警邮件。
 *
 * 红线：**纯报警零自愈**——不重启、不改配置、不调参。告警邮件复用注册验证码的
 * Resend 通道（不依赖 bot 自身回复链路）；ADMIN_ALERT_EMAIL 未配置时仅 CRITICAL 日志。
 * 全链 fail-open：心跳自身任何异常只打 warn（错误签名段会抓到它——闭环）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { getDb, getAppSetting, setAppSetting } from './db.mjs';
import { sendOpsAlertEmail } from './email.mjs';
import { log } from './logger.mjs';

const STRIKES_KEY = 'proactive_deadman_strikes';
const LAST_ALERT_KEY = 'proactive_deadman_last_alert';
const ACTIVE_WINDOW_H = Number(process.env.DEADMAN_ACTIVE_WINDOW_H || 6);
const STRIKES_TO_ALERT = Number(process.env.DEADMAN_STRIKES || 2);
const ALERT_COOLDOWN_H = Number(process.env.DEADMAN_ALERT_COOLDOWN_H || 6);

/**
 * 核心判定（可注入 now / 邮件函数，红色验证用）。
 * @returns { skipped, active, sent, strikes, alerted } —— 纯诊断信息
 */
export async function checkProactiveDeadman({ now = new Date(), sendAlert = sendOpsAlertEmail } = {}) {
  const out = { skipped: false, active: 0, sent: 0, strikes: 0, alerted: false };
  try {
    // 夜间不判定（上海 23:00-09:00）：quiet hours 里 proactive 本来安静，
    // sent=0 是正常的——凌晨累计 strike 全是误报。不清零也不累计，白天接着数。
    const shHour = (now.getUTCHours() + 8) % 24;
    if (shHour >= 23 || shHour < 9) { out.skipped = true; return out; }

    const sinceIso = new Date(now.getTime() - ACTIVE_WINDOW_H * 3600e3).toISOString();
    const sinceSec = Math.floor((now.getTime() - ACTIVE_WINDOW_H * 3600e3) / 1000);

    // 活跃 = 近 6h 有用户消息 + proactive 开着 + 微信绑定活跃（与 #263 受害面同口径）
    const rows = getDb().prepare(`
      SELECT c.id, c.last_proactive_sent_at FROM companions c
      JOIN users u ON u.id = c.user_id
      JOIN wechat_accounts wa ON wa.wechat_user_id = u.wechat_user_id AND wa.bot_id = c.bot_id
      WHERE wa.is_active = 1 AND c.proactive_enabled = 1
        AND c.last_user_reply_at IS NOT NULL
        AND datetime(REPLACE(c.last_user_reply_at, ' ', 'T')) >= datetime(?)
    `).all(sinceIso);
    out.active = rows.length;
    out.sent = rows.filter(r => Number(r.last_proactive_sent_at) >= sinceSec).length;

    let strikes = Number(getAppSetting(STRIKES_KEY) || 0);
    if (out.active > 0 && out.sent === 0) {
      strikes += 1;
    } else {
      strikes = 0;   // 任一周期恢复即清零（不是滑窗，是连续计数）
    }
    out.strikes = strikes;
    setAppSetting(STRIKES_KEY, String(strikes));

    if (strikes >= STRIKES_TO_ALERT) {
      log('error', `[Deadman] ★ CRITICAL：近 ${ACTIVE_WINDOW_H}h 有 ${out.active} 个活跃 companion 但 proactive 成功发送 = 0，已连续 ${strikes} 个周期——疑似 #263 形态静默断供，请立即查 error 日志（npm run arc:digest）`);
      const r = await emitDeadmanAlert({ active: out.active, strikes, now, sendAlert });
      out.alerted = r.sent;
      if (r.id) out.alertId = r.id;
    }
    return out;
  } catch (e) {
    // fail-open：心跳自身异常绝不影响 plan_tasks 批；这条 warn 会被错误签名段看见
    log('warn', `[Deadman] 心跳检查异常（已忽略）: ${e.message}`);
    out.skipped = true;
    return out;
  }
}

/**
 * 告警出口（v1.21.6）：从 env 读收件人 → 发送 → 返回投递凭据 { sent, id?, reason? }。
 * 抽出供 scripts/deadman_test_alert.mjs 走「真实取址 + 真实发送」端到端验证——收件人
 * 一律由代码从 ADMIN_ALERT_EMAIL 读，绝不写死。
 * 空收件人走显式 WARN：这正是本次 P1 的根因形态（报警器自己哑了），出口得会喊。
 */
export async function emitDeadmanAlert({ active = 0, strikes = STRIKES_TO_ALERT, now = new Date(), sendAlert = sendOpsAlertEmail, ignoreCooldown = false } = {}) {
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
    const id = await sendAlert(to, 'proactive 疑似静默断供',
      `近 ${ACTIVE_WINDOW_H} 小时内有 ${active} 个活跃 companion，但 proactive 成功发送数为 0，已连续 ${strikes} 个检查周期。\n\n`
      + `这与 #263 事故形态一致（错误被 catch 吞掉、进程不崩、health 正常）。\n`
      + `请上服务器跑：npm run arc:digest 看错误签名段；journalctl -u zhaohy-wechat 查日志。\n\n`
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
