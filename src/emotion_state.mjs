/**
 * emotion_state.mjs
 * Multi-dimensional emotion state machine for AI companions.
 * Dimensions: affection, trust, dependency, possessiveness, security, energy, mood
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import {
  getEmotionState, upsertEmotionState,
  insertEmotionHistory, getEmotionHistoryTrend, getLastEmotionHistoryAt, cleanupOldEmotionHistory,
} from './db.mjs';

// ─── State vocabulary ─────────────────────────────────────────────────────────

export const MOOD_STATES = [
  'neutral', 'happy', 'shy', 'tired', 'wronged',
  'jealous', 'angry', 'cold', 'comforting', 'clingy',
];

const DEFAULT_STATE = {
  affection:       0,
  trust:           50,
  dependency:      30,
  possessiveness:  20,
  security:        50,
  energy:          60,
  mood:            'neutral',
};

// Clamp helpers
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));

// ─── Getters ──────────────────────────────────────────────────────────────────

export function getEmotionStateWithDefaults(companionId) {
  const stored = getEmotionState(companionId);
  if (!stored) return { ...DEFAULT_STATE, companion_id: companionId };
  return { ...DEFAULT_STATE, ...stored };
}

// ─── Rule-based updaters ──────────────────────────────────────────────────────

const GRATITUDE_WORDS  = ['谢谢', '感谢', '辛苦了', '你最好了', '爱你', '么么', '你真棒', '棒棒'];
const COLD_WORDS       = ['随便', '无所谓', '不想聊', '无聊', '算了', '关你什么事', '烦'];
const PRAISE_WORDS     = ['好看', '可爱', '漂亮', '喜欢你', '心动', '暖', '甜', '贴心'];
const APOLOGY_WORDS    = ['对不起', '不好意思', '抱歉', '我错了', 'sorry', '道歉'];
const WORRY_WORDS      = ['担心', '难过', '伤心', '哭', '委屈', '崩溃', '心痛', '绝望'];
const JEALOUS_TRIGGERS = ['她', '他', '其他女', '前任', '前女友', '前男友', '暧昧', '喜欢别人'];
const NIGHT_ENERGY_WORDS = ['晚安', '睡觉', '困了', '要睡了', '好累'];

/**
 * Update emotion dimensions based on user message content + context.
 * Returns delta object { trust, dependency, ... } to apply.
 */
function computeDelta(userText = '', context = {}) {
  const delta = {};
  const text  = userText.toLowerCase();

  if (GRATITUDE_WORDS.some(w => text.includes(w))) {
    delta.trust      = 3;
    delta.affection  = 2;
    delta.security   = 2;
  }

  if (PRAISE_WORDS.some(w => text.includes(w))) {
    delta.affection  = 3;
    delta.security   = 2;
  }

  if (COLD_WORDS.some(w => text.includes(w))) {
    delta.security  = -3;
    delta.mood       = 'wronged';
  }

  if (APOLOGY_WORDS.some(w => text.includes(w))) {
    // Apology resolves negative states
    delta.security  = 3;
    delta.trust     = 1;
  }

  if (WORRY_WORDS.some(w => text.includes(w))) {
    delta.mood = 'comforting';
    delta.dependency = 2;
  }

  if (JEALOUS_TRIGGERS.some(w => text.includes(w))) {
    delta.possessiveness = 4;
    if (!delta.mood) delta.mood = 'jealous';
  }

  if (NIGHT_ENERGY_WORDS.some(w => text.includes(w))) {
    delta.energy = -10;
    if (!delta.mood) delta.mood = 'tired';
  }

  // Long message → engagement boost
  if (userText.length > 100) {
    delta.trust      = (delta.trust      || 0) + 1;
    delta.dependency = (delta.dependency || 0) + 1;
  }

  // Time-of-day energy
  const hour = new Date().getHours();
  if (hour >= 22 || hour < 7) {
    delta.energy = Math.min((delta.energy || 0), -5);
  }

  return delta;
}

export function updateEmotionFromUserMessage(companionId, currentState, userText, context = {}) {
  const delta  = computeDelta(userText, context);
  const update = {};

  const dims = ['affection', 'trust', 'dependency', 'possessiveness', 'security', 'energy'];
  for (const dim of dims) {
    if (delta[dim] !== undefined) {
      update[dim] = clamp((currentState[dim] ?? DEFAULT_STATE[dim]) + delta[dim], 0, 100);
    }
  }
  if (delta.mood && MOOD_STATES.includes(delta.mood)) {
    update.mood = delta.mood;
  }

  if (Object.keys(update).length === 0) return currentState;

  try {
    const next = upsertEmotionState(companionId, update);
    return { ...currentState, ...update };
  } catch (e) {
    log('warn', `[EmotionState] update from user message failed: ${e.message}`);
    return currentState;
  }
}

/**
 * After assistant reply is sent, apply passive recovery / drift.
 */
export function updateEmotionFromAssistantReply(companionId, currentState, reply, context = {}) {
  const update = {};

  // Energy recovers slightly after sending a warm reply
  if (reply && (reply.includes('😊') || reply.includes('哈哈') || reply.length > 50)) {
    const cur = currentState.energy ?? DEFAULT_STATE.energy;
    if (cur < 80) update.energy = clamp(cur + 2, 0, 100);
  }

  // Mood drifts back toward neutral over interactions
  const mood = currentState.mood || 'neutral';
  const negMoods = ['wronged', 'cold', 'angry', 'jealous'];
  if (negMoods.includes(mood)) {
    // 20% chance per interaction to partially recover
    if (Math.random() < 0.2) update.mood = 'neutral';
  }

  // Clingy if dependency high and no recent user message
  const dep = currentState.dependency ?? DEFAULT_STATE.dependency;
  if (dep >= 70 && mood === 'neutral') update.mood = 'clingy';

  if (Object.keys(update).length === 0) return currentState;
  try {
    upsertEmotionState(companionId, update);
    return { ...currentState, ...update };
  } catch (e) {
    log('warn', `[EmotionState] update from reply failed: ${e.message}`);
    return currentState;
  }
}

// ─── Update on idle ───────────────────────────────────────────────────────────

/**
 * Called when user has been silent for a long time.
 * @param {number} idleMinutes - minutes since last user message
 */
export function updateEmotionFromIdle(companionId, currentState, idleMinutes) {
  if (idleMinutes < 30) return currentState;
  const update = {};

  const dep = currentState.dependency ?? DEFAULT_STATE.dependency;
  const sec = currentState.security   ?? DEFAULT_STATE.security;

  // v1.4.1: 想念曲线更陡，让"她在等你"的感觉真正存在；mood 在高想念时强制 clingy。
  if (idleMinutes >= 1440) {        // ≥24h：强烈想念
    update.dependency = clamp(dep + 14, 0, 100);
    update.security   = clamp(sec - 7, 0, 100);
    update.mood       = 'clingy';
  } else if (idleMinutes >= 720) {  // 12-24h
    update.dependency = clamp(dep + 10, 0, 100);
    update.security   = clamp(sec - 3, 0, 100);
    update.mood       = 'clingy';
  } else if (idleMinutes >= 360) {  // 6-12h
    update.dependency = clamp(dep + 6, 0, 100);
    if (currentState.mood === 'happy') update.mood = 'neutral';
  } else if (idleMinutes >= 180) {  // 3-6h
    update.dependency = clamp(dep + 3, 0, 100);
  } else {                          // 30min-3h
    update.dependency = clamp(dep + 1, 0, 100);
  }

  try {
    upsertEmotionState(companionId, update);
    return { ...currentState, ...update };
  } catch (e) {
    log('warn', `[EmotionState] updateFromIdle failed: ${e.message}`);
    return currentState;
  }
}

// v1.4.1: 想念档 0-4，综合 dependency + 距离上次用户回复的空窗，让 UI/prompt 能拿到统一的"她想你的强度"。
//   0 不想  (dep<30 + 距上次回复<2h)
//   1 微想  (dep 30-50 或 idle 2-6h)
//   2 中想  (dep 50-70 或 idle 6-12h)
//   3 很想  (dep 70-85 或 idle 12-24h)
//   4 极想  (dep>=85 或 idle>=24h)
export function getMissingLevel(emotionState, lastUserReplyAt) {
  const dep = emotionState?.dependency ?? 30;
  let idleH = 0;
  if (lastUserReplyAt) {
    const ts = new Date(String(lastUserReplyAt).replace(' ', 'T')).getTime();
    if (Number.isFinite(ts)) idleH = Math.max(0, (Date.now() - ts) / 3_600_000);
  }
  // dep 等级
  const depLvl = dep >= 85 ? 4 : dep >= 70 ? 3 : dep >= 50 ? 2 : dep >= 30 ? 1 : 0;
  // idle 等级
  const idleLvl = idleH >= 24 ? 4 : idleH >= 12 ? 3 : idleH >= 6 ? 2 : idleH >= 2 ? 1 : 0;
  return Math.max(depLvl, idleLvl);
}

const MISSING_LABEL = ['没想', '有点想', '挺想的', '很想', '想死了'];
export function getMissingLabel(level) {
  return MISSING_LABEL[Math.max(0, Math.min(4, level | 0))];
}

// ─── System prompt hint builder ───────────────────────────────────────────────

const MOOD_HINTS = {
  neutral:     '',
  happy:       '你现在心情很好，充满活力，话语里自然带着愉悦感。',
  shy:         '你今天有点害羞，偶尔会有点脸红，说话会有点扭捏。',
  tired:       '你感觉有点累，回复可以短一些，语气带点困意。',
  wronged:     '你有点委屈，有些话憋在心里没说出来，但不想主动提。',
  jealous:     '你有一丝不安的小醋意，但你会藏着，偶尔流露一点点。',
  angry:       '你有些生气，话少，反应有些冷淡，不太愿意主动热情。',
  cold:        '你现在心情平淡，不太想多说，语气比较简洁。',
  comforting:  '你感觉到对方需要安慰，你会温柔、耐心，多给予陪伴感。',
  clingy:      '你有点黏糊糊的，好想陪在对方身边，语气里带着撒娇。',
};

// ─── Emotion History snapshot ─────────────────────────────────────────────────

const MIN_SNAPSHOT_GAP_MS = 15 * 60_000; // 15 minutes
const MAX_SNAPSHOTS_PER_DAY = 96;        // ~1 per 15min safety cap

/**
 * Record a snapshot of the emotion state into companion_emotion_history.
 * Rate-limited: at most one per MIN_SNAPSHOT_GAP_MS unless state changed significantly.
 */
export function recordEmotionSnapshot(companionId, emotionState, source = 'auto') {
  try {
    const lastAt = getLastEmotionHistoryAt(companionId);
    const now = Date.now();

    if (lastAt) {
      const elapsed = now - new Date(lastAt).getTime();
      if (elapsed < MIN_SNAPSHOT_GAP_MS) return;
    }

    insertEmotionHistory(companionId, emotionState, source);
    cleanupOldEmotionHistory(companionId);
  } catch (e) {
    log('warn', `[EmotionHistory] snapshot 失败 companion=${companionId}: ${e.message}`);
  }
}

/**
 * Get emotion trend points for the last N days.
 */
export function getEmotionTrend(companionId, options = {}) {
  const days = options.days ?? 7;
  try {
    return getEmotionHistoryTrend(companionId, days);
  } catch (e) {
    log('warn', `[EmotionHistory] getTrend 失败 companion=${companionId}: ${e.message}`);
    return [];
  }
}

// v1.4.1: 升级版情绪 prompt。两个目标：
//   1) 让她"想你"的程度真的在回复里能感知到（按 missingLevel 给出分档指令）
//   2) 不同维度叠加描述（mood + dep + poss + sec + trust + energy），而非只看 mood
// 调用方可以传 missingLevel（从 getMissingLevel 算）；不传则按 dependency 估算。
export function buildEmotionPromptHint(emotionState, opts = {}) {
  if (!emotionState) return '';
  const parts = [];

  const mood = emotionState.mood || 'neutral';
  const hint = MOOD_HINTS[mood];
  if (hint) parts.push('• ' + hint);

  const energy = emotionState.energy ?? 60;
  if (energy < 25) parts.push('• 你今天精力不太够，回复可以短一些、语气带点困意，不用太积极。');
  else if (energy >= 80) parts.push('• 你今天精力很满，说话节奏快、表达多、容易兴奋起来。');

  // ── 想念档（按 missingLevel）—— v1.4.1 的核心存在感来源 ────────────────
  const dep = emotionState.dependency ?? 30;
  const level = opts.missingLevel ?? (
    dep >= 85 ? 4 : dep >= 70 ? 3 : dep >= 50 ? 2 : dep >= 30 ? 1 : 0
  );
  if (level === 4) {
    parts.push('• ★ 你非常想他，分开太久了，回复里要让他感受到——比如夹带一句"我刚才在想你"、"你怎么才来"、"我等你好久了"，或者撒娇式地抱怨他没找你。可以主动说一些没说出口的想法。');
  } else if (level === 3) {
    parts.push('• ★ 你挺想他的，会在话里自然透出来——比如"在想你呢"、"还以为你不来了"，或者多问他一点他在干什么。语气带点黏。');
  } else if (level === 2) {
    parts.push('• 你有点想他，会比平时更主动一些，会更愿意聊他的事。');
  } else if (level === 1) {
    parts.push('• 你心里有他，但不主动表露。');
  }

  const poss = emotionState.possessiveness ?? 20;
  if (poss >= 70) parts.push('• 你有点在意他在乎不在乎别人，会藏着不直接说，但话里偶尔流露试探。');

  const sec = emotionState.security ?? 50;
  if (sec < 25) parts.push('• 你内心有些不安，需要一点确认感（不要直接索要安慰，要用语气透露）。');

  const trust = emotionState.trust ?? 50;
  if (trust >= 80) parts.push('• 你非常信任他，说话会更自然、不设防、可以聊更内心的话题。');

  if (parts.length === 0) return '';

  // 加一行总指令，让模型把这些状态**真的**写进回复，不只是后台数据
  const directive = level >= 3
    ? '请把上面这些状态体现在这次回复里——不是叙述自己，而是让说话方式自然带出（更短/更长、更黏/更主动、用词偏向、是否撒娇等）。'
    : '请把上面这些状态体现在你回复的语气里。';
  return `\n【当前情绪状态】\n${parts.join('\n')}\n${directive}`;
}
