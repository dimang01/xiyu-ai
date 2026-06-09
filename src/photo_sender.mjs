/**
 * 共享照片发送 helper：生成场景图 -> 下载转码 -> iLink CDN 上传 -> 微信图片消息发送。
 */

import path from 'node:path';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { generateImage, generateReply } from './ai.mjs';
import { tryAchievement } from './achievements.mjs';
import {
  getDailySchedule,
  markPhotoSent,
  saveConversationTurn,
  saveMessage,
  shanghaiDateKey,
} from './db.mjs';
import { sendMessageItem } from './ilink.mjs';
import { log } from './logger.mjs';
import { uploadFile } from './media.mjs';
import { sanitizePhotoPrompt } from './photo_planner.mjs';
import {
  buildIdentityPrompt,
  ensureVisualIdentity,
  saveGeneratedPhoto,
} from './visual_identity.mjs';

const PHOTO_DIR = path.resolve(process.cwd(), 'public/avatars/scenes');
const REQUEST_CAPTIONS = [
  '喏，刚拍的，别笑我',
  '在写东西呢，看到你消息就顺手拍了一张',
  '刚刚随手拍的，只给你看一眼',
  '给你看一下，别嫌我乱糟糟的',
];
const PROACTIVE_CAPTIONS = [
  '刚坐下来休息，突然想给你看看',
  '今天这里光线还挺好，想给你发一张',
  '在写东西呢，忽然想到你',
  '刚刚看到这个，就想发给你',
];

function envFlag(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

function requestCooldownMs() {
  const minutes = Number(process.env.PHOTO_REQUEST_COOLDOWN_MINUTES || 10);
  return Math.max(1, Number.isFinite(minutes) ? minutes : 10) * 60_000;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function currentMinute() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function timeSlotFromMinute(minute) {
  if (minute < 11 * 60) return 'morning';
  if (minute < 14 * 60) return 'noon';
  if (minute < 17 * 60) return 'afternoon';
  if (minute < 19 * 60) return 'golden hour';
  if (minute < 22 * 60) return 'evening';
  return 'night';
}

export function derivePhotoContext(companion) {
  const todayKey = shanghaiDateKey();
  const sched = companion?.id ? getDailySchedule(companion.id, todayKey) : null;
  const minute = currentMinute();
  let activity = companion?.current_scene || '在写东西';
  let mood = '';

  if (sched?.items?.length) {
    for (const it of sched.items) {
      const m = String(it.time || '').match(/^(\d{1,2}):(\d{2})/);
      if (!m) continue;
      const itMin = Number(m[1]) * 60 + Number(m[2]);
      if (itMin <= minute) activity = it.activity;
    }
    if (sched.mood_segments) {
      mood = minute < 12 * 60 ? sched.mood_segments.morning
        : minute < 18 * 60 ? sched.mood_segments.afternoon
        : sched.mood_segments.evening;
    }
  }

  return { activity, mood, timeSlot: timeSlotFromMinute(minute) };
}

export function pickPhotoCaption({ source = 'request', activity = '' } = {}) {
  const text = source === 'proactive' ? pick(PROACTIVE_CAPTIONS) : pick(REQUEST_CAPTIONS);
  return text.replace(/\s+/g, ' ').trim().slice(0, 30) || (activity ? `刚拍的，${activity}` : '刚拍的，给你看一眼');
}

function sanitizeCaption(text, source, activity) {
  const fallback = pickPhotoCaption({ source, activity });
  const cleaned = String(text || '')
    .replace(/[\[【].*?[\]】]/g, '')
    .replace(/\|\|/g, '')
    .replace(/当前情绪状态[^，。！？]*/g, '')
    .replace(/作为AI|作为 AI|生成了?一张图片|图片URL|图片地址/gi, '')
    .trim();
  return (cleaned || fallback).slice(0, 30);
}

async function generateNaturalCaption(companion, { activity, source }) {
  const examples = source === 'proactive'
    ? '刚坐下来休息，突然想给你看看 / 今天这里光线还挺好 / 在写东西呢，忽然想到你'
    : '喏，刚拍的，别笑我 / 在写东西呢，顺手拍了一张 / 只给你看一眼';
  try {
    const name = companion?.name || '她';
    const prompt = `你是${name}，正在微信里给喜欢的人发一张刚拍的日常照片。只输出一句10-30字的自然配文。
要求：像真实聊天；不要解释系统逻辑；不要说AI、生成图片、当前情绪状态；不要输出图片占位符。
当前场景：${activity || '在写东西'}
例子：${examples}`;
    const text = await generateReply(prompt, [], '给这张照片配一句话', {
      max_tokens: 60,
      temperature: 0.9,
      top_p: 0.9,
    });
    return sanitizeCaption(text, source, activity);
  } catch (e) {
    log('warn', `[Photo] caption 生成失败: ${e.message}`);
    return pickPhotoCaption({ source, activity });
  }
}

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

async function writeConvertedPhoto(url, companionId) {
  if (!existsSync(PHOTO_DIR)) mkdirSync(PHOTO_DIR, { recursive: true });
  const ts = Date.now();
  const outName = `scene_${companionId}_${ts}.webp`;
  const outPath = path.join(PHOTO_DIR, outName);
  const tmpPath = outPath + '.tmp';

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error('download HTTP ' + r.status);
    const contentLength = Number(r.headers.get('content-length') || 0);
    if (contentLength > MAX_PHOTO_BYTES) throw new Error(`图片过大 ${contentLength}B`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_PHOTO_BYTES) throw new Error(`图片过大 ${buf.length}B`);
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
    return { outName, outPath };
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

function cooldownState(companion) {
  const last = companion?.last_photo_at;
  if (!last) return { cooling: false, remainingMs: 0 };
  const ts = new Date(String(last).replace(' ', 'T') + (String(last).includes('Z') ? '' : 'Z')).getTime();
  if (!Number.isFinite(ts)) return { cooling: false, remainingMs: 0 };
  const remainingMs = requestCooldownMs() - (Date.now() - ts);
  return { cooling: remainingMs > 0, remainingMs: Math.max(0, remainingMs) };
}

// v1.19.0: 真人手机照质感层 —— 逼出"真照片"而非"AI 塑料图"。
// 研究 + 60 张实测结论：① 人像≠风景，给风景写 "skin texture" 是错的，必须分层；
// ② 反塑料靠 raw/unretouched/film grain + 具体的小瑕疵(毛孔/碎发/轻微不对称)，
//    并避开 8k/ultra/flawless/perfect skin 这类"越写越假"的反效果词(在 planner 里禁)。
// 这是所有生图(planner 决策图 + 程序兜底图)进入 generateImage 前的统一质感尾巴。
export const REALISM_CORE = Object.freeze([
  'shot on a modern smartphone, casual amateur snapshot, raw unedited photo',
  'natural film grain, true-to-life natural colors, balanced natural exposure',
  'realistic natural lighting with soft natural shadows',
  'natural depth of field, softly blurred real background',
  'slightly imperfect handheld framing, candid unposed everyday moment',
  'authentic everyday photo with a natural casual feel',
  'safe adult everyday content',
  'modest everyday content',
]);
// 主角是人时叠加：毛孔/碎发/轻微不对称——"不完美"才是真（正面措辞，不写 no/not）。
export const REALISM_PERSON = Object.freeze([
  'natural realistic skin with fine visible pores and subtle texture',
  'a few stray flyaway hairs, subtle natural facial asymmetry',
  'soft realistic highlights on the skin, sharp natural focus on the eyes',
  'fresh natural complexion with light or no makeup',
]);
// 主体是景时叠加：分层纵深 + 大气 + 自然色（绝不写 skin/face）。
export const REALISM_SCENERY = Object.freeze([
  'wide natural phone-camera perspective, layered depth from foreground to far background',
  'soft atmospheric depth, realistic dynamic range, true-to-life natural color palette',
]);

// 从 scene 文本判断主体是「人」还是「景」。多数照片主角是她，故默认人物；
// 仅在明确的风景标记(POV/looking out/skyline...)且无人物标记时判风景。
// 误判风险=回到旧的一刀切，不会比 v1.18.0 更差。
export function isSceneryScene(scene) {
  const s = String(scene || '').toLowerCase();
  // 人物主体的强信号（含 ENV_SELFIE：它带 selfie/woman/reaching toward camera）。
  // 注意：用 "her face" 而非裸 "face"，否则风景里 "glow on faces"(路人) 会误判成人物。
  const person = /\bselfie\b|self-portrait|environmental selfie|\bwoman\b|\bgirl\b|chest[- ]?up|waist[- ]?up|\bportrait\b|young woman|her face|reaching toward (the )?camera/;
  if (person.test(s)) return false;
  // 其余只要有风景信号就判景。
  const scenery = /scenery[- ]?pov|first[- ]?person pov|\bpov\b|looking out|fills the frame|skyline|landscape|\bthe view\b|sunset over|night market|street scene|city lights/;
  return scenery.test(s);
}

export function realismTailFor(scene) {
  return isSceneryScene(scene)
    ? [...REALISM_CORE, ...REALISM_SCENERY]
    : [...REALISM_CORE, ...REALISM_PERSON];
}

function buildScenePrompt({ activity, timeSlot, mood }) {
  const activityText = String(activity || 'quiet daily moment').replace(/[^\p{L}\p{N}\s,.-]/gu, ' ').replace(/\s+/g, ' ').trim();
  const moodText = String(mood || '').replace(/[^\p{L}\p{N}\s,.-]/gu, ' ').replace(/\s+/g, ' ').trim();
  // 场景层只描述「在做什么 + 光线 + 氛围」，质感统一由 buildFinalImagePrompt 的 realismTailFor 兜底。
  return [
    `realistic casual phone snapshot of an adult woman during ${activityText || 'an ordinary daily moment'}`,
    `${timeSlot || 'afternoon'} natural lighting`,
    moodText ? `subtle ${moodText} atmosphere` : 'ordinary-life atmosphere',
  ].join(', ');
}

function buildFinalImagePrompt({ identityPrompt, scenePrompt, providerCapabilities, referenceImagePath }) {
  const referenceNote = referenceImagePath && providerCapabilities?.referenceImage
    ? 'use the provided reference image ONLY for facial identity and likeness (keep the same face); do NOT copy its pose, body crop, framing or composition — strictly follow the text prompt for shot framing, distance and pose (a close waist-up phone shot unless the text says it is a scenery/POV shot)'
    : 'keep the same adult person identity using the stable description';
  // 去重：planner 写的 imagePrompt 常已含部分质感词，拼接前剔掉重复，
  // 避免顶到 900 字上限把独有的质感词（skin texture / grain / DoF）截掉。
  const sceneLower = String(scenePrompt || '').toLowerCase();
  const tail = realismTailFor(scenePrompt).filter((t) => {
    const key = t.split(',')[0].trim().toLowerCase();
    return key && !sceneLower.includes(key);
  });
  const prompt = [
    identityPrompt,
    scenePrompt,
    referenceNote,
    ...tail,
  ].filter(Boolean).join(', ');
  return sanitizePhotoPrompt(prompt);
}

// v1.10.53: 由扩展名推 data URL 的 mime（ref 图 saveReferenceImage 保留原扩展名）
function refMimeFromPath(p) {
  const ext = String(p).toLowerCase().match(/\.(png|jpe?g|webp|gif)$/)?.[1];
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/png';
}

export async function sendCompanionPhoto({
  companion,
  user = null,
  context,
  contextToken = null,
  activity = '',
  caption = '',
  imagePrompt = '',
  trigger = '',
  source = 'request',
  emotionState = null,
  visualIdentity = null,
  referenceImagePath = null,
  maintainIdentity = envFlag('PHOTO_MAINTAIN_IDENTITY', true),
  force = false,
  generateCaption = false,
  recordTurn = false,
} = {}) {
  if (!envFlag('PHOTO_SEND_ENABLED', true)) {
    return { ok: false, code: 'disabled', error: '照片发送未启用' };
  }
  const toUserId = user?.wechat_user_id || user?.wechatUserId || companion?.wechat_user_id || '';
  if (!companion?.id || !toUserId || !context?.token) {
    return { ok: false, code: 'missing_context', error: '照片发送上下文不完整' };
  }

  if (source === 'request' && !force) {
    const cooldown = cooldownState(companion);
    if (cooldown.cooling) {
      return { ok: false, code: 'cooldown', remainingMs: cooldown.remainingMs };
    }
  }

  const derived = derivePhotoContext(companion);
  const finalActivity = activity || derived.activity;
  const finalCaption = generateCaption
    ? await generateNaturalCaption(companion, { activity: finalActivity, source })
    : sanitizeCaption(caption || pickPhotoCaption({ source, activity: finalActivity }), source, finalActivity);

  let visual = {
    identity: visualIdentity,
    referenceImagePath,
    capabilities: null,
  };
  if (maintainIdentity && envFlag('PHOTO_VISUAL_IDENTITY_ENABLED', true)) {
    try {
      visual = await ensureVisualIdentity({
        companion,
        emotionState,
        context: { scene: finalActivity, source, trigger },
      });
    } catch (e) {
      log('warn', `[Photo] visual identity unavailable companion=${companion.id}: ${e.message}`);
    }
  }

  let generated;
  try {
    const scenePrompt = imagePrompt
      ? sanitizePhotoPrompt(imagePrompt)
      : sanitizePhotoPrompt(buildScenePrompt({ activity: finalActivity, timeSlot: derived.timeSlot, mood: derived.mood }));
    if (!scenePrompt) {
      return { ok: false, code: 'invalid_prompt', error: '照片 prompt 不合规', caption: finalCaption, activity: finalActivity };
    }
    const identityPrompt = maintainIdentity ? buildIdentityPrompt(visual?.identity) : '';
    const finalPrompt = buildFinalImagePrompt({
      identityPrompt,
      scenePrompt,
      providerCapabilities: visual?.capabilities,
      referenceImagePath: visual?.referenceImagePath,
    });
    if (!finalPrompt) {
      return { ok: false, code: 'invalid_prompt', error: '照片 prompt 不合规', caption: finalCaption, activity: finalActivity };
    }
    // v1.10.53: image-to-image —— provider 支持参考图且有锁定/自动 ref 时，把 ref
    // 图字节作为 input image 喂进生图，真正锚定同一张脸（不再只塞进文字 note）。
    let referenceImage = null;
    if (visual?.capabilities?.referenceImage && visual?.referenceImagePath) {
      try {
        const refBuf = await readFile(visual.referenceImagePath);
        referenceImage = `data:${refMimeFromPath(visual.referenceImagePath)};base64,${refBuf.toString('base64')}`;
        log('debug', `[Photo] i2i 参考图已载入 companion=${companion.id} bytes=${refBuf.length}`);
      } catch (e) {
        log('warn', `[Photo] 读取参考图失败 companion=${companion.id}: ${e.message}`);
      }
    }
    generated = { url: await generateImage(finalPrompt, { size: '1024x1024', referenceImage }), prompt: finalPrompt };
  } catch (e) {
    log('warn', `[Photo] 生成照片失败 companion=${companion.id}: ${e.message}`);
    return { ok: false, code: 'generate_failed', error: e.message, caption: finalCaption, activity: finalActivity };
  }

  let converted;
  try {
    converted = await writeConvertedPhoto(generated.url, companion.id);
    try { saveGeneratedPhoto(companion.id, converted.outPath); } catch (e) {
      log('warn', `[Photo] save generated photo skipped companion=${companion.id}: ${e.message}`);
    }
  } catch (e) {
    log('warn', `[Photo] 下载/转码失败 companion=${companion.id}: ${e.message}`);
    return { ok: false, code: 'convert_failed', error: e.message, caption: finalCaption, activity: finalActivity };
  }

  let item;
  try {
    const data = await readFile(converted.outPath);
    const uploaded = await uploadFile({ data, fileName: converted.outName, toUserId, ctx: context, mediaType: 'image' });
    item = uploaded.item;
  } catch (e) {
    log('warn', `[Photo] uploadFile 失败 companion=${companion.id}: ${e.message}`);
    return { ok: false, code: 'upload_failed', error: e.message, caption: finalCaption, activity: finalActivity };
  }

  try {
    const sent = await sendMessageItem(context, toUserId, item, contextToken);
    if (!sent) {
      return { ok: false, code: 'send_failed', error: 'sendMessageItem returned false', caption: finalCaption, activity: finalActivity };
    }
    saveMessage({
      msgId: `photo_${source}_${companion.id}_${Date.now()}`,
      fromUser: context.botId || 'bot',
      toUser: toUserId,
      msgType: 'image',
      content: `照片：${finalActivity}`,
      direction: 'out',
    });
    markPhotoSent(companion.id, `${finalActivity} / ${finalCaption}`);
    if (recordTurn) {
      saveConversationTurn(companion.id, 'assistant', `发了一张照片：${finalActivity}。${finalCaption}`, '场景分享');
    }
    tryAchievement(companion.id, 'first_scene_photo');
    log('info', `[Photo] 已发送 companion=${companion.id} source=${source} activity="${finalActivity}"`);
    return {
      ok: true,
      caption: finalCaption,
      activity: finalActivity,
      prompt: generated.prompt || '',
      trigger,
      fileName: converted.outName,
      source,
    };
  } catch (e) {
    log('warn', `[Photo] 发送失败 companion=${companion.id}: ${e.message}`);
    return { ok: false, code: 'send_failed', error: e.message, caption: finalCaption, activity: finalActivity };
  }
}
