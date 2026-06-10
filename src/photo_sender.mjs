/**
 * 共享照片发送 helper：生成场景图 -> 下载转码 -> iLink CDN 上传 -> 微信图片消息发送。
 */

import path from 'node:path';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { generateImage, generateReply } from './ai.mjs';
import { tryAchievement } from './achievements.mjs';
import {
  getDailySchedule,
  markPhotoSent,
  saveConversationTurn,
  saveMessage,
  shanghaiDateKey,
  insertPhotoLog,
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

// v1.21.2 PR-D：照片比例修复（'谁家好人自拍 1:1'）。复现实测（gemini via 302 chat 模态）：
// 文本比例声明完全无效（t2i/i2i 都仍出 1:1）；唯一原生有效手段是 i2i 参考图本身的比例
// （3:4 画布 ref → 输出 864x1184）。故三管齐下：原生 size 参数（zhipu/qwen/doubao/openai
// 支持）+ i2i 参考贴 3:4 画布（锁脸不锁方）+ 落地转码按目标比例裁切兜底（t2i 唯一可靠手段）。
const ASPECT_SIZE = { '3:4': '768x1024', '4:3': '1024x768', '1:1': '1024x1024' };
function normalizeAspect(a) { return ASPECT_SIZE[a] ? a : '3:4'; }
function aspectPromptHint(aspect) {
  return aspect === '4:3'
    ? 'landscape orientation photo, 4:3 aspect ratio, wider than tall'
    : 'vertical portrait orientation photo, 3:4 aspect ratio, taller than wide, shot on a phone held upright';
}

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

async function writeConvertedPhoto(url, companionId, aspect = '3:4') {
  if (!existsSync(PHOTO_DIR)) mkdirSync(PHOTO_DIR, { recursive: true });
  const ts = Date.now();
  const outName = `scene_${companionId}_${ts}.webp`;
  const outPath = path.join(PHOTO_DIR, outName);
  const tmpPath = outPath + '.tmp';
  // 目标尺寸按机位比例（曾无条件 1157^→crop 1024x1024：provider 出什么比例落地都成 1:1，
  // photo 功能上线(v1.10.0)起全量方图——本函数是所有照片必经，这里是 1:1 的总根因）
  const [tw, th] = (ASPECT_SIZE[aspect] || ASPECT_SIZE['3:4']).split('x').map(Number);
  const cover = Math.ceil(Math.max(tw, th) * 1.13);

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
        '-resize', `${cover}x${cover}^`,
        '-gravity', 'north',                       // north：竖裁保住头部
        '-crop', `${tw}x${th}+0+0`, '+repage',
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

// 测试钩子（photo_aspect_smoke 专用）：转码卡口是比例防回归的核心断言点
export async function __testWriteConvertedPhoto(url, companionId, aspect) {
  return writeConvertedPhoto(url, companionId, aspect);
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
// 主角是人时叠加：毛孔/碎发/轻微不对称——"不完美"才是真。
// v1.20.1: 按 2026-06-10 A/B 实验（用户反馈"照片太假"，gemini-2.5-flash-image
// 18 张对照）升级——旧词表压不住模型的"瓷面 AI 脸"默认；新词表三处关键：
// ①首句构图锚定（防 realism 词把场景/自拍构图带偏，第一轮实验实测会跑偏）
// ②"清晰可见毛孔/肤色不均/小瑕疵/黑眼圈/T 区油光"比"细腻毛孔"压得住磨皮
// ③尾句点名反 AI 理想脸（negative 句式，sanitize 的剥离机制只用于安全检查、原文保留）
export const REALISM_PERSON = Object.freeze([
  'strictly keep the exact composition, framing and setting described above, apply only the photographic realism below',
  'unretouched real skin with clearly visible pores and slightly uneven skin tone',
  'one or two tiny natural blemishes, faint under-eye shadows, slight natural shine on the T-zone',
  'a few stray flyaway hairs, subtle natural facial asymmetry',
  'soft realistic highlights on the skin, sharp natural focus on the eyes',
  'fresh natural complexion with light or no makeup',
  'looks like a real unfiltered phone photo posted on social media, not an idealized AI-generated face, no beauty filter, no airbrushing',
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

// v1.19.0: i2i 参考图「裁脸」——把锁定参考图裁成只剩头/脸的方形再喂给 i2i。
// 实测：参考图带背景+身体时，gemini i2i 在「同光照」(如白天)场景会偷懒沿用参考图的
// 背景甚至全身构图，文字压不住；裁成只剩脸后，i2i 没有背景/身体可抄，场景与构图只能
// 按文字重建（脸仍锁得住）。参考图是系统生成的近景人像，脸在上-中部，故取居中偏上方形。
// 可 PHOTO_I2I_FACE_CROP=0 关闭；比例/位置可调。
export async function cropReferenceToFace(buf, aspect = '3:4') {
  if (String(process.env.PHOTO_I2I_FACE_CROP ?? '1').toLowerCase() === '0') return buf;
  try {
    const ratio = Number(process.env.PHOTO_I2I_FACE_CROP_RATIO) || 0.62;
    const topOff = Number.isFinite(Number(process.env.PHOTO_I2I_FACE_CROP_TOP)) ? Number(process.env.PHOTO_I2I_FACE_CROP_TOP) : 0.06;
    const img = sharp(buf);
    const { width: W, height: H } = await img.metadata();
    if (!W || !H) return buf;
    const side = Math.max(64, Math.round(Math.min(W, H) * Math.min(0.95, Math.max(0.3, ratio))));
    const left = Math.max(0, Math.round((W - side) / 2));
    const top = Math.max(0, Math.round(H * Math.min(0.4, Math.max(0, topOff))));
    // v1.21.2: 参考图裁成目标比例窗而非正方形——gemini i2i 输出跟随参考图比例
    // （实测：方形 ref→1024x1024，3:4 ref→864x1184，文本声明无效）。锁脸不锁方：
    // 竖窗 = 脸的方形区往下延伸带肩颈（高 = side*4/3），引导竖构图且脸仍在上部锁住。
    const [aw, ah] = (normalizeAspect(aspect)).split(':').map(Number);
    const winW = Math.min(side, W - left);
    const winH = Math.min(Math.round(winW * ah / aw), H - top);
    const cut = await sharp(buf).extract({ left, top, width: winW, height: winH }).png().toBuffer();
    // 原图高度不够竖窗时补底边画布（米白，gemini 会按场景重绘，比例信号保留）
    const wantH = Math.round(winW * ah / aw);
    if (winH < wantH) {
      return await sharp(cut).extend({ bottom: wantH - winH, background: { r: 242, g: 238, b: 232 } }).png().toBuffer();
    }
    return cut;
  } catch {
    return buf; // 裁剪失败就用原图，不阻断发图
  }
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

// v1.19.5 (issue #237 #3): 生图模型（gpt-image / gemini-flash-image 系）偶发输出
// 三连格/六宫格 photo-strip 拼图——此前全链没有任何反拼图约束。固定追加在 sanitize
// **之后**（sanitizePhotoPrompt 的 900 字截断会吃掉尾部，不能拼在它之前）。
export const ANTI_COLLAGE_PROMPT = 'STRICTLY a single photo in one single frame — NOT a collage, no photo grid, no side-by-side panels, no photo strip, no multi-panel layout, no repeated copies of the same person';

export function buildFinalImagePrompt({ identityPrompt, scenePrompt, providerCapabilities, referenceImagePath }) {
  // v1.19.2: SCENERY/ACTIVITY-POV 无人脸 —— 不写人物 identity，也不写"keep the same face"
  // 的 referenceNote（否则 i2i 会硬把脸塞进无脸的桌面/风景 POV，如电脑前的工作 POV 变成人脸 candid）。
  const sceneryShot = isSceneryScene(scenePrompt);
  const referenceNote = sceneryShot
    ? 'first-person POV photo of the scene/objects in front of her — do NOT show her face, do NOT make it a selfie; the objects/scenery fill the frame, at most one hand or sleeve at the edge'
    : (referenceImagePath && providerCapabilities?.referenceImage
      ? 'use the provided reference image for FACE IDENTITY ONLY (keep the same face and likeness); completely IGNORE and REPLACE the reference image background, location, lighting, time of day, clothing and body pose — build the entire scene, background, lighting, time of day and outfit strictly from this text prompt. The photo time of day and setting MUST match the text (e.g. if the text says night, it must look like night), never the reference. Frame as a close waist-up phone shot unless the text says it is a scenery/POV shot'
      : 'keep the same adult person identity using the stable description');
  // 去重：planner 写的 imagePrompt 常已含部分质感词，拼接前剔掉重复，
  // 避免顶到 900 字上限把独有的质感词（skin texture / grain / DoF）截掉。
  const sceneLower = String(scenePrompt || '').toLowerCase();
  const tail = realismTailFor(scenePrompt).filter((t) => {
    const key = t.split(',')[0].trim().toLowerCase();
    return key && !sceneLower.includes(key);
  });
  const prompt = [
    sceneryShot ? '' : identityPrompt,   // 无脸 POV 不写人物外貌描述
    scenePrompt,
    referenceNote,
    ...tail,
  ].filter(Boolean).join(', ');
  const sanitized = sanitizePhotoPrompt(prompt);
  // 反拼图追加在截断之后，保证负面约束永远存活
  return sanitized ? `${sanitized}, ${ANTI_COLLAGE_PROMPT}` : sanitized;
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
  aspect = '3:4',           // v1.21.2: planner 按机位路由（aspectForShot）
  shotMode = '',            // 落库/digest 比例分布用
} = {}) {
  aspect = normalizeAspect(aspect);
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
    // v1.19.2: SCENERY/ACTIVITY-POV 无人脸 —— 不传参考图（走 t2i），否则 i2i 会把脸塞进桌面/风景 POV。
    let referenceImage = null;
    if (!isSceneryScene(scenePrompt) && visual?.capabilities?.referenceImage && visual?.referenceImagePath) {
      try {
        const rawRef = await readFile(visual.referenceImagePath);
        const refBuf = await cropReferenceToFace(rawRef, aspect); // 裁成目标比例窗：锁脸不锁方（输出跟随 ref 比例）
        const mime = refBuf === rawRef ? refMimeFromPath(visual.referenceImagePath) : 'image/png';
        referenceImage = `data:${mime};base64,${refBuf.toString('base64')}`;
        log('debug', `[Photo] i2i 参考图已载入 companion=${companion.id} raw=${rawRef.length} cropped=${refBuf.length}`);
      } catch (e) {
        log('warn', `[Photo] 读取参考图失败 companion=${companion.id}: ${e.message}`);
      }
    }
    const sizedPrompt = `${finalPrompt}, ${aspectPromptHint(aspect)}`;
    generated = { url: await generateImage(sizedPrompt, { size: ASPECT_SIZE[aspect], referenceImage }), prompt: sizedPrompt };
  } catch (e) {
    log('warn', `[Photo] 生成照片失败 companion=${companion.id}: ${e.message}`);
    return { ok: false, code: 'generate_failed', error: e.message, caption: finalCaption, activity: finalActivity };
  }

  let converted;
  try {
    converted = await writeConvertedPhoto(generated.url, companion.id, aspect);
    // v1.21.2: 尺寸落库（比例防回归数据源；arc-digest 出分布）
    try {
      const meta = await sharp(converted.outPath).metadata();
      insertPhotoLog(companion.id, { file: converted.outName, shotMode, aspect, width: meta.width, height: meta.height });
    } catch { /* 流水失败不阻塞发图 */ }
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
