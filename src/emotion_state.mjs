/**
 * emotion_state.mjs
 * Multi-dimensional emotion state machine for AI companions.
 * Dimensions: affection, trust, dependency, possessiveness, security, energy, mood
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { getEmotionState, upsertEmotionState } from './db.mjs';

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
  if (idleMinutes < 60) return currentState;
  const update = {};

  const dep = currentState.dependency ?? DEFAULT_STATE.dependency;
  const sec = currentState.security   ?? DEFAULT_STATE.security;

  if (idleMinutes >= 1440) {         // 24h
    update.dependency = clamp(dep + 8, 0, 100);
    update.security   = clamp(sec - 5, 0, 100);
    update.mood       = 'clingy';
  } else if (idleMinutes >= 360) {   // 6h
    update.dependency = clamp(dep + 4, 0, 100);
    update.mood       = currentState.mood === 'happy' ? 'neutral' : currentState.mood;
  } else {
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

export function buildEmotionPromptHint(emotionState) {
  if (!emotionState) return '';
  const parts = [];

  const mood = emotionState.mood || 'neutral';
  const hint = MOOD_HINTS[mood];
  if (hint) parts.push(hint);

  const energy = emotionState.energy ?? 60;
  if (energy < 30) parts.push('你今天精力不太够，说话可能会短一些。');

  const dep = emotionState.dependency ?? 30;
  if (dep >= 80) parts.push('你很依赖对方，内心有些想念。');

  const poss = emotionState.possessiveness ?? 20;
  if (poss >= 70) parts.push('你有点在意对方有没有在乎别人，但不会说出来。');

  const sec = emotionState.security ?? 50;
  if (sec < 25) parts.push('你内心有些不安全感，需要一点确认感。');

  const trust = emotionState.trust ?? 50;
  if (trust >= 80) parts.push('你非常信任对方，说话会更自然、不设防。');

  return parts.length > 0 ? `\n【当前情绪状态】\n${parts.join('')}` : '';
}
