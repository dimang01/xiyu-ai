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

async function writeConvertedPhoto(url, companionId) {
  if (!existsSync(PHOTO_DIR)) mkdirSync(PHOTO_DIR, { recursive: true });
  const ts = Date.now();
  const outName = `scene_${companionId}_${ts}.webp`;
  const outPath = path.join(PHOTO_DIR, outName);
  const tmpPath = outPath + '.tmp';

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
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

function buildScenePrompt({ activity, timeSlot, mood }) {
  const activityText = String(activity || 'quiet daily moment').replace(/[^\p{L}\p{N}\s,.-]/gu, ' ').replace(/\s+/g, ' ').trim();
  const moodText = String(mood || '').replace(/[^\p{L}\p{N}\s,.-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return [
    `realistic casual phone snapshot of an adult woman during ${activityText || 'an ordinary daily moment'}`,
    `${timeSlot || 'afternoon'} natural lighting`,
    moodText ? `subtle ${moodText} atmosphere` : 'ordinary-life atmosphere',
    'everyday environment',
    'slightly imperfect framing',
    'not overly polished',
    'not a studio portrait',
    'safe adult everyday content',
    'modest everyday content',
  ].join(', ');
}

function buildFinalImagePrompt({ identityPrompt, scenePrompt, providerCapabilities, referenceImagePath }) {
  const referenceNote = referenceImagePath && providerCapabilities?.referenceImage
    ? 'use the provided reference image only to keep the same adult person identity'
    : 'keep the same adult person identity using the stable description';
  const prompt = [
    identityPrompt,
    scenePrompt,
    referenceNote,
    'realistic casual phone snapshot',
    'natural lighting',
    'everyday environment',
    'slightly imperfect framing',
    'not overly polished',
    'not a studio portrait',
    'safe adult everyday content',
    'modest everyday content',
  ].filter(Boolean).join(', ');
  return sanitizePhotoPrompt(prompt);
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
    generated = { url: await generateImage(finalPrompt, { size: '1024x1024' }), prompt: finalPrompt };
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
