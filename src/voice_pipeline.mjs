/**
 * voice_pipeline.mjs — TTS → SILK 转码管线 (v1.4.0 Sprint 1)
 *
 * 调用链：
 *   text → ttsSynthesize() → mp3 Buffer → wx-voice encode → SILK Buffer + duration_ms
 *
 * 上游 (Sprint 2) src/proactive.mjs 会拿 silk + duration_ms 走 src/ilink.mjs::
 * sendVoiceMessage 推到微信。
 *
 * 临时文件策略：所有 mp3/silk 临时文件都在 os.tmpdir() 下，用随机名，try/finally
 * 必删。任何一步失败都不能留垃圾。
 *
 * 失败语义：抛 Error 让 caller 决定降级（不在这里 fallback 到文本）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { log } from './logger.mjs';
import { ttsSynthesize } from './providers/tts.mjs';

// wx-voice 是 CommonJS 模块，用 createRequire 桥接到 ESM
const require = createRequire(import.meta.url);

let _wxVoice = null;
function getWxVoiceInstance() {
  if (_wxVoice) return _wxVoice;
  const WxVoice = require('wx-voice');
  _wxVoice = new WxVoice();
  return _wxVoice;
}

function tmpPath(ext) {
  const name = `xiyu-voice-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
  return path.join(os.tmpdir(), name);
}

async function silentRm(filePath) {
  if (!filePath) return;
  try { await unlink(filePath); } catch { /* 已删/不存在都无所谓 */ }
}

/**
 * 用 wx-voice encode：把 mp3 文件转成 SILK 文件。
 * 它的 API 是 callback 风格，包成 Promise。
 * 同时返回 wx-voice probe 出的 duration（秒）。
 */
function wxEncode(mp3In, silkOut) {
  return new Promise((resolve, reject) => {
    try {
      const v = getWxVoiceInstance();
      v.encode(mp3In, silkOut, { format: 'silk' }, (info) => {
        // wx-voice 不直接报错，失败时回调拿到 undefined / 没有 duration
        if (!info || typeof info.duration !== 'number' || info.duration <= 0) {
          reject(new Error('wx-voice encode 返回无效 info'));
          return;
        }
        resolve(info); // { duration: <seconds, float> }
      });
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * 合成文本 → SILK 字节流 + 时长。
 *
 * @param {string} text - 待合成中文
 * @param {object} opts - 透传给 ttsSynthesize 的参数（voice_id/speed/model/timeoutMs）
 * @returns {Promise<{ silk: Buffer, duration_ms: number, mp3: Buffer, provider: string, voice_id: string }>}
 */
export async function synthesizeAndConvertToSilk(text, opts = {}) {
  if (!text || typeof text !== 'string') throw new Error('[voice_pipeline] text 必填');

  // Step 1: TTS → mp3 Buffer
  const { audio: mp3, format, provider, voice_id } = await ttsSynthesize(text, opts);
  if (format !== 'mp3') throw new Error(`[voice_pipeline] 期望 mp3 但收到 ${format}`);
  if (!mp3 || mp3.length < 32) throw new Error('[voice_pipeline] mp3 字节为空');

  // Step 2: 落盘 → wx-voice 编码 → 读回 SILK
  const mp3File = tmpPath('mp3');
  const silkFile = tmpPath('silk');
  let silk = null;
  let duration_ms = 0;

  try {
    await writeFile(mp3File, mp3);
    const info = await wxEncode(mp3File, silkFile);
    duration_ms = Math.round(info.duration * 1000);
    silk = await readFile(silkFile);
    if (!silk || silk.length < 32) throw new Error('[voice_pipeline] SILK 文件为空');
  } finally {
    // 任何路径都清临时文件
    await silentRm(mp3File);
    await silentRm(silkFile);
  }

  log('info', `[voice_pipeline] ok provider=${provider} chars=${text.length} mp3=${mp3.length}B silk=${silk.length}B dur=${duration_ms}ms`);
  return { silk, duration_ms, mp3, provider, voice_id };
}

/**
 * 仅做 TTS，不转 SILK。给前端"试听"路由用 (T1.5)。
 */
export async function synthesizeMp3Only(text, opts = {}) {
  if (!text || typeof text !== 'string') throw new Error('[voice_pipeline] text 必填');
  const { audio: mp3, format, provider, voice_id } = await ttsSynthesize(text, opts);
  if (format !== 'mp3') throw new Error(`[voice_pipeline] 期望 mp3 但收到 ${format}`);
  log('info', `[voice_pipeline] mp3-only provider=${provider} chars=${text.length} bytes=${mp3.length}`);
  return { mp3, provider, voice_id };
}
