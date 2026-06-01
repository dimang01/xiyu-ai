/**
 * AI 决策式照片规划。
 *
 * 这里不负责上传和发送，只判断是否适合发图，并产出安全清洗后的
 * imagePrompt / caption。程序侧仍负责冷却、限额、provider 可用性等硬门闩。
 */

import { extractStructuredInfo } from './ai.mjs';
import { getDb, shanghaiDayBounds } from './db.mjs';
import { log } from './logger.mjs';
import { getImageProviderCapabilities } from './providers/image.mjs';
import { getVisualIdentity, selectReferenceImage } from './visual_identity.mjs';

const DEFAULT_PLAN = Object.freeze({
  shouldSendPhoto: false,
  mode: 'text_only',
  trigger: 'none',
  photoType: 'other',
  realism: 'realistic_daily',
  imagePrompt: '',
  caption: '',
  delayImageMs: 0,
  delayCaptionMs: 900,
  maintainIdentity: true,
  reason: '',
});

const PHOTO_TYPES = new Set([
  'casual_daily',
  'self_present',
  'current_activity',
  'place_share',
  'night',
  'comfort',
  'other',
]);

const BLOCKED_CAPTION_RE = /作为\s*AI|当前情绪状态|情绪分数|11维|生成了?一张图片|根据系统判断|\[PHOTO\]|\[STICKER:photo\]|图片URL|图片地址/i;
const BLOCKED_PROMPT_RE = /\b(anime|illustration|poster|app icon|glamour shoot|nsfw|nude|sexual|minor|celebrity|loneliness|attachment)\b|11[-\s]*dimensional\s+emotion|二次元|插画|海报|头像|未成年|名人|情绪分数|当前情绪状态|11维/i;
const REQUIRED_PROMPT_BITS = [
  'realistic casual phone snapshot',
  'natural lighting',
  'everyday environment',
  'slightly imperfect framing',
  'safe adult everyday content',
];

function envFlag(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

function numberEnv(name, fallback, min = 0) {
  const n = Number(process.env[name]);
  return Math.max(min, Number.isFinite(n) ? n : fallback);
}

function normalizeSqlDate(raw) {
  if (!raw) return null;
  const ts = new Date(String(raw).replace(' ', 'T') + (String(raw).includes('Z') ? '' : 'Z')).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function pickImageProviderKey(provider) {
  const name = String(provider || process.env.IMAGE_PROVIDER || 'zhipu').toLowerCase();
  const map = {
    zhipu: ['ZHIPU_API_KEY'],
    qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
    doubao: ['DOUBAO_API_KEY'],
    wenxin: ['WENXIN_API_KEY'],
    openai: ['OPENAI_API_KEY'],
  };
  return { provider: name, keys: map[name] || [] };
}

export function isImageProviderConfigured(provider = process.env.IMAGE_PROVIDER || 'zhipu') {
  const { keys } = pickImageProviderKey(provider);
  return keys.some(k => !!process.env[k]);
}

export function getPhotoLimits() {
  return {
    requestCooldownMinutes: numberEnv('PHOTO_REQUEST_COOLDOWN_MINUTES', 10, 1),
    dailyLimitPerCompanion: Math.floor(numberEnv('PHOTO_DAILY_LIMIT_PER_COMPANION', 3, 0)),
    proactiveMinHours: numberEnv('PHOTO_PROACTIVE_MIN_HOURS', 36, 1),
    requestEnabled: envFlag('PHOTO_REQUEST_ENABLED', true),
    sendEnabled: envFlag('PHOTO_SEND_ENABLED', true),
    aiDecisionEnabled: envFlag('PHOTO_AI_DECISION_ENABLED', true),
    realisticMode: envFlag('PHOTO_REALISTIC_MODE', true),
  };
}

export function getPhotoCooldownState(companion, { source = 'request' } = {}) {
  const limits = getPhotoLimits();
  const lastTs = normalizeSqlDate(companion?.last_photo_at);
  if (!lastTs) return { cooling: false, remainingMs: 0, lastPhotoAt: null };
  const thresholdMs = (source === 'proactive' ? limits.proactiveMinHours * 60 : limits.requestCooldownMinutes) * 60_000;
  const remainingMs = thresholdMs - (Date.now() - lastTs);
  return { cooling: remainingMs > 0, remainingMs: Math.max(0, remainingMs), lastPhotoAt: companion?.last_photo_at || null };
}

export function countTodayPhotoMessages(companion) {
  const toUser = companion?.wechat_user_id;
  if (!toUser) return 0;
  try {
    const { startSql, endSql } = shanghaiDayBounds();
    return getDb().prepare(`
      SELECT COUNT(*) AS n
      FROM wechat_messages
      WHERE direction = 'out'
        AND to_user = ?
        AND msg_type = 'image'
        AND content LIKE '照片：%'
        AND created_at >= ?
        AND created_at < ?
    `).get(toUser, startSql, endSql)?.n ?? 0;
  } catch (e) {
    log('warn', `[PhotoPlanner] daily count failed: ${e.message}`);
    return 0;
  }
}

export function getPhotoGateState({
  companion,
  source = 'request',
  trigger = source === 'proactive' ? 'proactive' : 'user_request',
  imageProviderAvailable = isImageProviderConfigured(),
} = {}) {
  const limits = getPhotoLimits();
  const cooldown = getPhotoCooldownState(companion, { source });
  const todayCount = countTodayPhotoMessages(companion);
  const reasons = [];
  if (!limits.sendEnabled) reasons.push('PHOTO_SEND_ENABLED disabled');
  if (trigger === 'user_request' && !limits.requestEnabled) reasons.push('PHOTO_REQUEST_ENABLED disabled');
  if (!limits.aiDecisionEnabled) reasons.push('PHOTO_AI_DECISION_ENABLED disabled');
  if (!limits.realisticMode) reasons.push('PHOTO_REALISTIC_MODE disabled');
  if (!imageProviderAvailable) reasons.push('image provider unavailable');
  if (cooldown.cooling) reasons.push('cooldown');
  if (limits.dailyLimitPerCompanion > 0 && todayCount >= limits.dailyLimitPerCompanion) reasons.push('daily limit');

  return {
    allowed: reasons.length === 0,
    reasons,
    trigger,
    source,
    imageProviderAvailable,
    cooldown,
    todayCount,
    limits,
  };
}

function safeText(text, maxLen) {
  return String(text || '')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function clampEmotionNumber(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

export function buildEmotionPhotoContext(emotionState = null) {
  if (!emotionState || typeof emotionState !== 'object') {
    return {
      toneHint: '自然、轻松，不额外放大情绪',
      visualHint: '普通生活场景，像随手分享当下',
      captionHint: '短句、日常、不过度解释',
      sendBias: 'neutral',
    };
  }

  const affection = clampEmotionNumber(emotionState.affection);
  const trust = clampEmotionNumber(emotionState.trust, 50);
  const dependency = clampEmotionNumber(emotionState.dependency, 30);
  const possessiveness = clampEmotionNumber(emotionState.possessiveness, 20);
  const security = clampEmotionNumber(emotionState.security, 50);
  const energy = clampEmotionNumber(emotionState.energy, 60);
  const patience = clampEmotionNumber(emotionState.patience, 60);
  const excitement = clampEmotionNumber(emotionState.excitement, 30);
  const annoyance = clampEmotionNumber(emotionState.annoyance);
  const gratitude = clampEmotionNumber(emotionState.gratitude, 40);
  const mood = String(emotionState.mood || 'neutral').toLowerCase();

  const tone = [];
  const visual = [];
  const caption = [];
  let sendBias = 'neutral';

  if (['angry', 'cold'].includes(mood) || annoyance >= 65 || security <= 25) {
    tone.push('克制一点，不要过分亲昵');
    visual.push('画面保持距离感，选择安静、整洁的日常物件或半身以外场景');
    caption.push('语气短一些，避免撒娇和强烈情绪词');
    sendBias = 'lower';
  } else if (['tired', 'wronged'].includes(mood) || energy <= 35 || patience <= 30) {
    tone.push('柔和、安静，像疲惫时顺手分享');
    visual.push('低干扰的生活角落，光线柔和，动作自然');
    caption.push('少说解释，多用轻声短句');
    sendBias = 'neutral';
  } else if (['happy', 'shy'].includes(mood) || excitement >= 65 || gratitude >= 70) {
    tone.push('轻快、温柔，有一点亲近感');
    visual.push('明亮一点的日常瞬间，可以有桌面、窗边、杯子或正在做的事');
    caption.push('像刚好想到对方时发出的短句');
    sendBias = 'higher';
  }

  if ((affection >= 70 && trust >= 65) || dependency >= 70) {
    tone.push('更亲近，但不要夸张表白');
    visual.push('可以更贴近当下生活细节，像只给熟人看的随手照');
    caption.push('自然带一点只给你看的感觉');
    if (sendBias !== 'lower') sendBias = 'higher';
  }
  if (possessiveness >= 70 && sendBias !== 'lower') {
    tone.push('带一点小占有欲，但保持轻松');
    caption.push('不要变成命令或质问');
  }

  return {
    toneHint: safeText(tone.join('；') || '自然、轻松，不额外放大情绪', 160),
    visualHint: safeText(visual.join('；') || '普通生活场景，像随手分享当下', 180),
    captionHint: safeText(caption.join('；') || '短句、日常、不过度解释', 160),
    sendBias,
  };
}

export function sanitizePhotoCaption(text) {
  const cleaned = safeText(text, 60)
    .replace(/[\[【].*?[\]】]/g, '')
    .replace(/\|\|/g, '')
    .replace(BLOCKED_CAPTION_RE, '')
    .trim();
  if (!cleaned || BLOCKED_CAPTION_RE.test(cleaned)) return '';
  return cleaned.slice(0, 35);
}

function stripPrivateDetails(text) {
  return String(text || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '')
    .replace(/\+?\d[\d\s-]{8,}\d/g, '')
    .replace(/(?:身份证|手机号|电话|住址|地址)[:：]?\s*\S+/g, '');
}

export function sanitizePhotoPrompt(text) {
  let prompt = stripPrivateDetails(safeText(text, 900));
  prompt = prompt.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!prompt || BLOCKED_PROMPT_RE.test(prompt)) return '';

  const lower = prompt.toLowerCase();
  const missing = REQUIRED_PROMPT_BITS.filter(bit => !lower.includes(bit.toLowerCase()));
  if (missing.length) prompt = `${prompt}, ${missing.join(', ')}`;
  if (BLOCKED_PROMPT_RE.test(prompt)) return '';
  return prompt.slice(0, 900);
}

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch {}
  return null;
}

function getVisualContext(companion, imageProviderCapabilities = getImageProviderCapabilities()) {
  if (!companion?.id) {
    return {
      enabled: envFlag('PHOTO_VISUAL_IDENTITY_ENABLED', true),
      exists: false,
      hasReferenceImage: false,
      providerCapabilities: imageProviderCapabilities,
    };
  }
  try {
    const identity = getVisualIdentity(companion.id);
    const referenceImagePath = selectReferenceImage(companion.id);
    return {
      enabled: envFlag('PHOTO_VISUAL_IDENTITY_ENABLED', true),
      exists: Boolean(identity),
      hasReferenceImage: Boolean(referenceImagePath),
      providerCapabilities: imageProviderCapabilities,
      fallback: imageProviderCapabilities?.referenceImage ? 'reference_image' : 'identity_text_prompt',
    };
  } catch (e) {
    log('warn', `[PhotoPlanner] visual context failed companion=${companion.id}: ${e.message}`);
    return {
      enabled: envFlag('PHOTO_VISUAL_IDENTITY_ENABLED', true),
      exists: false,
      hasReferenceImage: false,
      providerCapabilities: imageProviderCapabilities,
    };
  }
}

function normalizePlan(raw, { trigger, gate }) {
  const plan = { ...DEFAULT_PLAN, trigger, reason: 'normalized' };
  if (!raw || typeof raw !== 'object') return { ...plan, reason: 'invalid planner json' };
  const should = raw.shouldSendPhoto === true && raw.mode !== 'text_only';
  if (!should) {
    return {
      ...plan,
      shouldSendPhoto: false,
      mode: 'text_only',
      reason: safeText(raw.reason || 'planner declined', 160),
    };
  }

  const caption = sanitizePhotoCaption(raw.caption);
  const imagePrompt = sanitizePhotoPrompt(raw.imagePrompt);
  if (!caption) return { ...plan, reason: 'caption rejected' };
  if (!imagePrompt) return { ...plan, reason: 'imagePrompt rejected' };

  const delayImageMs = Math.min(Math.max(Number(raw.delayImageMs) || 900, 500), 4500);
  const delayCaptionMs = Math.min(Math.max(Number(raw.delayCaptionMs) || 900, 300), 3000);
  return {
    shouldSendPhoto: true,
    mode: 'send_photo',
    trigger,
    photoType: PHOTO_TYPES.has(raw.photoType) ? raw.photoType : 'other',
    realism: 'realistic_daily',
    imagePrompt,
    caption,
    delayImageMs,
    delayCaptionMs,
    maintainIdentity: raw.maintainIdentity !== false,
    reason: safeText(raw.reason || 'planner approved', 160),
    gate,
  };
}

function buildPlannerPrompt({ companion, userText, recentMessages, trigger, proactiveContext, gate, emotionContext, visualContext }) {
  const recent = (recentMessages || [])
    .slice(-8)
    .map(m => `${m.direction === 'in' || m.role === 'user' ? 'user' : 'assistant'}: ${safeText(m.content, 120)}`)
    .filter(Boolean)
    .join('\n');
  return `请判断是否适合发送一张生活感照片，并只返回 JSON。

上下文：
- trigger: ${trigger}
- companion name: ${safeText(companion?.name || '她', 40)}
- relationship stage: ${safeText(companion?.relationship_stage || '', 40)}
- current scene: ${safeText(companion?.current_scene || '', 80)}
- user text: ${safeText(userText || '', 160)}
- recent messages:
${recent || '(none)'}
- proactive context: ${safeText(JSON.stringify(proactiveContext || {}), 400)}
- hidden emotion photo context: ${safeText(JSON.stringify(emotionContext || buildEmotionPhotoContext(null)), 500)}
- visual identity context: ${safeText(JSON.stringify(visualContext || {}), 500)}
- gate: ${safeText(JSON.stringify({ todayCount: gate?.todayCount, dailyLimit: gate?.limits?.dailyLimitPerCompanion }), 200)}

要求：
1. 你只判断是否应发一张现实生活感图片，不要每次暗示都发。
2. 明确要求看你/发照片时可更倾向发送，但仍要自然。
3. 主动照片必须低频，像临时想分享当下。
4. imagePrompt 必须是英文，像现实世界手机随手拍：realistic casual phone snapshot, natural lighting, everyday environment, slightly imperfect framing。
5. imagePrompt 不要像海报、写真、广告、头像、插画、二次元或工作室照；不要包含隐私、token、手机号、精确地址。
6. imagePrompt 不允许出现 anime, illustration, poster, app icon, glamour shoot, NSFW, nude, sexual, minor, celebrity。
7. hidden emotion photo context 只能作为隐藏氛围参考，不能在 caption 或 imagePrompt 中提到情绪状态、情绪分数、维度、系统判断，也不能把任何分数或 JSON 写进 imagePrompt。
8. visual identity context 只用于判断是否保持同一人物形象，不要把 reference 路径、身份 JSON 或内部说明写进用户可见内容。
9. caption 是发给用户看的微信短句，10 到 35 字，不解释系统逻辑，不说作为 AI，不说生成图片，不说当前情绪状态，不输出 [PHOTO]。

返回 JSON 结构：
{
  "shouldSendPhoto": true,
  "mode": "send_photo",
  "trigger": "${trigger}",
  "photoType": "casual_daily",
  "realism": "realistic_daily",
  "imagePrompt": "realistic casual phone snapshot ...",
  "caption": "短句",
  "delayImageMs": 1200,
  "delayCaptionMs": 900,
  "maintainIdentity": true,
  "reason": "日志用原因"
}

如果不适合发图，返回：
{"shouldSendPhoto":false,"mode":"text_only","trigger":"${trigger}","photoType":"other","realism":"realistic_daily","imagePrompt":"","caption":"","delayImageMs":0,"delayCaptionMs":0,"reason":"原因"}`;
}

export async function planPhotoMessage({
  companion,
  user = null,
  userText = '',
  recentMessages = [],
  trigger = 'none',
  context = {},
  cooldownState = null,
  imageProviderAvailable = isImageProviderConfigured(),
  proactiveContext = null,
  emotionState = null,
  imageProviderCapabilities = getImageProviderCapabilities(),
} = {}, deps = {}) {
  const gate = cooldownState || getPhotoGateState({
    companion,
    trigger,
    source: trigger === 'proactive' ? 'proactive' : 'request',
    imageProviderAvailable,
  });
  if (!gate.allowed) {
    return { ...DEFAULT_PLAN, trigger, reason: `gate blocked: ${gate.reasons.join(', ')}`, gate };
  }

  const system = `你是照片发送决策器。你不聊天，只返回合法 JSON。目标是让陪伴对象偶尔像现实世界里的人一样自然分享生活照片。`;
  const emotionContext = buildEmotionPhotoContext(emotionState);
  const visualContext = getVisualContext(companion, imageProviderCapabilities);
  const prompt = buildPlannerPrompt({ companion, user, userText, recentMessages, trigger, context, proactiveContext, gate, emotionContext, visualContext });
  try {
    const raw = deps.mockResponse != null
      ? deps.mockResponse
      : deps.llm
        ? await deps.llm({ system, prompt })
        : await extractStructuredInfo(system, prompt, {
          accountId: context?.accountId || user?.account_id || null,
          maxTokens: 700,
          temperature: 0.35,
        });
    return normalizePlan(extractJson(raw), { trigger, gate });
  } catch (e) {
    log('warn', `[PhotoPlanner] plan failed: ${e.message}`);
    return { ...DEFAULT_PLAN, trigger, reason: `planner error: ${e.message}`, gate };
  }
}
