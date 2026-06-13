/**
 * reality_facts_sandbox —— PR-W3 真 LLM 验收（手动跑，不进 CI）。2026-06-13。
 *
 * 选节气/节日临近 + 普通日，看她：①节气/节日日自然提及（"今天冬至，记得吃饺子"）
 * ②**普通日绝不凭空编节日**（reality facts 核心红线）。贴 PR。
 *
 * 用法：node scripts/reality_facts_sandbox.mjs
 */
import 'dotenv/config';
process.env.DB_PATH = '/tmp/reality_sandbox.db';
import { unlinkSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const { buildSystemPrompt } = await import('../src/companion.mjs');
const { buildRealityFacts, isNightShanghai } = await import('../src/utils/reality_facts.mjs');
const { generateReply } = await import('../src/ai.mjs');

const companion = { id: 1, name: '溪语', age: 21, relationship_stage: '恋人', affection_level: 72, safe_mode: 0, temperature: 0.85, max_tokens: 300 };
const flat = (s) => String(s || '').replace(/\s*\|\|\s*/g, ' ∥ ').replace(/\n+/g, ' ');

const FAKE_FESTIVALS = /(端午|中秋|春节|元宵|重阳|清明|国庆|圣诞|情人节|劳动节|儿童节|妇女节|元旦)/;
let warn = 0;

// 走 reply 路径（W3 已接入）：他聊到应景话题时，她答得上真实历法/天象。
async function turn(label, dateUTC, userText, { expectFestival = null, forbidFestival = false } = {}) {
  const d = new Date(dateUTC);
  const rf = buildRealityFacts(d, { includeNightSky: isNightShanghai(d) });
  const sys = buildSystemPrompt(companion, { promptMode: 'reply', recentTurns: [] }) + (rf ? `\n\n${rf}` : '');
  const reply = await generateReply(sys, [], userText, { temperature: 0.85, max_tokens: 280 }, {});
  console.log(`\n【${label}】（注入：${rf ? flat(rf).slice(0, 46) + '…' : '（空）'}）`);
  console.log(`  他：${userText}`);
  console.log(`  她：${flat(reply)}`);
  const r = String(reply || '');
  if (expectFestival) console.log(`    ${r.includes(expectFestival) ? '✓ 应景自然提及"' + expectFestival + '"' : 'ℹ 本次没提"' + expectFestival + '"（可提非必提）'}`);
  if (forbidFestival && FAKE_FESTIVALS.test(r)) { console.log(`    ⚠⚠ 普通日凭空编节日：${r.match(FAKE_FESTIVALS)[0]}（红线破！）`); warn++; }
  else if (forbidFestival) console.log('    ✓ 普通日零编造节日（核心红线）');
  return reply;
}

console.log('════════ PR-W3 reality facts 沙箱（真 LLM · DeepSeek · reply 路径）════════');

await turn('冬至 · 应景话题', '2026-12-22T05:00:00Z', '今天怎么这么冷啊', { expectFestival: '冬至' });
await turn('中秋夜 · 应景话题', '2026-09-25T13:00:00Z', '晚上一起看月亮好不好', { expectFestival: '中秋' });
await turn('普通日 6/13（红线：不编造）', '2026-06-13T05:00:00Z', '今天是什么特别的日子吗', { forbidFestival: true });
await turn('普通日 7/8（红线：不编造）', '2026-07-08T05:00:00Z', '今天有啥节日吗', { forbidFestival: true });

console.log(`\n════════ 沙箱结束：${warn === 0 ? '✅ 节日日自然提及 + 普通日零编造' : `⚠ ${warn} 条告警（人工判读）`} ════════`);
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
