/**
 * neglect_stage_smoke.mjs — v1.14 被冷落阶段 + 依恋风格 护栏
 *
 * 校验：
 *  1) getNeglectStage 按 idle 时长 × attachment_style 分档正确
 *  2) 三种依恋风格的升级快慢差异（anxious 快 / avoidant 早抽离）
 *  3) buildEmotionPromptHint 中 neglect 阶段语气正确「覆盖」想念档热切语气
 *
 * 跑：node scripts/neglect_stage_smoke.mjs
 */
import { getNeglectStage, neglectStageIndex, buildEmotionPromptHint, buildReunionHint } from '../src/emotion_state.mjs';

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; }
  else { fail++; console.error('✗ FAIL:', name); }
};

// ── 1. 分档阈值 ────────────────────────────────────────────────────────────
const cases = [
  // [style, hours, expected]
  ['secure',   3,  'none'],        ['secure',   10, 'missing'],
  ['secure',   30, 'uneasy'],      ['secure',   60, 'disappointed'], ['secure',  100, 'withdrawn'],
  ['secure',  200, 'long_gone'],   ['secure',  400, 'dormant'],      // v1.16.x 长尾：7天/14天
  ['anxious',  3,  'none'],        ['anxious',  8,  'missing'],
  ['anxious',  20, 'uneasy'],      ['anxious',  40, 'disappointed'], ['anxious',  70, 'withdrawn'],
  ['anxious', 150, 'long_gone'],   ['anxious', 300, 'dormant'],
  ['avoidant', 5,  'none'],        ['avoidant', 20, 'missing'],
  ['avoidant', 40, 'uneasy'],      ['avoidant', 60, 'disappointed'], ['avoidant', 80, 'withdrawn'],
  ['avoidant',150, 'long_gone'],   ['avoidant',300, 'dormant'],
];
for (const [style, h, exp] of cases) {
  const got = getNeglectStage(hoursAgo(h), style);
  check(`${style} @${h}h → ${exp} (got ${got})`, got === exp);
}

// ── 2. 风格差异 ────────────────────────────────────────────────────────────
check('焦虑型 @20h 已 uneasy，安全型还在 missing',
  getNeglectStage(hoursAgo(20), 'anxious') === 'uneasy' &&
  getNeglectStage(hoursAgo(20), 'secure')  === 'missing');
check('回避型 @80h 已 withdrawn，安全型还没（96h 才到）',
  getNeglectStage(hoursAgo(80), 'avoidant') === 'withdrawn' &&
  getNeglectStage(hoursAgo(80), 'secure')   !== 'withdrawn');
check('回避型前段更慢 @8h 仍 none（安全型已 missing）',
  getNeglectStage(hoursAgo(8), 'avoidant') === 'none' &&
  getNeglectStage(hoursAgo(8), 'secure')   === 'missing');
check('无回复记录 → none', getNeglectStage(null, 'secure') === 'none');
check('index 单调递增', neglectStageIndex('withdrawn') > neglectStageIndex('uneasy'));
check('长尾 index 续递增 dormant>long_gone>withdrawn',
  neglectStageIndex('dormant') > neglectStageIndex('long_gone') &&
  neglectStageIndex('long_gone') > neglectStageIndex('withdrawn'));
check('风格差异：长尾也分快慢（anxious @150h 已 long_gone，secure 还 withdrawn）',
  getNeglectStage(hoursAgo(150), 'anxious') === 'long_gone' &&
  getNeglectStage(hoursAgo(150), 'secure')  === 'withdrawn');

// ── 3. 语气覆盖（neglect 覆盖想念档）─────────────────────────────────────────
const es = { dependency: 90, mood: 'neutral' };   // dep 高 → 想念档本会是 level 4「你怎么才来」
const hUneasy = buildEmotionPromptHint(es, { neglectStage: 'uneasy',       missingLevel: 4 });
const hDisap  = buildEmotionPromptHint(es, { neglectStage: 'disappointed', missingLevel: 4 });
const hWith   = buildEmotionPromptHint(es, { neglectStage: 'withdrawn',    missingLevel: 4 });
const hLong   = buildEmotionPromptHint(es, { neglectStage: 'long_gone',    missingLevel: 4 });
const hDorm   = buildEmotionPromptHint(es, { neglectStage: 'dormant',      missingLevel: 4 });
const hNone   = buildEmotionPromptHint(es, { neglectStage: 'none',         missingLevel: 4 });

check('uneasy 走试探语气，且覆盖掉「你怎么才来」',
  hUneasy.includes('是不是把我忘了') && !hUneasy.includes('你怎么才来'));
check('disappointed 走失望语气 + 收着指令',
  hDisap.includes('失望') && hDisap.includes('收着'));
check('withdrawn 走冷淡抽离语气',
  hWith.includes('冷淡抽离'));
check('none 仍走原想念档热切语气',
  hNone.includes('你怎么才来') && !hNone.includes('冷淡抽离'));
check('long_gone 走"淡了"语气 + 久别淡然指令，覆盖热切想念',
  hLong.includes('淡了') && hLong.includes('久别淡然') && !hLong.includes('你怎么才来'));
check('dormant 走"放下"语气 + 久别淡然指令',
  hDorm.includes('放下') && hDorm.includes('久别淡然') && !hDorm.includes('你怎么才来'));

// ── 4. 久别重逢修复弧（P0）────────────────────────────────────────────────
check('none/missing 不触发重逢', buildReunionHint('none','secure')==='' && buildReunionHint('missing','anxious')==='');
check('secure 重逢=坦诚大方',    buildReunionHint('disappointed','secure').includes('坦诚大方'));
check('anxious 重逢=又惊又委屈',  buildReunionHint('disappointed','anxious').includes('又惊又委屈'));
check('avoidant 重逢=端着晾他',   buildReunionHint('disappointed','avoidant').includes('端着'));
check('重逢含修复标记+gap措辞',   buildReunionHint('withdrawn','secure').includes('修复时刻') && buildReunionHint('withdrawn','secure').includes('很久很久'));
// 长尾重逢：不再是"修复时刻"的扑回去/失望，而是"时隔多日"的平静疏离
check('long_gone 走"时隔多日" + gap=一个多礼拜，且非修复时刻',
  buildReunionHint('long_gone','secure').includes('时隔多日') &&
  buildReunionHint('long_gone','secure').includes('一个多礼拜') &&
  !buildReunionHint('long_gone','secure').includes('修复时刻'));
check('dormant gap=快两个礼拜 + 几乎要重新认识 + 三风格都有文案',
  buildReunionHint('dormant','avoidant').includes('快两个礼拜') &&
  buildReunionHint('dormant','secure').includes('几乎要重新认识') &&
  buildReunionHint('dormant','anxious').length > 0);

console.log(`\nneglect_stage_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
