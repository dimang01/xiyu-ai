/**
 * v1.10.43 visual_identity_candidates — 一次生成 4 张候选 selfie，让用户选最满意的
 * 锁为 reference。避免第一张丑图永久指挥后续生图。
 *
 * 不走 photo_planner LLM（成本太高 + 不必要），直接拼具象 imagePrompt。
 * 4 个 seed 给不同 lighting / angle / 表情变化，让选择有意义。
 */

import { imageGenerate } from './providers/image.mjs';
import { saveCandidateImage } from './visual_identity.mjs';
import { log } from './logger.mjs';

// 4 个 seed 对应不同光线 / 视角 / 表情，让候选有差异
const SEED_VARIATIONS = {
  s1: 'soft afternoon sunny daylight, looking slightly to the side with a warm gentle smile, slight upward selfie angle',
  s2: 'cozy warm indoor lamp light at home, full front view selfie, gentle close-mouth smile with cheerful eyes',
  s3: 'fresh bright morning natural daylight near a window, looking directly at the camera with bright cheerful eyes and an open warm smile',
  s4: 'clean midday daylight outdoors with soft green leafy background, candid spontaneous happy smile, head slightly tilted',
};

export const CANDIDATE_SEEDS = Object.keys(SEED_VARIATIONS);

function clothingToEnglish(style) {
  const s = String(style || '').toLowerCase();
  if (/甜美|sweet|cute/.test(s)) return 'cute pastel hoodie or light knit cardigan';
  if (/清新|fresh|elegant/.test(s)) return 'fresh clean light blouse or simple soft tee';
  if (/酷|cool|street/.test(s)) return 'oversized casual hoodie or graphic tee';
  if (/学院|preppy/.test(s)) return 'preppy soft cardigan over light shirt';
  return 'casual youthful daily wear';
}

export function buildIdentityCandidatePrompt(companion, seed) {
  const hairColor = companion?.hair_color || '黑色';
  const hairStyle = companion?.hair_style || '长发';
  const eye = companion?.eye_color || '棕色';
  const clothing = clothingToEnglish(companion?.clothing_style);
  const variation = SEED_VARIATIONS[seed] || SEED_VARIATIONS.s1;

  return [
    'realistic casual smartphone selfie portrait',
    'naturally pretty innocent-looking young East Asian woman',
    'very youthful first-year university freshman vibe',
    // v1.10.50: 清纯感视觉锚点
    'soft baby-faced look with round full plump cheeks',
    'large doe-eyed innocent gentle gaze',
    'soft side-swept fringe or wispy bangs framing the face',
    'small delicate chin and petite nose',
    'porcelain fair smooth dewy skin with slight rosy blush on cheeks',
    'soft shy bashful gentle close-mouth smile',
    'completely makeup-free natural pure look',
    'slim petite delicate youthful frame',
    `${hairColor} ${hairStyle} hair, soft and silky`,
    `${eye} eyes with glossy bright shine`,
    `wearing ${clothing}`,
    'smartphone front-facing camera selfie POV',
    'arm partially visible at edge of frame',
    'slight upward angle',
    variation,
    'photorealistic real life amateur phone photography',
    'natural soft diffused lighting, fresh airy clean atmosphere',
    'pure innocent gentle vibe, fresh and clean wholesome look',
  ].join(', ');
}

/**
 * 并发生成 4 张候选图。
 * @returns {Promise<{candidates: Array<{seed:string, url:string}>, errors: Array<{seed:string, error:string}>}>}
 */
export async function generateIdentityCandidates(companion, opts = {}) {
  const seeds = Array.isArray(opts.seeds) && opts.seeds.length ? opts.seeds : CANDIDATE_SEEDS;
  const t0 = Date.now();
  const results = await Promise.allSettled(seeds.map(async (seed) => {
    const prompt = buildIdentityCandidatePrompt(companion, seed);
    const url = await imageGenerate(prompt, { size: opts.size || '1024x1024' });
    return { seed, url };
  }));
  const candidates = [];
  const errors = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const seed = seeds[i];
    if (r.status !== 'fulfilled' || !r.value?.url) {
      errors.push({ seed, error: r.reason?.message || 'unknown' });
      continue;
    }
    // v1.10.46: 把 data URL / http URL 落地到磁盘，response 只返短 fname。
    // 避免 4 张 base64 (~12MB JSON) 撑爆前端解析。
    try {
      const raw = r.value.url;
      let buf;
      if (raw.startsWith('data:image/')) {
        const m = raw.match(/^data:image\/[a-z+]+;base64,(.+)$/i);
        buf = m ? Buffer.from(m[1], 'base64') : null;
      } else if (/^https?:\/\//.test(raw)) {
        const resp = await fetch(raw, { signal: AbortSignal.timeout(30_000) });
        if (resp.ok) buf = Buffer.from(await resp.arrayBuffer());
      }
      if (!buf || buf.length < 256) {
        errors.push({ seed, error: 'image bytes invalid' });
        continue;
      }
      const saved = saveCandidateImage(companion.id, buf, seed);
      if (!saved) {
        errors.push({ seed, error: 'save failed' });
        continue;
      }
      candidates.push({ seed, fname: saved.fname });
    } catch (e) {
      errors.push({ seed, error: e.message });
    }
  }
  log('info', `[identity-candidates] companion=${companion.id} 完成 ok=${candidates.length}/${seeds.length} 耗时=${Date.now() - t0}ms`);
  return { candidates, errors };
}
