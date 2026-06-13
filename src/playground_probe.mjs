/**
 * playground_probe.mjs —— playground 对外通道每日合成对话探针（#310 P0 静默两天的系统解·运行时一翼）。
 *
 * #310：playground.mjs 把 inner-OS 返回的 {thought,struct} 对象当字符串传 buildInnerOsHint→裸 throw
 * 冒 500，默认 INNER_OS_MODE=always 下网页通道 ≥8 字消息全 500，静默约 2 天。CI 通电冒烟拦合并前，
 * 本探针拦运行时：每日用默认配置 + ≥8 字合成消息真跑一次 playgroundChat（probe 模式零持久化），
 * 断言成功返回（≡200）。失败按形态分类——结构/TypeError（接线类，#310 形态）→ ops 告警；
 * provider/网络瞬断 → 不误叫（错误签名段管，与 deadman 克制-vs-错误同哲学）。
 *
 * 零污染：合成 companion id<0（永不撞真实数据·便于过滤排除）+ probe 模式跳过全部写——双保险。
 * 红线：纯探针零副作用、fail-open（探针自身 bug 不阻塞 plan_tasks 批）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */
import { log } from './logger.mjs';
import { sendOpsAlertEmail } from './email.mjs';
import { playgroundChat } from './playground.mjs';

export const PROBE_COMPANION_ID = -1;                 // 哨兵：永不撞真实 companion（正整数 id）
const PROBE_TEXT = '你好呀，今天过得怎么样？';        // ≥8 字合成消息（默认配置触发 inner-OS double-pass）

// 合成 companion（不入库；getCompanionById(-1)=null 时 playgroundChat 回退用本对象）。
export function syntheticProbeCompanion() {
  return {
    id: PROBE_COMPANION_ID, user_id: PROBE_COMPANION_ID, name: '通道探针',
    persona: '一个温和友善的普通朋友', personality: '温和', relationship_stage: '朋友',
    memory_enabled: 0, sticker_reply_enabled: 0, safe_mode: 0, chat_mode_active: 0,
    temperature: 0.8, max_tokens: 3000, top_p: 0.95, proactive_enabled: 0, affection_level: 30,
  };
}

// 失败分类：接线类（TypeError/字段错配=#310 形态）必告警；provider/网络瞬断软处理不误叫。
export function classifyProbeFailure(err) {
  const name = err?.name || '';
  const msg = String(err?.message || err || '');
  if (/HTTP\s+\d|timeout|timed out|ECONN|ENOTFOUND|network|fetch failed|provider|rate.?limit/i.test(msg)) {
    return 'provider';   // provider/网络瞬断
  }
  if (name === 'TypeError' || /is not a function|\.trim|not a string|cannot read|reading '/i.test(msg)) {
    return 'wiring';     // #310 形态：接线类结构错配
  }
  return 'wiring';       // 未知归 wiring（保守：宁可看一眼也别漏接线 bug）
}

/**
 * 跑一次合成探针。可注入 chat/alert/now 供 smoke。
 * @returns { ok, reply?, failureKind?, alerted }
 */
export async function runPlaygroundProbe({ chat = playgroundChat, alert = sendOpsAlertEmail, now = new Date() } = {}) {
  const out = { ok: false, alerted: false };
  try {
    const result = await chat(syntheticProbeCompanion(), PROBE_TEXT, { probe: true });
    const reply = result?.reply;
    if (typeof reply === 'string' && reply.trim().length > 0) {
      out.ok = true;
      out.reply = reply;
      log('info', `[PlaygroundProbe] ✓ 对外通道心跳正常（≡200）reply="${reply.slice(0, 40)}"`);
      return out;
    }
    // 返回了但回复空/非串 = 接线类降级（链路通但产出异常）
    out.failureKind = 'wiring';
    log('error', '[PlaygroundProbe] ✗ 对外通道返回异常（回复空/非字符串）——疑似接线类降级');
  } catch (err) {
    out.failureKind = classifyProbeFailure(err);
    log(out.failureKind === 'wiring' ? 'error' : 'warn',
      `[PlaygroundProbe] ✗ 对外通道探针抛错 kind=${out.failureKind}: ${err?.message || err}`);
    if (out.failureKind !== 'wiring') return out;   // provider/网络瞬断不告警（错误签名段管）
  }
  // 到这 = wiring 类失败 → ops 告警（#310 形态：默认配置网页通道断供）
  out.alerted = await emitProbeAlert({ failureKind: out.failureKind || 'wiring', now, alert });
  return out;
}

async function emitProbeAlert({ failureKind, now, alert }) {
  const to = String(process.env.ADMIN_ALERT_EMAIL || '').trim();
  if (!to) {
    log('warn', '[PlaygroundProbe] ⚠ ADMIN_ALERT_EMAIL 未配置——探针告警无收件人（报警器自己哑了）。请配置生产 .env。');
    return false;
  }
  try {
    await alert(to, 'playground 对外通道探针失败',
      `每日合成对话探针在默认配置（INNER_OS_MODE=always）下失败，形态=${failureKind}（接线类）。\n\n`
      + `这与 #310 形态一致（playground inner-OS 返回结构错配→裸 500，网页通道 ≥8 字消息静默断供）。\n`
      + `请查 journalctl -u zhaohy-wechat 看 [PlaygroundProbe]/[Playground] 报错，并跑 playground_probe_smoke。\n\n`
      + `本告警纯报警零自愈：未做任何重启/配置变更。检查时间：${now.toISOString()}`);
    log('info', '[PlaygroundProbe] 告警邮件已发出 通道=ops(sendOpsAlertEmail)');
    return true;
  } catch (e) {
    log('warn', `[PlaygroundProbe] 告警邮件发送失败（已记日志，不阻塞）: ${e.message}`);
    return false;
  }
}
