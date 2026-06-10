// v1.21.2 PR-D 比例复现工具（真跑 302/gemini，手动）：node scripts/photo_aspect_repro.mjs
// 实测结论：gemini 文本比例声明无效（t2i/i2i 均 1:1）；3:4 画布 ref → 输出 864x1184 ✓
// PR-D 第一步复现：t2i / i2i / 落地转码 三环节真实宽高记录（302/gemini 真跑）
import dotenv from 'dotenv';
dotenv.config({ path: '/opt/xiyu-ai-new/.env' });
process.env.DB_PATH = '/tmp/aspect_repro.db';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
const { imageGenerate } = await import('../src/providers/image.mjs');

async function probe(url, label) {
  const buf = url.startsWith('data:')
    ? Buffer.from(url.split(',')[1], 'base64')
    : Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
  const m = await sharp(buf).metadata();
  console.log(`${label}: ${m.width}x${m.height}  (${(m.width / m.height).toFixed(3)})`);
  return { buf, w: m.width, h: m.height };
}

const scene = 'casual smartphone selfie of a young woman in a cozy cafe, warm afternoon light, photorealistic';

// ① t2i 现状（size 文本=1024x1024）
const u1 = await imageGenerate(scene, { size: '1024x1024' });
const r1 = await probe(u1, '① t2i 现状 size=1024x1024');

// ② t2i 竖屏文本兜底（size 文本=768x1024 + 构图声明）
const u2 = await imageGenerate(scene + ', vertical portrait orientation, 3:4 aspect ratio, shot on phone front camera held upright', { size: '768x1024' });
const _r2 = await probe(u2, '② t2i 竖屏文本兜底 size=768x1024');

// ③ i2i 方形参考（用 ① 的方图当 ref）→ 输出是否跟随方形
const sq = await sharp(r1.buf).resize(512, 512).png().toBuffer();
writeFileSync('/tmp/ref_sq.png', sq);
const u3 = await imageGenerate(scene + ', vertical portrait orientation, 3:4 aspect ratio', { size: '768x1024', referenceImage: `data:image/png;base64,${sq.toString('base64')}` });
await probe(u3, '③ i2i 方形ref+竖屏文本');

// ④ i2i 3:4 参考画布 → 输出是否跟随竖形
const tall = await sharp(r1.buf).resize(512, 512).extend({ top: 85, bottom: 85, background: { r: 240, g: 235, b: 230 } }).png().toBuffer();
const u4 = await imageGenerate(scene + ', vertical portrait orientation, 3:4 aspect ratio', { size: '768x1024', referenceImage: `data:image/png;base64,${tall.toString('base64')}` });
await probe(u4, '④ i2i 3:4ref+竖屏文本');

console.log('repro done');
process.exit(0);
// ═══ v1.21.2 修复后端到端验收（追加段）：三机位真跑 → 落地最终尺寸 ═══
