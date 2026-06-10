/**
 * 批量预生成头像池（120-150 张）。
 *
 * 维度组合：年龄段(3) × 发型(6) × 发色(4) × vibe(6) × style(4) → 限制总数 130
 * 每张：调 CogView-4 → 下载到 nginx 静态目录 → 转 512x512 webp → 存 DB metadata + 语义 embedding
 *
 * 用法：
 *   node --env-file=.env scripts/gen_avatar_presets.mjs [count=130]
 */
import 'dotenv/config';
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { generateImage, embedText } from '../src/ai.mjs';
import { insertAvatarPreset, countAvatarPresets } from '../src/db.mjs';

const PRESET_DIR = path.resolve(process.cwd(), 'public/avatars/preset');
const TARGET_COUNT = Number(process.argv[2]) || 130;

// 维度
const AGES = [
  { key: 'teen', en: 'cute high school girl, 16 years old, youthful', school: true },
  { key: 'college', en: 'college student in her early twenties, fresh and lively' },
  { key: 'young_pro', en: 'young professional woman in her mid-twenties, gentle yet mature' },
];
const HAIRS = [
  { color: 'black', style: 'long', en: 'long jet-black straight hair flowing past shoulders' },
  { color: 'black', style: 'twin_tail', en: 'glossy black hair tied in twin tails with ribbons' },
  { color: 'brown', style: 'short', en: 'soft brown chin-length bob, slightly curled inward' },
  { color: 'brown', style: 'ponytail', en: 'warm brown hair tied in a high ponytail' },
  { color: 'pink', style: 'long_curly', en: 'pastel pink long wavy hair, gentle curls' },
  { color: 'blonde', style: 'long', en: 'golden blonde long hair, light wave at ends' },
  { color: 'silver', style: 'short', en: 'silvery white short bob, ethereal look' },
  { color: 'lavender', style: 'twin_tail', en: 'lavender pastel twin tails, kawaii style' },
];
const VIBES = [
  { key: 'sweet',     en: 'soft sweet smile, gentle eyes, slight blush', clothing: 'pastel pink blouse or sweet lolita-lite outfit' },
  { key: 'energetic', en: 'bright energetic smile, sparkling eyes, lively pose', clothing: 'casual hoodie or sporty outfit' },
  { key: 'gentle',    en: 'serene gentle expression, soft eyes, calm aura', clothing: 'cream knit sweater or plain white blouse' },
  { key: 'tsundere',  en: 'slightly proud arched brow with hint of shyness, side glance', clothing: 'classy dress with bow or twin-tail school uniform' },
  { key: 'cool',      en: 'cool aloof gaze, faint mysterious smile', clothing: 'black turtleneck or simple monochrome top' },
  { key: 'literary',  en: 'thoughtful contemplative look, slight tilt of head', clothing: 'beige cardigan or library shirt, maybe holding a book' },
];
const STYLES = [
  'Studio Ghibli soft animation style, warm pastel colors, hand-painted feel',
  'modern anime portrait, vibrant colors, pixiv top quality, sharp detailed face',
  'Kyoto Animation style, gentle lighting, detailed glistening eyes',
  'soft watercolor anime style, dreamy atmosphere, gentle gradients',
];

// 生成维度组合（去重 + 多样化）
function* genCombos(count) {
  const combos = [];
  for (const age of AGES) {
    for (const hair of HAIRS) {
      for (const vibe of VIBES) {
        combos.push({ age, hair, vibe });
      }
    }
  }
  // shuffle
  for (let i = combos.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [combos[i], combos[j]] = [combos[j], combos[i]];
  }
  let i = 0;
  while (i < count && i < combos.length) {
    const c = combos[i];
    const style = STYLES[i % STYLES.length];
    yield { ...c, style, idx: i };
    i++;
  }
}

function buildPrompt(combo) {
  const { age, hair, vibe, style } = combo;
  const schoolBackground = age.school
    ? 'soft classroom or cherry blossom background'
    : 'soft pink and pastel gradient background';
  return `Anime portrait of ${age.en}, ${hair.en}, expressive ${vibe.key === 'cool' ? 'sharp' : 'warm'} eyes, ${vibe.en}, wearing ${vibe.clothing}, half-body portrait facing forward, ${schoolBackground}, ${style}, highly detailed face, no text, no signature, no realistic human, anime illustration only`;
}

function fileNameFor(combo) {
  return `preset_${combo.age.key}_${combo.hair.color}_${combo.hair.style}_${combo.vibe.key}_${String(combo.idx).padStart(3, '0')}.webp`;
}

async function downloadAndConvert(url, outPath) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const tmp = outPath + '.tmp';
  writeFileSync(tmp, buf);
  // 切顶部去水印：放大 13% → gravity north 切 512x512 → 丢掉底部 ~115px (含右下角水印)
  await new Promise((resolve, reject) => {
    const proc = spawn('convert', [
      tmp, '-auto-orient',
      '-resize', '578x578^',
      '-gravity', 'north',
      '-crop', '512x512+0+0', '+repage',
      '-strip', '-quality', '85', outPath,
    ]);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error('convert code=' + code)));
    proc.on('error', reject);
  });
  try { unlinkSync(tmp); } catch {}
}

async function processOne(combo) {
  const fileName = fileNameFor(combo);
  const outPath = path.join(PRESET_DIR, fileName);
  if (existsSync(outPath)) {
    console.log(`  ⊙ 跳过已存在 ${fileName}`);
    return null;
  }
  const prompt = buildPrompt(combo);
  let url;
  try {
    url = await generateImage(prompt);
  } catch (e) {
    console.error(`  ✗ 生成失败 ${fileName}: ${e.message}`);
    return null;
  }
  try {
    await downloadAndConvert(url, outPath);
  } catch (e) {
    console.error(`  ✗ 下载/转码失败 ${fileName}: ${e.message}`);
    return null;
  }
  // 生成 embedding（基于 prompt 语义，用于以后匹配）
  let emb = null;
  try {
    // 简化版描述（中文 + 维度），让 embedding 更接近 companion 描述
    const semanticDesc = `${combo.age.key === 'teen' ? '高中生' : combo.age.key === 'college' ? '大学生' : '上班族'} ${combo.vibe.key === 'sweet' ? '甜美' : combo.vibe.key === 'energetic' ? '活泼元气' : combo.vibe.key === 'gentle' ? '温柔安静' : combo.vibe.key === 'tsundere' ? '傲娇' : combo.vibe.key === 'cool' ? '冷艳' : '文艺'} ${combo.hair.color === 'black' ? '黑发' : combo.hair.color === 'brown' ? '棕发' : combo.hair.color === 'pink' ? '粉发' : combo.hair.color === 'blonde' ? '金发' : combo.hair.color === 'silver' ? '银发' : '紫发'} ${combo.hair.style === 'long' ? '长发' : combo.hair.style === 'short' ? '短发' : combo.hair.style === 'twin_tail' ? '双马尾' : combo.hair.style === 'ponytail' ? '马尾' : combo.hair.style === 'long_curly' ? '长卷发' : '波波头'}`;
    emb = await embedText(semanticDesc);
  } catch {}
  insertAvatarPreset({
    fileName, prompt,
    age_range: combo.age.key,
    hair_color: combo.hair.color,
    hair_style: combo.hair.style,
    vibe: combo.vibe.key,
    style: combo.style.split(',')[0],
    clothing: combo.vibe.clothing.split(/[,，]/)[0],
    embedding: emb,
  });
  console.log(`  ✓ ${fileName}`);
  return fileName;
}

async function main() {
  if (!existsSync(PRESET_DIR)) mkdirSync(PRESET_DIR, { recursive: true });
  const before = countAvatarPresets();
  console.log(`目标：${TARGET_COUNT} 张；当前 DB：${before.all} 张`);

  // 并发 4 个任务（CogView 一次最多 4-8 并发，超了会限流）
  const combos = [...genCombos(TARGET_COUNT)];
  const CONCURRENCY = 4;
  let done = 0;
  async function worker() {
    while (combos.length > 0) {
      const c = combos.shift();
      if (!c) break;
      await processOne(c);
      done++;
      if (done % 10 === 0) console.log(`--- 进度 ${done}/${TARGET_COUNT} ---`);
    }
  }
  await Promise.all(Array(CONCURRENCY).fill(0).map(() => worker()));
  const after = countAvatarPresets();
  console.log(`完成：${after.all} 张（新增 ${after.all - before.all}）`);
}

main().catch(e => { console.error(e); process.exit(1); });
