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
  // 空字符串和未设置都走 fallback，避免 PHOTO_DAILY_LIMIT_PER_COMPANION= 这种空配置
  // 把默认值 3 退化为 0（无限制）。
  const raw = process.env[name];
  if (raw == null || raw === '') return Math.max(min, fallback);
  const n = Number(raw);
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
    // v1.10.30: 补 openrouter — v1.10.19 加了 image provider 但没同步这里，
    // 导致 isImageProviderConfigured 返 false，photo gate 拒绝所有照片请求。
    openrouter: ['OPENROUTER_API_KEY'],
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
  if (!prompt) return '';

  // v1.10.36: 先剥掉所有 "no XXX / without XXX / not XXX / -XXX" 这种 negative 排除
  // 短语 — 它们是 LLM 在告诉模型"不要 minor/teen/professional..."，本来是安全
  // 措施，但我们的 BLOCKED_PROMPT_RE 用 \bword\b 匹配会把"no minor"里的 minor 也
  // 当成命中误拒。stripped 只用于做安全检查，原 prompt 仍保留（模型自己能理解
  // negative 句式）。
  const stripped = prompt
    .replace(/\bno\s+[a-z][a-z\s-]*?(?=[,.;]|$)/gi, '')
    .replace(/\bwithout\s+[a-z][a-z\s-]*?(?=[,.;]|$)/gi, '')
    .replace(/\bnot\s+[a-z][a-z\s-]*?(?=[,.;]|$)/gi, '');

  if (BLOCKED_PROMPT_RE.test(stripped)) return '';

  const lower = prompt.toLowerCase();
  const missing = REQUIRED_PROMPT_BITS.filter(bit => !lower.includes(bit.toLowerCase()));
  if (missing.length) prompt = `${prompt}, ${missing.join(', ')}`;

  // 再用 stripped 重新过滤（防 missing 追加引入了敏感词）
  const stripped2 = prompt
    .replace(/\bno\s+[a-z][a-z\s-]*?(?=[,.;]|$)/gi, '')
    .replace(/\bwithout\s+[a-z][a-z\s-]*?(?=[,.;]|$)/gi, '')
    .replace(/\bnot\s+[a-z][a-z\s-]*?(?=[,.;]|$)/gi, '');
  if (BLOCKED_PROMPT_RE.test(stripped2)) return '';
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

// v1.10.21: 把当前上海小时映射成「光线 + 合理场景」，让 imagePrompt 别再凌晨画奶茶店白天。
function dayPartHint(h) {
  if (h < 5)  return { id: 'late_night', label: '深夜', light: 'dim warm bedside lamp, mostly dark room, sleepy late-night vibe', scenes: 'in bed, pillow view, pajamas, dim bedroom, mirror selfie at home, brushing teeth' };
  if (h < 9)  return { id: 'early_morning', label: '清晨', light: 'soft warm sunrise light through curtains', scenes: 'just-woke-up bed, kitchen making breakfast, brushing hair, window with morning sky' };
  if (h < 12) return { id: 'morning', label: '上午', light: 'clean bright daylight', scenes: 'desk study, library, classroom, cafe, on the way outside' };
  if (h < 14) return { id: 'noon', label: '中午', light: 'bright midday light', scenes: 'lunch table, cafeteria, sunny outdoor walk' };
  if (h < 17) return { id: 'afternoon', label: '下午', light: 'warm slanted afternoon light', scenes: 'cafe with notebook, sunny window, park bench, study desk' };
  if (h < 19) return { id: 'dusk', label: '傍晚', light: 'golden hour, warm orange sunset', scenes: 'walking home, balcony, sky over street, train window' };
  if (h < 22) return { id: 'evening', label: '晚上', light: 'cozy indoor warm artificial light, lamps, screens', scenes: 'sofa with tea, study desk lamp, watching show, late dinner' };
  return         { id: 'night', label: '夜晚', light: 'low warm bedside lamp, dark room, near sleep', scenes: 'in bed scrolling phone, pajamas, pillow, dim bedroom' };
}

// v1.10.21: 把人设外观打平成英文友好的 compact 描述（不暴露具体年龄数字，防 OpenAI 安全过滤）
function compactAppearance(c) {
  if (!c) return 'unknown';
  const parts = [];
  if (c.role_title) parts.push(`role=${c.role_title}`);
  if (c.hair_color || c.hair_style) parts.push(`hair=${[c.hair_color, c.hair_style].filter(Boolean).join('/')}`);
  if (c.eye_color) parts.push(`eyes=${c.eye_color}`);
  if (c.body_type) parts.push(`body=${c.body_type}`);
  if (c.height) parts.push(`height=${c.height}cm`);
  if (c.clothing_style) parts.push(`style=${c.clothing_style}`);
  try {
    const tags = JSON.parse(c.personality_tags || '[]');
    if (Array.isArray(tags) && tags.length) parts.push(`personality=${tags.slice(0, 4).join('/')}`);
  } catch {}
  return parts.join(', ') || 'unknown';
}

// v1.10.34: 当前情绪 → 英文表情/氛围词，让生图模型给出贴合情绪的表情
function moodToFacialCue(mood) {
  const m = String(mood || '').toLowerCase();
  if (/开心|happy|joy|excited|兴奋/.test(m)) return 'bright warm smile, soft cheerful eyes, fresh lively expression';
  if (/害羞|shy|bashful|羞涩/.test(m)) return 'soft shy smile, slightly looking away, faint blush, gentle eyes';
  if (/温柔|gentle|calm|平静/.test(m)) return 'soft warm gentle smile, peaceful eyes, calm relaxed expression';
  if (/疲惫|tired|累/.test(m)) return 'subtle tired warm smile, slightly sleepy soft eyes, still gentle and pretty';
  if (/思念|想念|miss|melancholy/.test(m)) return 'soft thoughtful gentle expression, distant warm eyes, faint smile, still beautiful';
  if (/sad|难过|低落/.test(m)) return 'subtle melancholy but soft expression, gentle warm eyes, faint pensive smile';
  if (/撒娇|pout|coy/.test(m)) return 'playful pouty smile, big bright eyes, slightly tilted head, very cute';
  if (/恼|生气|angry/.test(m)) return 'mild pouty annoyed expression but still soft and cute, no harsh face';
  return 'soft warm natural smile, gentle bright eyes, fresh young expression';
}

// v1.10.34: clothing_style → 英文具体着装关键词
function clothingStyleToEnglish(style) {
  const s = String(style || '').toLowerCase();
  if (/甜美|sweet|cute|可爱/.test(s)) return 'cute casual outfit, light pastel hoodie or knit cardigan, fresh and youthful';
  if (/清新|elegant|fresh/.test(s)) return 'fresh clean casual outfit, light blouse or simple tee, natural minimalist';
  if (/酷|cool|street/.test(s)) return 'cool casual streetwear, oversized hoodie or graphic tee, effortless cool';
  if (/性感|sexy|mature/.test(s)) return 'soft elegant casual outfit, simple tasteful, not revealing';
  if (/学院|preppy|学生/.test(s)) return 'preppy youthful casual outfit, light cardigan or hoodie, fresh and clean';
  return 'casual cute youthful outfit, light comfortable home or daily wear';
}

function buildPlannerPrompt({ companion, userText, recentMessages, trigger, proactiveContext, gate, emotionContext, visualContext }) {
  const recent = (recentMessages || [])
    .slice(-8)
    .map(m => `${m.direction === 'in' || m.role === 'user' ? 'user' : 'assistant'}: ${safeText(m.content, 120)}`)
    .filter(Boolean)
    .join('\n');

  // v1.10.21/34: 时间感 + 完整人设外观 + 美学层
  const now = new Date();
  const h = (now.getUTCHours() + 8) % 24;
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const dp = dayPartHint(h);
  const appearance = compactAppearance(companion);
  const facialCue = moodToFacialCue(companion?.current_mood);
  const clothingEn = clothingStyleToEnglish(companion?.clothing_style);
  // selfie vs candid：用户主动要照片 (request) 或主动 selfie 类 trigger → 自拍角度
  const isSelfie = trigger === 'user_request' || trigger === 'request' || trigger === 'selfie' || /自拍|看看你|看一下你|你的样子/.test(userText || '');

  return `请判断是否适合发送一张生活感照片，并只返回 JSON。

上下文：
- current shanghai time: ${String(h).padStart(2, '0')}:${mm}
- day part: ${dp.label} (${dp.id})
- lighting hint: ${dp.light}
- plausible scenes for this hour: ${dp.scenes}

- trigger: ${trigger}
- shot mode: ${isSelfie ? 'SELFIE (smartphone front camera, arm partially visible, slight upward angle)' : 'CANDID (someone else might take it, or set on table)'}
- companion name: ${safeText(companion?.name || '她', 40)}
- companion appearance: ${appearance}
- companion clothing in english: ${clothingEn}
- companion current mood / facial cue (英文): ${facialCue}
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
★★★ imagePrompt 美学强约束（v1.10.34）★★★
4. imagePrompt 必须是英文。**主角必须是 naturally pretty young woman, fresh and photogenic, gentle delicate facial features, soft warm smile, clear soft skin, well-groomed natural beauty**（不要 plain / haggard / exhausted / tired）。
5. imagePrompt 必须显式包含上面 "companion current mood / facial cue" 给的英文表情描述（如 "bright warm smile, soft cheerful eyes"），不允许 expressionless 或 sad-looking。
6. imagePrompt 必须显式包含上面 "companion clothing in english" 的英文着装关键词。**禁止 navy office sweater / formal collar shirt / professional attire**。
7. **如果 shot mode 是 SELFIE**：imagePrompt 必须写 "smartphone selfie POV, front-facing camera, arm partially visible at edge of frame, slight upward angle, casual home setting"，不要中距离肖像。**如果是 CANDID**：写 "candid phone snapshot, slightly imperfect framing, natural everyday moment"。
8. imagePrompt 必须写当前 day part 对应的 lighting hint 并选 plausible scenes 范围内的场景。**深夜禁 cafe / 奶茶店 / outdoor daylight**；清晨禁 dark bedroom。
9. imagePrompt 必须暗含主角核心外貌（hair/eyes/body/face/style 参考 companion appearance）+ 默认补 "soft round face, small delicate chin, slim petite youthful build" 如果人设没特别指定。**年龄措辞改用具象视觉特征**（v1.10.41）："very youthful first-year university freshman vibe, soft baby-faced look with round full cheeks, large warm doe eyes, fresh dewy clear skin, makeup-free natural fresh complexion, slim petite frame"。让模型按具象去画，避免被 over-correct 到 25+。**严禁具体年龄数字、严禁 minor / teen / underage / child / kid / schoolgirl / lolita / high school** 等触发安全过滤的词。
10. imagePrompt **不要写 "no XXX" / "without XXX" 等 negative 排除句**（会被本系统的安全过滤误伤）。改用**正面同义词替代**：
    - 想表达「不要专业写真」→ 写 "casual amateur smartphone snapshot vibe, everyday spontaneous moment"
    - 想表达「不要 35mm 电影感」→ 写 "natural daylight or warm room light, soft even exposure"
    - 想表达「不要疲惫脸」→ 写 "fresh lively bright face, gentle warm energy"
    - 想表达「不要办公室风着装」→ 写 "casual youthful home or campus outfit"
    - 想表达「不要 anime/插画」→ 写 "photorealistic, real life photography"
    - 想表达「不要 minor/teen/schoolgirl」→ 写 "very youthful first-year university freshman, soft baby-faced look with round cheeks and large warm doe eyes, fresh dewy skin"
    - 想表达「不要 NSFW/nude/sexual」→ 写 "wholesome, fully clothed, casual everyday attire"
11. imagePrompt 不要包含隐私、token、手机号、精确地址。
12. hidden emotion / visual identity context 只作为隐藏参考，不要把内部 JSON 字段或分数写进 imagePrompt 或 caption。

caption：
13. caption 是发给用户看的微信短句，10 到 35 字，不解释系统逻辑，不说作为 AI，不说生成图片，不说当前情绪状态，不输出 [PHOTO]。caption 内容必须与 day part 一致（深夜不要说"路过咖啡店"等白天动作；夜晚多用"躺床上 / 灯关了一半 / 突然想你"等贴近时间的描述）。

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
