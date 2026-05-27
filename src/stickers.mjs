/**
 * 表情包管理器
 *
 * 读取 assets/stickers/manifest.json，按 tag/emotion 查图。
 * 启动时一次加载，文件变更需要 systemctl restart 才会重读。
  *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.mjs';

const STICKERS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'stickers',
);
const MANIFEST_PATH = path.join(STICKERS_DIR, 'manifest.json');

let cache = null;

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    log('info', '[Stickers] Sticker manifest not found, sticker replies disabled.');
    return { stickers: [], byTag: new Map() };
  }
  try {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    const list = Array.isArray(raw.stickers) ? raw.stickers : [];
    const filtered = list.filter(s => {
      if (!s?.file) return false;
      const full = path.join(STICKERS_DIR, s.file);
      const ok = existsSync(full);
      if (!ok) log('warn', `[Stickers] missing file: ${s.file}`);
      return ok;
    });
    const byTag = new Map();
    for (const s of filtered) {
      const tags = [
        ...(Array.isArray(s.tags) ? s.tags : []),
        s.emotion,
      ].filter(Boolean).map(t => String(t).toLowerCase());
      for (const tag of tags) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push(s);
      }
    }
    log('info', `[Stickers] loaded count=${filtered.length} tags=${byTag.size}`);
    return { stickers: filtered, byTag };
  } catch (err) {
    log('warn', `[Stickers] manifest 解析失败: ${err.message}`);
    return { stickers: [], byTag: new Map() };
  }
}

function getCache() {
  if (!cache) cache = loadManifest();
  return cache;
}

export function reloadStickers() {
  cache = loadManifest();
  return cache;
}

export function hasStickers() {
  return getCache().stickers.length > 0;
}

export function listAvailableTags(maxTags = 30) {
  const { byTag } = getCache();
  return [...byTag.keys()].slice(0, maxTags);
}

/**
 * 按 tag 挑一张。多个匹配时随机选。找不到返回 null。
 */
export function pickSticker(tag) {
  if (!tag) return null;
  const { byTag } = getCache();
  const key = String(tag).toLowerCase().trim();
  let pool = byTag.get(key) || [];
  // 退一步：模糊匹配（tag 包含关系）
  if (pool.length === 0) {
    for (const [k, list] of byTag.entries()) {
      if (k.includes(key) || key.includes(k)) {
        pool = pool.concat(list);
      }
    }
  }
  if (pool.length === 0) return null;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  return {
    id: picked.id,
    file: picked.file,
    fullPath: path.join(STICKERS_DIR, picked.file),
    tags: picked.tags || [],
    emotion: picked.emotion || null,
    description: picked.description || null,
  };
}

/**
 * 从 AI 回复里抽取 [STICKER:tag] 标记。
 * 返回 { text: 剥离后的纯文本, stickers: [{tag, picked}] }
 * 同时支持中文中括号【STICKER:xx】。
 */
const STICKER_RE = /[\[【]STICKER:\s*([\w一-龥]+)\s*[\]】]/gi;

export function parseStickerMarkers(reply) {
  if (typeof reply !== 'string' || !reply) return { text: reply || '', stickers: [] };
  const stickers = [];
  const text = reply.replace(STICKER_RE, (_, tag) => {
    const picked = pickSticker(tag);
    if (picked) stickers.push({ tag, picked });
    return '';
  }).replace(/\s+/g, ' ').trim();
  return { text, stickers };
}

/**
 * 给 system prompt 用：告诉 AI 当前可用的 tag 集合。
 */
export function buildStickerPromptHint(enabled) {
  if (!enabled || !hasStickers()) return '';
  const tags = listAvailableTags(30);
  if (tags.length === 0) return '';
  return `
【可用表情包】
- 在合适的场景可以用 [STICKER:tag] 表情标记，比如 [STICKER:happy]、[STICKER:cat]、[STICKER:night]
- 可用 tag：${tags.join('、')}
- 一条消息最多用一个表情；不要每条都用；标记要放在合适的位置（开头/结尾）
- 没有特别合适的情绪时就不要硬塞表情`;
}
