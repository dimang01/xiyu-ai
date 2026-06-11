/**
 * 互动历史回填自动化 smoke（v1.21.3 PR-D，临时 DB 真函数，零 LLM）。
 *
 * 覆盖：
 *   1. decideBackfillAction 决策表：未回填→thin / thin+水位→full /
 *      thin+绑定→full / full→null / 存量老 companion（只有 backfilled_at）→null
 *   2. tier 状态读写：markCompanionBackfilled(tier) / 存量兼容（无 tier 视为 full）
 *   3. countRealUserTurns：synthetic 不计入水位
 *   4. backfillTimelineForCompanion 防重判定：full 后跳过 / thin 后允许 full
 *      （LLM 链路不进 CI，只测入口判定）
 *   5. 静态断言：dashboard 零 backfill 引用（按钮已撤）；POST 端点 requireAdmin；
 *      bot.mjs 水位挂点存在（存量扫尾靠它）
 */
process.env.DB_PATH = '/tmp/backfill_smoke.db';
import { unlinkSync, readFileSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const {
  getDb, markCompanionBackfilled, getCompanionBackfillStatus,
  countRealUserTurns, bulkInsertSyntheticTurns, saveConversationTurn,
} = await import('../src/db.mjs');
const { decideBackfillAction, backfillTimelineForCompanion } = await import('../src/backfill_history.mjs');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// ── 1. 决策表 ──────────────────────────────────────────────────────────────
ok(decideBackfillAction({ tier: null, userTurns: 0 }) === 'thin', '未回填 → thin（创建时打底）');
ok(decideBackfillAction({ tier: null, userTurns: 99 }) === 'thin', '存量未回填即使消息多 → 先 thin 打底');
ok(decideBackfillAction({ tier: 'thin', userTurns: 9 }) === null, 'thin + 9 条 → 不动（水位未到）');
ok(decideBackfillAction({ tier: 'thin', userTurns: 10 }) === 'full', 'thin + 10 条 → full（水位）');
ok(decideBackfillAction({ tier: 'thin', userTurns: 0, justBound: true }) === 'full', 'thin + 绑定微信 → full（先到者）');
ok(decideBackfillAction({ tier: 'full', userTurns: 99, justBound: true }) === null, 'full → 永远不再回填');

// ── 2. tier 状态读写 + 存量兼容 ────────────────────────────────────────────
const db = getDb();
db.pragma('foreign_keys = OFF');
db.prepare("INSERT INTO users (id, wechat_user_id) VALUES (1,'w')").run();
db.prepare("INSERT INTO companions (id, user_id, bot_id, name) VALUES (5,1,'b','溪')").run();
db.prepare("INSERT INTO companions (id, user_id, bot_id, name) VALUES (6,1,'b','语')").run();

markCompanionBackfilled(5, 'thin');
ok(getCompanionBackfillStatus(5)?.tier === 'thin', 'markCompanionBackfilled 写 tier=thin');
markCompanionBackfilled(5, 'full');
ok(getCompanionBackfillStatus(5)?.tier === 'full', '升级写 tier=full');
// 存量老 companion：只有 backfilled_at（按钮时代）→ 视为 full，绝不重复回填
db.prepare('UPDATE companions SET history_backfilled_at = 123, history_backfill_tier = NULL WHERE id = 6').run();
ok(getCompanionBackfillStatus(6)?.tier === 'full', '存量（无 tier 有 backfilled_at）视为 full');
ok(decideBackfillAction({ tier: getCompanionBackfillStatus(6).tier, userTurns: 50 }) === null, '存量已回填者水位检查不再触发');

// ── 3. 水位计数排除 synthetic ──────────────────────────────────────────────
saveConversationTurn(5, 'user', '真实消息1', null);
saveConversationTurn(5, 'user', '真实消息2', null);
saveConversationTurn(5, 'assistant', '她的回复', null);
bulkInsertSyntheticTurns(5, [
  { created_at: '2026-05-01 12:00:00', role: 'user', content: '虚拟消息', topic: null },
  { created_at: '2026-05-01 12:01:00', role: 'user', content: '虚拟消息2', topic: null },
]);
ok(countRealUserTurns(5) === 2, `水位只数真实 user 消息（实际：${countRealUserTurns(5)}，synthetic/assistant 不算）`);

// ── 4. backfill 入口防重判定（不触 LLM）────────────────────────────────────
const r1 = await backfillTimelineForCompanion({ id: 5, user_id: 1 }, { tier: 'full' });
ok(r1?.skipped === 'already-backfilled', 'full 后再 full → 跳过');
const r2 = await backfillTimelineForCompanion({ id: 5, user_id: 1 }, { tier: 'thin' });
ok(r2?.skipped === 'already-backfilled', 'full 后 thin → 跳过（不会降级）');

// ── 5. 静态断言 ────────────────────────────────────────────────────────────
const dash = readFileSync(new URL('../public/app/dashboard.html', import.meta.url), 'utf8');
ok(!dash.includes('backfill'), 'dashboard 零 backfill 引用（用户按钮已撤）');
const api = readFileSync(new URL('../src/api.mjs', import.meta.url), 'utf8');
const epIdx = api.indexOf("router.post('/companions/:id/backfill-history'");
ok(epIdx > -1 && api.slice(epIdx, epIdx + 400).includes('requireAdmin'), 'backfill-history POST 已 admin-only');
const bot = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
ok(bot.includes("maybeAutoBackfill(companion, { reason: 'watermark' })"), 'bot.mjs 每条消息水位挂点存在（存量扫尾靠它）');
ok(bot.includes("justBound: true"), 'bot.mjs 绑定触发挂点存在');

console.log(`\nbackfill_auto_smoke: ${pass} passed, ${fail} failed`);
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
process.exit(fail ? 1 : 0);
