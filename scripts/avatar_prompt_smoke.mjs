/**
 * avatar_prompt_smoke —— 头像候选 prompt 反恐怖谷红验（2026-06-13）。纯函数零网络。
 * 根因：visual_identity 头像链路堆 porcelain/baby-faced/doe-eyed/glossy 等 doll-face 触发词、
 * 零真实肤质层 → 过度光滑大眼 porcelain 假脸=恐怖谷（用户负反馈"哈人"）。修=删四禁词+接入
 * REALISTIC_SKIN_TERMS 单一来源。
 *
 * 红验：①新 prompt 全 seed 不含四个 doll-face 触发词 ②含真实肤质锚 ③塑料黑名单自检零命中
 *   ④单一来源静态断言（visual_identity import REALISTIC_SKIN_TERMS）。删修复必红。
 */
import { readFileSync } from 'node:fs';
import { buildIdentityCandidatePrompt, CANDIDATE_SEEDS } from '../src/visual_identity_candidates.mjs';
import { findPlasticTerms, REALISTIC_SKIN_TERMS } from '../src/image_realism_terms.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

const mock = { hair_color: '黑色', hair_style: '长发', eye_color: '棕色', age: 20 };
const FORBIDDEN = ['porcelain', 'dewy', 'glossy', 'baby-faced', 'doe-eyed'];

// ── ①②③ 每个 seed 的新 prompt：无四禁词 / 有真实肤质 / 黑名单零命中 ──
for (const seed of CANDIDATE_SEEDS) {
  const p = buildIdentityCandidatePrompt(mock, seed).toLowerCase();
  for (const w of FORBIDDEN) ok(!p.includes(w), `seed ${seed}：不含 doll-face 触发词「${w}」`);
  ok(p.includes('fine pores') && p.includes('film grain') && p.includes('natural skin texture'),
     `seed ${seed}：含真实肤质锚（fine pores/film grain/natural skin texture）`);
  const hits = findPlasticTerms(p);
  ok(hits.length === 0, `seed ${seed}：塑料黑名单自检零命中（实测命中 ${JSON.stringify(hits)}）`);
}

// ── ④ 单一来源静态断言 ──
{
  const src = readFileSync(new URL('../src/visual_identity_candidates.mjs', import.meta.url), 'utf8');
  ok(/import\s*\{[^}]*REALISTIC_SKIN_TERMS[^}]*\}\s*from\s*'\.\/image_realism_terms\.mjs'/.test(src),
     '头像链路接入 REALISTIC_SKIN_TERMS 单一来源（升级肤质词只改一处）');
  ok(src.includes('...REALISTIC_SKIN_TERMS'), '真人质感锚 spread 进 prompt 片段');
  ok(REALISTIC_SKIN_TERMS.length >= 3, '单一来源真实肤质锚 ≥3 条');
}

console.log(`\navatar_prompt_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
