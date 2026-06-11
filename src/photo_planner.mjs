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
    '302ai': ['AI302_API_KEY'],
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
  // v1.20.1: 900→2200。i2i 的 referenceNote 就占 ~400 字，900 上限把尾部的
  // REALISM_PERSON 反磨皮词全截掉了——生产 i2i 路径质感词从没真正生效，
  // 这是"照片假"的隐藏根因（A/B 实验实测）。gemini/gpt-image 的真实 prompt
  // 上限远大于此，2200 可容纳 identity+scene+refNote+完整 realism tail。
  let prompt = stripPrivateDetails(safeText(text, 2200));
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
  return prompt.slice(0, 2200);   // v1.20.1: 与入口上限一致（双重截断之前只改一处不生效）
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
  if (h < 19) return { id: 'dusk', label: '傍晚', light: 'golden hour fading into blue hour, a warm orange sunset glow low on the horizon under a deep blue twilight sky, moody atmospheric ambient light', scenes: 'seaside boardwalk, riverside walk, walking home, balcony with the evening sky, city street as the lights come on, sky over the sea, palm-lined promenade' };
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
  // v1.17.x: 整体偏可爱风（cute / sweet / pastel / girly），更贴"邻家小女友"的甜软感
  if (/甜美|sweet|cute|可爱/.test(s)) return 'cute girly outfit, soft pastel colors, light hoodie or knit cardigan or a sweet tee, playful youthful vibe';
  if (/清新|elegant|fresh/.test(s)) return 'fresh sweet casual outfit, light blouse or simple tee in soft pastel tone, clean and girly';
  if (/酷|cool|street/.test(s)) return 'cute casual streetwear, oversized hoodie or graphic tee, youthful playful look';
  if (/性感|sexy|mature/.test(s)) return 'soft sweet casual outfit, tasteful and youthful, gently cute, not revealing';
  if (/学院|preppy|学生/.test(s)) return 'cute preppy outfit, light cardigan or hoodie, fresh sweet and clean';
  return 'cute casual youthful outfit, soft pastel colors, light comfy daily wear, sweet girly vibe';
}

// v1.18.0: shot mode 三态 + 优先级修正；v1.19.5 (issue #237) 提炼为纯函数 + 上下文兜底。
// 旧 bug 1：用户明说"发张自拍"，但 current_scene 含晚霞/海时 isScenery 抢先命中 → 远景小背影。
//   修：拆「想看她」「想看景」「场景有景」三信号按意图定优先级，ENV_SELFIE 兜环境自拍。
// 旧 bug 2 (issue #237)：判定只看当前一条消息——聊了半天作业后用户说"你是不是发不了照片啊"，
//   这句没有"作业"字样 → 退回默认自拍，1 小时前的话题全丢。
//   修：当前消息有明确方向（自拍/景/活动）时永远优先；当前消息只是泛请求时，查最近几轮
//   上下文有没有"她正在做的事"（作业/代码/画…），有 → ACTIVITY_POV。
// v1.21.2 PR-D：按机位路由照片比例（手机前摄默认竖屏——'谁家好人自拍 1:1'修复）。
// SELFIE/ENV_SELFIE/ACTIVITY_POV/CANDID → 3:4 竖；SCENERY 默认 4:3 横，
// 窄竖景（塔/巷/瀑布/树）→ 3:4。provider 不支持原生比例时由 sender 文本兜底+落地裁切。
const TALL_SCENERY_RE = /(塔|高楼|大厦|巷|瀑布|树|竹|寺|楼梯|tower|alley|waterfall|tree|temple)/i;
export function aspectForShot(shotMode, sceneText = '') {
  if (shotMode === 'SCENERY') return TALL_SCENERY_RE.test(String(sceneText)) ? '3:4' : '4:3';
  return '3:4';
}

export function decideShotMode({ userText, recentText = '', currentScene = '', trigger = '' } = {}) {
  const _ptxt = String(userText || '');
  const _pscene = String(currentScene || '');
  const sceneIsScenic = /晚霞|夕阳|日落|余晖|落日|火烧云|天空|云海?|海边?|湖泊?|雪|月亮|星空|夜景|彩虹|樱花|风景|景色|窗外|江边?|河边?/.test(_ptxt + _pscene);
  const wantsSelfie = /自拍|看看你|看一下你|看看你的|你的样子|你长(啥|什么)样|想看你|拍张你|你的脸|露(个|张)?脸/.test(_ptxt);
  const wantsScenery = /(拍|看看|给我看|分享|来张|来一张|发张).{0,6}(晚霞|夕阳|日落|余晖|落日|火烧云|天空|云|海|湖|雪|月亮|星空|夜景|彩虹|樱花|风景|景色|外面|窗外)|外面.{0,4}(什么样|怎么样|长啥样)/.test(_ptxt);
  // v1.19.2: ACTIVITY-POV —— 用户想看"她手头正在做的事/作业/工作内容"(拍物不拍脸)。
  const wantsActivity = /(拍|看看|给我看|发张?|晒).{0,6}(作业|功课|工作|手头|笔记|手账|代码|方案|文档|在写的|在做的|在看的|在画的|在弄的|在练的|画|稿|书)|你(在|手头)?(写|做|弄|画|忙|敲|看|读|练|弹|搞)(的|了|啥|什么|到哪了?|多少了?)|(作业|功课|工作|代码|方案|稿|笔记|手账|画).{0,6}(到哪了?|多少了?|拍张?|看看|给我看)/.test(_ptxt);
  const selfieCapable = trigger === 'user_request' || trigger === 'request' || trigger === 'selfie';
  // 上下文兜底：当前消息没有任何明确方向（泛索图如"发不了照片啊？/再发一张"）时，
  // 最近对话里聊的是她手头的事 → 拍那个东西，别甩一张自拍装没聊过。
  const ctxActivity = !wantsSelfie && !wantsScenery && !wantsActivity
    && /(作业|功课|题|卷子|笔记|手账|代码|方案|文档|稿子?|论文|在写|在画|在做|字丑|公式)/.test(String(recentText || ''));
  if (wantsActivity || ctxActivity) return 'ACTIVITY_POV';
  if (wantsScenery && !wantsSelfie) return 'SCENERY';
  if (wantsSelfie || selfieCapable) return sceneIsScenic ? 'ENV_SELFIE' : 'SELFIE';
  return sceneIsScenic ? 'SCENERY' : 'CANDID';
}

function buildPlannerPrompt({ companion, userText, recentMessages, trigger, proactiveContext, gate, emotionContext, visualContext }) {
  const recent = (recentMessages || [])
    .slice(-8)
    .map(m => `${m.direction === 'in' || m.role === 'user' ? 'user' : 'assistant'}: ${safeText(m.content, 120)}`)
    .filter(Boolean)
    .join('\n');

  // v1.10.21/34: 时间感 + 完整人设外观 + 美学层
  const now = new Date();
  // 测试钩子：仅当显式设 PHOTO_TEST_HOUR(0-23) 才覆盖小时，用于评测不同时段；生产不设。
  const _testH = Number(process.env.PHOTO_TEST_HOUR);
  const h = Number.isInteger(_testH) && _testH >= 0 && _testH <= 23 ? _testH : (now.getUTCHours() + 8) % 24;
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const dp = dayPartHint(h);
  const appearance = compactAppearance(companion);
  const facialCue = moodToFacialCue(companion?.current_mood);
  const clothingEn = clothingStyleToEnglish(companion?.clothing_style);
  const recentPlain = (recentMessages || [])
    .slice(-8)
    .map(m => safeText(m.content, 120))
    .filter(Boolean)
    .join(' ');
  let shotMode = decideShotMode({
    userText,
    recentText: recentPlain,
    currentScene: companion?.current_scene,
    trigger,
  });
  // v1.20 安全收尾：安全模式（疑似未成年）强制中性照片——只拍景/物，绝不自拍/人像/flirt
  const safeModePhoto = !!Number(companion?.safe_mode);
  if (safeModePhoto && shotMode !== 'SCENERY' && shotMode !== 'ACTIVITY_POV') {
    shotMode = 'SCENERY';
  }

  const prompt = `请判断是否适合发送一张生活感照片，并只返回 JSON。

上下文：
- current shanghai time: ${String(h).padStart(2, '0')}:${mm}
- day part: ${dp.label} (${dp.id})
- lighting hint: ${dp.light}
- plausible scenes for this hour: ${dp.scenes}

- trigger: ${trigger}${safeModePhoto ? `
- ★★ SAFE MODE（最高优先级）：对方可能是未成年人。只允许分享风景/食物/手头事物等**中性照片**（已强制非自拍机位）；imagePrompt 绝不写任何人物/外貌/表情；caption 必须是普通朋友分享的口吻，**绝无**暧昧/撒娇/调情。拿不准就 shouldSendPhoto=false。` : ''}
- shot mode: ${
  shotMode === 'ACTIVITY_POV' ? 'ACTIVITY-POV（她拍自己正在做的事/手头的东西给对方看，像"你看我在写的作业"。first-person POV 低头看自己的桌面/手头：**主体是那个作业本/电脑屏幕/工作内容/手头的物件**——写满字的笔记本+笔、屏幕上的文档或代码、画了一半的画、做饭的案板等，桌面/物体填满画面；**绝不出现她的脸、不是自拍**，最多一只手或衣袖在画面边缘(握着笔/手放键盘上)；写明当前时段光线如 warm desk lamp at night / soft daylight by the window。规则 4/5/6/9（人物外貌/表情/着装）对它不适用）'
  : shotMode === 'ENV_SELFIE' ? 'ENVIRONMENTAL SELFIE（她是绝对主角：smartphone front-camera selfie, one arm reaching toward the camera, framed from the chest or waist up, her face clearly in sharp focus；同时人在户外，身后是当前那个景——晚霞/海/城市灯光等——作为氛围背景且自然虚化(softly out of focus behind her)，像真人在好看的地方拍的"环境自拍"发给对象：人是主体、景是身后的氛围，绝不是把人缩成远处小背影的风景图，也绝不是全身照）'
  : shotMode === 'SELFIE' ? 'SELFIE（smartphone front-camera selfie, one arm partially visible reaching toward the camera, framed from the chest or waist up, face clearly in focus；日常室内/户外随手自拍，背景真实且自然虚化）'
  : shotMode === 'SCENERY' ? 'SCENERY-POV（主体是她眼前的景本身——晚霞/天空/海等，那个景填满画面，像真人随手拍"你看这个"发给对方；最多一只手或衣角出现在画面极边缘，**手机/相机本身绝不能出现在画面里**（别写 holding a phone / a phone in frame）；绝不是站在景前的人像或全身照）'
  : 'CANDID（someone else might take it, or set on table；framed chest or waist up, natural everyday moment）'
}
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
4. imagePrompt 必须是英文。**（若 shot mode = SCENERY-POV 或 ACTIVITY-POV，本条及 5/6/9 不适用：只写景/桌面物件、绝不写人物外貌/脸/表情/着装。）** 其余机位下，**主角必须是 naturally pretty young woman, fresh and photogenic, gentle delicate facial features, soft warm smile**（不要 plain / haggard / exhausted / tired）。**但必须是一张真实手机随手拍的「真人照片」——真实自然的肤质（有细微纹理、毛孔、自然光影，不要 airbrushed / over-smoothed / waxy / plastic / poreless / 3d render / CGI doll face），五官有真人那种轻微不对称，像小红书/朋友圈的真实生活自拍，不是影楼写真也不是网红磨皮假图。**
5. imagePrompt 必须显式包含上面 "companion current mood / facial cue" 给的英文表情描述（如 "bright warm smile, soft cheerful eyes"），不允许 expressionless 或 sad-looking。
6. imagePrompt 必须显式包含上面 "companion clothing in english" 的英文着装关键词。**禁止 navy office sweater / formal collar shirt / professional attire**。
7. **必须严格按上面给出的 shot mode 写构图**：
   - **ENVIRONMENTAL SELFIE**：人是绝对主角的近景自拍（chest/waist up, face in sharp focus, one arm reaching toward camera），身后是当前那个景（晚霞/海/城市灯光等）做氛围且自然虚化——像真人在好看的地方拍给对象的"环境自拍"。**人是主体、景是背景**，绝不能缩成远处小背影。
   - **SELFIE**：近景手机自拍（chest/waist up, face in focus），背景是真实日常环境（居家/书桌/街道）且自然虚化，**不是纯白墙或影楼背景**。
   - **SCENERY-POV**：主体写那个景（如 "warm sunset glow over the sea, looking out over the water, the scenery fills the frame"），**景填满画面、是绝对主角**；最多 "a hand or sleeve at the very edge of the frame"，**绝不能让手机/相机出现在画面里**（别写 holding a phone / a phone in frame / taking a photo —— 否则模型会把一只手举着手机怼在镜头前，很出戏）。**SCENERY-POV 时只写景本身，不要写任何人物外貌/表情/着装/skin —— 规则 4/5/6/9 对它不适用**（写了 skin/face/young woman 会让模型硬塞一个人进画面当主体）。
   - **ACTIVITY-POV**：拍她手头正在做的事/东西（作业本+笔、电脑屏幕上的文档/代码、画到一半的画、做饭案板…），first-person POV 低头看桌面，**那个物件/作业/工作内容填满画面、是绝对主角**；**绝不出现她的脸、不是自拍**，最多一只手或衣袖在画面边缘；写当前时段光线。**只写桌面/物件不写人物外貌/表情/着装 —— 规则 4/5/6/9 对它不适用**。
   - **CANDID**：随手抓拍，slightly imperfect framing, natural everyday moment。
   **所有人像照（ENVIRONMENTAL SELFIE / SELFIE / CANDID）一律近景半身**："framed from the chest or waist up, close intimate phone-photo distance, face clearly in focus"——真实恋爱里女友发的照片几乎都是近景半身，**绝不要 full-length head-to-toe standing portrait / 全身照**（那像街拍或证件照，不像女友随手自拍）。
   **自拍动作要有变化、别死板**：不要每张都正脸怼镜头——另一只手可以自然地比耶/撑下巴/拨头发/拿着奶茶或笔，头可以微侧，视线可以不完全看镜头（看向别处或低头浅笑），像真人随手抓拍的多样姿势（仍保持近景半身、脸清晰）。从这些里随机挑一种，别千篇一律。
8. **【最重要】照片里的时间感必须与 current shanghai time 严格一致**：必须写当前 day part 的 lighting hint 并明确点出时段——**夜晚/深夜就必须写 "at night, dark sky / dark window outside, lit only by warm indoor lamp light"，绝对禁止出现 daylight / sunshine / bright daytime / sunny / 户外白天**；只有白天才写明亮日光。**imagePrompt 与 caption 必须同一时间、同一地点自洽**：caption 说"刚到家台灯下补作业"，imagePrompt 就必须是"室内夜晚书桌台灯"，绝不能是户外/白天。**若 companion current scene 与当前时段冲突**（如夜里 22 点 current_scene 还写"在路上"），**一律以当前时段的合理场景为准**重新设定（22 点该是到家/卧室/书桌，不是还在路上的大白天）。只选 plausible scenes 范围内的场景；**深夜禁 cafe/奶茶店/outdoor daylight**，清晨禁 dark bedroom。**像摄影师一样点明光位和镜头**：光位如 "warm bedside lamp glow" / "soft window light from the side" / "warm sunset backlight"；镜头——自拍 "phone front camera, close natural selfie perspective, shallow depth of field"，风景 "wide natural phone-camera perspective"。**户外场景要符合现实**：放学/通勤路上应有 a few passersby / 路灯 / 店铺等真实街景，夜晚户外要有 street lights / lit shops，不是空无一人的大白天。**必须明确写出所在背景/环境，且与 caption 一致**（咖啡馆→"sitting inside a cafe, blurred cafe interior and a window beside her"；卧室→"in her bedroom, bed and desk softly blurred behind"；街道→"on a city street with shops and a few passersby behind"）——**只写人不写环境，模型会自己乱编背景（常默认户外/校园全身）**。**imagePrompt 词序硬性要求**（防止场景被埋没）：① 开头先写机位 "close chest-up phone selfie"；② **紧接着马上写当前时段+地点背景**（如 "at night in her dim bedroom, only a warm desk lamp, dark window behind" / "inside a cafe by the window in the afternoon"）；③ **然后**才写人物外貌/表情/着装。**时段+背景必须排在那一长串外貌描述之前**——否则外貌会把场景挤到末尾被忽略或截断，导致 i2i 直接沿用参考图的户外白天（实测：夜晚自拍会错变成户外暮色）。
9. imagePrompt 必须暗含主角核心外貌（hair/eyes/body/face/style 参考 companion appearance）+ 默认补 "soft natural face, slim petite youthful build" 如果人设没特别指定。**年龄措辞改用具象视觉特征**（v1.10.41）："youthful early-college vibe, soft natural features, warm bright eyes, fresh clear complexion with realistic natural skin texture, light or no makeup, slim petite frame"。**关键：肤质必须真实有细节（细微毛孔/纹理/自然光影），不要 dewy / glossy / airbrushed / poreless 那种磨皮塑料感；脸要像真人手机照片，不是娃娃脸或 3D 渲染。** 让模型按具象去画，既避免被 over-correct 到 25+，也避免变成假娃娃脸。**头发要自然有生活感**，别梳得一丝不苟——可写 "natural slightly tousled hair, a few loose flyaway strands, hair moved by the wind"，过于整齐反而假。**严禁具体年龄数字、严禁 minor / teen / underage / child / kid / schoolgirl / lolita / high school** 等触发安全过滤的词。**另：绝不要写 8k / 4k / ultra realistic / ultra HD / masterpiece / hyperreal / flawless skin / perfect skin / porcelain skin / glossy glow —— 研究与实测均证明这些词会让模型出过度锐化的塑料假脸；真实感要靠 raw photo / unretouched / natural skin texture / fine pores / film grain / 具体小瑕疵(碎发/轻微不对称)来写。**
10. imagePrompt **不要写 "no XXX" / "without XXX" 等 negative 排除句**（会被本系统的安全过滤误伤）。改用**正面同义词替代**：
    - 想表达「不要专业写真」→ 写 "casual amateur smartphone snapshot vibe, everyday spontaneous moment"
    - 想表达「不要 35mm 电影感」→ 写 "natural daylight or warm room light, soft even exposure"
    - 想表达「不要疲惫脸」→ 写 "fresh lively bright face, gentle warm energy"
    - 想表达「不要办公室风着装」→ 写 "casual youthful home or campus outfit"
    - 想表达「不要 anime/插画」→ 写 "photorealistic, real life photography"
    - 想表达「不要 minor/teen/schoolgirl」→ 写 "youthful early-college vibe, soft natural features, warm bright eyes, fresh clear complexion with realistic natural skin texture and fine pores"（不要 dewy/baby-faced/round-cheeks 那种磨皮娃娃脸）
    - 想表达「不要 NSFW/nude/sexual」→ 写 "wholesome, fully clothed, casual everyday attire"
11. imagePrompt 不要包含隐私、token、手机号、精确地址。
12. hidden emotion / visual identity context 只作为隐藏参考，不要把内部 JSON 字段或分数写进 imagePrompt 或 caption。

caption：
13. caption 是发给他看的微信短句，10 到 35 字，不解释系统逻辑，不说作为 AI，不说生成图片，不说当前情绪状态，不输出 [PHOTO]。caption 内容必须与 day part 一致（深夜不要说"路过咖啡店"等白天动作；夜晚多用"躺床上 / 灯关了一半 / 突然想你"等贴近时间的描述）。

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
  return { prompt, shotMode };
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
