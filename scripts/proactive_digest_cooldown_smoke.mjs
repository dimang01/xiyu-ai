/**
 * proactive_digest_cooldown_smoke —— longTermDigest 旁路的素材冷却闸门红验（接线类第五案）。
 * 生产实锤 mem:509（daily_summary）经 digest 旁路反复复读 4 次/天——素材去重只挡 recallMemories
 * 召回路、覆盖不到 digest 旁路。本 smoke 钉死「闸门挂注入动作」修复 + 双向红验。
 *
 * 红验双向：
 *   ①剔除向（proactive）：summary id 在 excludeUsedIds → buildLongTermDigest 必剔（不再复读）
 *   ②放行向（对话召回/reply）：不传 excludeUsedIds → summary 全保留
 *     （他问"你还记得我喜欢哲学吗"必须答得上——digest 剔除绝不能伤对话召回）
 *   ③reminder 豁免形态：空 Set → 不剔除（与召回路 reminder 豁免一致）
 *   ④架构约定静态断言：proactive 调用带 excludeUsedIds / bot·playground 对话召回不带 /
 *     闸门铁律注释在场（新增旁路强制 review 的锚）
 */
process.env.DB_PATH = '/tmp/digest_cooldown_smoke.db';
import { unlinkSync, readFileSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const { getDb, saveMemory } = await import('../src/db.mjs');
const { buildLongTermDigest } = await import('../src/plan_tasks.mjs');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

// 建 companion + 塞一条 daily_summary（mem:509 形态：高价值，走 digest 旁路）
const db = getDb();
db.pragma('foreign_keys = OFF');
db.prepare("INSERT INTO companions (id, user_id, bot_id, name) VALUES (88, 1, 'b', '溪')").run();
const PHILO = '他喜欢哲学思辨，对天道和禅宗有深入理解';
saveMemory({ companionId: 88, userId: 1, memoryType: 'daily_summary', content: `2026-06-11 日记忆：${PHILO}`, importance: 8 });
const OTHER = '他在学吉他，最近在练爬格子';
saveMemory({ companionId: 88, userId: 1, memoryType: 'daily_summary', content: `2026-06-10 日记忆：${OTHER}`, importance: 6 });
// saveMemory 不返回 id（既有行为）——查回 mem id 作冷却键
const memId = db.prepare('SELECT id FROM companion_memories WHERE companion_id=88 AND content LIKE ?').get(`%${PHILO}%`).id;

// ── ① 剔除向（proactive）：该 summary id 在冷却集 → digest 不含它 ──
{
  const digest = await buildLongTermDigest(88, 1, { excludeUsedIds: new Set([`mem:${memId}`]) });
  ok(!digest.includes(PHILO), `①剔除向：冷却集含 mem:${memId} → digest 剔除该 summary（不再复读）`);
  ok(digest.includes(OTHER), '①剔除向：未冷却的 summary 仍保留（只剔中招那条，非整段空）');
}

// ── ② 放行向（对话召回/reply）：不传 excludeUsedIds → 全保留 ──
{
  const digest = await buildLongTermDigest(88, 1);
  ok(digest.includes(PHILO) && digest.includes(OTHER), '②放行向：reply 不传 → summary 全保留（他问"还记得我喜欢哲学吗"答得上）');
}

// ── ③ reminder 豁免形态：空 Set → 不剔除 ──
{
  const digest = await buildLongTermDigest(88, 1, { excludeUsedIds: new Set() });
  ok(digest.includes(PHILO), '③空 Set（reminder 豁免形态）→ 不剔除（与召回路豁免一致）');
}

// ── ④ 架构约定静态断言：闸门挂注入动作（proactive 带 / 对话召回不带 / 铁律注释在场）──
{
  const proSrc = readFileSync(new URL('../src/proactive.mjs', import.meta.url), 'utf8');
  const botSrc = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
  const pgSrc = readFileSync(new URL('../src/playground.mjs', import.meta.url), 'utf8');
  const ptSrc = readFileSync(new URL('../src/plan_tasks.mjs', import.meta.url), 'utf8');
  ok(/buildLongTermDigest\([^)]*excludeUsedIds/s.test(proSrc), '④proactive 调用带 excludeUsedIds（旁路过闸）');
  ok(!/buildLongTermDigest\([^)]*excludeUsedIds/s.test(botSrc), '④bot 对话召回不带 excludeUsedIds（永放行）');
  ok(!/buildLongTermDigest\([^)]*excludeUsedIds/s.test(pgSrc), '④playground 对话召回不带 excludeUsedIds（永放行）');
  ok(ptSrc.includes('素材冷却闸门') && ptSrc.includes('强制 review'),
     '④闸门铁律注释在场（新增注入旁路强制 review 的锚——闸门挂注入动作非路径）');
}

console.log(`\nproactive_digest_cooldown_smoke: ${pass} passed, ${fail} failed`);
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
process.exit(fail ? 1 : 0);
