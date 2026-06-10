/**
 * voice_inbound.mjs — 入站微信语音 download + AES 解密 + silk decode → mp3 Buffer
 *
 * iLink 入站 voice_item 给的 media 字段：
 *   - full_url:           https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=...&taskid=...
 *   - aes_key:            base64(utf8(aesKeyHex))，解码后是 32 字符 hex 串，再转 16 字节
 *   - encrypt_query_param: 备用（full_url 已含）
 *
 * 对称于 media.mjs 出站：encryptAesEcb('aes-128-ecb', 16-byte key, null IV, PKCS7)。
 *
 * silk 用 wx-voice 解码到 mp3（wx-voice CLI/API 要文件路径，所以走临时文件）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';


const require = createRequire(import.meta.url);

let _wxVoice = null;
function getWxVoice() {
  if (_wxVoice) return _wxVoice;
  const WxVoice = require('wx-voice');
  _wxVoice = new WxVoice();
  return _wxVoice;
}

function decryptAesEcb(ciphertext, keyBuf) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', keyBuf, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// iLink 出站时把 16 字节 key 先 hex 化（32 字符）再 base64 包一层；入站对称解开。
// 同时容错"直接 base64 原始 16 字节"格式，未来 iLink 改协议也能跑。
function parseAesKey(b64) {
  const decoded = Buffer.from(b64, 'base64');
  if (decoded.length === 16) return decoded;
  const asUtf8 = decoded.toString('utf8');
  if (/^[0-9a-fA-F]{32}$/.test(asUtf8)) return Buffer.from(asUtf8, 'hex');
  throw new Error(`unrecognized aes_key format: len=${decoded.length} sample=${asUtf8.slice(0, 16)}`);
}

function decodeSilkToMp3(silkPath, mp3Path, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const w = getWxVoice();
    let done = false;
    const finish = (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('wx-voice decode timeout')), timeoutMs);
    const errHandler = (err) => finish(err instanceof Error ? err : new Error(String(err)));
    w.once('error', errHandler);
    try {
      w.decode(silkPath, mp3Path, { format: 'mp3' }, (file) => {
        w.removeListener('error', errHandler);
        if (file) finish(null, file);
        else finish(new Error('wx-voice decode returned empty path'));
      });
    } catch (e) {
      w.removeListener('error', errHandler);
      finish(e);
    }
  });
}

/**
 * 入站语音完整管道：download → AES 解密 → silk decode → mp3 Buffer
 *
 * @param {object} voiceItem - msg.voiceItem
 * @returns {Promise<{ mp3: Buffer, durationMs: number, cipherBytes: number, mp3Bytes: number }>}
 */
export async function downloadInboundVoiceToMp3(voiceItem) {
  if (!voiceItem) throw new Error('no voiceItem');
  const url = voiceItem?.media?.full_url;
  const aesB64 = voiceItem?.media?.aes_key;
  if (!url) throw new Error('voiceItem.media.full_url missing');
  if (!aesB64) throw new Error('voiceItem.media.aes_key missing');

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`download HTTP ${resp.status}`);
  const cipher = Buffer.from(await resp.arrayBuffer());
  if (cipher.length < 16 || cipher.length % 16 !== 0) {
    throw new Error(`unexpected cipher length=${cipher.length}`);
  }

  const aesKey = parseAesKey(aesB64);
  const silk = decryptAesEcb(cipher, aesKey);
  if (silk.length < 8) throw new Error(`silk too small=${silk.length}`);

  const id = crypto.randomBytes(8).toString('hex');
  const silkPath = path.join(os.tmpdir(), `xiyu-inbound-${id}.silk`);
  const mp3Path = path.join(os.tmpdir(), `xiyu-inbound-${id}.mp3`);

  try {
    await writeFile(silkPath, silk);
    await decodeSilkToMp3(silkPath, mp3Path);
    const mp3 = await readFile(mp3Path);
    if (!mp3.length) throw new Error('decoded mp3 empty');
    return {
      mp3,
      durationMs: Number(voiceItem.playtime) || 0,
      cipherBytes: cipher.length,
      mp3Bytes: mp3.length,
    };
  } finally {
    await unlink(silkPath).catch(() => {});
    await unlink(mp3Path).catch(() => {});
  }
}
