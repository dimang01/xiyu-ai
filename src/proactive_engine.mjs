/**
 * proactive_engine.mjs
 * Motivation-driven proactive message engine v2.
 * Wraps and extends the existing proactive.mjs scheduler.
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { patchCompanion, getDailySchedule, shanghaiDateKey } from './db.mjs';
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

// ─── Motivation score (v1.6 三驱动) ──────────────────────────────────────
// motivation = base_time_score × emotion_multiplier × schedule_multiplier × random_jitter
//   - base_time_score: 0-80，纯时段（早晚高峰最高，午饭/凌晨最低）
//   - emotion_multiplier: 0.2-2.5，由 7 维情绪合成（clingy/dep/sec/poss/mood）
//   - schedule_multiplier: 0.3-1.5，基于今日日程当前活动（在忙/在闲）
//   - random_jitter: 0.8-1.2 真人不机械
// 用户原话："加 7 维情绪驱动和日程驱动以及随机时间驱动"——三驱动 = emotion + schedule + time/jitter

/** 0-80：单纯时段基线，模拟真人"什么时候有空发消息" */
export function computeTimeBaseScore(now = new Date()) {
  const h = now.getHours();
  if (h >= 23 || h < 7)   return 5;    // 凌晨/深夜：基本不打扰
  if (h >= 7  && h < 9)   return 70;   // 早安高峰
  if (h >= 9  && h < 11)  return 40;
  if (h >= 11 && h < 13)  return 30;   // 午饭忙
  if (h >= 13 && h < 17)  return 50;
  if (h >= 17 && h < 19)  return 60;   // 傍晚下班/放学
  if (h >= 19 && h < 22)  return 70;   // 晚间高峰
  return 50;                            // 22-23
}

/** 0.2-2.5：基于 7 维情绪 + mood 的乘数 */
export function computeEmotionMultiplier(emotion) {
  const mood = emotion?.mood || 'neutral';
  const dep  = emotion?.dependency ?? 30;
  const sec  = emotion?.security   ?? 50;
  const poss = emotion?.possessiveness ?? 20;
  // 各 mood 的基础倍率
  const moodMul = mood === 'clingy'    ? 1.6
               : mood === 'wronged'    ? 1.3
               : mood === 'jealous'    ? 1.4
               : mood === 'comforting' ? 1.2
               : mood === 'happy'      ? 1.1
               : mood === 'cold'       ? 0.5
               : mood === 'angry'      ? 0.6
               : mood === 'tired'      ? 0.7
               : 1.0;
  // dependency 高 → 想发；低 → 不想
  const depMul = 0.5 + (dep / 100) * 1.5;            // dep=0 → 0.5, dep=100 → 2.0
  // security 低 → 更主动找（想确认）；高 → 不焦虑
  const secMul = 1.4 - (sec / 100) * 0.7;            // sec=0 → 1.4, sec=100 → 0.7
  // possessiveness 高 → 多 +0.2
  const possBonus = poss >= 60 ? 1.2 : poss >= 40 ? 1.1 : 1.0;
  const raw = moodMul * depMul * secMul * possBonus;
  return Math.min(2.5, Math.max(0.2, raw));
}

/** 0.3-1.5：基于今日日程当前活动 */
export function computeScheduleMultiplier(companionId, now = new Date()) {
  try {
    const sched = getDailySchedule(companionId, shanghaiDateKey(now));
    if (!sched || !Array.isArray(sched.items)) return 1.0;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    // 找当前正在进行的活动（time <= now，取最近一个）
    let curItem = null;
    for (const it of sched.items) {
      const m = String(it.time || '').match(/^(\d{1,2}):(\d{2})$/);
      if (!m) continue;
      const itMin = Number(m[1]) * 60 + Number(m[2]);
      if (itMin <= nowMin && (!curItem || itMin > curItem._min)) {
        curItem = { ...it, _min: itMin };
      }
    }
    if (!curItem) return 1.0;
    const act = String(curItem.activity || '');
    // 在忙：上课/开会/上班/工作/写代码/做饭/睡觉/考试/面试 → 0.3
    if (/上课|开会|上班|工作|写代码|做饭|睡觉|考试|面试|健身|跑步|加班/.test(act)) return 0.3;
    // 半忙：吃饭/通勤/购物/去/路上 → 0.6
    if (/吃饭|吃午|吃晚|早餐|午餐|晚餐|通勤|购物|路上|去[^里]/.test(act)) return 0.6;
    // 闲：休息/刷手机/看剧/发呆/咖啡/听歌/逛 → 1.4
    if (/休息|刷手机|看剧|发呆|咖啡|听歌|逛|放空|阳台|窗边/.test(act)) return 1.4;
    // 默认中等
    return 1.0;
  } catch {
    return 1.0;
  }
}

/**
 * Combines time + emotion + schedule + jitter to produce a 0–100 motivation.
 * v1.6: 三驱动 multiplier 重构（旧版是加法 score，新版乘法 multiplier 表达力更强）
 */
export function computeProactiveMotivation(companion, context = {}) {
  const now = context.now || new Date();
  const emotion = getEmotionStateWithDefaults(companion.id);

  const base    = computeTimeBaseScore(now);
  const emoMul  = computeEmotionMultiplier(emotion);
  const schMul  = computeScheduleMultiplier(companion.id, now);
  const jitter  = 0.8 + Math.random() * 0.4;

  let motivation = base * emoMul * schMul * jitter;

  // intensity 整体调节（用户拖动 quiet/normal/clingy 强度）
  const intensity = companion.proactive_intensity || 'normal';
  if (intensity === 'clingy') motivation *= 1.3;
  if (intensity === 'quiet')  motivation *= 0.4;

  // 想念 score 作为最后微调（保留向后兼容；不再主导）
  if (context.includeMissingScore !== false) {
    const miss = computeMissingScore(companion, null, context);
    motivation += miss * 0.1;
  }

  return Math.min(100, Math.max(0, motivation));
}

/** 调试用：返回 motivation 的全部因子拆解 */
export function debugMotivationFactors(companion, context = {}) {
  const now = context.now || new Date();
  const emotion = getEmotionStateWithDefaults(companion.id);
  return {
    base_time: computeTimeBaseScore(now),
    emotion_multiplier: computeEmotionMultiplier(emotion),
    schedule_multiplier: computeScheduleMultiplier(companion.id, now),
    final: computeProactiveMotivation(companion, context),
    emotion_snapshot: { mood: emotion.mood, dep: emotion.dependency, sec: emotion.security, poss: emotion.possessiveness },
    hour: now.getHours(),
  };
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

  // v1.14: 被冷落退场 —— 不再一刀切「12h 没回就停」，按依恋风格分级（配合 neglect 阶段语气）。
  //   anxious  : 越冷落越想找，不退场（仅 minGap 防刷屏）
  //   secure   : 36h 内照常找 → 36-72h 渐进减频 → >72h 基本停（她也凉了）
  //   avoidant : 24h 后就收手自保（早抽离）
  // clingy intensity 滑块仍可强制不退场。
  const lastUser = companion.last_user_reply_at
    ? new Date(String(companion.last_user_reply_at).replace(' ', 'T')).getTime()
    : 0;
  const idleSinceUserH = lastUser ? (now - lastUser) / 3_600_000 : 0;
  const style = String(companion.attachment_style || 'secure').toLowerCase();
  if (intensity !== 'clingy') {
    // v1.16.x: 读空气——连发 N 条主动消息用户一条没回 → 闭嘴，等他先开口（防自说自话轰炸赶人）。
    const unansweredLimit = Number(process.env.PROACTIVE_UNANSWERED_LIMIT || 3);
    if ((companion.proactive_unanswered || 0) >= unansweredLimit) return true;
    if (style === 'anxious') {
      // v1.14.5 (P2-5) 焦虑型会追，但有尊严上限：追到 ~5 天没任何回应也收手，别滑向 needy/纠缠。
      if (idleSinceUserH > 120) return true;
    } else if (style === 'avoidant') {
      if (idleSinceUserH > 24) return true;                          // 回避型：早抽离自保
    } else {
      if (idleSinceUserH > 72) return true;                          // secure：>72h 基本停
      if (idleSinceUserH > 36 &&
          Math.random() < (idleSinceUserH - 36) / 48) return true;   // 36-72h 渐进减频
    }
  }

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

  // v1.6: 阈值放宽 + 中间值随机
  // 旧版固定阈值（normal=60）经常拒发。新版用"硬下限 + 软随机"：
  //   < 25: 拒
  //   25-50: 按 motivation/100 概率通过
  //   >= 50: 必过
  const hardFloor = intensity === 'quiet'  ? 50
                  : intensity === 'clingy' ? 15
                  : 25;
  if (motivation < hardFloor) return null;
  if (motivation < 50) {
    // 软通过：motivation 25-50 时按 motivation/100 概率随机
    if (Math.random() > motivation / 100) return null;
  }

  const trigger = selectProactiveTrigger(companion, { ...context, motivation });
  const message = buildProactiveIntent(companion, trigger, context);
  return { trigger, message, motivation };
}
