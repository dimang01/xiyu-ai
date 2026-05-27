/**
 * 为落地页生成装饰图（hero / 各 section 配图）。
 * 输出到 ./public/assets/landing/
 */
import 'dotenv/config';
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { generateImage } from '../src/ai.mjs';

const OUT_DIR = path.resolve(process.cwd(), 'public/assets/landing');

const ASSETS = [
  {
    name: 'hero-girl.webp',
    prompt: 'anime portrait of a gentle young woman in her early twenties, soft long black hair, wearing pastel pink sweater, sitting in a sunlit cafe by a window, holding a phone, a warm content smile, cherry blossom petals gently floating in soft pink atmosphere, Studio Ghibli soft animation style, warm pastel colors, half body portrait, highly detailed face, no text, no signature',
    size: '1024x1024',
  },
  {
    name: 'feature-persona.webp',
    prompt: 'anime girl writing in a sakura pink diary, on bed in cozy bedroom, soft fairy lights, gentle warm lighting, slight smile, casual sweater, Kyoto Animation style, dreamy atmosphere, no text',
    size: '1024x1024',
  },
  {
    name: 'feature-schedule.webp',
    prompt: 'anime girl walking on tree-lined street in spring, school uniform, carrying backpack, cherry blossoms falling, golden afternoon light, side view, peaceful expression, illustration style, soft pastel colors, no text',
    size: '1024x1024',
  },
  {
    name: 'feature-memory.webp',
    prompt: 'cozy scene: anime girl looking at a glass jar of pink stars and floating photo memories, warm bedroom, soft glowing light, dreamy nostalgic mood, watercolor anime style, gentle pastel, no text',
    size: '1024x1024',
  },
  {
    name: 'feature-relationship.webp',
    prompt: 'two silhouettes of a couple walking under a sakura tree at dusk, pink and warm orange sky, falling petals, gentle romantic atmosphere, anime illustration style, no faces visible (back view), soft warm tones, no text',
    size: '1024x1024',
  },
];

async function downloadAndConvert(url, outPath) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const tmp = outPath + '.tmp';
  writeFileSync(tmp, buf);
  // 切顶部去水印：放大 13% → gravity north 切 1024x1024 → 丢掉底部 ~230px (含右下角水印)
  await new Promise((resolve, reject) => {
    const proc = spawn('convert', [
      tmp, '-auto-orient',
      '-resize', '1157x1157^',
      '-gravity', 'north',
      '-crop', '1024x1024+0+0', '+repage',
      '-strip', '-quality', '88', outPath,
    ]);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error('convert code=' + code)));
    proc.on('error', reject);
  });
  try { unlinkSync(tmp); } catch {}
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  for (const a of ASSETS) {
    const out = path.join(OUT_DIR, a.name);
    if (existsSync(out)) {
      console.log(`  ⊙ skip existing ${a.name}`);
      continue;
    }
    console.log(`  generating ${a.name}...`);
    try {
      const url = await generateImage(a.prompt, { size: a.size });
      await downloadAndConvert(url, out);
      console.log(`  ✓ ${a.name}`);
    } catch (e) {
      console.error(`  ✗ ${a.name}: ${e.message}`);
    }
  }
  console.log('done');
}

main().catch(e => { console.error(e); process.exit(1); });
