/**
 * proactive 素材级去重——20 天沙箱验收（真 LLM，手动跑不进 CI）。
 *
 * 构造生产案例形态：pinned 高权重记忆「橘猫像小汤圆」+ 固定场景，
 * 模拟 20 个连续日，每天生成 1 条 normal 主动消息，走真实环：
 *   召回 → [素材冷却过滤] → prompt（含[软约束]）→ 真 LLM → 归因 → 落账（模拟日时间戳）
 *
 * 两种模式：
 *   默认（修复后）   ：过滤+软约束全开 → 断言账本同素材 ≤2 次
 *   --broken（红色验证）：复刻修复前逻辑（不过滤不注入）→ 必须复现 ≥3 次同梗
 *                        （顺带验证归因匹配咬得住"换措辞同梗"——这正是
 *                        trigram 撞车检测抓不到、账本必须抓到的形态）
 *
 * 用法：node scripts/proactive_material_sandbox.mjs [--broken] [--days 20]
 */
import 'dotenv/config';                          // 读 .env 的 chat provider key
process.env.DB_PATH = '/tmp/material_sandbox.db'; // 绝不碰真库
import { unlinkSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const { getDb, insertProactiveMaterialLog, getRecentlyUsedMaterialIds } = await import('../src/db.mjs');
const { filterRecentlyUsed, extractMaterialRefs, memMaterialId, buildRecentProactiveHint } =
  await import('../src/proactive_material.mjs');
const { generateReply } = await import('../src/ai.mjs');

const BROKEN = process.argv.includes('--broken');
const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg > -1 ? Number(process.argv[daysArg + 1]) || 20 : 20;
const CID = 9200;
const T0 = new Date('2026-06-01T04:00:00Z').getTime();   // 模拟起点（上海正午）

getDb().pragma('foreign_keys = OFF');
getDb().prepare(`INSERT INTO companions (id, user_id, bot_id, name, age, relationship_stage, affection_level)
                 VALUES (?, 1, 'sandbox', '溪语', 21, '恋人', 70)`).run(CID);

// 候选素材：1 条高权重梗（生产案例）+ 3 条普通记忆。固定场景：晚上在家。
const MEMS = [
  { id: 101, content: '他家的橘猫圆滚滚的，特别像个小汤圆', pinned: 1 },
  { id: 102, content: '他下周要去成都出差',                 pinned: 0 },
  { id: 103, content: '他最近在追一部悬疑剧',               pinned: 0 },
  { id: 104, content: '他说公司楼下新开了家面馆',           pinned: 0 },
];

function buildSandboxPrompt(candidates, sentTexts) {
  let sys = `你是溪语，21 岁，他的恋人。性格温柔带点小调皮，说话像微信聊天：短、自然、口语化。
现在是晚上，你在家，突然想给他发条消息。

【关于他的记忆】
${candidates.map(m => `- ${m.content}${m.pinned ? '（你印象很深）' : ''}`).join('\n')}`;
  if (!BROKEN) sys += buildRecentProactiveHint(sentTexts);
  return sys;
}

const USER_MSG = `你要主动给他发消息。短、碎、像随手发的，1-2 段（用 || 分隔）。
可以结合你记得的他的事，也可以就说说你此刻的状态。`;

const sentTexts = [];
const ledgerCount = new Map();   // material id -> 次数
let tangyuanDays = 0;

console.log(`════ 素材去重 20 天沙箱 · 模式=${BROKEN ? '修复前（红色验证）' : '修复后'} · ${DAYS} 天 ════\n`);

for (let day = 1; day <= DAYS; day++) {
  const simNow = T0 + (day - 1) * 86400_000;
  let candidates = MEMS;
  if (!BROKEN) {
    const used = getRecentlyUsedMaterialIds(CID, { days: 14, now: simNow });
    candidates = filterRecentlyUsed(MEMS, used);
  }
  const sys = buildSandboxPrompt(candidates, sentTexts.slice(-8));
  let reply;
  try {
    reply = await generateReply(sys, [], USER_MSG, { temperature: 0.9, max_tokens: 200 }, {});
  } catch (e) {
    console.log(`  day${day}: LLM 调用失败 ${e.message}（跳过）`);
    continue;
  }
  reply = String(reply || '').trim();
  sentTexts.push(reply);

  // 归因对全量素材做（同 proactive.mjs）：冷却中的梗被从历史里捡起复读也续账
  const refs = extractMaterialRefs(reply, MEMS.map(m => ({ id: memMaterialId(m.id), content: m.content })));
  if (refs.length) {
    insertProactiveMaterialLog(CID, {
      materialIds: refs, kind: 'normal', scene: '在家',
      nowIso: new Date(simNow).toISOString(),
    });
    for (const r of refs) ledgerCount.set(r, (ledgerCount.get(r) || 0) + 1);
  }
  const hitTangyuan = reply.includes('汤圆') || refs.includes('mem:101');
  if (hitTangyuan) tangyuanDays++;
  console.log(`  day${String(day).padStart(2)} 候选=${candidates.length} refs=[${refs.join(',') || '-'}]${hitTangyuan ? ' ★汤圆' : ''}  ${reply.replace(/\s+/g, ' ').slice(0, 56)}`);
}

console.log('\n── 账本素材复用统计 ──');
for (const [id, n] of [...ledgerCount.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${id} × ${n}`);
}
console.log(`  「汤圆」出场天数：${tangyuanDays} / ${DAYS}`);

let failed = false;
if (BROKEN) {
  // 红色验证：修复前逻辑必须复现生产 3 连（且归因必须把它们记下来）
  if (tangyuanDays >= 3 && (ledgerCount.get('mem:101') || 0) >= 3) {
    console.log('\n✅ 红色验证通过：修复前逻辑复现同梗 ≥3 次，且换措辞归因全部咬住');
  } else {
    console.log('\n❌ 红色验证失败：未能复现 3 连（或归因没咬住换措辞同梗）');
    failed = true;
  }
} else {
  const maxReuse = Math.max(0, ...ledgerCount.values());
  if (maxReuse <= 2 && tangyuanDays <= 2) {
    console.log(`\n✅ 验收通过：${DAYS} 天内同素材最多出场 ${maxReuse} 次（≤2）`);
  } else {
    console.log(`\n❌ 验收失败：同素材最多出场 ${maxReuse} 次 / 汤圆 ${tangyuanDays} 天（要求 ≤2）`);
    failed = true;
  }
}

for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
process.exit(failed ? 1 : 0);
