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
    let disabledCount = 0;
    const filtered = list.filter(s => {
      if (!s?.file) return false;
      // v1.10.25: 支持 disabled:true 跳过不合人设的 sticker（如儿童形象 BQB
      // 被 16 岁高中生人设 [STICKER:shy] 选中显然别扭）。manifest 里给整组
      // 加 "disabled": true 即可全跳。
      if (s.disabled === true) { disabledCount++; return false; }
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
    log('info', `[Stickers] loaded count=${filtered.length} tags=${byTag.size} disabled=${disabledCount}`);
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
  const tags = listAvailableTags(40);
  if (tags.length === 0) return '';
  // v1.9.2: 例子里加反讽/吐槽类，让 AI 知道这些 meme 反应也是可选的
  // （否则容易只在 happy/cute/cat 之间选，错过陪伴语境最有杀伤力的反讽场景）
  return `
【可用表情包】
- 在合适的场景可以用 [STICKER:tag] 表情标记
- 正面例子：[STICKER:happy]、[STICKER:love]、[STICKER:shy]
- 反讽吐槽：[STICKER:mock]、[STICKER:dismissive]、[STICKER:eyeroll]、[STICKER:whatever]、[STICKER:speechless]
  · 用在他得意忘形 / 说傻话 / 自恋 / 吹牛 / 找事时（"你又觉得你配了"这类反应）
- 场景：[STICKER:night]、[STICKER:morning]、[STICKER:hug]、[STICKER:ping]
- 可用 tag：${tags.join('、')}
- 心情合适时**大方用**——开心 / 害羞 / 撒娇 / 吐槽他 / 晚安早安 / 想他 这些场景都很贴，平均每 2-3 条带一个，情绪有起伏时更要用，让聊天更有表情、更像真人
- 一条消息最多一个表情，放开头或结尾；真没合适情绪时才不用（但别太吝啬）
- **表情包不是照片**——说"拍了/发你看"这类话时，要么系统真的在发照片，要么别这么说；想给他看你看到的东西时，用文字描述画面就行`;
}
