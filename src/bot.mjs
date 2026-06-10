/**
 * 消息处理核心逻辑
 *
 * 入口签名 (rawMsg, botContext)
 *   botContext = { token, botId, baseUrl, accountId?, userId? }
 *   每个 polling loop 都把自己的 context 传进来，handleMessage 内部所有
 *   sendMessage / sendTyping 都用这个 context 的 token。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { parseMessage, sendTextMessage, sendTyping, sendMessageItem, rememberContextToken, peekSendQuota } from './ilink.mjs';
import { generateReply, recognizeImage, embedText } from './ai.mjs';
import { downloadInboundVoiceToMp3 } from './voice_inbound.mjs';
import { analyzeVoiceWithQwen } from './voice_emotion.mjs';
import { dedupSegments } from './text_similarity.mjs';
import {
  saveMessage, getRecentHistory, getUserProfile, recallMemories, recallMemoriesSemantic,
  getConversationContext, saveConversationTurn,
  getActiveWechatBinding, getCompanionById, consumePendingBindSessionForWechat,
  isAccountBanned, getDailySchedule, shanghaiDateKey, getRecentSchedules, getPersonaFacts,
  markUserConfessed, markCompanionConfessed, getCompanionPreferencesForPrompt,
  recordSafetyEvent,
  upsertShaping, listShaping,
  claimMessage, clearProactiveUnanswered,
  getOpenRelationshipEvent,
} from './db.mjs';
import { buildSystemPrompt, buildFirstTurnHint } from './companion.mjs';
import { syncUpdateCompanionState, extractAndSaveMemories, extractAndUpdateUserProfile, consumePendingCelebration, detectUserConfession, detectCompanionConfession, detectIntimacyOvereach, canAcceptConfession, daysSinceMeet, DAYS_TO_LOVER } from './memory.mjs';
import { buildLongTermDigest } from './plan_tasks.mjs';
import { parseStickerMarkers, buildStickerPromptHint, hasStickers } from './stickers.mjs';
import { detectTeaching, buildShapingConfirmHint, buildShapingPromptHint } from './shaping.mjs';
import { uploadFile, readMediaBuffer } from './media.mjs';
import { safeOutboundReply, inboundIsBlocked, detectSafetyRisk, detectCrisisLevel, buildCrisisReply, scrubPersonaLeak, scrubConflictRedline } from './moderation.mjs';
import { runArcSignalTick } from './relationship_arc_runtime.mjs';
import { applyCrisisOverride, userRaisedMemoryTopic } from './relationship_arc.mjs';
import { log } from './logger.mjs';
import { applyPersonaGuard } from './persona_guard.mjs';
import { tryAchievement } from './achievements.mjs';
import { getEmotionStateWithDefaults, updateEmotionFromUserMessage, updateEmotionFromAssistantReply, buildEmotionPromptHint, getMissingLevel, getNeglectStage, buildReunionHint } from './emotion_state.mjs';
import { escalationLevel, escalationDirective } from './escalation.mjs';
import { detectPhotoIntentSmart, detectPhotoPromise, hasUnsafePhotoContent } from './photo_intent.mjs';
import { detectMinorSmart, activateSafeMode } from './minor_guard.mjs';
import { getPhotoGateState, planPhotoMessage } from './photo_planner.mjs';
import { sendCompanionPhoto } from './photo_sender.mjs';
import { recordUserReplied } from './proactive_engine.mjs';
import { extractOpenLoops, detectAndResolveOpenLoops } from './open_loops.mjs';
import { generateInnerMonologue, buildInnerOsHint } from './inner_os.mjs';
import { maybeSleepBlock } from './sleep.mjs';

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const _PHOTO_REQUEST_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.PHOTO_REQUEST_ENABLED ?? 'true').toLowerCase());
const PHOTO_REQUEST_FALLBACKS = [
  '刚才没拍好，等我一下',
  '现在有点乱，等我拍好点',
  '等等，我找个好看的角度',
  '刚刚那张糊了，别急',
];
// v1.10.40: 异步生图前发的"等一下"安抚句，让用户立刻知道收到了请求
// v1.20 实测调性修正：删掉"挑一张/找一张/看看刚拍的"——那是翻相册库存的视角，
// 真人被问"在干嘛"是现场拍。全部改为现场拍的口吻。
const PHOTO_ACK_OPTIONS = [
  '稍等 我拍一张',
  '等等哦 这就拍',
  '等下哦 拍个给你',
  '嗯等一下 我拍给你看',
];
// 异步生图中又被请求时的"还在挑"短句
const PHOTO_BUSY_REPLIES = [
  '嗯…等一下哦 还在挑',
  '别催别催 马上',
  '我还在选哦 等等',
];
const UNSAFE_PHOTO_REPLY = '这个不行啦，换个正常点的给你看';

function pickPhotoRequestFallback() {
  return PHOTO_REQUEST_FALLBACKS[Math.floor(Math.random() * PHOTO_REQUEST_FALLBACKS.length)];
}

function pickPhotoAck() {
  return PHOTO_ACK_OPTIONS[Math.floor(Math.random() * PHOTO_ACK_OPTIONS.length)];
}

function pickPhotoBusyReply() {
  return PHOTO_BUSY_REPLIES[Math.floor(Math.random() * PHOTO_BUSY_REPLIES.length)];
}

// v1.10.40: 异步生图防并发锁 — companion_id 在 inflight 时拒绝再触发
const inflightPhoto = new Set();

// v1.19.5 (issue #237 #1): 异步发图任务，从 strong_photo_request 路径提炼，
// 让"她答应发图"出口检测也能复用同一条链路。
// 调用方负责先 inflightPhoto.add()；本函数 fire-and-forget，finally 里删锁。
// silentOnDecline=true（promise 路径）：planner 拒绝/生图失败时**静默**只记日志——
// 她不是被用户直接索图，补一条"拍不了"反而突兀；下轮聊到再自然圆。
function firePhotoTask({ ctx, msg, botId, photoCompanion, binding, userText, companion, gate, silentOnDecline = false }) {
  const photoTaskCtx = { ctx, msg, botId, photoCompanion, binding, userText, companion };
  (async () => {
    const recentForPlanner = getRecentHistory(photoTaskCtx.msg.fromUser, photoTaskCtx.botId, 10);
    let photoEmotionState = null;
    try {
      photoEmotionState = getEmotionStateWithDefaults(photoTaskCtx.companion.id);
    } catch (e) {
      log('warn', `[Bot] async photo emotion state unavailable: ${e.message}`);
    }
    try {
      const plan = await planPhotoMessage({
        companion: photoTaskCtx.photoCompanion,
        user: { ...photoTaskCtx.binding, wechat_user_id: photoTaskCtx.msg.fromUser },
        userText: photoTaskCtx.userText,
        recentMessages: recentForPlanner,
        trigger: 'user_request',
        context: { accountId: photoTaskCtx.binding.account_id || null },
        cooldownState: gate,
        imageProviderAvailable: gate.imageProviderAvailable,
        emotionState: photoEmotionState,
      });
      if (plan.shouldSendPhoto) {
        const result = await sendCompanionPhoto({
          companion: photoTaskCtx.photoCompanion,
          user: { ...photoTaskCtx.binding, wechat_user_id: photoTaskCtx.msg.fromUser },
          context: photoTaskCtx.ctx,
          contextToken: photoTaskCtx.msg.contextToken,
          activity: photoTaskCtx.companion.current_scene || '',
          imagePrompt: plan.imagePrompt,
          caption: plan.caption,
          trigger: 'user_request',
          source: 'request',
          emotionState: photoEmotionState,
          aspect: plan.aspect,
          shotMode: plan.shotMode,
          maintainIdentity: plan.maintainIdentity !== false,
        });
        if (result.ok) {
          let captionText = result.caption || plan.caption;
          if (captionText) {
            await sleep(plan.delayCaptionMs || randInt(700, 1400));
            // v1.20.1: caption 尽力而为——一轮"连发+ack+图"常把 6 条/5min 的 iLink 配额
            // 吃满，caption 作为第 7 条会进 30s-drain 队列、3 分钟后才到（生产实测
            // 13:02 图 → 13:05 文），上下文早走了。配额不够直接放弃，图自己会说话。
            if (peekSendQuota(photoTaskCtx.botId)) {
              await sendAndRecord(photoTaskCtx.ctx, photoTaskCtx.msg.fromUser, captionText, photoTaskCtx.msg.contextToken);
            } else {
              log('info', `[Bot] photo caption 撞限速 → 放弃不排队 companion=${photoTaskCtx.companion.id}`);
              captionText = '';
            }
          }
          saveConversationTurn(photoTaskCtx.companion.id, 'assistant', captionText || '[photo]', photoTaskCtx.companion.chat_mode_active);
          log('info', `[Bot] async photo sent companion=${photoTaskCtx.companion.id}`);
          return;
        }
        log('warn', `[Bot] async photo send failed companion=${photoTaskCtx.companion.id} code=${result.code || 'unknown'} error=${result.error || ''}`);
      } else {
        log('debug', `[Bot] async photo planner declined companion=${photoTaskCtx.companion.id} reason=${plan.reason}`);
      }
      if (silentOnDecline) {
        log('info', `[Bot] photo promise path declined/failed silently companion=${photoTaskCtx.companion.id}`);
        return;
      }
      // 生不出来 / 拒绝 / send 失败：给一个 fallback 文字
      const fallback = pickPhotoRequestFallback();
      await sendAndRecord(photoTaskCtx.ctx, photoTaskCtx.msg.fromUser, fallback, photoTaskCtx.msg.contextToken);
      saveConversationTurn(photoTaskCtx.companion.id, 'assistant', fallback, photoTaskCtx.companion.chat_mode_active);
    } catch (e) {
      log('warn', `[Bot] async photo gen error companion=${photoTaskCtx.companion.id}: ${e.message}`);
      if (!silentOnDecline) {
        try {
          await sendAndRecord(photoTaskCtx.ctx, photoTaskCtx.msg.fromUser, '光线不好 等下再发哈', photoTaskCtx.msg.contextToken);
        } catch (e2) {
          log('warn', `[Bot] async photo fallback send also failed: ${e2.message}`);
        }
      }
    } finally {
      inflightPhoto.delete(photoTaskCtx.companion.id);
    }
  })().catch(e => {
    log('error', `[Bot] async photo task unhandled: ${e.message}`);
    inflightPhoto.delete(companion.id);
  });
}

const BIND_CODE_RE = /(?:^绑定\s*)?(XYU-\d{6})$/i;
// 模拟打字延迟：按文字长度自适应
//   短消息（1-10 字）：~2-5s（手机打字真实感）
//   中等消息（10-50 字）：~3-10s
//   长消息（50+字）：上限 15s（避免用户等太久）
// 计时常量做成 env 可调（仅影响打字延迟节奏，不改内容/安全/图片）：沙箱/压测可调低提速。
const REPLY_DELAY_MIN_MS = Number.isFinite(Number(process.env.REPLY_DELAY_MIN_MS)) ? Number(process.env.REPLY_DELAY_MIN_MS) : 2_000;
const REPLY_DELAY_MAX_MS = Number.isFinite(Number(process.env.REPLY_DELAY_MAX_MS)) ? Number(process.env.REPLY_DELAY_MAX_MS) : 15_000;

// v1.9.11: 破冰延迟（用户长时间沉默后第一条消息）
// 阈值可调：默认沉默 ≥ 30 分钟视为"破冰场景"，下次回复加额外延迟。
// 用 env 控：
//   ICEBREAKER_SILENCE_MIN_MIN — 触发阈值（分钟，默认 30）
//   ICEBREAKER_DELAY_MIN_MS / MAX_MS — 额外延迟范围（默认 5-20s）
const ICEBREAKER_SILENCE_MIN_MIN = Math.max(0, Number(process.env.ICEBREAKER_SILENCE_MIN_MIN) || 30);
const ICEBREAKER_DELAY_MIN_MS = Math.max(0, Number(process.env.ICEBREAKER_DELAY_MIN_MS) || 5_000);
const ICEBREAKER_DELAY_MAX_MS = Math.max(ICEBREAKER_DELAY_MIN_MS, Number(process.env.ICEBREAKER_DELAY_MAX_MS) || 20_000);

/**
 * v1.9.11: 计算破冰延迟（用户沉默 N 分钟后第一条消息）
 * 沉默时间越长延迟越长（但 cap 在 max）
 * @returns ms 延迟。0 表示不需要破冰延迟。
 */
function computeIcebreakerDelay(lastUserReplyAt) {
  if (!lastUserReplyAt) return 0;  // 全新对话不算破冰（用 typing 延迟就够）
  const last = new Date(String(lastUserReplyAt).replace(' ', 'T')).getTime();
  if (!Number.isFinite(last)) return 0;
  const silenceMin = (Date.now() - last) / 60_000;
  if (silenceMin < ICEBREAKER_SILENCE_MIN_MIN) return 0;
  // 沉默 30min → min；沉默 24h+ → max。线性插值。
  const t = Math.min(1, (silenceMin - ICEBREAKER_SILENCE_MIN_MIN) / (24 * 60));
  const base = ICEBREAKER_DELAY_MIN_MS + (ICEBREAKER_DELAY_MAX_MS - ICEBREAKER_DELAY_MIN_MS) * t;
  // ±25% jitter
  const jitter = base * (Math.random() * 0.5 - 0.25);
  return Math.max(ICEBREAKER_DELAY_MIN_MS, Math.round(base + jitter));
}
const REPLY_DELAY_PER_CHAR_MS = Number.isFinite(Number(process.env.REPLY_DELAY_PER_CHAR_MS)) ? Number(process.env.REPLY_DELAY_PER_CHAR_MS) : 150;
function computeReplyDelay(text) {
  const len = (text || '').length;
  const base = len * REPLY_DELAY_PER_CHAR_MS;
  const jitter = Math.floor(Math.random() * 1500);
  return Math.max(REPLY_DELAY_MIN_MS, Math.min(REPLY_DELAY_MAX_MS, base + jitter));
}

// 把 AI 回复按 || 拆成多条短消息 + 强制后处理（去 kaomoji、长段拆分）
const MAX_SEGMENTS = 4;
const MAX_SEG_LEN = 25;  // 单段强制上限（超过会再拆）

// kaomoji 标识符（含这些字符的括号内容必删）
const KAOMOJI_INNER_CHARS = /[ω♥♡♬♪σ＞＜ヽノ٩ʕɞ´`¸∇∀＾·•・˘ﾟ]/;
// 残留的尾巴符号（/♡ 这种）
const KAOMOJI_TRAIL = /\s*[\/＼\-]+\s*[♥♡♬♪☆★✿❀➡]+/g;
const KAOMOJI_SOLO_SYM = /[♥♡♬♪☆★ω＞＜ノヽ٩]/g;

function stripKaomoji(text) {
  // 1. 圆括号包裹的 kaomoji（含中文则保留正常括号）
  text = text.replace(/[（(][^（）()]{0,20}[）)]/g, m => {
    const inner = m.slice(1, -1);
    if (/[一-鿿]/.test(inner)) return m;  // 含中文 → 正常括号保留
    if (KAOMOJI_INNER_CHARS.test(inner)) return '';
    if (/^[\W\d\s]{1,10}$/.test(inner)) return '';  // 纯符号 → 删
    return m;
  });
  // 2. 残留的 /♡、 ~♥ 等尾巴
  text = text.replace(KAOMOJI_TRAIL, '');
  // 3. 落单的 kaomoji 符号
  text = text.replace(KAOMOJI_SOLO_SYM, '');
  return text;
}

function postProcessReply(reply) {
  if (!reply || typeof reply !== 'string') return reply || '';
  let text = reply;
  text = stripKaomoji(text);
  text = text.replace(/[!！]{2,}/g, '！');
  text = text.replace(/[?？]{2,}/g, '？');
  text = text.replace(/[…\.]{4,}/g, '…');
  text = text.replace(/～+/g, '～').replace(/~+/g, '~');  // 波浪线归一
  // 注意：换行先保留 — v1.10.13 用它做最高优先级分段
  text = text.replace(/[ \t]+/g, ' ').replace(/^[ \t]+|[ \t]+$/gm, '').trim();

  // v1.10.13: 优先用 AI 输出的换行作为段落分隔（最自然、最少破坏语义）。
  // 之前 postProcessReply 完全不看 \n —— AI 用换行分了完美 3 段，被整串塞进
  // splitReplySegments 二次处理 → 没 || 也没句末标点 → 落到按 25 字硬切 →
  // 把「怎么一点都不|听话」这种短语腰斩成两段。
  if (/\n/.test(text) && !/\|\|/.test(text)) {
    const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (lines.length >= 2 && lines.length <= MAX_SEGMENTS && lines.every(l => l.length <= 60)) {
      return lines.join('||');
    }
  }

  // 没有 || 但 > 20 字 → 按句尾自动拆
  if (!/\|\|/.test(text) && text.length > 20) {
    const parts = text.split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      text = parts.slice(0, MAX_SEGMENTS).join('||');
    }
  }
  return text;
}

function splitReplySegments(reply) {
  if (!reply || typeof reply !== 'string') return [reply || ''];
  // 先后处理（去 kaomoji + 长段自动拆）
  const processed = postProcessReply(reply);
  // 支持半角 ||、全角 ｜｜
  let raw = processed.split(/\s*(?:\|\||｜｜)\s*/g).map(s => s.trim()).filter(Boolean);
  if (raw.length === 0) return [processed.trim()];

  // 二次强制：每段超过 MAX_SEG_LEN 字 → 按内部句末标点再拆
  // v1.10.13: 取消按 `，`/`,` 拆 —— 中文逗号是子句分隔，按它切会腰斩主谓宾
  // （比如「她说，他来了」会被切成「她说，」「他来了」）。
  const expanded = [];
  for (const seg of raw) {
    if (seg.length <= MAX_SEG_LEN) { expanded.push(seg); continue; }
    const subs = seg.split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);
    if (subs.length > 1) {
      // 累计拼回去，每个 sub 不超过 MAX
      let cur = '';
      for (const s of subs) {
        if ((cur + s).length > MAX_SEG_LEN && cur) {
          expanded.push(cur);
          cur = s;
        } else {
          cur += s;
        }
      }
      if (cur) expanded.push(cur);
    } else {
      // v1.10.13: 没分隔符的长段，宁愿整段发也不腰斩 —— 用户看一条长消息
      // 比看「怎么一点都不」「听话」这种诡异腰斩好得多。
      expanded.push(seg);
    }
  }
  raw = expanded;

  // v1.10.13: 兜底合并 — 末段 < 3 字时合并到上一段，避免「听话」式 hard-slice 残尾。
  // 阈值刻意保守，让 AI 主动用 || 分的「好的」「明白了」这种短确认段能保留。
  while (raw.length >= 2 && raw[raw.length - 1].length < 3) {
    const tail = raw.pop();
    raw[raw.length - 1] = `${raw[raw.length - 1]}${tail}`;
  }

  if (raw.length > MAX_SEGMENTS) {
    return [...raw.slice(0, MAX_SEGMENTS - 1), raw.slice(MAX_SEGMENTS - 1).join('')];
  }
  return raw;
}

// 同一用户已有"生成回复中"的任务时，新进来的消息只入库不再触发 AI；
// 等当前回复结束后 AI 已能从 history 里看到全部连发的内容，自然合并响应。
const inflightUsers = new Set();

// v1.10.53: 连发消息合并（debounce）——真人常一次连发 2-3 条消息/图片；不再每条
// 都单独回，而是等用户停手（安静窗口）后把这一串整合成「一轮」，只回一次。
//   · COALESCE_WINDOW_MS：两条消息间隔超过它就视为"发完了"，开始回复
//   · COALESCE_MAX_WAIT_MS：一直连发不停的硬上限，到点强制冲刷，防永远不回
const COALESCE_ENABLED     = String(process.env.COALESCE_ENABLED ?? 'true').toLowerCase() !== 'false';
const COALESCE_WINDOW_MS   = Number(process.env.COALESCE_WINDOW_MS) || 10_000;
const COALESCE_MAX_WAIT_MS = Number(process.env.COALESCE_MAX_WAIT_MS) || 30_000;
// fromUser -> { parts: string[], firstAt: number, timer, turn }
const pendingBursts = new Map();

// 测试 seam：默认走真实 processUserTurn；测试可替换以验证合并/计时逻辑而不跑重管线。
let _turnRunner = (turn) => processUserTurn(turn);
export function __setTurnRunnerForTest(fn) { _turnRunner = typeof fn === 'function' ? fn : ((t) => processUserTurn(t)); }

// 把一条已识别的 userText 推进该用户的 burst 缓冲并重置计时器；停手后 flush 合并回复。
// COALESCE 关闭时退回老行为：直接处理（仍用 inflightUsers 防同一用户并发回复）。
export function enqueueOrRunTurn(turn) {
  const fromUser = turn.fromUser;
  if (!COALESCE_ENABLED) {
    if (inflightUsers.has(fromUser)) { log('info', `[Bot] 已有回复进行中，跳过 user=${fromUser}`); return; }
    _turnRunner(turn).catch(e => log('error', `[Bot] processUserTurn 异常: ${e.message}`));
    return;
  }
  let b = pendingBursts.get(fromUser);
  if (!b) { b = { parts: [], firstAt: Date.now(), timer: null, turn }; pendingBursts.set(fromUser, b); }
  b.parts.push(turn.userText);
  b.turn = turn;  // 留最新一条的 ctx / contextToken / companion
  if (b.timer) clearTimeout(b.timer);
  const remaining = COALESCE_MAX_WAIT_MS - (Date.now() - b.firstAt);
  const delay = Math.max(0, Math.min(COALESCE_WINDOW_MS, remaining));
  b.timer = setTimeout(() => flushBurst(fromUser), delay);
  log('debug', `[Bot] coalesce: user=${fromUser} 缓冲第 ${b.parts.length} 条，${delay}ms 后冲刷`);
}

// 安静窗口到点：把缓冲里的多条合并成一段（换行分隔），整体回一次。
function flushBurst(fromUser) {
  const b = pendingBursts.get(fromUser);
  if (!b) return;
  if (inflightUsers.has(fromUser)) {  // 上一轮还在回复 → 等下一个窗口再冲刷
    b.timer = setTimeout(() => flushBurst(fromUser), COALESCE_WINDOW_MS);
    return;
  }
  pendingBursts.delete(fromUser);
  const userText = b.parts.length <= 1 ? (b.parts[0] || '') : b.parts.join('\n');
  if (b.parts.length > 1) log('info', `[Bot] coalesce flush: user=${fromUser} 合并 ${b.parts.length} 条 → 一次回复`);
  _turnRunner({ ...b.turn, userText }).catch(e => log('error', `[Bot] flush 异常: ${e.message}`));
}

// 防重放：记录已处理的 msgId（内存）
const processedIds = new Set();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

export async function handleMessage(rawMsg, botContext = {}) {
  const msg = parseMessage(rawMsg, botContext.botId);
  const botId = msg.botId || botContext.botId;
  const ctx = { token: botContext.token, botId, baseUrl: botContext.baseUrl };

  if (!msg.fromUser) {
    log('warn', '[Bot] missing from_user_id, skip inbound message');
    return;
  }
  if (!msg.contextToken) {
    log('warn', `[Bot] missing context_token from=${msg.fromUser} msgId=${msg.msgId}`);
  } else {
    // 把这一对 (botId, userId) 的最新 context_token 缓存下来，给主动消息用
    rememberContextToken(ctx.botId, msg.fromUser, msg.contextToken);
  }

  // 防重放：内存快速层 + 持久化兜底（claimMessage，重启不丢 → 修 Issue #1 重启重复回复）
  if (msg.msgId) {
    if (processedIds.has(msg.msgId) || !claimMessage(msg.msgId)) {
      log('debug', `[Bot] 跳过重复 msgId=${msg.msgId}`);
      return;
    }
    processedIds.add(msg.msgId);
    if (processedIds.size > 5000) {
      const arr = [...processedIds];
      processedIds.clear();
      arr.slice(-3000).forEach(id => processedIds.add(id));
    }
  }

  log('info', `[Bot] inbound message type=${msg.msgType} from=${msg.fromUser} bot_id=${botId || 'EMPTY'} msgId=${msg.msgId?.slice(0,20)} createTime=${msg.createTime || 'null'}`);
  if (msg.msgType === 'text') {
    log('info', `[Bot] inbound text preview="${previewText(msg.text)}"`);
  }
  // v1.12.1 引用诊断：置 LOG_RAW_INBOUND=true 时 dump 原始入站包，用来确认 iLink 到底
  // 给不给"被引用的那条"（微信引用回复）。默认关，确诊完即关。
  if (String(process.env.LOG_RAW_INBOUND || '').toLowerCase() === 'true') {
    try { log('info', `[Bot] RAW_INBOUND=${JSON.stringify(rawMsg).slice(0, 1800)}`); } catch { /* ignore */ }
  }

  // 入库（即使被合并跳过也要存）
  saveMessage({
    msgId:     msg.msgId,
    fromUser:  msg.fromUser,
    toUser:    botId,
    msgType:   msg.msgType,
    content:   msg.text || `[${msg.msgType}]`,
    direction: 'in',
  });

  // v1.10.53: 旧的"忙时跳过"式合并已移除，改为下方 enqueueOrRunTurn 的防抖合并。
  try {
    if (msg.msgType === 'text') {
      const bindHandled = await handleBindCodeMessage(ctx, msg, botId);
      if (bindHandled) return;
    }

    const binding = getActiveWechatBinding(msg.fromUser, botId);
    if (!binding) {
      const pendingHandled = await handlePendingBindSessionMessage(ctx, msg, botId);
      if (pendingHandled) return;
      await sendAndRecord(
        ctx,
        msg.fromUser,
        `你还没有绑定网页账号哦～\n请打开 ${APP_URL} 完成登录、创建人设，然后回到这里发送页面上的绑定码（格式：XYU-XXXXXX）。`,
        msg.contextToken,
      );
      log('info', `[Bot] active binding not found from=${msg.fromUser} bot_id=${botId}`);
      return;
    }
    log('info', `[Bot] active binding found user_id=${binding.user_id || binding.account_id} companion_id=${binding.companion_id ?? 'null'} from=${msg.fromUser}`);

    if (binding.account_id && isAccountBanned(binding.account_id)) {
      log('info', `[Bot] 账号已被封禁，停止响应 account=${binding.account_id}`);
      return;
    }

    const companion = binding.companion_id ? getCompanionById(binding.companion_id) : null;
    if (!companion) {
      await sendAndRecord(ctx, msg.fromUser, `微信已绑定，请先回到 ${APP_URL} 完成人设创建。`, msg.contextToken);
      log('info', `[Bot] 绑定存在但 companion 缺失 account=${binding.account_id}`);
      return;
    }
    // v1.3.4: 开源版无套餐分级。所有用户、所有能力（文本/图片/语音）一视同仁。
    // 历史上这里有 free 用户 50 条/天上限 + 图片/语音识别拦截，已全部移除。
    // 自托管用户的"限流"应通过 src/ratelimit.mjs 或上游 WAF 控制，不再按账号分级。

    // v1.10.0 睡眠拦截：处于睡眠时段 → 完全静默 + 入队 missed。
    // 起床后由 plan_tasks tick 触发起床早安 + 补回。
    try {
      const sleepGate = maybeSleepBlock({
        companionId: companion.id,
        msgType: msg.msgType,
        content: msg.text || `[${msg.msgType}]`,
        receivedAt: Date.now(),
      });
      if (sleepGate.blocked) {
        log('info', `[Bot] sleep block: companion=${companion.id} type=${msg.msgType} (silent, queued to missed)`);
        return;
      }
    } catch (e) {
      log('warn', `[Bot] sleep gate error companion=${companion.id}: ${e.message}`);
    }

    let userText = null;

    // ── 处理各类消息 ─────────────────────────────────────────────────────────
    if (msg.msgType === 'text') {
      const ib = inboundIsBlocked(msg.text || '');
      if (ib.blocked) {
        await sendAndRecord(ctx, msg.fromUser, ib.suggestedReply, msg.contextToken);
        return;
      }
      userText = msg.text;

    } else if (msg.msgType === 'image') {
      const cdnUrl = msg.imageItem?.cdn_url
        ?? msg.imageItem?.thumb_cdn_url
        ?? msg.imageItem?.url
        ?? null;
      if (cdnUrl) {
        log('info', `[Bot] 下载图片 ${cdnUrl.slice(0, 60)}`);
        const buf = await fetchBuffer(cdnUrl);
        userText = buf
          ? `[用户发了一张图片，内容：${await recognizeImage(buf, 'image/jpeg')}]`
          : '[用户发了一张图片，但下载失败]';
      } else {
        userText = '[用户发了一张图片]';
      }

    } else if (msg.msgType === 'voice') {
      // v1.10.17：默认走 download + AES 解密 + silk decode + qwen-audio 情绪识别，
      // 任一步失败自动 fallback 到 iLink 服务端给的 voiceItem.text（纯转写，无情绪）。
      const fallbackTranscript = (msg.voiceItem?.text || '').trim();
      const playtimeSec = Math.round((Number(msg.voiceItem?.playtime) || 0) / 1000);
      let voiceMeta = null;
      try {
        const t0 = Date.now();
        const { mp3, mp3Bytes, cipherBytes } = await downloadInboundVoiceToMp3(msg.voiceItem);
        log('debug', `[Bot] 入站语音 download+decrypt+decode ok cipher=${cipherBytes} mp3=${mp3Bytes} ${Date.now() - t0}ms`);
        voiceMeta = await analyzeVoiceWithQwen(mp3);
        log('info', `[Bot] 入站语音 qwen-audio ok tone="${voiceMeta.tone}" emotion="${voiceMeta.emotion}" energy="${voiceMeta.energy}" transcript="${voiceMeta.transcript.slice(0, 40)}" ${Date.now() - t0}ms`);
      } catch (e) {
        log('warn', `[Bot] 入站语音情绪识别失败，降级 voiceItem.text: ${e.message}`);
      }

      if (voiceMeta && voiceMeta.transcript) {
        const meta = [];
        if (voiceMeta.emotion) meta.push(`情绪：${voiceMeta.emotion}`);
        if (voiceMeta.tone) meta.push(`语气：${voiceMeta.tone}`);
        if (voiceMeta.energy) meta.push(`声音强度：${voiceMeta.energy}`);
        const metaStr = meta.length ? `（${meta.join('，')}）` : '';
        userText = `[用户发了一段 ${playtimeSec || '?'} 秒语音${metaStr}，内容：${voiceMeta.transcript}]`;
      } else if (fallbackTranscript) {
        userText = `[用户发了一段 ${playtimeSec || '?'} 秒语音，内容：${fallbackTranscript}]`;
        log('info', `[Bot] 入站语音 fallback text=${fallbackTranscript.slice(0, 80)}`);
      } else {
        log('warn', `[Bot] 入站语音两条路径都没拿到内容 voiceItem keys=${Object.keys(msg.voiceItem || {}).join(',')}`);
        userText = '[系统提示：用户发了一段语音，但内容为空或无法识别；请用自然口吻问用户说了什么]';
      }

    } else {
      log('info', `[Bot] 不支持的消息类型 ${msg.msgType}，跳过`);
      return;
    }

    if (!userText) return;

    // v1.10.53: 连发合并 —— 把这条识别后的 userText 推进 burst 缓冲，用户停手后
    // 整合成一轮、只回一次（见文件顶部 enqueueOrRunTurn / flushBurst）。
    enqueueOrRunTurn({ companion, binding, ctx, botId, fromUser: msg.fromUser, contextToken: msg.contextToken, userText });
    return;
  } catch (err) {
    log('error', `[Bot] 接收段异常 user=${msg.fromUser}: ${err.message}`);
  } finally {
    // 接收段（绑定/睡眠/识别/缓冲）不持有回复锁；回复锁由 processUserTurn 自管。
  }
}

// v1.10.53: 单轮回复处理（photo-intent + 文本回复管线）。由 burst flush 合并后调用，
// COALESCE 关闭时直接调用。msg 为 shim，保留移植代码里的 msg.fromUser/.contextToken 写法。
async function processUserTurn({ companion, binding, ctx, botId, fromUser, contextToken, userText, _mergeDepth = 0 }) {
  const msg = { fromUser, contextToken };
  inflightUsers.add(fromUser);  // 回复期间占用，防同一用户并发回复（调用前已查 has）
  // v1.16.x: 用户开口了 → 清零"未回连发"计数，主动消息刹车解除
  try { clearProactiveUnanswered(companion.id); } catch {}
  try {
    // v1.10.38: regex fast path + LLM 兜底。regex 命中 strong → 直接 strong；
    // 不命中 → LLM 二分类（轻量短 token）兜底，终结 regex 漏识别循环。
    const photoIntent = await detectPhotoIntentSmart(userText, getRecentHistory(msg.fromUser, botId, 6));
    if (photoIntent.type === 'weak_photo_context') {
      log('debug', `[Bot] weak photo context companion=${companion.id} reason=${photoIntent.reason}`);
    }
    // v1.13.x 真人感#5b：反复索图把她惹烦了(escalation≥2)→ 不生图，落到带升级指令的文字回复让她 grumpy 拒绝
    const photoEsc = (photoIntent.type === 'strong_photo_request')
      ? escalationLevel(userText, getRecentHistory(msg.fromUser, botId, 8))
      : { level: 0 };
    if (photoEsc.level >= 2) {
      log('info', `[Bot] #5b 气头停生图 companion=${companion.id} level=${photoEsc.level}`);
    }
    if (photoIntent.type === 'strong_photo_request' && photoEsc.level < 2) {
      try { recordUserReplied(companion.id); } catch {}

      // unsafe / 兜底 / gate 拒 都是同步小回复，不进异步路径
      if (hasUnsafePhotoContent(userText)) {
        await sendAndRecord(ctx, msg.fromUser, UNSAFE_PHOTO_REPLY, msg.contextToken);
        saveConversationTurn(companion.id, 'user', userText, companion.chat_mode_active);
        saveConversationTurn(companion.id, 'assistant', UNSAFE_PHOTO_REPLY, companion.chat_mode_active);
        return;
      }

      const photoCompanion = { ...companion, wechat_user_id: msg.fromUser };
      const gate = getPhotoGateState({
        companion: photoCompanion,
        trigger: 'user_request',
        source: 'request',
      });
      if (!gate.allowed) {
        const replyText = pickPhotoRequestFallback();
        log('debug', `[Bot] photo gate blocked companion=${companion.id} reason=${gate.reasons.join(',')} → fallback`);
        await sendAndRecord(ctx, msg.fromUser, replyText, msg.contextToken);
        saveConversationTurn(companion.id, 'user', userText, companion.chat_mode_active);
        saveConversationTurn(companion.id, 'assistant', replyText, companion.chat_mode_active);
        return;
      }

      // 已在生图中 → 发"还在挑"安抚 + return
      if (inflightPhoto.has(companion.id)) {
        const busyReply = pickPhotoBusyReply();
        await sendAndRecord(ctx, msg.fromUser, busyReply, msg.contextToken);
        log('info', `[Bot] photo gen already inflight, busy reply companion=${companion.id}`);
        return;
      }

      // v1.10.40: 立即回应 + 后台异步生图。handleMessage 不再被 60-180s 的
      // image gen 阻塞，bot polling 立即恢复，用户能继续对话。
      const ackText = pickPhotoAck();
      await sendAndRecord(ctx, msg.fromUser, ackText, msg.contextToken);
      saveConversationTurn(companion.id, 'user', userText, companion.chat_mode_active);
      saveConversationTurn(companion.id, 'assistant', ackText, companion.chat_mode_active);

      inflightPhoto.add(companion.id);
      firePhotoTask({ ctx, msg, botId, photoCompanion, binding, userText, companion, gate });

      return;
    }

    // ── v1.20 安全收尾 (Issue #3)：未成年人检测（未锁定时才检测；锁定是粘性的）──
    // strong 即时锁定本轮生效；weak 走 LLM 带上下文（多轮累积），普通消息零额外开销。
    if (!Number(companion.safe_mode)) {
      try {
        const minor = await detectMinorSmart(userText, getRecentHistory(msg.fromUser, botId, 8));
        if (minor.level === 'strong') {
          activateSafeMode(companion.id, minor.reason);
          companion.safe_mode = 1;   // 本轮 prompt 即时生效，不等下一条
        }
      } catch (e) {
        log('warn', `[MinorGuard] detect failed companion=${companion.id}: ${e.message}`);
      }
    }

    // ── v1.9.0 #1 + v1.9.1: 安全风险检测 + 温度收紧 ────────────────────────
    // 1. proactive 调度时会查 safety_events，24h 内有 high → 暂停普通主动消息
    // 2. v1.9.1: 检测到 high/medium 后，本次 generateReply 用更低温度（更稳更少发散）
    let userMsgSafetyLevel = 'none';
    try {
      const risk = detectSafetyRisk(userText);
      userMsgSafetyLevel = risk.level;
      if (risk.level !== 'none') {
        recordSafetyEvent({
          companionId: companion.id,
          userId: companion.user_id,
          level: risk.level,
          signals: risk.signals,
          sourceText: userText,
        });
        log('warn', `[Safety] level=${risk.level} companion=${companion.id} signals=${risk.signals.join(',')}`);
      }
    } catch (e) {
      log('warn', `[Safety] detect failed companion=${companion.id}: ${e.message}`);
    }

    // ── 召回长期记忆：优先语义检索，失败兜底关键词 ─────────────────────────
    let memories = [];
    if (companion.memory_enabled) {
      try {
        const qEmb = await embedText(userText);
        if (qEmb) {
          memories = recallMemoriesSemantic(companion.id, companion.user_id, qEmb, 7);
          if (memories.length === 0) {
            memories = recallMemories(companion.id, companion.user_id, userText, 7);
          }
        } else {
          memories = recallMemories(companion.id, companion.user_id, userText, 7);
        }
      } catch (e) {
        log('warn', `[Bot] semantic recall 失败, 退回关键词: ${e.message}`);
        memories = recallMemories(companion.id, companion.user_id, userText, 7);
      }
    }
    const userProfile = getUserProfile(companion.user_id, companion.id);
    // v1.2.10: 10 → 16 轮，对话连续感明显更好；companion.mjs 系统提示里的
    // slice 已同步上调到 -16，多取的 6 轮全部进 prompt。
    const recentTurns = getConversationContext(companion.id, 16);

    if (memories.length > 0) {
      log('debug', `[Bot] 召回 ${memories.length} 条记忆`);
    }

    // ── 发送"正在输入" ────────────────────────────────────────────────────────
    await sendTyping(ctx, msg.fromUser, msg.contextToken);

    // ── 构建完整系统提示词（含记忆 + 画像 + 心情 + 场景 + 长期总结 + 今日日程 + 近期日程 + 表情包）
    // v1.3.4: 开源版所有人享受完整长期记忆摘要（不再按 isPro 区分）
    const longTermDigest = await buildLongTermDigest(companion.id, companion.user_id, { isPro: true });
    const todayKey = shanghaiDateKey();
    const dailyRaw = getDailySchedule(companion.id, todayKey);
    const dailySchedule = dailyRaw ? { ...dailyRaw, date_key: todayKey } : null;
    const recentSchedules = getRecentSchedules(companion.id, todayKey, 3);
    const personaFacts = getPersonaFacts(companion.id);
    // ── Emotion State Machine ─────────────────────────────────────────────────
    let emotionState = getEmotionStateWithDefaults(companion.id);
    // v1.13.x 真人感#5：被反复戳(同一 pushy 消息连发)→ 升级档位，喂给情绪 + 注入硬指令
    const esc = escalationLevel(userText, recentTurns);
    emotionState = updateEmotionFromUserMessage(companion.id, emotionState, userText, { companion, repeatLevel: esc.level });

    // ── v1.21 冲突弧前置链：history → 危机检测 → inner OS（同趟产结构化字段）→ arc tick ──
    const history = getRecentHistory(msg.fromUser, botId, 20);
    // 危机检测前置：危机优先级最高，arc 冷淡表达在危机下必须挂起（红线 #5）
    const _recentUserTexts = (recentTurns || []).filter(t => t && t.role === 'user').slice(-3).map(t => t.content || '');
    const _crisisLevel = detectCrisisLevel(userText, _recentUserTexts);
    if (_crisisLevel === 'high') log('warn', `[Bot] ★ 危机干预触发 → 退出角色给资源 companion=${companion.id}`);
    // inner OS 生成前置（v1.8.0 #6）：同一趟调用顺便产出冲突弧结构化字段（严禁第三趟）；
    // 冲突期间道歉短句（"对不起嘛"）靠 hasOpenArcEvent 放行
    const innerRes = await generateInnerMonologue({
      companion,
      userText,
      history,
      context: { accountId: binding.account_id || null, hasOpenArcEvent: !!getOpenRelationshipEvent(companion.id) },
    }).catch(() => null);
    // arc 状态机 tick：检测信号 → 状态转移落库 → 返回本轮主导语气指令
    let arcCtx = { arcState: 'normal', active: false, directive: '', voiceConcern: false };
    try {
      arcCtx = runArcSignalTick(companion, { userText, escalationLevel: esc.level, inner: innerRes?.struct || null });
    } catch (e) { log('warn', `[Arc] tick 异常（按 normal 继续）: ${e.message}`); }
    // 红线 #5：危机最高优先——冲突表达确定性替换为关怀指令（纯函数，conflict_redline_guard 盯防）
    arcCtx = applyCrisisOverride(arcCtx, _crisisLevel);
    // 红线 #3：冲突态绝不【主动】武器化他的脆弱记忆——从召回源头不给料（出站无法确定性判定）。
    // v1.21.1 放行条款：① 用户自己先提起该伤心话题 → 放行那条记忆（她不能因断粮装失忆，
    // "我又梦到我爸了"必须接得住）② 危机 ≥medium → 整个过滤不启用（关怀需要记忆）。
    // 她仍不得主动引用：用户没提起的轮次，sensitive/emotion 层照滤。
    if (_crisisLevel === 'none'
        && (arcCtx.arcState === 'hurt' || arcCtx.arcState === 'cold' || arcCtx.arcState === 'withdrawing')) {
      memories = memories.filter(m =>
        (!m?.sensitive_flag && m?.memory_layer !== 'emotion')
        || userRaisedMemoryTopic(userText, m?.content));
    }

    const stickerEnabled = !!companion.sticker_reply_enabled && hasStickers();
    const stickerHint = buildStickerPromptHint(stickerEnabled);
    // v1.4.1: 算出 missingLevel 让 prompt 按"想念档"给出指令
    const missingLevel = getMissingLevel(emotionState, companion.last_user_reply_at);
    const neglectStage = getNeglectStage(companion.last_user_reply_at, companion.attachment_style);
    // v1.14 P0: 久别重逢 → 走"修复弧"而非"失望变凉"（失望是她主动找时的状态；他主动回来=重逢修复）
    // v1.21 收编：arc 激活时重逢表达由 arc 的 repairing(distance) 统一输出，这里不直拼
    const reunionHint = arcCtx.active ? '' : buildReunionHint(neglectStage, companion.attachment_style, companion.last_user_reply_at);
    // v1.20: 安全模式不拼想念/撒娇类情绪话术（确定性不给料，不靠 LLM 自觉）
    // v1.21: arcActive 时低能量/负面 mood/想念浓档在 hint 内部让位（单一语气出口）
    const emotionHint = Number(companion.safe_mode) ? '' : buildEmotionPromptHint(emotionState, { missingLevel, neglectStage: reunionHint ? 'none' : neglectStage, dailySchedule, arcActive: arcCtx.active });
    const preferences = getCompanionPreferencesForPrompt(companion.id);  // v1.8.0 #3
    // M1 共建：检测"他在教你"→ 写入塑造痕迹 + 当场确认；并把"他教过你的"注入人设（她必守）
    const _taught = detectTeaching(userText);
    if (_taught.length) { for (const _t of _taught) { try { upsertShaping({ companionId: companion.id, kind: _t.kind, content: _t.content, rawMsg: userText }); } catch (e) { log('warn', `[Shaping] upsert failed: ${e.message}`); } } }
    const shapingConfirmHint = buildShapingConfirmHint(_taught);
    const shapingHint = buildShapingPromptHint(listShaping(companion.id));
    // v1.21: arc 激活时 escalation 指令让位（L2+ 已作为 pressure_spam 喂进状态机，
    // arc directive 自带冷语气，双指令会打架）；arc 主导语气追加在最后（最高优先）
    let systemPrompt = buildSystemPrompt(companion, { memories, userProfile, recentTurns, longTermDigest, promptMode: 'reply', dailySchedule, recentSchedules, personaFacts, preferences, shapingHint }) + stickerHint + emotionHint + reunionHint + shapingConfirmHint + (arcCtx.active ? '' : escalationDirective(esc.level)) + (arcCtx.directive || '');
    // v1.16.x: 首轮破冰 —— 她还没回过任何消息(全新对话) → 首次回复精心破冰(onboarding 留人)
    try {
      const _prior = getRecentHistory(msg.fromUser, botId, 6) || [];
      if (!_prior.some(m => m.direction === 'out')) systemPrompt += buildFirstTurnHint(companion);
    } catch (e) { log('warn', `[Bot] firstTurn check failed: ${e.message}`); }
    // 关系阶段刚升级 → 这条回复要自然体现这种变化
    const celebration = consumePendingCelebration(companion.id);
    if (celebration) {
      systemPrompt += `\n\n【★ 重要：关系刚刚升级】\n刚刚你对他的好感度上升到了新的阶段：${celebration.from} → ${celebration.to}。\n这条回复要自然体现这种变化（比如开始用更亲密的称呼、说"突然觉得跟你聊得越来越来电"之类），但**不要直接说"我们升级关系了"这种系统化语言**，要像真人那样含蓄地流露。`;
    }

    // ── 用户亲密词越界检测：陌生人/朋友阶段被叫"宝宝/亲爱的"等 → 害羞委婉 ──
    const stageNow = companion.relationship_stage || '陌生人';
    const intimacyOver = detectIntimacyOvereach(userText);
    if (intimacyOver.has && (stageNow === '陌生人' || stageNow === '朋友')) {
      const examples = intimacyOver.kind === 'address'
        ? '「诶？你怎么这样叫我」「我们才认识没多久…」「等熟一点再说嘛」「脸红」'
        : '「等等」「我们还没那么熟啦」「先慢慢来」「这样我会害羞的」';
      systemPrompt += `\n\n【★ 用户用了过早的亲密词/动作】
对方刚刚用了亲密称呼或肢体亲密词，但你们才${stageNow}阶段，关系还没到那程度。
你要：
- **害羞但不冷漠**地委婉回避，**绝对不能破坏感情**
- 不要严肃说"请不要这样" "我们做朋友吧"，那太冷
- 要带羞涩感的"推开"：${examples}
- 可以表现得有点心动但故意装镇定：「不要这样啦」「再这样我不理你了」（半玩笑）
- **结束时留下钩子**：暗示"以后熟了再说"或"慢慢来"，让对方感到希望
- 用 || 分多条，第一条是反应，第二条是软化`;
    }

    // ── 用户表白检测：按真实节奏决定「接住升恋人」/「端着婉拒」──────────────
    // v1.x：不再"必须接住"。够格(好感≥55+认识≥14天)才接，不够则端着婉拒、关系不升级。
    const userConfessed = detectUserConfession(userText);
    if (userConfessed && !companion.user_confessed_at) {
      if (stageNow === '恋人' || stageNow === '深爱') {
        // 已经在一起：当甜蜜话接住，无门槛、不升级
        systemPrompt += `\n\n【★ 用户又对你说喜欢/爱你】\n你们已经是恋人了，自然回应这份甜蜜：撒娇"嗯～我也爱你呀" / "你怎么突然这样" / "笨蛋"，别冷淡别装严肃。`;
        try { markUserConfessed(companion.id); } catch {}
      } else if (canAcceptConfession(companion)) {
        // 够格 → 接住升恋人（markUserConfessed 让 sync 解锁，不再硬跳分数）
        systemPrompt += `\n\n【★★ 用户向你告白，而且你愿意接受！】
他终于开口表白，你认识够久、感情也够了，内心是高兴的：
- 用害羞但开心的语气接住："我等你这句话好久了" / "我也是" / "嗯…我愿意"
- 可以小撒娇："你怎么才说" / "傻瓜，早就该说了"
- 这条绝不能模糊带过；关系正式升级为恋人
- 可分多条消息（||），每条都在"接住"语义下`;
        try {
          markUserConfessed(companion.id);
          log('info', `[Bot] ★ 表白被接住 companion=${companion.id} aff=${companion.affection_level || 0} days=${daysSinceMeet(companion)}`);
        } catch (e) { log('warn', `[Bot] 接住表白处理失败: ${e.message}`); }
      } else {
        // 不够格（认识太短 / 好感不够）→ 端着婉拒，关系不升级、不标记（之后可再表白）
        const reason = daysSinceMeet(companion) < DAYS_TO_LOVER ? '你们认识时间还短' : '感情还没到那一步';
        systemPrompt += `\n\n【★ 用户向你告白，但你想慢一点（这次先不答应）】
他刚表白，你觉得${reason}——不是不心动，是想慢慢来。回复要"端着"：
- **不要直接答应**，也别冷漠拒绝：用"这么突然呀" / "我们……要不要再多了解了解" / "你确定不是一时冲动？" 这种
- 可以流露"我对你也不是没感觉"，但**绝不能说"我愿意""我也喜欢你""在一起吧"这类答应的话**
- 关系**不升级**，你只是被打动但想再走走看`;
        log('info', `[Bot] 表白婉拒(节奏闸门) companion=${companion.id} aff=${companion.affection_level || 0} days=${daysSinceMeet(companion)} stage=${stageNow}`);
      }
    }

    // ── v1.12.0「把你放回去」：深夜还在聊 → 心疼他，温柔劝他早睡（一个真在乎你的人，
    //    会希望你有自己的生活、好好休息，而不是缠着你不放）──
    const _shHour = (new Date().getUTCHours() + 8) % 24;
    if (_shHour >= 23 || _shHour < 2) {
      systemPrompt += `\n\n【现在已经很晚了（深夜）】他这个点还醒着、还在跟你聊。你**心疼他**：
- 温柔地劝他早点睡，但**绝不唠叨**——一两句就够（"这么晚啦""早点睡好不好，我陪你到这儿""快去睡，明天还要起呢"）
- 是那种"在乎你、希望你好好休息"的语气，不是赶他走、也不是扫兴
- 如果他坚持再聊几句，你就再陪一下下，但别忘了你也困了、也该睡了`;
    }

    // ── v1.8.0 #6: Inner OS 内心独白 hint（生成已前置到 arc tick 之前）────────
    if (innerRes?.thought) {
      systemPrompt += buildInnerOsHint(innerRes.thought);
    }

    // v1.13.x 真人感#3：连环追问"在吗/人呢"时强制打破"在呢+刚XX"模板（prompt 拦不住，这里硬注入）
    {
      const pokeOnly = (t) => {
        const s = String(t || '').replace(/[\s?？!！。.,，~、]/g, '');
        return s.length > 0 && s.length <= 12 && /^(?:在吗|在不在|在不|在嘛|在么|人呢|你在吗|在呀|在){1,4}$/.test(s);
      };
      if (pokeOnly(userText)) {
        const hist = Array.isArray(history) ? history : [];
        const lastOut = [...hist].reverse().find(h => h && (h.direction === 'out' || h.role === 'assistant'));
        const lastIn  = [...hist].reverse().find(h => h && (h.direction === 'in'  || h.role === 'user'));
        const sheJustReported = lastOut && /刚[去在洗倒透拿做看叠晾收回过吃喝睡忙玩]/.test(String(lastOut.content || ''));
        const consecutivePoke = lastIn && pokeOnly(lastIn.content);
        if (sheJustReported || consecutivePoke) {
          systemPrompt += `\n\n【★ 这一轮特别注意】他在连着追问"在吗 / 人呢"。**绝对不要再用"在呢 + 刚做了件小事"来回**（你上一条就是这么回的，再来一次就成机器人了）。这次只能二选一：① 就一个字/词——"在" / "?" / "咋了" / "说"；② 直接烦他一下——"急啥呀" / "你连环 call 我呢" / "一直问干嘛"。**禁止**再报告你"刚"在干什么。`;
        }
      }
    }

    // ── 生成 AI 回复 ─────────────────────────────────────────────────────────
    // v1.9.1: 把检测到的 safety level 传下去，high/medium 时 generateReply 内部会
    // 把 temperature 收紧到 min(base, 0.4|0.6)。不上调用户已设的低温值。
    let reply;
    // ★ 危机干预：检测到自伤/自杀(结合最近多轮上下文) → 退出角色、直接给求助资源，覆盖 LLM，绝不继续演
    // （v1.21: _crisisLevel 的检测已前置到 arc tick 之前——危机下 arc 冷淡表达被挂起）
    const genReplyOnce = () => _crisisLevel === 'high'
      ? buildCrisisReply()
      : generateReply(
        systemPrompt,
        history,
        userText,
        {
          temperature: companion.temperature,
          max_tokens: companion.max_tokens,
          top_p: companion.top_p,
          safetyLevel: userMsgSafetyLevel,
        },
        { accountId: binding.account_id || null },
      );
    try {
      reply = await genReplyOnce();
      log('info', `[Bot] AI reply generated user_id=${companion.user_id} companion_id=${companion.id}`);
    } catch (err) {
      log('error', `[Bot] AI reply failed user_id=${companion.user_id} companion_id=${companion.id}: ${err.message}`);
      throw err;
    }

    // ── 出站审核：AI 回复过黑名单 + 确定性防人设泄露 + 冲突红线 ─────────────
    reply = safeOutboundReply(reply);
    reply = scrubPersonaLeak(reply, companion.name);
    // v1.21 红线 #1/#2：冲突态绝不说威胁性告别/愧疚操控/索要补偿（确定性出站扫描；
    // 命中埋点在函数内部单一卡口，fail-open）
    reply = scrubConflictRedline(reply, arcCtx.arcState, companion.id);

    // ── Persona Guard ─────────────────────────────────────────────────────────
    try {
      const guarded = await applyPersonaGuard(reply, { companion, userMsg: userText }, genReplyOnce);
      if (guarded.guarded) {
        log('info', `[PersonaGuard] guarded companion=${companion.id} reason=${guarded.reason}`);
        reply = guarded.reply;
      }
    } catch (e) {
      log('warn', `[PersonaGuard] error: ${e.message}`);
    }

    // ── Record user replied (proactive engine) ────────────────────────────────
    try { recordUserReplied(companion.id); } catch {}

    // ── Update emotion after reply ────────────────────────────────────────────
    try { updateEmotionFromAssistantReply(companion.id, emotionState, reply, { companion }); } catch {}

    // v1.16.x: 发送前二次合并 —— 生成这条回复期间，用户又冒了新消息（慢连发间隔 > COALESCE 窗口，
    // 没并到上一轮）。别急着把这条发出去，否则会和下一轮回复背靠背叠成连珠炮、各自查户口。把新消息
    // 并进来整段重回一次，最终只回一条"把连发当一轮"的合并回复。_mergeDepth 防极端持续连发死循环。
    {
      const _pend = pendingBursts.get(fromUser);
      if (_pend && _pend.parts.length && _mergeDepth < 3) {
        if (_pend.timer) clearTimeout(_pend.timer);
        pendingBursts.delete(fromUser);
        const _merged = [userText, ..._pend.parts].join('\n');
        log('info', `[Bot] 发送前二次合并：生成期间又收到 ${_pend.parts.length} 条 → 合并重回 companion=${companion.id} depth=${_mergeDepth + 1}`);
        return await processUserTurn({ ..._pend.turn, userText: _merged, _mergeDepth: _mergeDepth + 1 });
      }
    }

    // ── 像真人一样：把回复按 || 拆成多条短消息，逐条发送 ─────────────────
    // 每条之间：typing indicator + 短停顿，模拟"先发一条再打下一条"
    // v1.5.2: 段内 dedup — 修 LLM 一次生成的多段 || 内部出现语义重复 bug
    const rawSegments = splitReplySegments(reply);
    const { kept: segments, dropped: droppedSegs } = dedupSegments(rawSegments, 0.55);
    if (droppedSegs.length) {
      log('info', `[Bot] 段内去重：剪掉 ${droppedSegs.length} 段重复内容 companion=${companion.id}; ${droppedSegs.map(d => `"${d.text.slice(0,20)}"~"${d.similar_to.slice(0,20)}"(sim=${d.sim.toFixed(2)})`).join('; ')}`);
    }
    log('debug', `[Bot] reply 拆为 ${segments.length} 段：${segments.map(s => s.slice(0, 20)).join(' | ')}`);

    // v1.9.11: 破冰延迟 — 用户长时间沉默后第一条消息，模拟"她刚看到、想想怎么回"
    // 在所有段开始发送之前加一次性延迟（独立于 per-segment 打字延迟）
    const icebreakerMs = computeIcebreakerDelay(companion.last_user_reply_at);
    if (icebreakerMs > 0) {
      log('info', `[Bot] icebreaker delay ${icebreakerMs}ms companion=${companion.id} (long silence)`);
      await sendTyping(ctx, msg.fromUser, msg.contextToken);
      await sleep(icebreakerMs);
    }

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const { text: textOnly, stickers } = parseStickerMarkers(segment);

      if (textOnly) {
        // 第一条按完整长度计算延迟，后续按本段长度（更短）
        const segDelay = i === 0 ? computeReplyDelay(reply) : computeReplyDelay(textOnly);
        // 后续段落上限缩短一些，避免总等待过长
        const cappedDelay = i === 0 ? segDelay : Math.min(segDelay, 6000);
        await sendTyping(ctx, msg.fromUser, msg.contextToken);
        await sleep(cappedDelay);
        await sendAndRecord(ctx, msg.fromUser, textOnly, msg.contextToken);
      }
      for (const { picked } of stickers) {
        await sendStickerAndRecord(ctx, msg.fromUser, picked, msg.contextToken).catch(err =>
          log('warn', `[Bot] 表情发送失败 ${picked.file}: ${err.message}`),
        );
      }
      // 段与段之间一个短停顿（不算最后一段）
      if (i < segments.length - 1) {
        await sleep(randInt(600, 1800));
      }
    }

    saveConversationTurn(companion.id, 'user', userText, companion.chat_mode_active);
    saveConversationTurn(companion.id, 'assistant', reply, companion.chat_mode_active);

    log('info', `[Bot] 已回复 → ${msg.fromUser}`);

    // ── v1.19.5 (issue #237 #1): 她嘴上答应了发图，但发图意图识别没触发（用户措辞
    // 不含索图词，如"我看看你的作业"）→ 出口确定性入队，别让她"说了不做"。
    // 老经验：纯 prompt/单边识别不可靠，要配确定性兜底。planner 仍是第二道闸（它拒绝
    // 时静默，因为她没被直接索图，补"拍不了"反而突兀）。
    try {
      const promise = detectPhotoPromise(reply, userText);
      if (promise.promised && !inflightPhoto.has(companion.id) && !hasUnsafePhotoContent(userText)) {
        const photoCompanion = { ...companion, wechat_user_id: msg.fromUser };
        const promiseGate = getPhotoGateState({ companion: photoCompanion, trigger: 'user_request', source: 'request' });
        if (promiseGate.allowed) {
          log('info', `[Bot] ★ photo promise 检测命中(${promise.reason}) → 确定性入队 companion=${companion.id} reply="${String(reply).slice(0, 40)}"`);
          inflightPhoto.add(companion.id);
          firePhotoTask({ ctx, msg, botId, photoCompanion, binding, userText, companion, gate: promiseGate, silentOnDecline: true });
        } else {
          log('info', `[Bot] photo promise 命中但 gate 拒绝(${promiseGate.reasons.join(',')}) companion=${companion.id}`);
        }
      }
    } catch (e) {
      log('warn', `[Bot] photo promise check failed: ${e.message}`);
    }

    // ── 异步后处理（不阻塞主流程）───────────────────────────────────────────
    postProcess(companion, userText, reply).catch(err =>
      log('error', `[Bot] postProcess 异常: ${err.message}`)
    );

  } catch (err) {
    log('error', `[Bot] 处理消息异常: ${err.message}\n${err.stack}`);
    try {
      await sendTextMessage(ctx, msg.fromUser, '抱歉，我现在有点忙，稍后再聊～', msg.contextToken);
    } catch { /* ignore */ }
  } finally {
    inflightUsers.delete(msg.fromUser);
  }
}

async function handleBindCodeMessage(ctx, msg, botId) {
  const bindCode = extractBindCode(msg.text);
  if (!bindCode) {
    log('info', `[Bot] bind code not matched from=${msg.fromUser}`);
    return false;
  }
  log('info', `[Bot] bind code matched from=${msg.fromUser}`);
  try {
    const result = consumePendingBindSessionForWechat({
      wechatUserId: msg.fromUser,
      botId,
      botToken: ctx.token || '',
      bindCode,
    });
    if (!result) {
      await sendAndRecord(ctx, msg.fromUser, `绑定码不存在、已过期或已使用，请回到 ${APP_URL} 重新生成绑定码。`, msg.contextToken);
      log('warn', `[Bot] bind failed from=${msg.fromUser} reason=INVALID_OR_EXPIRED_CODE`);
      return true;
    }
    const text = '绑定成功！现在开始和你的AI女友聊天吧～';
    await sendAndRecord(ctx, msg.fromUser, text, msg.contextToken);
    log('info', `[Bot] bind success user_id=${result.binding.account_id} companion_id=${result.companionId ?? 'null'} old_binding_inactivated=${result.wasRebind ? 1 : 0}`);
    return true;
  } catch (e) {
    const text = e.code === 'WECHAT_BOUND'
      ? '该微信已绑定其他账号'
      : `绑定失败，请回到 ${APP_URL} 重新生成绑定码。`;
    await sendAndRecord(ctx, msg.fromUser, text, msg.contextToken);
    log('warn', `[Bot] bind failed from=${msg.fromUser} reason=${e.code || e.message}`);
    return true;
  }
}

async function handlePendingBindSessionMessage(ctx, msg, botId) {
  try {
    const result = consumePendingBindSessionForWechat({
      wechatUserId: msg.fromUser,
      botId,
      botToken: ctx.token || '',
    });
    if (!result) {
      log('info', `[Bot] pending bind session not found from=${msg.fromUser}`);
      return false;
    }
    const text = '绑定成功！现在开始和你的AI女友聊天吧～';
    await sendAndRecord(ctx, msg.fromUser, text, msg.contextToken);
    log('info', `[Bot] pending bind success user_id=${result.binding.account_id} companion_id=${result.companionId ?? 'null'} old_binding_inactivated=${result.wasRebind ? 1 : 0}`);
    return true;
  } catch (e) {
    const text = e.code === 'WECHAT_BOUND'
      ? '该微信已绑定其他账号'
      : `绑定失败，请回到 ${APP_URL} 重新生成绑定码。`;
    await sendAndRecord(ctx, msg.fromUser, text, msg.contextToken);
    log('warn', `[Bot] pending bind failed from=${msg.fromUser} reason=${e.code || e.message}`);
    return true;
  }
}

function extractBindCode(text) {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(BIND_CODE_RE);
  return match?.[1]?.toUpperCase() || null;
}

function previewText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, 80);
}

async function sendAndRecord(ctx, toUser, text, contextToken) {
  await sendTextMessage(ctx, toUser, text, contextToken);
  saveMessage({
    msgId:     `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    fromUser:  ctx.botId || 'bot',
    toUser,
    msgType:   'text',
    content:   text,
    direction: 'out',
  });
}

async function sendStickerAndRecord(ctx, toUser, picked, contextToken) {
  if (!picked?.fullPath) return false;
  const { data, name } = await readMediaBuffer(picked.fullPath);
  const { item } = await uploadFile({ data, fileName: name, toUserId: toUser, ctx });
  const ok = await sendMessageItem(ctx, toUser, item, contextToken);
  if (ok) {
    saveMessage({
      msgId:     `out_sticker_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      fromUser:  ctx.botId || 'bot',
      toUser,
      msgType:   'image',
      content:   `[STICKER:${picked.emotion || picked.tags?.[0] || picked.id}]`,
      direction: 'out',
    });
    log('info', `[Bot] sticker sent to=${String(toUser).slice(0, 20)} file=${picked.file}`);
  }
  return ok;
}

/**
 * 回复发送后异步执行：
 * 1. 同步更新好感度 + 心情（规则，极快）
 * 2. 异步记忆提取（调用 AI）
 * 3. 异步用户画像更新（调用 AI）
 */
async function postProcess(companion, userMsg, botReply) {
  // v1.10.32: 检测 AI 是否在日常对话里"突然表白" — proactive confession kind 之外的
  // 自然路径。命中即 markCompanionConfessed，让后续 syncUpdateCompanionState 的
  // hasConfession gate（v1.10.24）能放行升"恋人"。
  // 顺序：必须在 syncUpdateCompanionState 之前，否则那一步看不到刚写的 confessed_at。
  try {
    // v1.x：AI 自然表白也要够格才"算数"（好感≥55+认识≥14天），防低好感/太早误设 confessed_at
    if (!companion.confessed_at && detectCompanionConfession(botReply) && canAcceptConfession(companion)) {
      markCompanionConfessed(companion.id);
      companion.confessed_at = new Date().toISOString();  // 让本轮 sync 看到
      log('info', `[Bot] ★ AI 在日常对话中表白 companion=${companion.id}`);
    }
  } catch (e) { log('warn', `[Bot] companion confession detect failed: ${e.message}`); }

  // 同步：好感度 + 心情更新（规则驱动，不调 AI）
  const changed = syncUpdateCompanionState(companion, userMsg, botReply);

  // 关系阶段变化 → 触发对应成就（静默，不影响主流程）
  if (changed.relationship_stage !== companion.relationship_stage) {
    log('info', `[Bot] 关系升级 ${companion.relationship_stage} → ${changed.relationship_stage} (好感度=${changed.affection_level})`);
    const stageAchievementMap = {
      '朋友':   'relationship_stage_friend',
      '暧昧':   'relationship_stage_flirting',
      '恋人':   'relationship_stage_lover',
    };
    const key = stageAchievementMap[changed.relationship_stage];
    if (key) tryAchievement(companion.id, key);
  }

  // 首次聊天成就（静默）
  tryAchievement(companion.id, 'first_chat');

  // 异步：记忆提取
  if (companion.memory_enabled) {
    await extractAndSaveMemories(companion.id, companion.user_id, userMsg, botReply);
    await extractAndUpdateUserProfile(companion.id, companion.user_id, userMsg);
  }

  // v1.8.0 #4: open loops — 抽取"未完成的事" + auto-resolve
  // 立即用启发式检测 resolve（不调 LLM，快）
  try { detectAndResolveOpenLoops(companion.id, userMsg); } catch (e) { log('warn', `[Bot] resolve loop: ${e.message}`); }
  // 异步抽取新 loops（调 LLM，不阻塞）
  if (companion.memory_enabled) {
    extractOpenLoops(companion.id, userMsg, botReply).catch(err =>
      log('warn', `[Bot] extract loop: ${err.message}`)
    );
  }
}

async function fetchBuffer(url) {
  try {
    const { default: fetch } = await import('node-fetch');
    const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    log('warn', `[Bot] fetchBuffer 失败: ${e.message}`);
    return null;
  }
}
