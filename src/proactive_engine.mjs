/**
 * proactive_engine.mjs
 * Motivation-driven proactive message engine v2.
 * Wraps and extends the existing proactive.mjs scheduler.
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { patchCompanion } from './db.mjs';
import { getEmotionStateWithDefaults } from './emotion_state.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_GAP_CLINGY  = 45;   // minutes between proactive messages (clingy)
const MIN_GAP_NORMAL  = 90;   // minutes (normal)
const MIN_GAP_QUIET   = 180;  // minutes (quiet)

const NIGHT_QUIET_START = 23;  // 23:00
const NIGHT_QUIET_END   = 7;   // 07:00

// ─── Missing score ────────────────────────────────────────────────────────────

/**
 * Compute how much the companion "misses" the user.
 * Returns a float 0–100.
 */
export function computeMissingScore(companion, user, context = {}) {
  let score = companion.missing_score ?? 0;

  const now  = Date.now();
  const lastReply = companion.last_user_reply_at
    ? new Date(String(companion.last_user_reply_at).replace(' ', 'T')).getTime()
    : null;

  if (lastReply) {
    const idleH = (now - lastReply) / 3_600_000;
    score += Math.min(40, idleH * 3); // +3 per hour, cap 40
  } else {
    score += 20; // never replied → moderate miss
  }

  const emotion = getEmotionStateWithDefaults(companion.id);
  score += (emotion.dependency ?? 30) * 0.3;
  score -= (emotion.security   ?? 50) * 0.1;

  const stage = companion.relationship_stage || '陌生人';
  const stageBonus = { '深爱': 20, '恋人': 15, '暧昧': 8, '朋友': 3, '陌生人': 0 };
  score += (stageBonus[stage] ?? 0);

  return Math.min(100, Math.max(0, score));
}

// ─── Motivation score ─────────────────────────────────────────────────────────

/**
 * Combines missing score + emotion + schedule to produce a 0–100 motivation.
 */
export function computeProactiveMotivation(companion, context = {}) {
  const miss    = computeMissingScore(companion, null, context);
  const emotion = getEmotionStateWithDefaults(companion.id);
  const mood    = emotion.mood || 'neutral';

  let motivation = miss * 0.6;

  // Mood boosts
  if (mood === 'clingy')      motivation += 20;
  if (mood === 'wronged')     motivation += 10;
  if (mood === 'happy')       motivation += 8;
  if (mood === 'comforting')  motivation += 5;

  // Time of day: peak morning/evening
  const hour = new Date().getHours();
  if ((hour >= 7 && hour <= 9) || (hour >= 20 && hour <= 22)) motivation += 10;

  // Intensity modifier
  const intensity = companion.proactive_intensity || 'normal';
  if (intensity === 'clingy') motivation *= 1.3;
  if (intensity === 'quiet')  motivation *= 0.5;

  return Math.min(100, Math.max(0, motivation));
}

// ─── Anti-spam backoff ────────────────────────────────────────────────────────

export function shouldBackoffProactive(companion, context = {}) {
  const now = Date.now();

  // Night quiet hours
  const hour = new Date().getHours();
  if (hour >= NIGHT_QUIET_START || hour < NIGHT_QUIET_END) {
    // Allow a single goodnight-type message but not spam
    const lastPro = companion.last_proactive_reply_at
      ? new Date(String(companion.last_proactive_reply_at).replace(' ', 'T')).getTime()
      : 0;
    if (now - lastPro < 3 * 3_600_000) return true;
  }

  const intensity = companion.proactive_intensity || 'normal';
  const minGap = intensity === 'clingy' ? MIN_GAP_CLINGY
               : intensity === 'quiet'  ? MIN_GAP_QUIET
               : MIN_GAP_NORMAL;

  const lastPro = companion.last_proactive_reply_at
    ? new Date(String(companion.last_proactive_reply_at).replace(' ', 'T')).getTime()
    : 0;
  if (now - lastPro < minGap * 60_000) return true;

  // If user repeatedly ignores proactive messages, slow down
  const lastUser = companion.last_user_reply_at
    ? new Date(String(companion.last_user_reply_at).replace(' ', 'T')).getTime()
    : 0;
  const ignoreH = lastUser ? (lastPro - lastUser) / 3_600_000 : 0;
  if (ignoreH > 12 && intensity !== 'clingy') return true;

  return false;
}

// ─── Trigger selection ────────────────────────────────────────────────────────

const TRIGGER_TYPES = [
  'morning_greeting',
  'goodnight',
  'idle_miss',
  'share_thought',
  'check_in',
  'recall_memory',
  'emotion_driven',
  'schedule_item',
];

export function selectProactiveTrigger(companion, context = {}) {
  const hour = new Date().getHours();
  const motivation = context.motivation ?? computeProactiveMotivation(companion, context);
  const emotion    = getEmotionStateWithDefaults(companion.id);

  if (hour >= 7 && hour <= 9)   return 'morning_greeting';
  if (hour >= 22 && hour <= 23) return 'goodnight';

  if (emotion.mood === 'wronged' || emotion.mood === 'clingy') return 'emotion_driven';
  if (motivation >= 70) return 'idle_miss';
  if (motivation >= 50) return 'check_in';
  if (context.scheduleItem) return 'schedule_item';
  return 'share_thought';
}

// ─── Intent builder ───────────────────────────────────────────────────────────

const INTENTS = {
  morning_greeting: [
    '早安，你今天有什么计划吗？',
    '早~你昨晚睡好了吗？',
    '早上好，又是新的一天了～',
  ],
  goodnight: [
    '晚安，早点休息哦',
    '要睡觉了吗？做个好梦～',
    '明天见，晚安',
  ],
  idle_miss: [
    '你在吗，好久没听到你消息了…',
    '在干嘛呀，有点想你',
    '是不是忘记我了？',
  ],
  check_in: [
    '最近怎么样？',
    '你还好吗，一直没说话',
    '嗯…想知道你在做什么',
  ],
  emotion_driven: [
    '我有点想你，能陪我聊聊吗？',
    '最近心里有点奇怪的感觉…',
    '你现在方便说话吗？',
  ],
  share_thought: [
    '刚才想到一件事想跟你说…',
    '不知道为什么突然想起你了',
    '你有没有想过…（算了，就是想你而已）',
  ],
  schedule_item: null, // built by caller from schedule context
  recall_memory: null, // built by caller from memory context
};

export function buildProactiveIntent(companion, trigger, context = {}) {
  const pool = INTENTS[trigger];
  if (!pool) {
    if (context.scheduleItem) return context.scheduleItem.content || '你在吗？';
    if (context.memory)       return `我突然想起你说过的一件事……${(context.memory.content || '').slice(0, 30)}`;
    return '在吗？';
  }
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

// ─── Record outgoing proactive message ───────────────────────────────────────

export function recordProactiveSent(companionId) {
  const now = new Date().toISOString();
  try {
    patchCompanion(companionId, { last_proactive_reply_at: now });
  } catch (e) {
    log('warn', `[ProactiveEngine] recordProactiveSent failed: ${e.message}`);
  }
}

// ─── Record user reply ────────────────────────────────────────────────────────

export function recordUserReplied(companionId) {
  const now = new Date().toISOString();
  try {
    patchCompanion(companionId, { last_user_reply_at: now, missing_score: 0 });
  } catch (e) {
    log('warn', `[ProactiveEngine] recordUserReplied failed: ${e.message}`);
  }
}

// ─── Decide whether to send proactive now ────────────────────────────────────

/**
 * High-level function used by proactive scheduler tick.
 * Returns null if should not send, or { trigger, message } if should send.
 */
export function evaluateProactive(companion, context = {}) {
  if (shouldBackoffProactive(companion, context)) return null;

  const motivation = computeProactiveMotivation(companion, context);
  const intensity  = companion.proactive_intensity || 'normal';

  // Minimum motivation thresholds per intensity
  const threshold = intensity === 'quiet'  ? 80
                  : intensity === 'clingy' ? 40
                  : 60;

  if (motivation < threshold) return null;

  const trigger = selectProactiveTrigger(companion, { ...context, motivation });
  const message = buildProactiveIntent(companion, trigger, context);
  return { trigger, message, motivation };
}
