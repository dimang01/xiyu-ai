/**
 * iLink CDN 媒体上传：AES-128-ECB 加密 → getUploadUrl → CDN 上传 → 拿到 downloadParam
 *
 * 用法：
 *   const { item } = await uploadFile({ data, fileName: 'cute.png', toUserId, ctx });
 *   // 把 item 塞进 sendmessage 的 item_list 即可
 *
 * 算法和参数都对齐 openclaw-weixin 官方 SDK，确保兼容。
  *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { log } from './logger.mjs';

const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const API_TIMEOUT_MS = 15_000;
const CDN_UPLOAD_TIMEOUT_MS = 60_000;
const CDN_MAX_RETRIES = 3;
const MAX_FILE_SIZE = 100 * 1024 * 1024;

// iLink 端 type 字段（MessageItemType）：1 TEXT, 2 IMAGE, 3 VOICE, 4 FILE, 5 VIDEO
export const ItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
// CDN 上传 media_type（UploadMediaType）—— 注意和 ItemType 是两套枚举：
// 1 IMAGE, 2 VIDEO, 3 FILE, 4 VOICE。VOICE 必须用 4，用 FILE(3) 会被 iLink 静默丢弃
// （HTTP 200 但消息不送达微信端）。修自 v1.4.0 hotfix。
export const CDNMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 };

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
const VOICE_EXTS = new Set(['.silk', '.slk', '.amr']);

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function classifyMedia(fileName, mediaTypeOverride = null) {
  // 显式覆盖优先（caller 说"这是 voice"就当 voice，不靠后缀猜）
  if (mediaTypeOverride === 'voice') {
    return { cdnType: CDNMediaType.VOICE, itemType: ItemType.VOICE };
  }
  if (mediaTypeOverride === 'image') {
    return { cdnType: CDNMediaType.IMAGE, itemType: ItemType.IMAGE };
  }
  if (mediaTypeOverride === 'video') {
    return { cdnType: CDNMediaType.VIDEO, itemType: ItemType.VIDEO };
  }
  const ext = path.extname(fileName || '').toLowerCase();
  if (IMAGE_EXTS.has(ext)) return { cdnType: CDNMediaType.IMAGE, itemType: ItemType.IMAGE };
  if (VIDEO_EXTS.has(ext)) return { cdnType: CDNMediaType.VIDEO, itemType: ItemType.VIDEO };
  if (VOICE_EXTS.has(ext)) return { cdnType: CDNMediaType.VOICE, itemType: ItemType.VOICE };
  return { cdnType: CDNMediaType.FILE, itemType: ItemType.FILE };
}

function randomUIN() {
  const n = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(n), 'utf-8').toString('base64');
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把本地文件/URL 读成 Buffer。
 */
export async function readMediaBuffer(filePath) {
  if (typeof filePath !== 'string') throw new Error('readMediaBuffer: filePath must be string');
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    const res = await fetchWithTimeout(filePath, {}, CDN_UPLOAD_TIMEOUT_MS);
    if (!res.ok) throw new Error(`download ${filePath}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE_SIZE) throw new Error(`file too large: ${buf.length}`);
    const u = new URL(filePath);
    return { data: buf, name: path.basename(u.pathname) || 'file' };
  }
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_SIZE) throw new Error(`file too large: ${stat.size}`);
  const data = await fs.readFile(filePath);
  return { data, name: path.basename(filePath) };
}

/**
 * 加密上传一个媒体文件到 iLink CDN，返回可以塞进 sendmessage 的 MessageItem。
 *
 * @param {object} args
 * @param {Buffer} args.data           - 文件二进制
 * @param {string} args.fileName       - 文件名（用于识别扩展名，voice 没扩展名时也要传一个）
 * @param {string} args.toUserId       - 接收方
 * @param {object} args.ctx            - { baseUrl, token }
 * @param {string} [args.mediaType]    - 显式覆盖：'voice' / 'image' / 'video' / 'file'；
 *                                       默认按 fileName 扩展名识别
 * @param {number} [args.durationMs]   - voice 必填：音频时长毫秒
 */
export async function uploadFile({ data, fileName, toUserId, ctx, mediaType = null, durationMs = null }) {
  if (!data || !data.length) throw new Error('uploadFile: empty data');
  if (!ctx?.token) throw new Error('uploadFile: missing ctx.token');
  if (!toUserId) throw new Error('uploadFile: missing toUserId');

  const baseUrl = (ctx.baseUrl || 'https://ilinkai.weixin.qq.com').replace(/\/$/, '');
  const { cdnType, itemType } = classifyMedia(fileName, mediaType);
  if (itemType === ItemType.VOICE && (!durationMs || durationMs <= 0)) {
    throw new Error('uploadFile: voice 类型必须传 durationMs');
  }

  const filekey = crypto.randomBytes(16).toString('hex');
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString('hex');
  const rawMd5 = crypto.createHash('md5').update(data).digest('hex');
  const cipherSize = aesEcbPaddedSize(data.length);

  // 1. getUploadUrl
  const reqBody = {
    filekey,
    media_type: cdnType,
    to_user_id: toUserId,
    rawsize: data.length,
    rawfilemd5: rawMd5,
    filesize: cipherSize,
    no_need_thumb: true,
    aeskey: aesKeyHex,
    base_info: { channel_version: '2.4.4', bot_agent: 'OpenClaw' },
  };

  const uploadUrlRes = await fetchWithTimeout(
    `${baseUrl}/ilink/bot/getuploadurl`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'AuthorizationType': 'ilink_bot_token',
        'Authorization': `Bearer ${ctx.token}`,
        'X-WECHAT-UIN': randomUIN(),
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': '132100',
      },
      body: JSON.stringify(reqBody),
    },
    API_TIMEOUT_MS,
  );
  const uploadUrlRaw = await uploadUrlRes.text();
  if (!uploadUrlRes.ok) {
    throw new Error(`getuploadurl HTTP ${uploadUrlRes.status}: ${uploadUrlRaw.slice(0, 200)}`);
  }
  let uploadResp;
  try { uploadResp = JSON.parse(uploadUrlRaw); } catch { throw new Error(`getuploadurl invalid JSON: ${uploadUrlRaw.slice(0, 200)}`); }

  // iLink 新旧两种返回：
  //   旧版：{ ret, upload_param }   → 客户端拼 URL
  //   新版：{ upload_full_url }     → 直接用现成 URL
  let cdnUrl;
  if (uploadResp.upload_full_url) {
    cdnUrl = String(uploadResp.upload_full_url);
  } else if (uploadResp.upload_param) {
    cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadResp.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
  } else {
    log('warn', `[Media] getuploadurl 拒绝 file=${fileName} size=${data.length} cdnType=${cdnType} raw=${uploadUrlRaw.slice(0, 500)}`);
    throw new Error(`getuploadurl failed ret=${uploadResp.ret} errmsg=${uploadResp.errmsg ?? uploadResp.err_msg ?? '(no upload url)'} keys=${Object.keys(uploadResp).join(',')}`);
  }
  if ((uploadResp.ret ?? 0) !== 0) {
    throw new Error(`getuploadurl ret=${uploadResp.ret} errmsg=${uploadResp.errmsg ?? '(unknown)'}`);
  }

  // 2. AES-128-ECB 加密
  const ciphertext = encryptAesEcb(data, aesKey);

  // 3. PUT 到 CDN
  let downloadParam = null;
  let lastErr;
  for (let attempt = 1; attempt <= CDN_MAX_RETRIES; attempt++) {
    try {
      const cdnRes = await fetchWithTimeout(
        cdnUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
        },
        CDN_UPLOAD_TIMEOUT_MS,
      );
      if (cdnRes.status >= 400 && cdnRes.status < 500) {
        throw new Error(`CDN upload client error ${cdnRes.status}`);
      }
      if (cdnRes.status !== 200) {
        throw new Error(`CDN upload server error ${cdnRes.status}`);
      }
      downloadParam = cdnRes.headers.get('x-encrypted-param');
      if (!downloadParam) throw new Error('CDN response missing x-encrypted-param header');
      break;
    } catch (err) {
      lastErr = err;
      if (String(err.message || '').includes('client error')) throw err;
      if (attempt >= CDN_MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  if (!downloadParam) throw lastErr || new Error('CDN upload failed');

  const media = {
    encrypt_query_param: downloadParam,
    aes_key: Buffer.from(aesKeyHex).toString('base64'),
    encrypt_type: 1,
  };

  let item;
  if (itemType === ItemType.IMAGE) {
    item = { type: ItemType.IMAGE, image_item: { media, mid_size: cipherSize } };
  } else if (itemType === ItemType.VIDEO) {
    item = { type: ItemType.VIDEO, video_item: { media, video_size: cipherSize } };
  } else if (itemType === ItemType.VOICE) {
    // 字段名对齐 openclaw-weixin 官方 voice-outbound.js:
    //   playtime_ms (不是 duration_ms)、encode_type=6 (SILK)、sample_rate=24000 (SILK 标准)
    // 之前 voice_size 是 image_item 的范式，voice_item 里没有这字段、传了被 iLink 视为
    // 协议错误静默丢弃。
    item = {
      type: ItemType.VOICE,
      voice_item: {
        media,
        playtime_ms: Math.round(durationMs),
        encode_type: 6,
        sample_rate: 24000,
      },
    };
  } else {
    item = {
      type: ItemType.FILE,
      file_item: { media, file_name: fileName || 'file', len: String(data.length) },
    };
  }

  log('info', `[Media] uploaded filename=${fileName} size=${data.length} cipherSize=${cipherSize} type=${itemType} to=${String(toUserId).slice(0, 20)}`);
  return { item, downloadParam, aesKeyHex, fileSize: data.length, cipherSize };
}
