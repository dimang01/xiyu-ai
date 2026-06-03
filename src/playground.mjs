/**
 * 浏览器 playground —— 不经过 iLink / 微信，直接在网页里跟 companion 聊天。
 *
 * 目标：让未拿到腾讯 iLink/ClawBot 准入的用户也能完整体验 AI 人设、
 *      长期记忆、关系阶段、情绪/好感度演进。
 *
 * 与 bot.mjs 主管线的差异：
 *   - 不发微信、不跑 sendTyping、不拆段分发；直接整段 JSON 返回
 *   - 不处理图片/语音/媒体（playground 只接受文本）
 *   - 仍然写 companion_conversation_turns 让记忆系统正常工作
 *   - postProcess 仍然异步执行（好感度 + 心情 + 记忆提取 + 画像更新）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { generateReply, embedText } from './ai.mjs';
import {
  recallMemoriesSemantic, recallMemories, getUserProfile, getConversationContext,
  getDailySchedule, getRecentSchedules, getPersonaFacts, shanghaiDateKey,
  saveConversationTurn, getCompanionById, patchCompanion,
  getCompanionPreferencesForPrompt,
  recordSafetyEvent,
} from './db.mjs';
import { buildSystemPrompt } from './companion.mjs';
import { buildLongTermDigest } from './plan_tasks.mjs';
import {
  computeRelationshipStage, syncUpdateCompanionState, detectIntimacyOvereach,
  detectUserConfession, consumePendingCelebration, extractAndSaveMemories,
  extractAndUpdateUserProfile,
} from './memory.mjs';
import { safeOutboundReply, detectSafetyRisk } from './moderation.mjs';
import { buildStickerPromptHint, hasStickers, parseStickerMarkers } from './stickers.mjs';
import {
  getEmotionStateWithDefaults, updateEmotionFromUserMessage,
  updateEmotionFromAssistantReply, buildEmotionPromptHint, getMissingLevel,
} from './emotion_state.mjs';
import { generateInnerMonologue, buildInnerOsHint } from './inner_os.mjs';
import { extractOpenLoops, detectAndResolveOpenLoops } from './open_loops.mjs';

/**
 * @param {object} companion 由调用方查好的 companion 行
 * @param {string} userText 用户输入（文本）
 * @returns {Promise<{reply:string, segments:string[], state:{mood, affection_level, relationship_stage}}>}
 */
export async function playgroundChat(companion, userText) {
  if (!companion) throw new Error('companion 不存在');
  const text = String(userText || '').trim();
  if (!text) throw new Error('userText 不能为空');
  if (text.length > 2000) throw new Error('userText 过长（>2000）');

  // ── v1.9.0 #1 + v1.9.1: 安全风险检测 + 温度收紧 ──────────────────────────
  let userMsgSafetyLevel = 'none';
  try {
    const risk = detectSafetyRisk(text);
    userMsgSafetyLevel = risk.level;
    if (risk.level !== 'none') {
      recordSafetyEvent({
        companionId: companion.id,
        userId: companion.user_id,
        level: risk.level,
        signals: risk.signals,
        sourceText: text,
      });
      log('warn', `[Safety] level=${risk.level} companion=${companion.id} signals=${risk.signals.join(',')}`);
    }
  } catch (e) {
    log('warn', `[Safety] detect failed companion=${companion.id}: ${e.message}`);
  }

  // ── 召回长期记忆 ───────────────────────────────────────────────────────────
  let memories = [];
  if (companion.memory_enabled) {
    try {
      const qEmb = await embedText(text);
      if (qEmb) {
        memories = recallMemoriesSemantic(companion.id, companion.user_id, qEmb, 7);
        if (memories.length === 0) {
          memories = recallMemories(companion.id, companion.user_id, text, 7);
        }
      } else {
        memories = recallMemories(companion.id, companion.user_id, text, 7);
      }
    } catch (e) {
      log('warn', `[Playground] semantic recall 失败: ${e.message}`);
      memories = recallMemories(companion.id, companion.user_id, text, 7);
    }
  }

  const userProfile = getUserProfile(companion.user_id, companion.id);
  const recentTurns = getConversationContext(companion.id, 10);
  const todayKey = shanghaiDateKey();
  const dailyRaw = getDailySchedule(companion.id, todayKey);
  const dailySchedule = dailyRaw ? { ...dailyRaw, date_key: todayKey } : null;
  const recentSchedules = getRecentSchedules(companion.id, todayKey, 3);
  const personaFacts = getPersonaFacts(companion.id);
  const longTermDigest = await buildLongTermDigest(companion.id, companion.user_id, { isPro: true });

  const stickerEnabled = !!companion.sticker_reply_enabled && hasStickers();
  const stickerHint = buildStickerPromptHint(stickerEnabled);

  // v1.5.2 PR E: 跟 bot.mjs 路径对齐 — 每条用户消息都重算 7 维情绪并喂回 prompt。
  // 之前 playground 完全跳过 emotion_state，导致：
  //   1. 浏览器对话时她情绪不演化
  //   2. dashboard 看到的 7 维状态因 playground 对话停滞
  //   3. playground 回复缺"她想念档"口吻
  let emotionState = getEmotionStateWithDefaults(companion.id);
  emotionState = updateEmotionFromUserMessage(companion.id, emotionState, text, { companion });
  const missingLevel = getMissingLevel(emotionState, companion.last_user_reply_at);
  const emotionHint = buildEmotionPromptHint(emotionState, { missingLevel });

  // v1.8.0 #3: preferences 结构化偏好账本
  const preferences = getCompanionPreferencesForPrompt(companion.id);

  let systemPrompt = buildSystemPrompt(companion, {
    memories, userProfile, recentTurns, longTermDigest,
    promptMode: 'reply', dailySchedule, recentSchedules, personaFacts, preferences,
  }) + stickerHint + emotionHint;

  // 关系刚升级
  const celebration = consumePendingCelebration(companion.id);
  if (celebration) {
    systemPrompt += `\n\n【★ 重要：关系刚刚升级】\n刚刚你对他的好感度上升到了新的阶段：${celebration.from} → ${celebration.to}。\n这条回复要自然体现这种变化（比如更亲密的称呼、"突然觉得跟你聊得越来越来电"），但**不要直接说"我们升级关系了"**。`;
  }

  // 用户亲密词越界
  const stageNow = companion.relationship_stage || '陌生人';
  const intimacyOver = detectIntimacyOvereach(text);
  if (intimacyOver.has && (stageNow === '陌生人' || stageNow === '朋友')) {
    systemPrompt += `\n\n【★ 用户用了过早的亲密词】当前 ${stageNow} 阶段；要害羞但不冷漠地委婉回避，留"以后熟了再说"钩子；多条 || 分段。`;
  }

  // 用户表白
  const userConfessed = detectUserConfession(text);
  if (userConfessed && !companion.user_confessed_at) {
    systemPrompt += `\n\n【★★ 用户向你告白】必须接住。不能拒绝，不能转移话题。多条 || 分段。`;
    try {
      const newAff = Math.max(companion.affection_level || 0, 55);
      const newStage = computeRelationshipStage(newAff);
      patchCompanion(companion.id, {
        affection_level: newAff,
        relationship_stage: newStage,
        user_confessed_at: new Date().toISOString(),
      });
    } catch (e) {
      log('warn', `[Playground] 表白后处理失败: ${e.message}`);
    }
  }

  // history：playground 没有 wechat 历史，用 recent conversation turns 拼一份
  const history = recentTurns.slice(-10).map(t => ({
    role: t.role === 'assistant' ? 'assistant' : 'user',
    content: String(t.content || ''),
  }));

  // v1.8.0 #6: Inner OS 双重思考 —— 生成内心独白后注入 system prompt
  // 失败/跳过都不阻塞主流程
  const innerThought = await generateInnerMonologue({
    companion,
    userText: text,
    history,
    context: { accountId: null },  // playground 走 web 通道，没有 wechat account
  }).catch(() => null);
  if (innerThought) {
    systemPrompt += buildInnerOsHint(innerThought);
  }

  let reply;
  try {
    reply = await generateReply(systemPrompt, history, text, {
      temperature: companion.temperature,
      max_tokens: companion.max_tokens,
      top_p: companion.top_p,
      safetyLevel: userMsgSafetyLevel,  // v1.9.1: high/medium 时收紧温度
    });
  } catch (err) {
    log('error', `[Playground] generateReply 失败 companion=${companion.id}: ${err.message}`);
    throw err;
  }
  reply = safeOutboundReply(reply);

  // v1.5.2 PR E: assistant reply 后也走情绪更新（mood drift / energy 恢复等），跟 bot.mjs 对齐
  try {
    updateEmotionFromAssistantReply(companion.id, emotionState, reply, { companion });
  } catch { /* 情绪更新失败不影响主链路 */ }

  // 拆段（与 bot.mjs 同款 || 拆分），并把 [STICKER:xxx] 标记原样保留在 segments 里
  const segments = String(reply).split(/\s*(?:\|\||｜｜)\s*/g).map(s => s.trim()).filter(Boolean);
  // 把 sticker marker 解析成 { type:'sticker', file_url } 让前端直接显示
  const richSegments = segments.map(seg => {
    const { text: t, stickers } = parseStickerMarkers(seg);
    return {
      text: t || null,
      stickers: stickers.map(s => ({
        tag: s.picked?.emotion || (s.picked?.tags && s.picked.tags[0]) || s.picked?.id || 'sticker',
        url: s.picked?.fileUrl || s.picked?.url || null,  // 可能没有 URL；前端 fallback 显示文字标签
      })),
    };
  });

  // 写入对话历史，让长期记忆系统能继续工作
  try {
    saveConversationTurn(companion.id, 'user', text, companion.chat_mode_active);
    saveConversationTurn(companion.id, 'assistant', reply, companion.chat_mode_active);
  } catch (e) {
    log('warn', `[Playground] saveConversationTurn 失败: ${e.message}`);
  }

  // v1.8.0 #4: open loops —— 启发式 resolve 立即跑（不调 LLM，快）
  try { detectAndResolveOpenLoops(companion.id, text); }
  catch (e) { log('warn', `[Playground] resolve loop: ${e.message}`); }

  // 后处理（异步，不阻塞响应）：好感度 + 心情 + 记忆提取 + open loops 抽取
  (async () => {
    try {
      syncUpdateCompanionState(companion, text, reply);
      if (companion.memory_enabled) {
        await extractAndSaveMemories(companion.id, companion.user_id, text, reply);
        await extractAndUpdateUserProfile(companion.id, companion.user_id, text);
        extractOpenLoops(companion.id, text, reply).catch(err =>
          log('warn', `[Playground] extract loop: ${err.message}`)
        );
      }
    } catch (e) {
      log('warn', `[Playground] postProcess 失败: ${e.message}`);
    }
  })();

  // 返回最新 companion 状态给前端实时显示
  const after = getCompanionById(companion.id) || companion;

  return {
    reply,
    segments: richSegments,
    state: {
      mood: after.current_mood,
      affection_level: after.affection_level,
      relationship_stage: after.relationship_stage,
    },
  };
}
