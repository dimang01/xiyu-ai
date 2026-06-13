/**
 * avatar_realism_ab —— 头像反恐怖谷 A/B 真出图对比（手动跑，需 image provider）。2026-06-13。
 *
 * 同一组 appearance 种子，OLD（含 porcelain/baby-faced/doe-eyed/glossy 的旧 prompt）与
 * NEW（删四禁词 + 接入 REALISTIC_SKIN_TERMS 的新 prompt）各出 N 张，落盘并排，贴 PR 给
 * 维护者并排看——**出图美学是产品调性决策的唯一依据**（维护者拍板）。
 *
 * 用法（在配了 image provider 的环境，如生产 .env）：
 *   node scripts/avatar_realism_ab.mjs            # 默认 4 seed 各新旧 1 张 = 8 张
 *   OUT=/path node scripts/avatar_realism_ab.mjs  # 自定义落盘目录
 * 出图烧 image 配额（约 8 张）——非只读，跑前确认授权。
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildIdentityCandidatePrompt, CANDIDATE_SEEDS } from '../src/visual_identity_candidates.mjs';

const { imageGenerate } = await import('../src/providers/image.mjs');

const OUT = process.env.OUT || '/tmp/avatar_ab';
mkdirSync(OUT, { recursive: true });

// 固定 appearance 种子（新旧唯一变量 = prompt 措辞，控制变量）
const mock = { hair_color: '黑色', hair_style: '长发', eye_color: '棕色', age: 20 };

// 旧版 prompt（改之前的 buildIdentityCandidatePrompt 片段，含四个 doll-face 触发词）——
// 自包含复刻，让一个脚本就能出新旧对比（不依赖 git stash）。
function buildOldPrompt(c, seed) {
  const cur = buildIdentityCandidatePrompt(c, seed);   // 新版作骨架
  // 把新版的"清纯锚 + 真实肤质"段，换回旧版那串 doll-face 词（其余 seed/服装/年龄完全一致）
  const NEW_CHUNK = [
    'soft side-swept fringe or wispy bangs framing the face',
    'small delicate chin and petite nose',
    'gentle innocent natural gaze',
    'completely makeup-free natural pure look',
  ].join(', ');
  const OLD_CHUNK = [
    'soft baby-faced look with round full plump cheeks',
    'large doe-eyed innocent gentle gaze',
    'soft side-swept fringe or wispy bangs framing the face',
    'small delicate chin and petite nose',
    'porcelain fair smooth dewy skin with slight rosy blush on cheeks',
    'completely makeup-free natural pure look',
  ].join(', ');
  let old = cur.replace(NEW_CHUNK, OLD_CHUNK);
  // 旧版眼睛是 glossy bright shine；旧版无 REALISTIC_SKIN_TERMS
  old = old.replace('eyes, clear and bright', 'eyes with glossy bright shine');
  old = old.replace('hair, soft and natural with a few loose strands', 'hair, soft and silky');
  old = old.replace(/, real unretouched smartphone photo[^,]*,[^,]*,[^—]*— a candid real phone snapshot, not an AI render or CGI/, '');
  return old;
}

async function gen(tag, prompt) {
  try {
    const url = await imageGenerate(prompt, { size: '1024x1024' });
    let buf = null;
    if (url?.startsWith('data:image/')) { const m = url.match(/base64,(.+)$/); buf = m ? Buffer.from(m[1], 'base64') : null; }
    else if (/^https?:\/\//.test(url)) { buf = Buffer.from(await (await fetch(url)).arrayBuffer()); }
    if (buf) { const f = `${OUT}/${tag}.png`; writeFileSync(f, buf); console.log(`  ✓ ${tag} → ${f}`); }
    else console.log(`  ✗ ${tag}: 无图数据`);
  } catch (e) { console.log(`  ✗ ${tag}: ${e.message}`); }
}

console.log(`头像 A/B 出图 → ${OUT}（OLD=含四禁词 / NEW=删禁词+真实肤质）`);
for (const seed of CANDIDATE_SEEDS) {
  await gen(`OLD_${seed}`, buildOldPrompt(mock, seed));
  await gen(`NEW_${seed}`, buildIdentityCandidatePrompt(mock, seed));
}
console.log(`\n完成。把 ${OUT}/OLD_* 与 NEW_* 并排贴 PR 给维护者定稿。`);
