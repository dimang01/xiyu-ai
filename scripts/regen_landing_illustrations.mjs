#!/usr/bin/env node
/**
 * 用 OpenRouter (openai/gpt-5-image-mini) 重新生成 5 张落地页插图，
 * PNG → WebP 转码并覆盖 public/assets/landing/*.webp。
 *
 * 用法：
 *   OPENROUTER_API_KEY=sk-or-... node scripts/regen_landing_illustrations.mjs
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
  console.error('缺少 OPENROUTER_API_KEY 环境变量');
  process.exit(1);
}

const ROOT = path.resolve(process.cwd(), 'public/assets/landing');
if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true });

const PALETTE = 'soft pastel palette: blush pink (#FFB6D9), sakura cream (#FFE8F2), cloud white (#FAFAFA), gentle slate ink. very airy negative space.';
const STYLE   = 'minimal modern flat illustration, clean vector look, dreamy editorial style, no text, no logos, no faces with photoreal features (semi-abstract is OK), soft long shadows, subtle grain.';
const FRAME   = '1:1 square composition, plenty of white space, slight off-center balance, mobile-friendly.';

const TARGETS = [
  // 注：v1.6.2 试过 hero-girl 作为首页 hero 衬底 / auth 左栏主视觉，gpt-5-image-mini
  // 生成出来是粉发二次元少女正脸，与产品"她像真实的人"调性冲突，作为衬底也太抢戏。
  // v1.6.3 撤掉这张图，首页保持干净 logo + 文案，auth 左栏改用 feature-persona。
  // 如果以后想加人物视觉，prompt 要重写到强制不露脸 + 写实摄影感（无 anime）。
  {
    name: 'feature-persona',
    prompt: `An open journal with hand-drawn life mementos floating around it: a small pressed flower, a tiny polaroid of a cat, a folded paper crane, a coffee ring, a tiny ribbon. Symbolizing a complete inner life and memories. ${PALETTE} ${STYLE} ${FRAME}`,
  },
  {
    name: 'feature-schedule',
    prompt: `A soft rounded analog clock at center, surrounded by tiny floating life icons: a croissant, a book, a tea cup, a yoga mat, a moon — arranged like a daily timeline orbit. Symbolizing a real lived day. ${PALETTE} ${STYLE} ${FRAME}`,
  },
  {
    name: 'feature-relationship',
    prompt: `Five hearts left to right, growing in size and saturation from a faint outlined heart to a deep blushing heart, connected by a delicate dotted curve like a relationship arc. Tiny sparkle accents. Symbolizing 5 relationship stages. ${PALETTE} ${STYLE} ${FRAME}`,
  },
  {
    name: 'feature-memory',
    prompt: `A constellation of memory cards floating gently: each card shows a tiny pictogram (a coffee, a cat, a birthday cake, a book, a moon). Thin connecting lines between them like neural links. Calm, organized, dreamy. ${PALETTE} ${STYLE} ${FRAME}`,
  },
];

async function generateOne({ name, prompt }) {
  const t0 = Date.now();
  console.log(`[${name}] requesting...`);
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://github.com/dimang01/xiyu-ai',
      'X-Title': process.env.OPENROUTER_APP_TITLE || 'Xiyu AI landing illustration',
    },
    body: JSON.stringify({
      model: 'openai/gpt-5-image-mini',
      messages: [{ role: 'user', content: prompt }],
      modalities: ['image', 'text'],
    }),
  });
  if (!resp.ok) {
    throw new Error(`[${name}] HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json();
  const url = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url || '';
  const m = url.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) throw new Error(`[${name}] no image in response`);
  const ext = m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  const tmpPath = path.join(ROOT, `${name}.${ext}.tmp`);
  const webpPath = path.join(ROOT, `${name}.webp`);
  writeFileSync(tmpPath, buf);

  // PNG → WebP, 限制最大边 1280 减体积
  const r = spawnSync('convert', [
    tmpPath,
    '-strip',
    '-resize', '1280x1280>',
    '-quality', '88',
    '-define', 'webp:method=6',
    webpPath,
  ], { stdio: 'inherit' });
  try { unlinkSync(tmpPath); } catch {}
  if (r.status !== 0) throw new Error(`[${name}] convert exit ${r.status}`);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[${name}] ok → ${webpPath} (${buf.length} B src, ${elapsed}s)`);
}

(async () => {
  // 限制并发 2，避免一次性 5 个长请求触发上游限流
  const queue = [...TARGETS];
  const workers = Array.from({ length: 2 }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await generateOne(item); }
      catch (e) { console.error(`✗ ${item.name}: ${e.message}`); }
    }
  });
  await Promise.all(workers);
  console.log('done');
})();
