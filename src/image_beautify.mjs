/**
 * v1.10.52 全局图片美颜后处理
 *
 * 在 imageGenerate 层调用，所有发出去的图（identity candidates、photo
 * sender、avatar 等）自动经过：
 *   - 微提亮 brightness 1.08
 *   - 增饱和 saturation 1.13（粉嫩感）
 *   - 微调整对比 (1.03, -4) 让肤色更柔
 *   - 极轻高斯模糊 0.65（磨皮感更明显，但仍不糊掉眼睛/发丝细节）
 *
 * v1.10.53: 强度整体提一档（用户反馈「美颜可以高一点」），仍刻意不到
 * 网红/塑料感。.env 设 IMAGE_BEAUTIFY_ENABLED=false 可关。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import sharp from 'sharp';
import { log } from './logger.mjs';

const BEAUTIFY_ENABLED = String(process.env.IMAGE_BEAUTIFY_ENABLED ?? 'true').toLowerCase() !== 'false';

/**
 * @param {Buffer} buf 原始图片字节
 * @param {object} opts
 * @returns {Promise<Buffer>} 美颜后的字节
 */
export async function beautifyImage(buf, opts = {}) {
  if (!BEAUTIFY_ENABLED) return buf;
  if (!Buffer.isBuffer(buf) || buf.length < 512) return buf;
  const t0 = Date.now();
  try {
    const out = await sharp(buf)
      .modulate({
        brightness: opts.brightness ?? 1.08,
        saturation: opts.saturation ?? 1.13,
      })
      .linear(opts.contrast ?? 1.03, opts.contrastOffset ?? -4)
      .blur(opts.blur ?? 0.65)
      .png({ quality: 92, compressionLevel: 6 })
      .toBuffer();
    log('debug', `[beautify] ok ${buf.length}→${out.length} ${Date.now() - t0}ms`);
    return out;
  } catch (e) {
    log('warn', `[beautify] 失败，返回原图: ${e.message}`);
    return buf;
  }
}

/**
 * 把 imageGenerate 返回的 URL（data:base64 或 http）解成 Buffer。
 * @param {string} url
 * @returns {Promise<Buffer|null>}
 */
export async function urlToBuffer(url) {
  if (!url) return null;
  if (url.startsWith('data:image/')) {
    const m = url.match(/^data:image\/[a-z+]+;base64,(.+)$/i);
    return m ? Buffer.from(m[1], 'base64') : null;
  }
  if (/^https?:\/\//.test(url)) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) return null;
      return Buffer.from(await resp.arrayBuffer());
    } catch (e) {
      log('warn', `[beautify] urlToBuffer 失败: ${e.message}`);
      return null;
    }
  }
  return null;
}

/**
 * 便利方法：URL → buffer → beautify → data:URL（让 imageGenerate 返回类型不变）
 * @param {string} url
 * @returns {Promise<string>} data: 开头的 URL；失败返回原 url
 */
export async function beautifyImageUrl(url) {
  if (!BEAUTIFY_ENABLED) return url;
  const buf = await urlToBuffer(url);
  if (!buf) return url;
  const out = await beautifyImage(buf);
  return `data:image/png;base64,${out.toString('base64')}`;
}

export function isBeautifyEnabled() {
  return BEAUTIFY_ENABLED;
}
