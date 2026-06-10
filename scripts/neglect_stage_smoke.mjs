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
// v1.21 收编：disappointed/withdrawn/long_gone/dormant 的冷落语气从这里删除，
// 由 relationship_arc 状态机（neglect 事件 → hurt/cold/withdrawing）统一输出。
// 这里只验证两件事：① 旧口不再输出冷落语气 ② 也绝不能掉回热切想念（倒退最致命）。
// arc 侧的等价表达由 conflict_arc_smoke 的 buildArcToneDirective 断言覆盖。
for (const [name, h] of [['disappointed', hDisap], ['withdrawn', hWith], ['long_gone', hLong], ['dormant', hDorm]]) {
  check(`${name} 旧口已收编：不再输出冷落语气，也不掉回热切想念`,
    !h.includes('失望') && !h.includes('冷淡抽离') && !h.includes('久别淡然') && !h.includes('你怎么才来'));
}
check('none 仍走原想念档热切语气',
  hNone.includes('你怎么才来') && !hNone.includes('冷淡抽离'));
// arc 等价复现验证：冷落语气在新口（buildArcToneDirective）输出
{
  const { buildArcToneDirective } = await import('../src/relationship_arc.mjs');
  const cold = buildArcToneDirective('cold', { category: 'distance' });
  const wd = buildArcToneDirective('withdrawing', { category: 'distance' });
  check('arc 新口：cold(distance) 含"失望盖过想念"的凉', cold.includes('失望') && cold.includes('短回'));
  check('arc 新口：withdrawing 含抽离自保语气', wd.includes('抽离自保') && wd.includes('极短'));
}

// ── 4. 久别重逢弧 —— 前 7 天按天细分 + 后段 long_gone/dormant 2 档 ──────────────
check('none/missing 不触发重逢', buildReunionHint('none','secure')==='' && buildReunionHint('missing','anxious')==='');
// 前 7 天：每天 gap 措辞不同（传精确 last_user_reply_at）
check('day1 重逢 gap=一天没见',     buildReunionHint('uneasy','secure', hoursAgo(30)).includes('一天没见'));
check('day3 重逢 gap=三天没理你了', buildReunionHint('disappointed','secure', hoursAgo(75)).includes('三天没理你了'));
check('day5 重逢 gap=五天没动静了', buildReunionHint('withdrawn','secure', hoursAgo(125)).includes('五天没动静了'));
check('day6 重逢 gap=快一个礼拜没见了', buildReunionHint('withdrawn','secure', hoursAgo(155)).includes('快一个礼拜没见了'));
check('天数不同→措辞不同（3天≠5天）',
  buildReunionHint('disappointed','secure', hoursAgo(75)) !== buildReunionHint('withdrawn','secure', hoursAgo(125)));
// 前 7 天风格调制 + 修复时刻标记
check('secure 重逢=坦诚大方',  buildReunionHint('disappointed','secure',  hoursAgo(75)).includes('坦诚大方'));
check('anxious 重逢=又想又怕', buildReunionHint('disappointed','anxious', hoursAgo(75)).includes('又想又怕'));
check('avoidant 重逢=端着晾他', buildReunionHint('disappointed','avoidant', hoursAgo(75)).includes('端着'));
check('前 7 天含修复时刻标记',  buildReunionHint('disappointed','secure', hoursAgo(75)).includes('修复时刻'));
// 7-14 天长尾：平静疏离（"时隔多日"而非"修复时刻"扑回去）
check('long_gone(8天) 走时隔多日 + 一个多礼拜，非修复时刻',
  buildReunionHint('long_gone','secure', hoursAgo(200)).includes('时隔多日') &&
  buildReunionHint('long_gone','secure', hoursAgo(200)).includes('一个多礼拜') &&
  !buildReunionHint('long_gone','secure', hoursAgo(200)).includes('修复时刻'));
check('dormant(15天) gap=快两个礼拜 + 几乎要重新认识',
  buildReunionHint('dormant','avoidant', hoursAgo(360)).includes('快两个礼拜') &&
  buildReunionHint('dormant','secure', hoursAgo(360)).includes('几乎要重新认识'));
check('兜底：不传时间按 stage 仍可用', buildReunionHint('long_gone','secure').includes('一个多礼拜'));

console.log(`\nneglect_stage_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
