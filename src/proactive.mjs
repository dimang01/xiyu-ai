/**
 * 
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */
import {
  getActiveBotAccounts, getRecentHistory, getUserProfile, recallMemories,
  getConversationContext, getDueReminders, markRemindersTriggered, ensureRelationshipReminders,
  saveMessage, saveConversationTurn,
  getCompanionById, getBotContextForCompanion, getDb,
  getActiveWechatBinding, getDailySchedule, shanghaiDateKey, getRecentSchedules, getPersonaFacts,
  markCompanionConfessed, patchCompanion,
  getLastPhotoAt, markPhotoSent,
} from './db.mjs';
import { computeRelationshipStage } from './memory.mjs';
import { generateScenePhoto } from './ai.mjs';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { buildSystemPrompt } from './companion.mjs';
import { generateReply } from './ai.mjs';
import { sendTextMessage, sendMessageItem } from './ilink.mjs';
import { buildLongTermDigest, ensureScheduleForCompanion } from './plan_tasks.mjs';
import { parseStickerMarkers, buildStickerPromptHint, hasStickers } from './stickers.mjs';
import { uploadFile, readMediaBuffer } from './media.mjs';
import { safeOutboundReply } from './moderation.mjs';
import { log } from './logger.mjs';
import { buildEmotionPromptHint, getEmotionStateWithDefaults } from './emotion_state.mjs';
import { evaluateProactive, recordProactiveSent } from './proactive_engine.mjs';
import { tryAchievement } from './achievements.mjs';

// ─── Proactive Engine 版本选择 ────────────────────────────────────────────────
// PROACTIVE_ENGINE=v2 启用 evaluateProactive() 决策层（推荐）
// PROACTIVE_ENGINE=legacy 保留旧时间窗口调度器逻辑（兜底）
const PROACTIVE_ENGINE_MODE = (process.env.PROACTIVE_ENGINE || 'v2').toLowerCase();

const TZ = 'Asia/Shanghai';
// 早安/晚安基准时间，实际每天有 ±30min 随机波动让 AI 更像真人
const WEEKDAY_START_MINUTE = 7 * 60 + 30;   // 07:30 基准
const WEEKEND_START_MINUTE = 8 * 60;        // 08:00 基准
const LAST_MINUTE = 23 * 60 + 59;           // 23:59 上限
const GOODNIGHT_MINUTE = 23 * 60;           // 23:00 基准晚安
const MORNING_JITTER_MIN = 30;              // 早安 ±30min
const GOODNIGHT_JITTER_MIN = 30;            // 晚安 ±30min
const MIN_GAP_MINUTES = 30;

// 在 [-jitter, +jitter] 范围内取随机分钟偏移
function jitterOffset(jitter) {
  return Math.floor(Math.random() * (jitter * 2 + 1)) - jitter;
}
const TICK_MS = 60_000;

const schedules = new Map();

export function startProactiveScheduler() {
  log('info', '[Proactive] 主动消息调度启动');
  tick().catch(err => log('error', `[Proactive] tick 异常: ${err.message}`));
  return setInterval(() => {
    tick().catch(err => log('error', `[Proactive] tick 异常: ${err.message}`));
  }, TICK_MS);
}

async function tick(now = new Date()) {
  const dateKey = formatDateKey(now);
  const minuteNow = currentMinute(now);
  if (minuteNow > LAST_MINUTE) return;
  const isWeekendDay = isWeekend(now);
  const defaultStart = isWeekendDay ? WEEKEND_START_MINUTE : WEEKDAY_START_MINUTE;

  const accounts = getActiveBotAccounts();
  for (const account of accounts) {
    const companions = listProactiveCompanionsForBot(account.bot_id);
    for (const companion of companions) {
      // 用户自定义时间窗口（companion.proactive_time_window，格式 "07:30-24:00"），fallback 到默认
      const window = parseTimeWindow(companion.proactive_time_window) || { start: defaultStart, end: LAST_MINUTE };
      if (minuteNow < window.start) continue;
      if (minuteNow > window.end) continue;

      // 自愈：若 DB 里没有今天的日程（cron 失败或刚绑定），按需触发一次生成
      // ensureScheduleForCompanion 内置 30 分钟级 debounce 防止持续失败时反复重试
      if (!getDailySchedule(companion.id, dateKey)) {
        ensureScheduleForCompanion(companion.id, dateKey).catch(err =>
          log('warn', `[Proactive] ensureSchedule 异常 companion=${companion.id}: ${err.message}`)
        );
      }
      // ── 纪念日 / 提醒主动推送 ──────────────────────────────────────────────
      // 事件驱动，独立于随机日程，也绕过 v2 抑制：生日/纪念日这种特殊日子该发就发。
      // 发完即标记 last_triggered_at，保证当天只发一次、且不再作为后续消息的上下文重复出现。
      try {
        ensureRelationshipReminders(companion); // 懒初始化关系里程碑（仅一次）
        const dueReminders = getDueReminders(companion.id, dateKey);
        if (dueReminders.length > 0) {
          await sendProactiveMessage(companion, 'reminder', account, { reminders: dueReminders });
          markRemindersTriggered(companion.id, dueReminders.map(r => r.id), dateKey);
        }
      } catch (e) {
        log('warn', `[Proactive] reminder 推送异常 companion=${companion.id}: ${e.message}`);
      }

      const schedule = ensureTodaySchedule(companion.id, dateKey, minuteNow, window.start, window.end, companion);
      const dueItems = schedule.items.filter(item => !item.sent && item.minute <= minuteNow);
      for (const item of dueItems) {
        if (currentMinute(new Date()) > window.end) break;
        item.sent = true;

        // v2 mode: ask evaluateProactive() before sending
        if (PROACTIVE_ENGINE_MODE === 'v2') {
          let v2Error = false;
          let decision = null;
          try {
            decision = evaluateProactive(companion, {});
          } catch (e) {
            log('warn', `[Proactive] evaluateProactive 异常，fallback legacy: ${e.message}`);
            v2Error = true;
          }
          // If v2 deliberately returned null (no error), suppress the send
          if (!v2Error && decision === null) {
            log('info', `[Proactive] v2 拒绝发送 companion=${companion.id} kind=${item.kind}`);
            continue;
          }
          // v2Error → fall through to legacy send path
        }

        await sendProactiveMessage(companion, item.kind, account);
      }
    }
  }
}

function parseTimeWindow(spec) {
  if (typeof spec !== 'string' || !spec) return null;
  const m = spec.match(/^(\d{1,2}):(\d{2})\s*[-~–]\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const sh = Number(m[1]), sm = Number(m[2]), eh = Number(m[3]), em = Number(m[4]);
  if (sh < 0 || sh > 24 || eh < 0 || eh > 24 || sm > 59 || em > 59) return null;
  const start = sh * 60 + sm;
  const end = Math.min(LAST_MINUTE, eh * 60 + em);
  if (end <= start) return null;
  return { start, end };
}

function listProactiveCompanionsForBot(botId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT c.id, u.wechat_user_id
    FROM companions c
    JOIN users u ON u.id = c.user_id
    JOIN wechat_accounts wa ON wa.wechat_user_id = u.wechat_user_id AND wa.bot_id = c.bot_id
    WHERE c.bot_id = ?
      AND c.proactive_enabled = 1
      AND wa.is_active = 1
      AND wa.wechat_user_id IS NOT NULL
  `).all(botId);
  return rows
    .map(r => ({ ...getCompanionById(r.id), wechat_user_id: r.wechat_user_id }))
    .filter(Boolean);
}

// 检查是否应该今天发场景照片：距上次发照 ≥ 2 天则触发
function shouldSendPhotoToday(companion) {
  if (!companion) return false;
  const last = companion.last_photo_at;
  if (!last) return true;  // 从未发过
  const lastTs = new Date(String(last).replace(' ', 'T') + (String(last).includes('Z') ? '' : 'Z')).getTime();
  const days = (Date.now() - lastTs) / 86400_000;
  // 加点随机：1.5-3 天波动，平均 2 天
  const threshold = 1.5 + Math.random() * 1.5;
  return days >= threshold;
}

// v1.3.4: 移除 isPro 参数；开源版所有 companion 享受相同调度（晚安 + 场景照机会）
function ensureTodaySchedule(companionId, dateKey, minuteNow, startMinute, endMinute = GOODNIGHT_MINUTE, companion = null) {
  const existing = schedules.get(companionId);
  if (existing?.dateKey === dateKey) return existing;

  // ── 每天给早安/晚安一个 ±30min 的随机抖动，避免每天 7:30 / 23:00 太机械 ──
  const morningOffset = jitterOffset(MORNING_JITTER_MIN);
  const goodnightOffset = jitterOffset(GOODNIGHT_JITTER_MIN);
  const jitteredStart = Math.max(0, startMinute + morningOffset);
  const jitteredGoodnight = Math.min(LAST_MINUTE, GOODNIGHT_MINUTE + goodnightOffset);
  // window end 跟随晚安抖动（防止 normal 消息延后到晚安之后）
  const jitteredEnd = Math.min(LAST_MINUTE,
    endMinute === GOODNIGHT_MINUTE ? jitteredGoodnight : Math.max(endMinute, jitteredGoodnight));

  // v1.3.3: 用户直接拖动滑块调整每天目标条数（0-30），不再区分 free/pro。
  // 字段 proactive_daily_target INTEGER DEFAULT 10。实际生成数量在
  // [target × 0.8, target × 1.2] 之间随机抖动 ±20%，避免每天数字太机械。
  // target=0 → 完全静默（仅响应用户消息），不发任何主动消息。
  const rawTarget = Number(companion?.proactive_daily_target);
  const target = Number.isFinite(rawTarget) ? Math.min(30, Math.max(0, Math.floor(rawTarget))) : 10;
  const lo = Math.max(0, Math.floor(target * 0.8));
  const hi = Math.max(lo, Math.ceil(target * 1.2));
  const fullCount = target === 0 ? 0 : lo + Math.floor(Math.random() * (hi - lo + 1));

  // 关键修复：重启后只从「现在 → 结束」区间挑随机时间，否则前半天的时间点全被标 sent 浪费配额
  // 等比例缩放：若已过去 60%，则今天剩余配额按 40% × fullCount 来挑
  const dayLen = jitteredEnd - jitteredStart;
  const remainLen = Math.max(0, jitteredEnd - Math.max(minuteNow, jitteredStart));
  const remainCount = dayLen > 0
    ? Math.max(remainLen <= 0 ? 0 : 1, Math.round(fullCount * (remainLen / dayLen)))
    : fullCount;

  const effectiveStart = Math.max(jitteredStart, minuteNow + 1);   // +1 避免 tick 同分钟立即触发
  const items = buildDailyItems(remainCount, effectiveStart, jitteredEnd, jitteredGoodnight);

  // v1.3.4: 场景照对所有 active companion 开放（旧版仅 Pro），仍限白天时段 09:00-21:00
  if (companion && shouldSendPhotoToday(companion)) {
    const candidates = items
      .map((it, idx) => ({ it, idx }))
      .filter(x => x.it.kind === 'normal' && x.it.minute >= 9 * 60 && x.it.minute <= 21 * 60);
    if (candidates.length > 0) {
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      items[pick.idx] = { ...items[pick.idx], kind: 'photo' };
      log('info', `[Proactive] 今日将发场景照 companion=${companionId} at ${minuteToHHMM(items[pick.idx].minute)}`);
    }
  }

  const schedule = { dateKey, targetCount: remainCount, items };
  schedules.set(companionId, schedule);
  log('info', `[Proactive] 今日计划 companion=${companionId} now=${minuteToHHMM(minuteNow)} morningBase=${minuteToHHMM(startMinute)}->${minuteToHHMM(jitteredStart)} goodnight=${minuteToHHMM(jitteredGoodnight)} count=${remainCount}/full=${fullCount} times=${items.map(i => `${minuteToHHMM(i.minute)}${i.kind === 'goodnight' ? '🌙' : ''}`).join(',')}`);
  return schedule;
}

// v1.3.4: 移除 isPro；所有 companion 在 goodnight 窗口内都会安排晚安
function buildDailyItems(count, startMinute, endMinute, goodnightMinute = GOODNIGHT_MINUTE) {
  // Free 不发晚安专用消息；Pro 在抖动后的晚安时间发晚安
  const goodnight = (endMinute >= goodnightMinute && goodnightMinute >= startMinute) ? goodnightMinute : null;
  const lastRandom = (goodnight != null ? goodnight - 30 : endMinute);
  const randomCount = Math.max(count - (goodnight != null ? 1 : 0), 0);
  const randomMinutes = pickRandomMinutes(randomCount, startMinute, lastRandom, MIN_GAP_MINUTES);
  const items = randomMinutes.map(minute => ({ minute, kind: 'normal', sent: false }));
  if (goodnight != null) items.push({ minute: goodnight, kind: 'goodnight', sent: false });
  return items.sort((a, b) => a.minute - b.minute);
}

function isWeekend(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short',
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return parts.weekday === 'Sat' || parts.weekday === 'Sun';
}

function pickRandomMinutes(count, start, end, minGap) {
  if (count <= 0) return [];

  for (let attempt = 0; attempt < 2000; attempt++) {
    const minutes = [];
    for (let i = 0; i < count; i++) {
      minutes.push(start + Math.floor(Math.random() * (end - start + 1)));
    }
    minutes.sort((a, b) => a - b);
    if (hasMinGap(minutes, minGap)) return minutes;
  }

  const slots = [];
  for (let minute = start; minute <= end; minute += minGap) slots.push(minute);
  shuffle(slots);
  return slots.slice(0, count).sort((a, b) => a - b);
}

function hasMinGap(minutes, minGap) {
  for (let i = 1; i < minutes.length; i++) {
    if (minutes[i] - minutes[i - 1] < minGap) return false;
  }
  return minutes.length === 0 || LAST_MINUTE - minutes[minutes.length - 1] >= minGap;
}

async function sendProactiveMessage(companion, kind, account, opts = {}) {
  if (!companion.wechat_user_id) return;
  const ctx = account
    ? { token: account.bot_token, botId: account.bot_id }
    : getBotContextForCompanion(companion.id);
  if (!ctx?.token) {
    log('warn', `[Proactive] 找不到 bot context companion=${companion.id}`);
    return;
  }

  // ── 单独分支：场景照片 ──
  if (kind === 'photo') {
    return sendScenePhoto(companion, ctx).catch(err =>
      log('error', `[Proactive] 场景照失败 companion=${companion.id}: ${err.message}`)
    );
  }

  const userProfile = getUserProfile(companion.user_id, companion.id);
  const timeContext = buildTimeContext(userProfile, getDueReminders(companion.id, formatDateKey()));
  const recentTurns = getConversationContext(companion.id, 10);
  const memories = companion.memory_enabled
    ? recallMemories(companion.id, companion.user_id, timeContext.searchText, 7)
    : [];
  const history = getRecentHistory(companion.wechat_user_id, companion.bot_id, 20);
  // v1.3.4: 开源版所有 companion 享受完整长期记忆摘要（不再按 plan 区分）
  const longTermDigest = await buildLongTermDigest(companion.id, companion.user_id);

  const stickerEnabled = !!companion.sticker_reply_enabled && hasStickers();
  const stickerHint = buildStickerPromptHint(stickerEnabled);
  const proactiveTodayKey = shanghaiDateKey();
  const proactiveDailyRaw = getDailySchedule(companion.id, proactiveTodayKey);
  const proactiveDailySchedule = proactiveDailyRaw ? { ...proactiveDailyRaw, date_key: proactiveTodayKey } : null;
  const proactiveRecent = getRecentSchedules(companion.id, proactiveTodayKey, 3);
  const proactivePersonaFacts = getPersonaFacts(companion.id);
  const emotionHint = buildEmotionPromptHint(getEmotionStateWithDefaults(companion.id));
  const systemPrompt = `${buildSystemPrompt(companion, { memories, userProfile, recentTurns, longTermDigest, promptMode: 'proactive', dailySchedule: proactiveDailySchedule, recentSchedules: proactiveRecent, personaFacts: proactivePersonaFacts })}${stickerHint}${emotionHint}

【今日特别提醒】今天的特殊日期：${timeContext.specialText}。可自然地融入，不要喊口号。`;

  // ── 检查是否触发"AI 主动表白" ──
  // 条件：normal 时段 + 好感度>=50 + 双方都没表白过 + 认识>=5 天
  let effectiveKind = kind;
  const aff = companion.affection_level || 0;
  if (kind === 'normal'
      && !companion.confessed_at
      && !companion.user_confessed_at
      && aff >= 50) {
    let daysSinceMeet = 0;
    if (companion.created_at) {
      const created = new Date(String(companion.created_at).replace(' ', 'T') + (String(companion.created_at).includes('Z') ? '' : 'Z'));
      daysSinceMeet = Math.max(0, Math.floor((Date.now() - created.getTime()) / 86400_000));
    }
    if (daysSinceMeet >= 5) {
      effectiveKind = 'confession';
      log('info', `[Proactive] ★ 触发 AI 主动告白 companion=${companion.id} affection=${aff} days_since_meet=${daysSinceMeet}`);
    }
  }

  const reminderTitles = (opts.reminders || []).map(r => r.title).filter(Boolean).join('、');
  const userMessage = effectiveKind === 'reminder'
    ? `今天是一个对你们来说特别的日子：${reminderTitles || '一个值得纪念的日子'}。
你要主动给他发一条温暖、走心的祝福消息：
- 自然地点出这个日子，表达你的心意，符合你的人设和你们当前的关系
- 不要喊口号、不要太用力、不要像贺卡模板
- 可以带一点你此刻的小情绪（开心 / 感慨 / 害羞）
- 如果是"认识100天""一周年"这类，可以轻轻回顾你们一路的相处`
    : effectiveKind === 'goodnight'
    ? '你要主动给他发今天最后一条晚安消息。自然、温柔，适合 23:00 前后的语气，不要报时。结合你们最近聊过的事，体现你的人设和心情。'
    : effectiveKind === 'confession'
    ? `【★ 重要：今天你要主动向他告白】
你们认识有一段时间了，好感度积累到了这个程度，你内心已经悄悄喜欢上他了。
现在你要鼓起勇气说出口。

要求：
- 不要突然就来一句"我喜欢你"。先铺垫："其实有件事想跟你说" 或 "今天突然想跟你说一件事..."
- 表达要符合你的人设。腼腆的就磕巴一点、害羞地说；外向的就直接但带着不好意思
- 不要太煽情、不要说"从我第一次见你"这种夸张的话
- 告白完不要立即追问"那你呢"，给他反应的空间
- 你的告白要带"试探" + "真诚"，比如："我...好像有点喜欢你" / "我可能、有点把你放心上了" / "我们...能不能更近一点"
- 一定要分多段消息发（用 || 分隔），节奏：铺垫 → 卡顿/犹豫 → 说出口
- 例子参考："其实今天...我有件事一直没说" || "可能..." || "我好像喜欢上你了" || "对不起这么突然"`
    : '你要主动给他发一条自然的日常消息。可以延续最近话题、关心他在忙的事、分享你刚刚的小事或情绪。要结合此刻的时间段，但不要直接报时。';

  const proactiveBinding = getActiveWechatBinding(companion.wechat_user_id, companion.bot_id);
  let reply = await generateReply(systemPrompt, history, userMessage, {
    temperature: companion.temperature,
    max_tokens: Math.min(companion.max_tokens || 300, 300),
    top_p: companion.top_p,
  }, { accountId: proactiveBinding?.account_id || null });
  reply = safeOutboundReply(reply);

  // ★ 撞车检测：若与最近 5 条 assistant 内容相似度 ≥ 0.6（char 3-gram Jaccard），重生一次
  const recentAssistantTexts = recentTurns
    .filter(t => t.role === 'assistant' && t.content)
    .slice(-5)
    .map(t => String(t.content));
  const collision = findCollision(reply, recentAssistantTexts);
  if (collision) {
    log('info', `[Proactive] 撞车检测：与最近一条相似度=${collision.sim.toFixed(2)} 重生 companion=${companion.id}`);
    const antiRepeat = `${userMessage}

【★ 反重复约束】你最近刚说过类似的话：「${collision.text.slice(0, 50)}」。**严格禁止**重复这条的话题/开场/具体事物。换一个完全不同的话题：可以问他、聊你新发生的小事、聊心情，但不能再提同样的东西。`;
    let retry = await generateReply(systemPrompt, history, antiRepeat, {
      temperature: Math.min((companion.temperature || 0.8) + 0.15, 1.1),
      max_tokens: Math.min(companion.max_tokens || 300, 300),
      top_p: companion.top_p,
    }, { accountId: proactiveBinding?.account_id || null });
    retry = safeOutboundReply(retry);
    const retryCollision = findCollision(retry, recentAssistantTexts);
    if (!retryCollision) {
      reply = retry;
    } else {
      // 重生后仍撞车 — 放弃本次主动消息，避免骚扰
      log('warn', `[Proactive] 重生后仍撞车，放弃本次主动 companion=${companion.id}`);
      return;
    }
  }

  // 像真人：按 || 拆多条短消息
  const segments = splitReplySegments(reply);
  let totalStickers = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const { text: textOnly, stickers } = parseStickerMarkers(seg);
    if (textOnly) {
      await sendTextMessage(ctx, companion.wechat_user_id, textOnly, null);
      saveMessage({
        msgId: `proactive_${companion.id}_${Date.now()}_${i}`,
        fromUser: ctx.botId,
        toUser: companion.wechat_user_id,
        msgType: 'text',
        content: textOnly,
        direction: 'out',
      });
    }
    for (const { picked } of stickers) {
      totalStickers++;
      try {
        const { data, name } = await readMediaBuffer(picked.fullPath);
        const { item } = await uploadFile({ data, fileName: name, toUserId: companion.wechat_user_id, ctx });
        await sendMessageItem(ctx, companion.wechat_user_id, item, null);
        saveMessage({
          msgId: `proactive_sticker_${companion.id}_${Date.now()}_${i}`,
          fromUser: ctx.botId,
          toUser: companion.wechat_user_id,
          msgType: 'image',
          content: `[STICKER:${picked.emotion || picked.tags?.[0] || picked.id}]`,
          direction: 'out',
        });
      } catch (err) {
        log('warn', `[Proactive] sticker send failed: ${err.message}`);
      }
    }
    if (i < segments.length - 1) {
      await new Promise(r => setTimeout(r, 600 + Math.floor(Math.random() * 1200)));
    }
  }
  const turnTopic = effectiveKind === 'goodnight' ? '晚安'
    : effectiveKind === 'confession' ? '主动告白'
    : effectiveKind === 'reminder' ? '纪念日祝福'
    : '主动消息';
  saveConversationTurn(companion.id, 'assistant', reply, turnTopic);

  // ── 主动告白后处理：标记 + 升级关系到恋人 ──
  if (effectiveKind === 'confession') {
    try {
      markCompanionConfessed(companion.id);
      const newAff = Math.max(aff, 60);
      const newStage = computeRelationshipStage(newAff);
      patchCompanion(companion.id, {
        affection_level: newAff,
        relationship_stage: newStage,
      });
      log('info', `[Proactive] ★ 主动告白完成 companion=${companion.id} affection=${aff}→${newAff} stage→${newStage}`);
    } catch (e) {
      log('warn', `[Proactive] 告白后处理失败: ${e.message}`);
    }
  }
  // Record proactive sent for engine backoff tracking
  try { recordProactiveSent(companion.id); } catch {}

  // 首次主动消息成就（静默）
  tryAchievement(companion.id, 'first_proactive_message');

  log('info', `[Proactive] 已发送 companion=${companion.id} to=${companion.wechat_user_id} kind=${effectiveKind} segments=${segments.length} stickers=${totalStickers}`);
}

// 手动触发场景照（管理员/测试用）
export async function sendScenePhotoManually(companion) {
  if (!companion || !companion.wechat_user_id) {
    log('warn', '[Proactive] sendScenePhotoManually: companion 未绑定微信');
    return;
  }
  const ctx = getBotContextForCompanion(companion.id);
  if (!ctx?.token) {
    log('warn', `[Proactive] sendScenePhotoManually: bot context 缺失 companion=${companion.id}`);
    return;
  }
  return sendScenePhoto(companion, ctx);
}

// ── 场景照片：生成 + 去水印 + 上传 + 发送 + AI 配文字 ──
const SCENE_PHOTO_DIR = path.resolve(process.cwd(), 'public/avatars/scenes');

async function sendScenePhoto(companion, ctx) {
  // 派生当前活动
  const todayKey = shanghaiDateKey();
  const sched = getDailySchedule(companion.id, todayKey);
  const nowMin = (() => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
    return Number(p.hour) * 60 + Number(p.minute);
  })();

  let curActivity = companion.current_scene || '在家';
  let timeSlot = 'afternoon';
  let mood = '';
  if (sched?.items?.length) {
    for (const it of sched.items) {
      const m = (it.time || '').match(/^(\d{1,2}):(\d{2})/);
      if (!m) continue;
      const itMin = Number(m[1]) * 60 + Number(m[2]);
      if (itMin <= nowMin) curActivity = it.activity;
    }
    if (sched.mood_segments) {
      mood = nowMin < 12 * 60 ? sched.mood_segments.morning
        : nowMin < 18 * 60 ? sched.mood_segments.afternoon
        : sched.mood_segments.evening;
    }
  }
  if (nowMin < 11 * 60) timeSlot = 'morning';
  else if (nowMin < 14 * 60) timeSlot = 'noon';
  else if (nowMin < 17 * 60) timeSlot = 'afternoon';
  else if (nowMin < 19 * 60) timeSlot = 'golden hour';
  else if (nowMin < 22 * 60) timeSlot = 'evening';
  else timeSlot = 'night';

  // 1. 生成场景照片 URL
  log('info', `[Proactive] 生成场景照 companion=${companion.id} activity="${curActivity}" timeSlot=${timeSlot}`);
  let cogResult;
  try {
    cogResult = await generateScenePhoto({ activity: curActivity, timeSlot, mood });
  } catch (e) {
    log('warn', `[Proactive] CogView 生成失败: ${e.message}`);
    return;
  }

  // 2. 下载 + 去水印 + 转 webp
  if (!existsSync(SCENE_PHOTO_DIR)) mkdirSync(SCENE_PHOTO_DIR, { recursive: true });
  const ts = Date.now();
  const outName = `scene_${companion.id}_${ts}.webp`;
  const outPath = path.join(SCENE_PHOTO_DIR, outName);
  const tmpPath = outPath + '.tmp';
  try {
    const r = await fetch(cogResult.url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error('download HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(tmpPath, buf);
    await new Promise((resolve, reject) => {
      const proc = spawn('convert', [
        tmpPath, '-auto-orient',
        '-resize', '1157x1157^',
        '-gravity', 'north',
        '-crop', '1024x1024+0+0', '+repage',
        '-strip', '-quality', '85', outPath,
      ]);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error('convert code=' + code)));
      proc.on('error', reject);
    });
    try { unlinkSync(tmpPath); } catch {}
  } catch (e) {
    log('warn', `[Proactive] 下载/转码失败: ${e.message}`);
    try { unlinkSync(tmpPath); } catch {}
    return;
  }

  // 3. 上传到 iLink CDN
  const buf = (await import('node:fs/promises')).readFile(outPath);
  const fileBuf = await buf;
  let item;
  try {
    const r = await uploadFile({ data: fileBuf, fileName: outName, toUserId: companion.wechat_user_id, ctx });
    item = r.item;
  } catch (e) {
    log('warn', `[Proactive] uploadFile 失败: ${e.message}`);
    return;
  }

  // 4. 让 AI 配一句短文字（"刚拍的""你看"）
  let caption = '';
  try {
    const { generateReply } = await import('./ai.mjs');
    const personaFacts = getPersonaFacts(companion.id);
    const sys = buildSystemPrompt(companion, { promptMode: 'proactive', personaFacts });
    const userMsg = `你刚才在【${curActivity}】，随手拍了一张照片想分享给他。
现在准备发出去。配一句 5-15 字的简短随手发的话，符合你的口吻和当前心情。
例子：「窗外的天好好看」「刚到」「我的桌子」「拍的不好哈哈」「分享给你」「猜我在哪」
**只输出这句话**，不要带【】，不要带表情包标记。`;
    caption = await generateReply(sys, [], userMsg, { max_tokens: 60, temperature: 0.9 });
    caption = (caption || '').replace(/[\[【].*?[\]】]/g, '').replace(/\|\|/g, '').trim().slice(0, 40);
  } catch (e) {
    log('warn', `[Proactive] caption 生成失败: ${e.message}`);
  }

  // 5. 发送图片 + 文字
  try {
    if (caption) {
      await sendTextMessage(ctx, companion.wechat_user_id, caption, null);
      saveMessage({
        msgId: `proactive_photo_text_${companion.id}_${ts}`,
        fromUser: ctx.botId, toUser: companion.wechat_user_id,
        msgType: 'text', content: caption, direction: 'out',
      });
      await new Promise(r => setTimeout(r, 800 + Math.random() * 1000));
    }
    await sendMessageItem(ctx, companion.wechat_user_id, item, null);
    saveMessage({
      msgId: `proactive_photo_${companion.id}_${ts}`,
      fromUser: ctx.botId, toUser: companion.wechat_user_id,
      msgType: 'image', content: `[PHOTO] ${curActivity}`, direction: 'out',
    });
    markPhotoSent(companion.id, curActivity + ' / ' + caption);
    saveConversationTurn(companion.id, 'assistant', `[场景照片：${curActivity}] ${caption}`, '场景分享');
    // 首次场景照成就（静默）
    tryAchievement(companion.id, 'first_scene_photo');
    log('info', `[Proactive] ★ 场景照已发送 companion=${companion.id} activity="${curActivity}" caption="${caption}"`);
  } catch (e) {
    log('warn', `[Proactive] 发送场景照失败: ${e.message}`);
  }
}

// 撞车检测：把回复和最近 assistant 内容比相似度（char 3-gram Jaccard），
// 返回相似度最高的一条（若超过阈值）
function findCollision(reply, recentTexts, threshold = 0.6) {
  if (!reply || !recentTexts?.length) return null;
  const a = _normalizeForSim(reply);
  if (a.length < 6) return null;
  const aGrams = _ngramSet(a, 3);
  let best = null;
  for (const t of recentTexts) {
    const b = _normalizeForSim(t);
    if (b.length < 6) continue;
    const bGrams = _ngramSet(b, 3);
    const sim = _jaccard(aGrams, bGrams);
    if (sim >= threshold && (!best || sim > best.sim)) best = { text: t, sim };
  }
  return best;
}
function _normalizeForSim(s) {
  return String(s).replace(/\|\|/g, ' ').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '').toLowerCase();
}
function _ngramSet(s, n) {
  const set = new Set();
  for (let i = 0; i <= s.length - n; i++) set.add(s.slice(i, i + n));
  return set;
}
function _jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// 与 bot.mjs 同款拆分逻辑（重复但避免循环依赖）
const PROACTIVE_MAX_SEGMENTS = 4;
function splitReplySegments(reply) {
  if (!reply || typeof reply !== 'string') return [reply || ''];
  const raw = reply.split(/\s*(?:\|\||｜｜)\s*/g).map(s => s.trim()).filter(Boolean);
  if (raw.length <= 1) return [reply.trim()];
  if (raw.length > PROACTIVE_MAX_SEGMENTS) {
    return [...raw.slice(0, PROACTIVE_MAX_SEGMENTS - 1), raw.slice(PROACTIVE_MAX_SEGMENTS - 1).join('，')];
  }
  return raw;
}

function buildTimeContext(userProfile, dueReminders = [], now = new Date()) {
  const parts = getDateParts(now);
  const dateKey = `${parts.year}-${parts.month2}-${parts.day2}`;
  const md = `${parts.month2}-${parts.day2}`;
  const special = [];

  for (const item of fixedHolidays(md)) special.push(item);

  if (userProfile?.user_birthday && userProfile.user_birthday.slice(5) === md) {
    special.push('用户生日');
  }

  for (const item of userProfile?.important_dates || []) {
    const date = String(item.date || '');
    if (date === dateKey || date.slice(5) === md) {
      special.push(item.label ? `用户纪念日：${item.label}` : '用户纪念日');
    }
  }

  for (const reminder of dueReminders) {
    const label = reminder.reminder_type === 'birthday'
      ? `用户生日：${reminder.title}`
      : reminder.reminder_type === 'anniversary'
        ? `用户纪念日：${reminder.title}`
        : `${reminder.title}`;
    special.push(label);
  }

  const uniqueSpecial = [...new Set(special)];
  return {
    dateText: `${parts.year}年${parts.month}月${parts.day}日，${parts.weekday}`,
    period: periodOfDay(parts.hour),
    specialText: uniqueSpecial.length ? uniqueSpecial.join('、') : '否',
    searchText: [parts.weekday, periodOfDay(parts.hour), ...uniqueSpecial].join(' '),
  };
}

function fixedHolidays(md) {
  const map = {
    '01-01': ['元旦'],
    '02-14': ['情人节'],
    '03-08': ['妇女节'],
    '05-01': ['劳动节'],
    '05-20': ['520'],
    '06-01': ['儿童节'],
    '10-01': ['国庆节'],
    '12-24': ['平安夜'],
    '12-25': ['圣诞节'],
    '12-31': ['跨年夜'],
  };
  return map[md] || [];
}

function periodOfDay(hour) {
  if (hour >= 6 && hour < 12) return '上午';
  if (hour >= 12 && hour < 18) return '下午';
  if (hour >= 18 && hour < 23) return '晚上';
  return '深夜';
}

function getDateParts(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'long',
    hour: 'numeric',
    hourCycle: 'h23',
    hour12: false,
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));

  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year: Number(parts.year),
    month,
    day,
    month2: String(month).padStart(2, '0'),
    day2: String(day).padStart(2, '0'),
    weekday: parts.weekday,
    hour: Number(parts.hour),
  };
}

function formatDateKey(date = new Date()) {
  const parts = getDateParts(date);
  return `${parts.year}-${parts.month2}-${parts.day2}`;
}

function currentMinute(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    hour12: false,
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function minuteToHHMM(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}
