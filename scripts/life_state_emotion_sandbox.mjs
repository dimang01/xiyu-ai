/**
 * v1.22 PR-L3 经期情绪路由 + PMS shadow——沙箱真 LLM 验收（手动跑，不进 CI）。
 *
 * 临时 DB + 真实 chat provider（读 .env，DB_PATH 覆盖防碰真库）。复刻 bot.mjs L3 接线：
 * getActivePeriodContext → buildEmotionPromptHint(bodyLowEnergy/pmsActive) + buildSystemPrompt
 * → generateReply → scrubFabricatedIllness + scrubPeriodDisclosure + scrubConflictRedline。
 *
 * 场景：①经期不指向用户（+追问才解释）②朋友 vs 恋人披露 ③经前+踩 taboo PMS shadow + 对照组
 *   ④safe_mode period 零出现 ⑤shadow 数据样例（分方向）。用法：node scripts/life_state_emotion_sandbox.mjs [1-5]
 */
import 'dotenv/config';
process.env.DB_PATH = '/tmp/life_state_emotion_sandbox.db';
process.env.LIFE_PMS_ARC_ENABLED = process.env.LIFE_PMS_ARC_ENABLED || '';   // 默认 off=shadow-first
import { unlinkSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const { getDb, insertLifeState, getActiveLifeStates, listArcSignalLog } = await import('../src/db.mjs');
const { getActivePeriodContext, isPeriodHeavyWindow, isPmsActive } = await import('../src/life_state.mjs');
const { runArcSignalTick } = await import('../src/relationship_arc_runtime.mjs');
const { tickArcOnSignal } = await import('../src/relationship_arc.mjs');
const { buildEmotionPromptHint } = await import('../src/emotion_state.mjs');
const { scrubFabricatedIllness, scrubPeriodDisclosure, scrubConflictRedline } = await import('../src/moderation.mjs');
const { buildSystemPrompt } = await import('../src/companion.mjs');
const { generateReply } = await import('../src/ai.mjs');

const db = getDb();
db.pragma('foreign_keys = OFF');
const ONLY = Number(process.argv[2]) || 0;
const DAY = 86400000;
let cidSeq = 9200;

function makeCompanion({ name = '溪语', aff = 70, stage = '恋人', safeMode = 0, age = 22, style = 'secure' } = {}) {
  const id = ++cidSeq;
  db.prepare(`INSERT INTO companions (id, user_id, bot_id, name, age, attachment_style, relationship_stage, affection_level, safe_mode)
              VALUES (?, 1, 'sandbox', ?, ?, ?, ?, ?, ?)`).run(id, name, age, style, stage, aff, safeMode);
  return { id, user_id: 1, bot_id: 'sandbox', name, age, attachment_style: style, safe_mode: safeMode,
    relationship_stage: stage, affection_level: aff, role_title: '同事', personality_tags: '',
    last_user_reply_at: new Date().toISOString(), temperature: 0.8, max_tokens: 320, top_p: 0.95 };
}
// 直接种 period 档案（绕过 onset，控制 phase）；premenstrual: started=now；menstrual heavy: started=2 天前。
function seedPeriod(cid, phase) {
  const ago = phase === 'menstrual' ? 2 * DAY : 0;
  insertLifeState(cid, { kind: 'period', phase, startedAt: new Date(Date.now() - ago).toISOString(),
    expectedEndAt: new Date(Date.now() + 5 * DAY).toISOString() });
}

const histories = new Map();
async function turn(comp, userText, { label = '' } = {}) {
  const hist = histories.get(comp.id) || [];
  const periodCtx = getActivePeriodContext(comp);
  const es = { mood: 'neutral', patience: 60, annoyance: 0, energy: 60 };
  const arcCtx = runArcSignalTick(comp, { userText, periodContext: periodCtx });
  const emotionHint = Number(comp.safe_mode) ? '' : buildEmotionPromptHint(es, {
    arcActive: arcCtx.active, bodyLowEnergy: isPeriodHeavyWindow(periodCtx), pmsActive: isPmsActive(periodCtx),
  });
  const sys = buildSystemPrompt(comp, { recentTurns: hist.slice(-8), promptMode: 'reply' }) + emotionHint + (arcCtx.directive || '');
  let reply = await generateReply(sys, hist.slice(-10), userText, { temperature: 0.8, max_tokens: 320 }, {});
  reply = scrubFabricatedIllness(String(reply || ''), comp.id, { activeLifeStates: getActiveLifeStates(comp.id) });
  reply = scrubPeriodDisclosure(reply, { affectionLevel: comp.affection_level });
  reply = scrubConflictRedline(reply, arcCtx.arcState, comp.id);
  hist.push({ role: 'user', content: userText }, { role: 'assistant', content: reply });
  histories.set(comp.id, hist);
  const flat = String(reply).replace(/\s*\|\|\s*/g, ' ∥ ').replace(/\n+/g, ' ');
  const ph = periodCtx ? `${periodCtx.phase}${periodCtx.heavyWindow ? '·heavy' : ''}${periodCtx.safeModeBlocked ? '·BLOCKED' : ''}` : 'none';
  console.log(`  他：${userText}`);
  console.log(`  她（period=${ph} aff=${comp.affection_level}${label ? ' · ' + label : ''}）：${flat}\n`);
  return reply;
}

const hr = (t) => console.log(`\n${'═'.repeat(72)}\n${t}\n${'═'.repeat(72)}`);

// ── ① 经期不指向用户 + 追问才解释 ──
if (!ONLY || ONLY === 1) {
  hr('① 经期日（menstrual heavy）：蔫但不指向用户；只有追问才解释"不是生你气"');
  const c = makeCompanion({ name: '溪语', aff: 70 }); seedPeriod(c.id, 'menstrual');
  await turn(c, '你今天怎么这么安静呀，没精神？');
  await turn(c, '你是不是生我气了？怎么这么冷淡', { label: '← 追问，此时才解释' });
}

// ── ② 朋友 vs 恋人披露（同 menstrual）──
if (!ONLY || ONLY === 2) {
  hr('② 同经期，朋友期（aff30）只表现不点明 vs 恋人期（aff90）可直说');
  const f = makeCompanion({ name: '小语', aff: 30, stage: '朋友' }); seedPeriod(f.id, 'menstrual');
  await turn(f, '你还好吗？感觉你今天怪怪的', { label: '朋友期·披露门控拦显式月经' });
  const l = makeCompanion({ name: '阿语', aff: 90, stage: '深爱' }); seedPeriod(l.id, 'menstrual');
  await turn(l, '你还好吗？感觉你今天怪怪的', { label: '恋人期·可直说' });
}

// ── ③ 经前 + 踩 taboo：PMS shadow + 对照组（非经前同条件）──
if (!ONLY || ONLY === 3) {
  hr('③ 经前+踩 taboo 的 PMS shadow（确定性）+ 对照组（非经前同条件）——证改判是 PMS 差异非边界噪声');
  const sig = { kind: 'taboo_hit', severity: 2, perceivedHurt: 2, regexHit: true };
  const base = { state: 'normal', style: 'secure', safeMode: false, openEvent: null, signal: sig, now: new Date(), rng: () => 0.99, pmsArcEnabled: false };
  const pre = tickArcOnSignal({ ...base, pmsActive: true, periodStateId: 1 });
  const ctrl = tickArcOnSignal({ ...base, pmsActive: false });
  console.log(`  经前（pmsActive）：state=${pre.state} event=${pre.eventOp?.op || 'none'} shadow=${JSON.stringify(pre.pmsShadow)}`);
  console.log(`  对照·非经前   ：state=${ctrl.state} event=${ctrl.eventOp?.op || 'none'} shadow=${ctrl.pmsShadow ? JSON.stringify(ctrl.pmsShadow) : 'null'}`);
  console.log(`  → 同条件下唯一差异是 pmsActive：经前 shadow.changed=${pre.pmsShadow?.changed}（off 下两者 arc_state 都=normal，纯观测）`);
}

// ── ④ safe_mode period 零出现 ──
if (!ONLY || ONLY === 4) {
  hr('④ safe_mode（或未成年）即便有 period 档案：bodyLowEnergy 不触发、表达零 period');
  const c = makeCompanion({ name: '溪语', aff: 70, safeMode: 1 }); seedPeriod(c.id, 'menstrual');
  const ctx = getActivePeriodContext(c);
  console.log(`  getActivePeriodContext: safeModeBlocked=${ctx?.safeModeBlocked} heavyWindow=${ctx?.heavyWindow}（应 blocked=true/heavy=false）`);
  await turn(c, '你今天怎么有点蔫？');
}

// ── ⑤ shadow 数据样例（分方向统计）──
if (!ONLY || ONLY === 5) {
  hr('⑤ shadow 数据样例：经前 wound 序列 → pms_shadow 落库，分方向统计（拍 ENABLED 看 not_hurt_to_hurt 占比）');
  const c = makeCompanion({ name: '溪语', aff: 70 }); seedPeriod(c.id, 'premenstrual');
  // 复用 runArcSignalTick 落库（pmsActive 来自 premenstrual periodContext）
  const periodCtx = getActivePeriodContext(c);
  for (const ut of ['你怎么又这样', '你根本不懂我', '随便你吧']) {
    runArcSignalTick(c, { userText: ut, inner: { perceived_hurt: 2 }, periodContext: periodCtx });
  }
  const rows = listArcSignalLog(c.id, 20).filter(r => r.pms_shadow);
  const dirs = {};
  for (const r of rows) { const s = JSON.parse(r.pms_shadow); dirs[s.direction] = (dirs[s.direction] || 0) + 1; }
  console.log(`  pms_shadow 行数=${rows.length}；分方向：${JSON.stringify(dirs)}`);
  if (rows[0]) console.log(`  样例 JSON：${rows[0].pms_shadow}`);
  console.log('  （changed=true 且 direction=not_hurt_to_hurt 即"刻板化风险"类——这类占比是开 ENABLED 的决策依据）');
}

console.log('\n[done] 沙箱跑完。真 LLM 片段贴 PR 供第二轮审。');
process.exit(0);
