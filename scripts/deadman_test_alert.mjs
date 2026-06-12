/**
 * deadman_test_alert.mjs —— 死人开关告警出口端到端验证（v1.21.6 P1 收尾）。
 *
 * 走 proactive_deadman 自身的「取址(从 ADMIN_ALERT_EMAIL 读) + 发送」逻辑发一封测试告警，
 * 用 ignoreCooldown 绕过计数触发条件（不碰真实用户数据）。
 * **收件人一律由代码从 env 读，本脚本绝不写死地址**（隐私红线：运维告警地址只存生产 .env）。
 *
 * 用法（在生产 /opt/xiyu-ai-new 跑，需先 set -a; . ./.env; set +a）：
 *   node scripts/deadman_test_alert.mjs
 * 反向断言（临时清空收件人，必须走「只打日志」不发）：
 *   ADMIN_ALERT_EMAIL= node scripts/deadman_test_alert.mjs
 */
import { emitDeadmanAlert } from '../src/proactive_deadman.mjs';

const r = await emitDeadmanAlert({ active: 1, strikes: Number(process.env.DEADMAN_STRIKES || 2), ignoreCooldown: true });

// 不打印收件人地址（隐私红线）；只打投递结果
console.log('[deadman-test] 结果:', JSON.stringify({ sent: r.sent, id: r.id || null, reason: r.reason || null }));
if (r.sent) {
  console.log(`[deadman-test] ✅ 已发出，message-id=${r.id || '(dev_stdout 无 id)'}——去 ADMIN_ALERT_EMAIL 收件箱确认`);
} else if (r.reason === 'no_recipient') {
  console.log('[deadman-test] ⚠ 反向断言命中：ADMIN_ALERT_EMAIL 未配置 → 走「只打日志」分支、未发邮件（符合预期）');
} else {
  console.log(`[deadman-test] ❌ 未发出，reason=${r.reason}${r.error ? ' / ' + r.error : ''}`);
}
process.exit(0);
