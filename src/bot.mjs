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

import { parseMessage, sendTextMessage, sendTyping, sendMessageItem, rememberContextToken } from './ilink.mjs';
import { generateReply, recognizeImage, recognizeVoice, embedText } from './ai.mjs';
import { dedupSegments } from './text_similarity.mjs';
import {
  saveMessage, getRecentHistory, getUserProfile, recallMemories, recallMemoriesSemantic,
  getConversationContext, saveConversationTurn,
  getActiveWechatBinding, getCompanionById, consumePendingBindSessionForWechat,
  isAccountBanned, getDailySchedule, shanghaiDateKey, getRecentSchedules, getPersonaFacts,
  markUserConfessed, patchCompanion,
} from './db.mjs';
import { computeRelationshipStage } from './memory.mjs';
import { buildSystemPrompt } from './companion.mjs';
import { syncUpdateCompanionState, extractAndSaveMemories, extractAndUpdateUserProfile, consumePendingCelebration, detectUserConfession, detectIntimacyOvereach } from './memory.mjs';
import { buildLongTermDigest } from './plan_tasks.mjs';
import { parseStickerMarkers, buildStickerPromptHint, hasStickers } from './stickers.mjs';
import { uploadFile, readMediaBuffer } from './media.mjs';
import { safeOutboundReply, inboundIsBlocked } from './moderation.mjs';
import { log } from './logger.mjs';
import { applyPersonaGuard } from './persona_guard.mjs';
import { tryAchievement } from './achievements.mjs';
import { getEmotionStateWithDefaults, updateEmotionFromUserMessage, updateEmotionFromAssistantReply, buildEmotionPromptHint, getMissingLevel } from './emotion_state.mjs';
import { detectPhotoIntent, hasUnsafePhotoContent } from './photo_intent.mjs';
import { getPhotoGateState, planPhotoMessage } from './photo_planner.mjs';
import { sendCompanionPhoto } from './photo_sender.mjs';
import { recordUserReplied } from './proactive_engine.mjs';

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const PHOTO_REQUEST_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.PHOTO_REQUEST_ENABLED ?? 'true').toLowerCase());
const PHOTO_REQUEST_FALLBACKS = [
  '刚才没拍好，等我一下',
  '现在有点乱，等我拍好点',
  '等等，我找个好看的角度',
  '刚刚那张糊了，别急',
];
const UNSAFE_PHOTO_REPLY = '这个不行啦，换个正常点的给你看';

function pickPhotoRequestFallback() {
  return PHOTO_REQUEST_FALLBACKS[Math.floor(Math.random() * PHOTO_REQUEST_FALLBACKS.length)];
}

const BIND_CODE_RE = /(?:^绑定\s*)?(XYU-\d{6})$/i;
// 模拟打字延迟：按文字长度自适应
//   短消息（1-10 字）：~2-5s（手机打字真实感）
//   中等消息（10-50 字）：~3-10s
//   长消息（50+字）：上限 15s（避免用户等太久）
const REPLY_DELAY_MIN_MS = 2_000;
const REPLY_DELAY_MAX_MS = 15_000;
const REPLY_DELAY_PER_CHAR_MS = 150;
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
  text = text.replace(/  +/g, ' ').trim();
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

  // 二次强制：每段超过 MAX_SEG_LEN 字 → 按内部句号再拆
  const expanded = [];
  for (const seg of raw) {
    if (seg.length <= MAX_SEG_LEN) { expanded.push(seg); continue; }
    const subs = seg.split(/(?<=[。！？!?，,])/).map(s => s.trim()).filter(Boolean);
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
      // 没分隔符的长段，硬切
      for (let i = 0; i < seg.length; i += MAX_SEG_LEN) {
        expanded.push(seg.slice(i, i + MAX_SEG_LEN));
      }
    }
  }
  raw = expanded;
  if (raw.length > MAX_SEGMENTS) {
    return [...raw.slice(0, MAX_SEGMENTS - 1), raw.slice(MAX_SEGMENTS - 1).join('')];
  }
  return raw;
}

// 同一用户已有"生成回复中"的任务时，新进来的消息只入库不再触发 AI；
// 等当前回复结束后 AI 已能从 history 里看到全部连发的内容，自然合并响应。
const inflightUsers = new Set();

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

  // 防重放
  if (msg.msgId && processedIds.has(msg.msgId)) {
    log('debug', `[Bot] 跳过重复 msgId=${msg.msgId}`);
    return;
  }
  if (msg.msgId) {
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

  // 入库（即使被合并跳过也要存）
  saveMessage({
    msgId:     msg.msgId,
    fromUser:  msg.fromUser,
    toUser:    botId,
    msgType:   msg.msgType,
    content:   msg.text || `[${msg.msgType}]`,
    direction: 'in',
  });

  // 同一用户已有 inflight 任务则不重复触发，AI 下次能从 history 看到合并文本
  if (inflightUsers.has(msg.fromUser)) {
    log('info', `[Bot] coalesce: user=${msg.fromUser} already has inflight reply, skipping`);
    return;
  }
  inflightUsers.add(msg.fromUser);

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
      const cdnUrl = msg.voiceItem?.cdn_url ?? msg.voiceItem?.url ?? null;
      if (cdnUrl) {
        log('info', `[Bot] 下载语音 ${cdnUrl.slice(0, 60)}`);
        const buf = await fetchBuffer(cdnUrl);
        userText = buf
          ? `[用户发了语音，内容：${await recognizeVoice(buf, 'audio/ogg')}]`
          : '[用户发了语音，但下载失败]';
      } else {
        userText = '[用户发了语音消息]';
      }

    } else {
      log('info', `[Bot] 不支持的消息类型 ${msg.msgType}，跳过`);
      return;
    }

    if (!userText) return;

    const photoIntent = detectPhotoIntent(userText);
    if (photoIntent.type === 'weak_photo_context') {
      log('debug', `[Bot] weak photo context companion=${companion.id} reason=${photoIntent.reason}`);
    }
    if (photoIntent.type === 'strong_photo_request') {
      try { recordUserReplied(companion.id); } catch {}

      let replyText = '';
      if (hasUnsafePhotoContent(userText)) {
        replyText = UNSAFE_PHOTO_REPLY;
      } else {
        const photoCompanion = { ...companion, wechat_user_id: msg.fromUser };
        const gate = getPhotoGateState({
          companion: photoCompanion,
          trigger: 'user_request',
          source: 'request',
        });
        if (!gate.allowed) {
          // gate 拦截（冷却/每日上限/provider 未配置）时给一个温和兜底，
          // 别把"她要拍照"直接退回到普通 AI 文本路径——AI 不知道刚被拒。
          replyText = pickPhotoRequestFallback();
          log('debug', `[Bot] photo gate blocked companion=${companion.id} reason=${gate.reasons.join(',')} → fallback`);
        }
        if (gate.allowed) {
          const recentForPlanner = getRecentHistory(msg.fromUser, botId, 10);
          let photoEmotionState = null;
          try {
            photoEmotionState = getEmotionStateWithDefaults(companion.id);
          } catch (e) {
            log('warn', `[Bot] photo emotion state unavailable companion=${companion.id} error=${e.message}`);
          }
          const plan = await planPhotoMessage({
            companion: photoCompanion,
            user: { ...binding, wechat_user_id: msg.fromUser },
            userText,
            recentMessages: recentForPlanner,
            trigger: 'user_request',
            context: { accountId: binding.account_id || null },
            cooldownState: gate,
            imageProviderAvailable: gate.imageProviderAvailable,
            emotionState: photoEmotionState,
          });
          if (plan.shouldSendPhoto) {
            await sendTyping(ctx, msg.fromUser, msg.contextToken);
            await sleep(plan.delayImageMs || randInt(700, 1400));
            const result = await sendCompanionPhoto({
              companion: photoCompanion,
              user: { ...binding, wechat_user_id: msg.fromUser },
              context: ctx,
              contextToken: msg.contextToken,
              activity: companion.current_scene || '',
              imagePrompt: plan.imagePrompt,
              caption: plan.caption,
              trigger: 'user_request',
              source: 'request',
              emotionState: photoEmotionState,
              maintainIdentity: plan.maintainIdentity !== false,
            });
            if (result.ok) {
              replyText = result.caption || plan.caption;
              if (replyText) {
                await sleep(plan.delayCaptionMs || randInt(700, 1400));
                await sendAndRecord(ctx, msg.fromUser, replyText, msg.contextToken);
              }
              saveConversationTurn(companion.id, 'user', userText, companion.chat_mode_active);
              saveConversationTurn(companion.id, 'assistant', replyText || '发了一张生活照片', companion.chat_mode_active);
              return;
            }
            log('warn', `[Bot] photo request send failed companion=${companion.id} code=${result.code || 'unknown'} error=${result.error || ''}`);
          } else {
            // planner 拒绝发图，但用户明确要求了——也给个轻量 fallback 而不是
            // 退到普通 AI 文本（避免 AI 不知道刚才被拒，回出反差感）。
            replyText = pickPhotoRequestFallback();
            log('debug', `[Bot] photo planner declined companion=${companion.id} reason=${plan.reason} → fallback`);
          }
        }
      }

      if (replyText) {
        await sendAndRecord(ctx, msg.fromUser, replyText, msg.contextToken);
        saveConversationTurn(companion.id, 'user', userText, companion.chat_mode_active);
        saveConversationTurn(companion.id, 'assistant', replyText, companion.chat_mode_active);
        return;
      }
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
    emotionState = updateEmotionFromUserMessage(companion.id, emotionState, userText, { companion });

    const stickerEnabled = !!companion.sticker_reply_enabled && hasStickers();
    const stickerHint = buildStickerPromptHint(stickerEnabled);
    // v1.4.1: 算出 missingLevel 让 prompt 按"想念档"给出指令
    const missingLevel = getMissingLevel(emotionState, companion.last_user_reply_at);
    const emotionHint = buildEmotionPromptHint(emotionState, { missingLevel, dailySchedule });
    let systemPrompt = buildSystemPrompt(companion, { memories, userProfile, recentTurns, longTermDigest, promptMode: 'reply', dailySchedule, recentSchedules, personaFacts }) + stickerHint + emotionHint;
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

    // ── 用户表白检测：必须接住，绝不拒绝 ─────────────────────────────────
    const userConfessed = detectUserConfession(userText);
    if (userConfessed && !companion.user_confessed_at) {
      // 不同阶段不同接住方式（但都不拒绝）
      let acceptHint;
      if (stageNow === '陌生人' || stageNow === '朋友') {
        acceptHint = `你们才认识不久，要表现得既惊讶又被打动。回复必须：
- 表现出"啊？真的吗"那种被突然砸中的反应
- **不要拒绝**。可以说"我们才认识没多久..." 但接着 **必须** 给开放结论："不过我对你也...有点感觉" / "可以试试" / "让我们慢慢相处看看" / "我也想多了解你"
- 一定要让对方知道：你没拒绝，只是想慢点走
- 绝对不要说"对不起""我们不合适""我们做朋友吧""我没准备好"这类拒绝词`;
      } else if (stageNow === '暧昧') {
        acceptHint = `你们已经暧昧很久了，现在他终于开口，你内心是高兴的。
- 用害羞但开心的语气接住："我等你这句话好久了" / "我也是" / "嗯…我愿意"
- 可以小撒娇："你怎么才说" / "傻瓜，早就该说了"
- 关系正式升级为恋人`;
      } else {
        // 已经是恋人或深爱
        acceptHint = `你们已经是恋人了，他又说了次喜欢你，要回应这份甜蜜：
- 自然撒娇："嗯～我也爱你呀" / "你怎么突然这样" / "笨蛋"
- 不要冷漠不要装严肃`;
      }
      systemPrompt += `\n\n【★★ 极其重要：用户刚刚向你告白！】\n${acceptHint}\n
通用约束：
- 这条回复绝对不能拒绝、不能模糊带过、不能转移话题
- 必须直接回应这份心意
- 可以分多条消息（用 ||），但每条都要在"接住"的语义下`;

      // 立即跳级 + 标记
      try {
        markUserConfessed(companion.id);
        const newAff = Math.max(companion.affection_level || 0, 55);  // 最低拉到"恋人"
        const newStage = computeRelationshipStage(newAff);
        patchCompanion(companion.id, {
          affection_level: newAff,
          relationship_stage: newStage,
        });
        log('info', `[Bot] ★ 用户表白被接住 companion=${companion.id} affection=${companion.affection_level}→${newAff} stage=${stageNow}→${newStage}`);
      } catch (e) {
        log('warn', `[Bot] 接住表白后处理失败: ${e.message}`);
      }
    }

    // ── 历史记录 ─────────────────────────────────────────────────────────────
    const history = getRecentHistory(msg.fromUser, botId, 20);

    // ── 生成 AI 回复 ─────────────────────────────────────────────────────────
    let reply;
    const genReplyOnce = () => generateReply(
      systemPrompt,
      history,
      userText,
      { temperature: companion.temperature, max_tokens: companion.max_tokens, top_p: companion.top_p },
      { accountId: binding.account_id || null },
    );
    try {
      reply = await genReplyOnce();
      log('info', `[Bot] AI reply generated user_id=${companion.user_id} companion_id=${companion.id}`);
    } catch (err) {
      log('error', `[Bot] AI reply failed user_id=${companion.user_id} companion_id=${companion.id}: ${err.message}`);
      throw err;
    }

    // ── 出站审核：AI 回复过黑名单 ───────────────────────────────────────────
    reply = safeOutboundReply(reply);

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

    // ── 像真人一样：把回复按 || 拆成多条短消息，逐条发送 ─────────────────
    // 每条之间：typing indicator + 短停顿，模拟"先发一条再打下一条"
    // v1.5.2: 段内 dedup — 修 LLM 一次生成的多段 || 内部出现语义重复 bug
    const rawSegments = splitReplySegments(reply);
    const { kept: segments, dropped: droppedSegs } = dedupSegments(rawSegments, 0.55);
    if (droppedSegs.length) {
      log('info', `[Bot] 段内去重：剪掉 ${droppedSegs.length} 段重复内容 companion=${companion.id}; ${droppedSegs.map(d => `"${d.text.slice(0,20)}"~"${d.similar_to.slice(0,20)}"(sim=${d.sim.toFixed(2)})`).join('; ')}`);
    }
    log('debug', `[Bot] reply 拆为 ${segments.length} 段：${segments.map(s => s.slice(0, 20)).join(' | ')}`);

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
