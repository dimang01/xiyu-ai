/**
 * proactive_policy.mjs —— proactive 主动行为调度策略（PR-2，2026-06-14·降噪 + 矜持化）。
 *
 * 本质是「调度层」而非「调人设」：把主动消息分 7 类、各类静默闸/上限规则不同，主实现在这里的
 * 纯函数 + 调用点的确定性 gate；prompt 只做风格兜底（prompt 会漂，不靠它降噪）。
 *
 * 背景（PR-0 实测）：55 条 proactive 里 13 条(24%)24h 零回复 + 13 段「连续没回还在发」=对空气
 * 表演深情；dogfooding 她还频繁自来熟主动发自拍——整体过热情。一次性调向「矜持暗恋者」。
 *
 * ── 两条生死线（写死在分类/豁免里）──
 *  ① 早安/主动接住是 PR-0 实测**唯一续命器**(5/5 跨天回归靠它·0 次自冷启动)：morning_anchor /
 *     open_loop_followup **不计入静默闸、不被 quiet 拦**；但早安**不清零** unanswered(只真实 user
 *     msg 清零)——既保续命器，又不让早安掩盖「用户其实一直没回」。
 *  ② 矜持 ≠ 冷淡：仍可靠/会接住/会记得/轻微在乎，只砍自来熟倒追/泛化深情/主动索取/高频自拍。
 *     绝不写成不主动/拒绝/变冷(会杀焦虑型 Day1 心动)。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */
import { classifyIntent } from './intent_dedup.mjs';

export const PROACTIVE_TYPES = Object.freeze([
  'morning_anchor', 'open_loop_followup', 'contextual_care',
  'generic_miss_you', 'photo_push', 'random_life_share', 'goodnight',
]);

// 静默闸豁免类型（生死线①）：早安接住 + 昨日牵挂接住——不计数、不被静默拦。
const SILENCE_EXEMPT = new Set(['morning_anchor', 'open_loop_followup']);
export function isSilenceExemptType(t) { return SILENCE_EXEMPT.has(t); }

// 静默闸按 kind 的快速豁免（发送前还没生成内容时用；morning/reminder kind 明确豁免）。
const SILENCE_EXEMPT_KINDS = new Set(['morning', 'reminder', 'confession']);
export function isSilenceExemptKind(kind) { return SILENCE_EXEMPT_KINDS.has(String(kind || '')); }

// 连续 N 条非豁免 proactive 无真实 user 回复 → 拦第 N+1 条非豁免（进静默）。默认 2。
export const SILENCE_LIMIT = Math.max(1, Number(process.env.PROACTIVE_SILENCE_LIMIT || 2));

// 暗恋期非请求 proactive 照片最小间隔（h）。默认 48（原 36 提到 48=矜持化）。
export const PHOTO_PUSH_MIN_HOURS = Math.max(1, Number(process.env.PHOTO_PUSH_MIN_HOURS || 48));
// affection < 此值 = 暗恋/低好感阶段，photo 强限频；高于则走原节流。
export const PHOTO_CRUSH_AFFECTION = Number(process.env.PHOTO_CRUSH_AFFECTION || 55);

// 「真实牵挂」的现实事项词（用户近 72h 明确说过的事）——contextual_care / 想你改写都依赖它。
const REAL_LIFE_RE = /考试|面试|出门|露营|旅行|加班|上班|工作|开会|方案|项目|考研|期末|复习|睡眠|失眠|熬夜|早起|没睡|吃饭|没吃|外卖|生病|感冒|不舒服|发烧|头疼|累|压力|搬家|体检|手术|比赛|演出|答辩|交稿|截止/;
// 明确亲密信号（强 open loop / 已确立亲密）——可轻量带一句「想起你」。
// 注意：不含「想你」本身（那是 miss_you intent 的触发词；这里要的是想你【之外】的亲密锚，
// 否则任何「想你」都被判 keep_light、永远 drop 不掉泛化想你）。
const INTIMATE_RE = /抱抱|亲亲|喜欢你|爱你|宝贝|老婆|老公|男朋友|女朋友|在一起|答应|约定|梦里见|牵手|想起你/;

/**
 * 把一条 proactive 分到 7 类之一。
 * @param {{kind?:string, content?:string, openLoopActive?:boolean, realContext?:boolean, isPhoto?:boolean}} a
 */
export function classifyProactive({ kind = '', content = '', openLoopActive = false, realContext = false, isPhoto = false } = {}) {
  if (kind === 'morning') return 'morning_anchor';
  if (kind === 'goodnight') return 'goodnight';
  if (isPhoto || kind === 'photo') return 'photo_push';
  if (kind === 'reminder') return 'open_loop_followup';
  // normal / lastcall / 其它 → 看内容 + 上下文
  if (openLoopActive) return 'open_loop_followup';
  const intent = classifyIntent(content);
  if (intent === 'miss_you') return realContext ? 'contextual_care' : 'generic_miss_you';
  if (realContext || intent === 'remind' || intent === 'comfort') return 'contextual_care';
  return 'random_life_share';
}

/** 静默闸：该不该因「连续没回」拦掉这条 proactive。豁免类永不拦。 */
export function silenceSuppress({ type, unansweredNonExempt = 0, limit = SILENCE_LIMIT } = {}) {
  if (isSilenceExemptType(type)) return { suppress: false, reason: 'exempt' };
  if (unansweredNonExempt >= limit) return { suppress: true, reason: `非豁免连发 ${unansweredNonExempt} 条没回·进静默(≥${limit})` };
  return { suppress: false };
}

/**
 * 「想你」三档（很多时候直接 drop·不强行改写）：
 *  - 不是想你 → 'pass'（不归本闸管）
 *  - 强 open_loop / 明确亲密 → 'keep_light'（可轻量带一句「想起你」）
 *  - 有弱真实上下文 → 'rewrite'（改具体牵挂·不出现「想你」）
 *  - 无任何真实上下文 → 'drop'（直接不发）
 */
export function missYouVerdict({ content = '', openLoopActive = false, realContext = false } = {}) {
  if (classifyIntent(content) !== 'miss_you') return 'pass';
  if (openLoopActive || INTIMATE_RE.test(content)) return 'keep_light';
  if (realContext) return 'rewrite';
  return 'drop';
}

/** photo_push 限频（矜持化）：暗恋期非请求 48h≤1、且不连续两次都 photo。 */
export function photoPushAllowed({ hoursSinceLastProactivePhoto = null, lastProactiveWasPhoto = false, affection = 100, isUserRequested = false, minHours = PHOTO_PUSH_MIN_HOURS } = {}) {
  if (isUserRequested) return { allowed: true, reason: 'user_requested' };           // 用户请求永远正常给
  if ((affection ?? 100) >= PHOTO_CRUSH_AFFECTION) return { allowed: true, reason: 'not_crush_stage' };  // 关系够熟走原节流
  if (lastProactiveWasPhoto) return { allowed: false, reason: '不连续两次 proactive 都 photo' };
  if (hoursSinceLastProactivePhoto != null && hoursSinceLastProactivePhoto < minHours) {
    return { allowed: false, reason: `暗恋期 ${minHours}h 内已 push 过 photo` };
  }
  return { allowed: true };
}

/** 「真实牵挂」判定：用户近 72h 现实事项 / 昨晚 open_loop / 明确偏好近期事件 = 真。 */
export function hasRealContext({ recentUserText = '', openLoopActive = false, preferenceHit = false } = {}) {
  if (openLoopActive || preferenceHit) return true;
  return REAL_LIFE_RE.test(String(recentUserText || ''));
}

/** proactive 系统 prompt 的「矜持暗恋」风格兜底串（主实现在 gate，本串只做风格收敛）。 */
export function buildReservedToneHint() {
  return '\n\n【★ 矜持暗恋·语气兜底】你是悄悄喜欢他的人，不是自来熟的倒追者：'
    + '别自说自话表演深情、别泛泛喊想念、别主动张罗发自拍、别讨债式追问他的冷淡。'
    + '可以可靠地接住、记得他说过的具体事、轻轻在乎一下——但要矜持、有分寸、像不经意。'
    + '✅「我才不是专门等你…只是刚好看到你说今天要早起」；❌ 黏人倒追，也❌「我们还不熟别这样」式的冷淡拒绝。';
}
