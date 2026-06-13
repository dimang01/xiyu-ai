/**
 * playground_probe_smoke —— 对外通道每日合成探针的告警逻辑 + 零污染红验（2026-06-13，#310 系统解·运行时一翼）。
 *
 * 验：①接线类抛错(#310 形态)→必告警 ②成功→不告警 ③空回复→接线降级告警 ④provider/网络瞬断→软处理不误叫
 *     ⑤合成消息 ≥8 字 + probe 标志真传入 ⑥空收件人→no_recipient 不发（报警器哑了显式 WARN）
 *     ⑦零污染（补充④）：真跑 playgroundChat(probe) 后，任何表 companion_id/user_id=-1 零行。
 */
process.env.DB_PATH = '/tmp/playground_probe_smoke.db';
process.env.ADMIN_ALERT_EMAIL = 'ops@example.com';
process.env.INNER_OS_MODE = 'off';   // 零污染测仅需写点被 gate；inner-OS LLM 跳过加速（#310 形态另由告警逻辑测覆盖）
import { unlinkSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const { getDb } = await import('../src/db.mjs');
const { runPlaygroundProbe, PROBE_COMPANION_ID } = await import('../src/playground_probe.mjs');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };
const mkAlert = () => { const mails = []; return { mails, fn: async (to, subject, text) => { mails.push({ to, subject, text }); } }; };

// ── ① 接线类抛错（#310 形态：TypeError）→ 必告警 ───────────────────────────────
{
  const a = mkAlert();
  const r = await runPlaygroundProbe({ chat: async () => { throw new TypeError("innerRes.trim is not a function"); }, alert: a.fn });
  ok(r.ok === false && r.failureKind === 'wiring' && r.alerted === true, `①接线类抛错→告警（实测 kind=${r.failureKind} alerted=${r.alerted}）`);
  ok(a.mails.length === 1 && a.mails[0].subject.includes('探针失败'), '①告警邮件发到 ADMIN_ALERT_EMAIL');
}

// ── ② 成功（非空回复）→ 不告警 ──────────────────────────────────────────────────
{
  const a = mkAlert();
  const r = await runPlaygroundProbe({ chat: async () => ({ reply: '嗯～我挺好的，你呢？' }), alert: a.fn });
  ok(r.ok === true && r.alerted === false && a.mails.length === 0, `②成功→不告警（实测 ok=${r.ok} alerted=${r.alerted}）`);
}

// ── ③ 空回复 → 接线类降级告警 ─────────────────────────────────────────────────
{
  const a = mkAlert();
  const r = await runPlaygroundProbe({ chat: async () => ({ reply: '' }), alert: a.fn });
  ok(r.ok === false && r.failureKind === 'wiring' && r.alerted === true, `③空回复→接线降级告警（实测 kind=${r.failureKind}）`);
}

// ── ④ provider/网络瞬断 → 软处理不误叫 ─────────────────────────────────────────
{
  const a = mkAlert();
  const r = await runPlaygroundProbe({ chat: async () => { throw new Error('HTTP 503 provider unavailable'); }, alert: a.fn });
  ok(r.ok === false && r.failureKind === 'provider' && r.alerted === false && a.mails.length === 0,
    `④provider 瞬断→不告警（错误签名段管；实测 kind=${r.failureKind} alerted=${r.alerted}）`);
}

// ── ⑤ 合成消息 ≥8 字 + probe 标志真传入 ─────────────────────────────────────────
{
  let seenText = null, seenOpts = null;
  await runPlaygroundProbe({ chat: async (comp, text, opts) => { seenText = text; seenOpts = opts; return { reply: 'ok 一切都好' }; }, alert: async () => {} });
  ok(typeof seenText === 'string' && seenText.length >= 8, `⑤合成消息 ≥8 字（实测 len=${seenText?.length}）`);
  ok(seenOpts && seenOpts.probe === true, `⑤probe 标志真传入 playgroundChat（实测 ${JSON.stringify(seenOpts)}）`);
}

// ── ⑥ 空收件人 → no_recipient 不发（报警器哑了显式 WARN）──────────────────────────
{
  const saved = process.env.ADMIN_ALERT_EMAIL;
  process.env.ADMIN_ALERT_EMAIL = '';
  const a = mkAlert();
  const r = await runPlaygroundProbe({ chat: async () => { throw new TypeError('x.trim is not a function'); }, alert: a.fn });
  ok(r.failureKind === 'wiring' && r.alerted === false && a.mails.length === 0, `⑥空收件人→不发（实测 alerted=${r.alerted}）`);
  process.env.ADMIN_ALERT_EMAIL = saved;
}

// ── ⑦ 零污染（补充④）：真跑 playgroundChat(probe) 后，任何表 companion_id/user_id=-1 零行 ──
{
  const db = getDb();
  // 真链路：default chat = 真 playgroundChat（probe 模式）；无 LLM key → generateReply 返回 FALLBACK，
  // 路径仍走到末尾的写点（被 probe gate）→ 验 gate 真生效。跑 2 次累积。
  let r1 = await runPlaygroundProbe({ alert: async () => {} });
  let r2 = await runPlaygroundProbe({ alert: async () => {} });
  ok(r1.ok === true && r2.ok === true, `⑦真链路跑通到末尾（gate 被走到才有意义；实测 ok=${r1.ok}/${r2.ok} kind=${r1.failureKind || ''}）`);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  const leaked = [];
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    for (const col of ['companion_id', 'user_id']) {
      if (cols.includes(col)) {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${col} = ?`).get(PROBE_COMPANION_ID).n;
        if (n > 0) leaked.push(`${t}.${col}=${n}`);
      }
    }
  }
  ok(leaked.length === 0, `⑦零污染：探针跑 2 次后无 companion_id/user_id=-1 残留（泄漏：${leaked.join(', ') || '无'}）`);
}

for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
console.log(`playground_probe_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
