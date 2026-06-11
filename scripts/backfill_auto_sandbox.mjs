/**
 * 回填自动化——真实链路沙箱（真 LLM，手动跑不进 CI）。
 *
 * 走完整自动化链：创建（thin 7 天打底）→ 注入 10 条真实消息（水位）→
 * 自动升 full（8~90 天向更早追加）。验收：
 *   - thin 产物全部落在最近 7 天，turns/记忆有内容
 *   - full 触发后薄版条目原文一字不变（她可能已经引用过）
 *   - full 新增条目全部 ≥8 天前（不碰薄版周）
 *
 * 用法：node scripts/backfill_auto_sandbox.mjs
 */
import 'dotenv/config';
process.env.DB_PATH = '/tmp/backfill_sandbox.db';
import { unlinkSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const { getDb, getCompanionBackfillStatus, saveConversationTurn } = await import('../src/db.mjs');
const { maybeAutoBackfill } = await import('../src/backfill_history.mjs');

const db = getDb();
db.pragma('foreign_keys = OFF');
db.prepare("INSERT INTO users (id, wechat_user_id) VALUES (1,'w')").run();
db.prepare(`INSERT INTO companions (id, user_id, bot_id, name, age, role_title, how_met)
            VALUES (9, 1, 'sandbox', '溪语', 21, '邻家女孩', '在便利店门口躲雨认识')`).run();
const comp = { id: 9, user_id: 1, name: '溪语', age: 21, role_title: '邻家女孩', how_met: '在便利店门口躲雨认识' };

const waitDone = async (label, timeoutMs = 90_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 2000));
    const st = getCompanionBackfillStatus(9);
    if (st?.tier === label) return st;
  }
  throw new Error(`等待 ${label} 超时`);
};

const synthRows = () => db.prepare(`
  SELECT id, content, created_at, (julianday('now') - julianday(created_at)) AS days_ago
  FROM companion_conversation_turns WHERE companion_id = 9 AND synthetic = 1 ORDER BY id`).all();

let failed = false;
const check = (cond, name) => { console.log(cond ? `  ✓ ${name}` : `  ✗ ${name}`); if (!cond) failed = true; };

// ── 阶段 1：创建触发 thin ──────────────────────────────────────────────────
console.log('── 阶段 1：创建 → thin 薄版 ──');
maybeAutoBackfill(comp, { reason: 'create' });
await waitDone('thin');
const thinRows = synthRows();
console.log(`  thin 产物 ${thinRows.length} 条 turns`);
check(thinRows.length >= 4, 'thin 有内容（≥4 条 turns）');
check(thinRows.every(r => r.days_ago <= 7.5), `thin 全部落在最近 7 天（最远 ${Math.max(...thinRows.map(r => r.days_ago)).toFixed(1)} 天前）`);
for (const r of thinRows.slice(0, 4)) console.log(`    [${r.created_at}] ${r.content.slice(0, 40)}`);
const thinSnapshot = new Map(thinRows.map(r => [r.id, r.content]));

// ── 阶段 2：10 条真实消息 → 水位升 full ────────────────────────────────────
console.log('── 阶段 2：注入 10 条真实消息 → 水位升 full ──');
for (let i = 1; i <= 10; i++) saveConversationTurn(9, 'user', `真实消息 ${i}`, null);
maybeAutoBackfill(comp, { reason: 'watermark' });   // 模拟 bot.mjs 每条消息的检查
await waitDone('full', 120_000);
const allRows = synthRows();
const fullRows = allRows.filter(r => !thinSnapshot.has(r.id));
console.log(`  full 新增 ${fullRows.length} 条 turns（总 synthetic ${allRows.length}）`);
check(fullRows.length >= 20, 'full 有体量（≥20 条 turns）');
check(fullRows.every(r => r.days_ago >= 7.5), `full 全部 ≥8 天前（最近 ${Math.min(...fullRows.map(r => r.days_ago)).toFixed(1)} 天前）——不碰薄版周`);
const thinIntact = thinRows.every(r => thinSnapshot.get(r.id) === db.prepare(
  'SELECT content FROM companion_conversation_turns WHERE id = ?').get(r.id)?.content);
check(thinIntact, '薄版条目原文一字未变（她可能已引用过）');
for (const r of fullRows.slice(0, 4)) console.log(`    [${r.created_at}] ${r.content.slice(0, 40)}`);

// ── 阶段 3：full 后水位不再触发 ────────────────────────────────────────────
const before = allRows.length;
maybeAutoBackfill(comp, { reason: 'watermark' });
await new Promise(r => setTimeout(r, 4000));
check(synthRows().length === before, 'full 后水位检查零动作');

console.log(failed ? '\n❌ 沙箱验收失败' : '\n✅ 沙箱验收通过：thin→水位→full 全链 OK');
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
process.exit(failed ? 1 : 0);
