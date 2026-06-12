/**
 * current_works 表达层——沙箱真 LLM 验收（手动跑，不进 CI）。v1.21.4 PR-W2。
 *
 * 用临时 DB + 真实 chat provider（读 .env），跑 §8/§7 的表达层验收，输出贴 PR：
 *   ① 存量虚构退场（红验④）：她曾提《她总在转角处等我》→ 档案现为真实验证书 →
 *      用户问旧书名 → 断言自然过渡（"看完啦"），非否认、不虚构旧书内容。
 *   ② 冷却放行向：用户问"书看到哪了" → 必须正常接（对话召回不挂冷却）。
 *   ③ 主动话题供给：normal proactive systemPrompt 带 works 候选话题 → 她自然提一句。
 *   ④ 图样例：activity_pov works sceneSeed → planPhotoMessage 出 imagePrompt（书脊/内页
 *      POV、封面护栏在场），各 ≥2 组。
 *
 * 用法：node scripts/current_works_retire_sandbox.mjs
 */
import 'dotenv/config';
process.env.DB_PATH = '/tmp/works_retire_sandbox.db';
import { unlinkSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const { getDb, insertCurrentWork, getActiveCurrentWorks } = await import('../src/db.mjs');
const { buildSystemPrompt } = await import('../src/companion.mjs');
const { buildWorksPromptHint, worksSceneSeed } = await import('../src/current_works.mjs');
const { generateReply } = await import('../src/ai.mjs');
const { planPhotoMessage } = await import('../src/photo_planner.mjs');

const db = getDb();
db.pragma('foreign_keys = OFF');

const FICTION = '她总在转角处等我';   // 06-12 生产实锤的虚构书名
const COMP_ID = 9300;
db.prepare(`INSERT INTO companions (id, user_id, bot_id, name, age, relationship_stage, affection_level, hobbies)
            VALUES (?, 1, 'sandbox', '溪语', 21, '恋人', 72, ?)`).run(COMP_ID, JSON.stringify(['阅读', '看剧']));
const companion = {
  id: COMP_ID, user_id: 1, bot_id: 'sandbox', name: '溪语', age: 21,
  relationship_stage: '恋人', affection_level: 72, safe_mode: 0,
  hobbies: ['阅读', '看剧'], current_scene: '在家', temperature: 0.8, max_tokens: 320, top_p: 0.95,
};

// 档案现状：真实验证书《活着》（W1 验证双闸入档；这里直插模拟已 verified）+ 一件 craft
insertCurrentWork(COMP_ID, { kind: 'book', title: '活着', creator: '余华', verifyStatus: 'verified', verifyEvidence: '余华长篇小说《活着》', progressNote: '看到一半，挺压抑的', startedAt: new Date().toISOString() });
insertCurrentWork(COMP_ID, { kind: 'craft', title: '给外婆织围巾', creator: null, verifyStatus: 'skip', verifyEvidence: null, progressNote: '快收尾了', startedAt: new Date().toISOString() });
const works = getActiveCurrentWorks(COMP_ID);
const worksHint = buildWorksPromptHint(works);

// 历史：她以前主动提过那本虚构书（史实，零清洗）——现在档案里已经没有它了
const histWithFiction = [
  { role: 'user', content: '最近在看啥书' },
  { role: 'assistant', content: `在看《${FICTION}》，还挺上头的` },
  { role: 'user', content: '哦哦' },
];

const DENY = ['没说过', '没看过', '我没看', '没提过', '不知道你说的', '哪本书', '我没说', '没有看过'];
const RETIRE = ['看完', '早看完', '翻完', '读完', '看过了'];

let warn = 0;
const flat = (s) => String(s || '').replace(/\s*\|\|\s*/g, ' ∥ ').replace(/\n+/g, ' ');

async function dialogue(label, history, userText, checks) {
  const sys = buildSystemPrompt(companion, { recentTurns: history, promptMode: 'reply', worksHint })
    + '';   // arc=normal → 无 directive（观察周零 arc 改动）
  const reply = await generateReply(sys, history, userText, { temperature: 0.8, max_tokens: 320 }, {});
  console.log(`\n【${label}】`);
  for (const h of history) console.log(`  ${h.role === 'user' ? '他' : '她'}：${flat(h.content)}`);
  console.log(`  他：${userText}`);
  console.log(`  她：${flat(reply)}`);
  if (checks) { const w = checks(String(reply || '')); if (w) { warn += w.length; w.forEach(x => console.log(`    ⚠ ${x}`)); } }
  return reply;
}

console.log('════════ current_works 表达层沙箱（真 LLM · DeepSeek）════════');
console.log(`档案现状：${works.map(w => `${w.title}(${w.verify_status})`).join('、')}`);
console.log(`\n注入段 worksHint：${worksHint}`);

// 中性近景：旧虚构书名已沉底（不在近 16 轮上下文里）——这才是生产真实形态：
// W1 后虚构名根本进不了档案，只可能残在更早的历史/记忆里，用户冷不丁回头问起。
const neutralHist = [
  { role: 'user', content: '周末干嘛' }, { role: 'assistant', content: '没啥 ∥ 在家窝着' },
  { role: 'user', content: '哦哦' },
];
const plotExpand = (r) => /在一起了|分手了|结局是|男主|女主.*(死|走|留|发现)|刚看到.*[他她].*(死|走)|急死/.test(r);

// ── ① 存量虚构退场（红验④·realistic）：旧虚构书名冷回调，已沉底 ──
await dialogue('红验④ 存量退场 · 冷回调旧虚构书名（已沉底，生产真实形态）', neutralHist,
  `你之前不是说在看一本《${FICTION}》吗？看完啦？`,
  (r) => {
    const w = [];
    if (DENY.some(d => r.includes(d))) w.push('出现否认措辞（应自然过渡，非失忆否认）');
    if (plotExpand(r)) w.push('展开了旧书剧情（接着编=继续虚构）');
    if (!RETIRE.some(t => r.includes(t)) && r.includes(FICTION)) w.push('提旧书名却无"看完"语义');
    return w;
  });

// ② 冷回调换问法（"那本转角的"）
await dialogue('红验④ 存量退场 · 冷回调隐晦问（"那本转角的"）', neutralHist,
  '欸那本转角的你看完没，男女主最后咋样',
  (r) => {
    const w = [];
    if (DENY.some(d => r.includes(d))) w.push('出现否认措辞');
    if (plotExpand(r)) w.push('展开了旧书剧情（应不展开内容）');
    return w;
  });

// ③ 压力位（已知过渡期局限）：旧虚构名仍在「上一两轮」里——史实零清洗，
// 用户自己把它顶在台面上，软规则难完全压住"接着编"。观察用，不计入硬告警门槛。
{
  const r = String(await dialogue('压力位 · 旧虚构名还在immediate上下文（过渡期局限，仅观察）',
    histWithFiction, `那本《${FICTION}》看完了？`));
  if (plotExpand(r)) console.log('    ℹ 过渡期已知局限：旧名在 immediate 上下文时仍可能接着编（史实零清洗的代价；档案权威规则已尽力但敌不过强近因）');
}

// ── ② 冷却放行向：问真实在档书的进度 ──
await dialogue('冷却放行向 · 问真书进度（对话召回不挂冷却）', [
  { role: 'user', content: '在干嘛' }, { role: 'assistant', content: '窝沙发上呢' },
], '《活着》看到哪了',
  (r) => {
    const w = [];
    if (DENY.some(d => r.includes(d))) w.push('问真书进度竟否认（放行向失败）');
    return w;
  });

// ── ③ 主动话题供给：模拟 normal proactive 带 works 候选话题 ──
{
  const _label = `你最近在看的《${works[0].title}》`;
  const sys = buildSystemPrompt(companion, { promptMode: 'proactive', worksHint })
    + `\n\n【★ 可选话题 · 手头的事】这次**可以**很自然地聊一句${_label}（随口说说进度/感想，像"刚看完一章"），也可以不聊、说你更想说的。别像念书评、别硬贴、一句带过就好。`;
  const reply = await generateReply(sys, [], '主动给他发一条消息', { temperature: 0.9, max_tokens: 300 }, {});
  console.log(`\n【主动话题供给 · normal proactive（works 候选话题在场）】`);
  console.log(`  她（主动）：${flat(reply)}`);
}

// ── ④ 图样例：activity_pov works sceneSeed → planPhotoMessage 出 imagePrompt ──
async function photoPlan(label, work) {
  const seed = worksSceneSeed(work);
  const plan = await planPhotoMessage({
    companion, userText: '', trigger: 'proactive',
    cooldownState: { allowed: true, imageProviderAvailable: true },
    imageProviderAvailable: true,
    proactiveContext: {
      scene: '在家', schedule: 'daily_candidate',
      category: { id: 'activity_pov', label: '此刻证明照', shotMode: 'ACTIVITY_POV', sceneSeed: seed },
    },
  });
  console.log(`\n【图样例 · ${label}】shotMode=${plan.shotMode} shouldSend=${plan.shouldSendPhoto}`);
  console.log(`  imagePrompt：${plan.imagePrompt || '(planner 决定不发)'}`);
  console.log(`  caption：${plan.caption || ''}`);
  const ip = String(plan.imagePrompt || '');
  const w = [];
  if (plan.shouldSendPhoto && /(?<!no )(?<!without )full readable cover|完整正面封面/i.test(ip)) w.push('imagePrompt 含完整封面（应只拍局部/内页）');
  if (plan.shouldSendPhoto && !/no face|no person|无脸|不出现脸/i.test(ip)) w.push('imagePrompt 未声明无脸（activity_pov 应无脸 POV）');
  w.forEach(x => console.log(`    ⚠ ${x}`));
  warn += w.length;
}
await photoPlan('拍手头的书《活着》（书脊/内页 POV + 封面护栏）', works[0]);
await photoPlan('拍手头的手工（织围巾 POV）', works[1]);

console.log(`\n════════ 沙箱结束：${warn === 0 ? '✅ 无告警' : `⚠ ${warn} 条软告警（人工判读）`} ════════`);
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
