/**
 * voice_pipeline.mjs — TTS → SILK 转码管线 (v1.4.0 Sprint 1)
 *
 * 调用链：
 *   text → ttsSynthesize() → mp3 Buffer → wx-voice encode → SILK Buffer + duration_ms
 *
 * v1.4.0 SILK 输出原本是为微信发语音准备的；但 iLink 协议禁止 bot outbound voice
 * （HTTP 200 静默丢弃，官方 SDK 没有 sendVoice）。所以 SILK 路径目前不在生产
 * 链路里跑，留着是为协议层将来放开后能即插即用。生产用的是 mp3 路径（浏览器
 * 端 playground 朗读 / dashboard 试听 / diary 朗读都直接播 mp3）。
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
import { spawn } from 'node:child_process';
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

// 用 ffprobe 拿 mp3 真实时长（秒，float）。失败返回 null。
function probeDurationSeconds(filePath) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
    const p = spawn('ffprobe', args);
    let out = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const v = parseFloat(out.trim());
      resolve(Number.isFinite(v) && v > 0 ? v : null);
    });
  });
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
 * 它的 callback 接收的是输出文件路径字符串（truthy 即成功），失败时为 undefined。
 * 注意：wx-voice 不返回 duration，duration 由 caller 自行用 ffprobe 解 mp3 算。
 */
function wxEncode(mp3In, silkOut) {
  return new Promise((resolve, reject) => {
    try {
      const v = getWxVoiceInstance();
      v.encode(mp3In, silkOut, { format: 'silk' }, (res) => {
        if (!res) {
          reject(new Error('wx-voice encode 失败（callback 收到 undefined，可能 SILK SDK 未编译或 mp3 损坏）'));
          return;
        }
        resolve(res); // 输出文件路径
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
  let silk;
  let duration_ms;

  try {
    await writeFile(mp3File, mp3);
    // ffprobe 拿 duration（并行启动，不阻塞 encode）
    const [probedSec] = await Promise.all([
      probeDurationSeconds(mp3File),
      wxEncode(mp3File, silkFile),
    ]);
    silk = await readFile(silkFile);
    if (!silk || silk.length < 32) throw new Error('[voice_pipeline] SILK 文件为空');
    if (probedSec && probedSec > 0) {
      duration_ms = Math.round(probedSec * 1000);
    } else {
      // 兜底：按 SILK 24kHz mono 大约 1500 bytes/s 估算（粗但够用）
      duration_ms = Math.max(500, Math.round((silk.length / 1500) * 1000));
      log('warn', `[voice_pipeline] ffprobe 失败，duration 估算为 ${duration_ms}ms`);
    }
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
