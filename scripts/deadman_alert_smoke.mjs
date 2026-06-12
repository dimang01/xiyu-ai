/**
 * deadman_alert_smoke —— 死人开关告警出口接线红色验证（v1.21.6 P1 收尾）。
 *
 * 锁住：① 有收件人→发送并返回 message-id（投递凭据，之前被吞）② 收件人从 env 读、非写死
 *       ③ 反向：空收件人→no_recipient「只打日志」不发（本次 P1 根因形态）
 *       ④ 发送失败→send_failed fail-open 不抛 ⑤ dev_stdout→sent 但 id=null
 * 全程用占位地址 ops@example.com，绝不含任何真实运维地址。
 */
process.env.ADMIN_ALERT_EMAIL = 'ops@example.com';   // 占位，非真实运维地址
process.env.DB_PATH = process.env.DB_PATH || '/tmp/deadman_alert_smoke.db';
delete process.env.RESEND_API_KEY;                   // 确保 dev_stdout（#5 用）
delete process.env.EMAIL_MODE;

const { emitDeadmanAlert } = await import('../src/proactive_deadman.mjs');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

// ① 有收件人 + mock 返回 id → sent + id，且收件人来自 env
{
  let captured = null;
  const fakeSend = async (to, subj) => { captured = { to, subj }; return 'msg_abc123'; };
  const r = await emitDeadmanAlert({ active: 1, strikes: 2, sendAlert: fakeSend, ignoreCooldown: true });
  ok(r.sent === true && r.id === 'msg_abc123', `有收件人→sent+message-id（实测 sent=${r.sent} id=${r.id}）`);
  ok(captured && captured.to === 'ops@example.com', '收件人从 env(ADMIN_ALERT_EMAIL) 读，非写死');
}

// ③ 反向：空收件人 → no_recipient，sendAlert 根本不被调用（P1 根因形态）
{
  const saved = process.env.ADMIN_ALERT_EMAIL;
  process.env.ADMIN_ALERT_EMAIL = '';
  let called = false;
  const r = await emitDeadmanAlert({ active: 1, sendAlert: async () => { called = true; return 'x'; }, ignoreCooldown: true });
  process.env.ADMIN_ALERT_EMAIL = saved;
  ok(r.sent === false && r.reason === 'no_recipient', `红色验证·反向：空收件人→no_recipient 不发（实测 ${r.reason}）`);
  ok(called === false, '空收件人时 sendAlert 根本没被调用');
}

// ④ 发送失败 → send_failed，fail-open 不抛
{
  const r = await emitDeadmanAlert({ active: 1, sendAlert: async () => { throw new Error('Resend HTTP 500'); }, ignoreCooldown: true });
  ok(r.sent === false && r.reason === 'send_failed', `发送失败→send_failed 不抛（实测 ${r.reason}）`);
}

// ⑤ dev_stdout（默认 sendOpsAlertEmail，无 RESEND）→ sent 但 id=null
{
  const r = await emitDeadmanAlert({ active: 1, ignoreCooldown: true });
  ok(r.sent === true && r.id === null, `dev_stdout→sent 且 id=null（实测 sent=${r.sent} id=${r.id}）`);
}

import { rmSync } from 'node:fs';
for (const ext of ['', '-wal', '-shm']) { try { rmSync(process.env.DB_PATH + ext); } catch {} }

console.log(`\ndeadman_alert_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
