/**
 * emotion_stress_test.mjs — 情绪机制 ABCD 极限压测 + 行为验证
 *
 * 用独立临时 DB（DB_PATH），验证：不崩溃、值合法、prompt 生成稳健、行为符合心理学。
 * 跑：node scripts/emotion_stress_test.mjs
 */
import { unlinkSync } from 'node:fs';

const TMP = `/tmp/emotion_stress_${Date.now()}.db`;
process.env.DB_PATH = TMP;                       // 必须在 import db 之前设

const emo = await import('../src/emotion_state.mjs');
const dbm = await import('../src/db.mjs');
dbm.getDb().pragma('foreign_keys = OFF');

const DIMS = ['affection','trust','dependency','possessiveness','security','energy','patience','excitement','annoyance','gratitude','mood_intensity'];
const MOODS = emo.MOOD_STATES;

let crashes = 0, bad = 0, promptBad = 0, moodSwitches = 0;
const issues = [];
const ranges = {}; DIMS.forEach(d => ranges[d] = [Infinity, -Infinity]);

function check(s, ctx) {
  for (const d of DIMS) {
    const v = s[d];
    if (v === undefined) { issues.push(`${ctx}: ${d}=undefined`); bad++; continue; }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) { issues.push(`${ctx}: ${d}=${v}`); bad++; }
    else { ranges[d][0] = Math.min(ranges[d][0], v); ranges[d][1] = Math.max(ranges[d][1], v); }
  }
  if (s.mood && !MOODS.includes(s.mood)) { issues.push(`${ctx}: mood=${s.mood} 非法`); bad++; }
}
function checkPrompt(h, ctx) {
  if (typeof h !== 'string') { issues.push(`${ctx}: prompt 非字符串 ${typeof h}`); promptBad++; }
}

const MSGS = ['谢谢你','你好看可爱','随便吧无所谓','对不起我错了','我好难过崩溃','她是谁前任','困了晚安',
  '中奖了好消息太棒了','多喝水注意身体','在吗在吗快回怎么不回','你说话不算数','懒得理你关我什么事',
  '骗你的啦哈哈','今天天气不错','哈哈哈哈','你又爽约言而无信','我爱你么么','在干嘛','...','',
  'x'.repeat(300),'😊😊😊','你怎么又放我鸽子','嗯','好的'];
const STAGES = [undefined,'none','missing','uneasy','disappointed','withdrawn'];

// ── 1) 随机 1000 轮：更新 + 每轮 buildEmotionPromptHint（含 D-1） ──
const CID = 990001;
let st = emo.getEmotionStateWithDefaults(CID);
let prevMood = st.mood;
const N = 1000;
for (let i = 0; i < N; i++) {
  const r = Math.random();
  try {
    if (r < 0.5) {
      const msg = MSGS[(Math.random() * MSGS.length) | 0];
      const rep = Math.random() < 0.2 ? ((Math.random() * 3) | 0) : 0;
      st = emo.updateEmotionFromUserMessage(CID, st, msg, { companion: { affection_level: (Math.random() * 100) | 0 }, repeatLevel: rep });
    } else if (r < 0.75) {
      const idle = [10, 40, 120, 400, 800, 1500, 3000, 6000][(Math.random() * 8) | 0];
      st = emo.updateEmotionFromIdle(CID, st, idle, (Math.random() * 100) | 0);
    } else {
      st = emo.updateEmotionFromAssistantReply(CID, st, '哈哈好的😊', {});
    }
    check(st, `r${i}`);
    if (st.mood !== prevMood) { moodSwitches++; prevMood = st.mood; }
    // 每轮也生成 prompt（D-1 混合底色在里面）
    const h = emo.buildEmotionPromptHint(st, { missingLevel: (Math.random() * 5) | 0, neglectStage: STAGES[(Math.random() * STAGES.length) | 0] });
    checkPrompt(h, `r${i}`);
  } catch (e) { crashes++; issues.push(`r${i} CRASH: ${e.message}`); }
}

// ── 2) buildEmotionPromptHint 极端 state fuzzing（含非法 mood / 维度 0/100 边界） ──
let pFuzz = 0;
for (let i = 0; i < 300; i++) {
  const s = {};
  for (const d of DIMS) s[d] = [0, 100, (Math.random() * 100) | 0, -5, 150, NaN][(Math.random() * 6) | 0];
  s.mood = [...MOODS, 'garbage', undefined, null][(Math.random() * (MOODS.length + 3)) | 0];
  try {
    const h = emo.buildEmotionPromptHint(s, { missingLevel: (Math.random() * 6 | 0) - 1, neglectStage: STAGES[(Math.random() * STAGES.length) | 0], dailySchedule: null });
    if (typeof h !== 'string') { promptBad++; issues.push(`fuzz${i}: 非字符串`); }
    pFuzz++;
  } catch (e) { crashes++; issues.push(`fuzz${i} CRASH: ${e.message}`); }
}

// ── 3) 定向行为验证（ABC + D） ──
const beh = [];
let _seq = 992000;
const fresh = () => { const c = _seq++; return [c, emo.getEmotionStateWithDefaults(c)]; };
// ABC 回归
{ let [c, s] = fresh(); s = { ...s, trust: 80, security: 70 }; const t0 = s.trust;
  for (let k = 0; k < 3; k++) s = emo.updateEmotionFromUserMessage(c, s, '你说话不算数又爽约', { companion: { affection_level: 60 } });
  beh.push(['A 失信3次 trust 持续降', s.trust < t0 - 8, `${t0}→${s.trust}`]); }
{ let [c, s] = fresh(); s = emo.updateEmotionFromUserMessage(c, s, '你又爽约', { companion: { affection_level: 50 } }); const m0 = s.mood;
  s = emo.updateEmotionFromUserMessage(c, s, '今天天气不错', { companion: { affection_level: 50 } });
  beh.push(['C 强负面后普通消息保持惯性', s.mood === m0 && m0 !== 'neutral', `${m0}→${s.mood}`]); }
{ let [c, s] = fresh(); s = { ...s, excitement: 85 }; s = emo.updateEmotionFromIdle(c, s, 120, 50);
  beh.push(['B excitement idle 后衰减', s.excitement < 85, `85→${s.excitement}`]); }
// D-2 维度耦合
{ let [c, s] = fresh(); s = { ...s, security: 10, possessiveness: 30 }; const p0 = s.possessiveness;
  s = emo.updateEmotionFromUserMessage(c, s, '她是谁前任', { companion: { affection_level: 50 } });
  beh.push(['D-2 低安全感放大醋意', s.possessiveness - p0 > 4, `醋 +${s.possessiveness - p0}(基础+4)`]); }
{ let [cA, sA] = fresh(); sA = { ...sA, trust: 95, security: 70 }; const ta = sA.trust;
  sA = emo.updateEmotionFromUserMessage(cA, sA, '你说话不算数', { companion: { affection_level: 60 } });
  const dropHi = ta - sA.trust;
  let [cB, sB] = fresh(); sB = { ...sB, trust: 60, security: 70 }; const tb = sB.trust;
  sB = emo.updateEmotionFromUserMessage(cB, sB, '你说话不算数', { companion: { affection_level: 60 } });
  const dropLo = tb - sB.trust;
  beh.push(['D-2 高信任缓冲背叛(掉得更少)', dropHi < dropLo, `高信任掉${dropHi} < 普通掉${dropLo}`]); }
// D-1 混合底色
{ let [_c, s] = fresh(); s = { ...s, mood: 'wronged', mood_intensity: 55, dependency: 75 };
  const h = emo.buildEmotionPromptHint(s, { missingLevel: 2 });
  beh.push(['D-1 委屈+高依赖出"又凶又软"底色', h.includes('又凶又软'), h.includes('又凶又软') ? 'ok' : '未注入']); }

console.log(`\n=== 随机 ${N} 轮 + prompt 生成 ===`);
console.log(`崩溃: ${crashes} | 非法值: ${bad} | prompt 异常: ${promptBad} | mood 切换: ${moodSwitches}/${N} (${(moodSwitches / N * 100).toFixed(0)}%)`);
console.log(`prompt fuzzing(极端 state): ${pFuzz}/300 安全`);
if (issues.length) console.log('前 15 个问题:', issues.slice(0, 15));
console.log('维度范围:'); for (const d of DIMS) console.log(`  ${d.padEnd(15)} ${ranges[d][0] === Infinity ? '—' : ranges[d][0] + '–' + ranges[d][1]}`);
console.log(`\n=== 定向行为验证 (ABC + D) ===`);
let bf = 0; for (const [n, ok, detail] of beh) { console.log(`  ${ok ? '✓' : '✗'} ${n}  (${detail})`); if (!ok) bf++; }
try { unlinkSync(TMP); } catch {}
const fail = crashes > 0 || bad > 0 || promptBad > 0 || bf > 0;
console.log(`\n结论: ${fail ? '❌ 有问题，需排查' : '✅ ABCD 全部稳定，输出合理，可上线'}`);
process.exit(fail ? 1 : 0);
