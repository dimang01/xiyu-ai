/**
 * proactive 素材级去重 smoke（v1.21.3 PR-E，临时 DB 真函数，零 LLM）。
 *
 * 覆盖：
 *   1. 归因锚匹配——生产案例形态：「小汤圆」3 条措辞各不同的 reply 必须全命中
 *      （换措辞同梗正是 trigram 撞车检测抓不到的形态）；泛词碎片不误判
 *   2. 召回冷却过滤：用过出局 / 没用过保留 / fail-safe 放行
 *   3. 账本 db 层：落账→时间窗查询（14 天内命中、过期不命中）、fail-open
 *   4. 作用域钉死（静态断言）：冷却过滤只挂 proactive 链路，
 *      对话召回（bot.mjs / playground.mjs）零引用——她接不住用户聊的梗是事故
 *   5. reminder 豁免与 fail-open 挂载形态（静态断言 proactive.mjs 源码）
 */
process.env.DB_PATH = '/tmp/material_smoke.db';
delete process.env.PROACTIVE_MATERIAL_DEDUP_DAYS;
import { unlinkSync, readFileSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const {
  insertProactiveMaterialLog, getRecentlyUsedMaterialIds, getRecentProactiveTexts,
  getDb, saveConversationTurn,
} = await import('../src/db.mjs');
const {
  filterRecentlyUsed, extractMaterialRefs, materialDedupDays,
  memMaterialId, loopMaterialId, buildRecentProactiveHint,
} = await import('../src/proactive_material.mjs');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// ── 1. 归因锚匹配：生产案例「橘猫像小汤圆」──────────────────────────────
const tangyuanMem = { id: 'mem:101', content: '他家的橘猫圆滚滚的，特别像个小汤圆' };
const otherMem = { id: 'mem:102', content: '他下周要去成都出差' };
const candidates = [tangyuanMem, otherMem];

// 3 天 3 次措辞各不同——但"小汤圆"次次在场（专有名词正是高权重记忆的锚）
const day1 = '突然想到你家那只小汤圆了，它今天有没有拆家';
const day2 = '刚看到一只橘猫，胖得跟你说的小汤圆似的哈哈';
const day3 = '在想小汤圆现在是不是趴在你键盘上';
ok(extractMaterialRefs(day1, candidates).includes('mem:101'), '换措辞同梗 day1 命中');
ok(extractMaterialRefs(day2, candidates).includes('mem:101'), '换措辞同梗 day2 命中');
ok(extractMaterialRefs(day3, candidates).includes('mem:101'), '换措辞同梗 day3 命中');
ok(!extractMaterialRefs(day1, candidates).includes('mem:102'), '未引用的记忆不误归因');

// ≥4 字锚直接命中（不依赖 3 字专名）
ok(extractMaterialRefs('对了你不是说要去成都出差吗', candidates).includes('mem:102'), '4 字锚（成都出差）命中');

// 2 字缩称锚：LLM 把"小汤圆"缩成"汤圆"（红色验证沙箱抓出的真实漏报形态）
ok(extractMaterialRefs('你家汤圆今天有没有又滚到沙发底下啊', candidates).includes('mem:101'), '2 字缩称锚（汤圆）命中');
ok(extractMaterialRefs('刚看到一只橘猫胖得不行', candidates).includes('mem:101'), '2 字缩称锚（橘猫）命中');
// 常见双字白名单：撞上"下周"不算引用 mem:102
ok(!extractMaterialRefs('下周要不要一起看电影呀', candidates).includes('mem:102'), '常见双字（下周）不误判');

// 泛词碎片不误判："今天的"与记忆里的"今天的"重叠不算引用
const genericMem = { id: 'mem:103', content: '今天的他看起来有点累' };
ok(!extractMaterialRefs('今天的天气真好呀', [genericMem]).includes('mem:103'), '泛词碎片（今天的）不误判');
ok(extractMaterialRefs('', candidates).length === 0, '空 reply 返回空');
ok(extractMaterialRefs(day1, null).length === 0, '候选为 null 返回空（fail-safe）');

// ── 2. 召回冷却过滤 ────────────────────────────────────────────────────
const mems = [{ id: 101, content: 'a' }, { id: 102, content: 'b' }];
const used = new Set(['mem:101']);
const filtered = filterRecentlyUsed(mems, used);
ok(filtered.length === 1 && filtered[0].id === 102, '用过的记忆出局，没用过的保留');
ok(filterRecentlyUsed(mems, new Set()).length === 2, '空账本全放行');
ok(filterRecentlyUsed(mems, null).length === 2, '非 Set 入参原样放行（fail-safe：宁可重复不可断供）');
ok(filterRecentlyUsed([], used).length === 0, '空候选不炸');

// ── 3. env 配置 ────────────────────────────────────────────────────────
ok(materialDedupDays() === 14, '默认冷却 14 天');
ok(materialDedupDays({ PROACTIVE_MATERIAL_DEDUP_DAYS: '7' }) === 7, 'env 覆盖生效');
ok(materialDedupDays({ PROACTIVE_MATERIAL_DEDUP_DAYS: 'abc' }) === 14, '非法 env 回退默认');

// ── 4. 账本 db 层：落账 + 时间窗 + fail-open ────────────────────────────
const NOW = Date.now();
insertProactiveMaterialLog(7, { materialIds: ['mem:101', 'loop:5'], kind: 'normal', scene: '通勤' });
insertProactiveMaterialLog(7, {
  materialIds: ['mem:999'], kind: 'normal',
  nowIso: new Date(NOW - 20 * 86400e3).toISOString(),   // 20 天前的旧账
});
const recent = getRecentlyUsedMaterialIds(7, { days: 14, now: NOW });
ok(recent.has('mem:101') && recent.has('loop:5'), '14 天内的素材在冷却集里');
ok(!recent.has('mem:999'), '过期素材（20 天前）不在冷却集');
ok(getRecentlyUsedMaterialIds(8, { days: 14 }).size === 0, '无账 companion 返回空集');
insertProactiveMaterialLog(7, { materialIds: 'not-an-array' });   // 坏参数
insertProactiveMaterialLog(7, {});                                 // 空参数
ok(true, '坏参数落账不抛（fail-open）');
ok(memMaterialId(101) === 'mem:101' && loopMaterialId(5) === 'loop:5', '素材 ID 规范');

// 软约束数据源：proactive topic 的 turn 能被查回
getDb().pragma('foreign_keys = OFF');
getDb().prepare("INSERT INTO companions (id, user_id, bot_id, name) VALUES (7, 1, 'b', '溪')").run();
saveConversationTurn(7, 'assistant', '突然想到你家那只小汤圆了', '主动消息');
saveConversationTurn(7, 'assistant', '这条是对话不该进摘要', null);
const texts = getRecentProactiveTexts(7, { days: 7 });
ok(texts.length === 1 && texts[0].includes('小汤圆'), '近 7 天 proactive 摘要只取主动消息 topic');

const hint = buildRecentProactiveHint(texts);
ok(hint.includes('小汤圆') && hint.includes('严格禁止'), '软约束注入段包含已发摘要与禁令');
ok(buildRecentProactiveHint([]) === '', '无摘要时注入段为空');

// ── 5. 作用域钉死（静态断言）────────────────────────────────────────────
const botSrc = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
const pgSrc = readFileSync(new URL('../src/playground.mjs', import.meta.url), 'utf8');
const proactiveSrc = readFileSync(new URL('../src/proactive.mjs', import.meta.url), 'utf8');
for (const [name, src] of [['bot.mjs', botSrc], ['playground.mjs', pgSrc]]) {
  ok(!src.includes('filterRecentlyUsed') && !src.includes('getRecentlyUsedMaterialIds')
     && !src.includes('proactive_material'),
     `对话召回不挂素材冷却：${name} 零引用`);
}
ok(proactiveSrc.includes('filterRecentlyUsed(') && proactiveSrc.includes('getRecentlyUsedMaterialIds('),
   'proactive.mjs 已挂召回冷却');
ok(/kind === 'reminder'\s*\n?\s*\? new Set\(\)/.test(proactiveSrc.replace(/\r/g, '')) || proactiveSrc.includes("kind === 'reminder'"),
   'reminder（纪念日）豁免存在');
ok(proactiveSrc.includes('extractMaterialRefs(') && proactiveSrc.includes('insertProactiveMaterialLog('),
   '发送成功后归因落账已挂');

console.log(`\nproactive_material_smoke: ${pass} passed, ${fail} failed`);
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
process.exit(fail ? 1 : 0);
