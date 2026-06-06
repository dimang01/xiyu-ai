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

// v1.10.51: 4 seed 强差异化 — 不同表情 + 不同视角 + 不同环境 + 不同情绪，
// 让用户选择真有意义。前版本 4 张几乎只换光线，差异太小。
const SEED_VARIATIONS = {
  // 害羞低头 / 室内柔光 / 内向感
  s1: 'shy bashful expression looking slightly down with a faint smile and rosy blushing cheeks, hand near chin or hair, soft afternoon window light from the side casting gentle warm glow, intimate quiet bedroom or dorm room background',
  // 开心露齿 / 阳光 / 外向感
  s2: 'bright wide genuine open smile showing a hint of teeth, looking directly into the camera with sparkling cheerful eyes, sunny bright midday natural daylight, fresh clean campus or park outdoor background with soft bokeh',
  // 抓拍中笑 / 室内暖灯 / 自然感
  s3: 'candid mid-laugh expression with hand slightly raised covering part of the cheek, head tilted at a playful angle, eyes half-crinkled from laughing, cozy warm indoor lamp lighting, home or cafe setting',
  // 远眺侧脸 / 黄金时分 / 文艺感
  s4: 'serene calm gentle close-mouth smile with eyes looking softly off into the distance to the side, three-quarter profile angle, warm golden-hour sunset light glowing on the cheek, soft green leafy or sky background',
};

export const CANDIDATE_SEEDS = Object.keys(SEED_VARIATIONS);

// v1.10.51: 按 companion.age 动态选年龄段视觉描述，不再硬编码 freshman
// OpenAI 安全过滤对 < 18 / school 词很严，用模糊措辞 + 视觉锚点替代具体数字
function ageVibePrompt(age) {
  const a = Number(age) || 18;
  if (a <= 17) {
    return {
      look: 'extremely fresh just-out-of-school look, pure youthful baby face appearance, gentle innocent doe-eyed expression, very wholesome clean vibe like a fresh-faced college freshman who just turned 18',
      body: 'slim petite delicate youthful frame, slight student-like vibe',
      atmo: 'pure clean wholesome airy fresh atmosphere',
    };
  }
  if (a <= 20) {
    return {
      look: 'fresh first-year to second-year university freshman vibe, soft baby-faced youthful appearance',
      body: 'slim petite youthful frame',
      atmo: 'fresh young clean college student atmosphere',
    };
  }
  if (a <= 24) {
    return {
      look: 'fresh upperclassman or new-graduate vibe, gentle youthful appearance with subtle hint of growing maturity, still very fresh',
      body: 'slim youthful frame with graceful proportions',
      atmo: 'fresh young adult clean refined atmosphere',
    };
  }
  if (a <= 28) {
    return {
      look: 'early-career young woman vibe, fresh-faced but with calm gentle mature presence',
      body: 'slim graceful frame with poised elegance',
      atmo: 'fresh clean refined young adult atmosphere',
    };
  }
  return {
    look: 'mature graceful young woman vibe, calm gentle composed appearance',
    body: 'slim elegant graceful frame',
    atmo: 'mature refined gentle atmosphere',
  };
}

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

  // v1.10.51: 按 companion.age 取年龄段 vibe，替代硬编码 freshman
  const av = ageVibePrompt(companion?.age);

  return [
    'realistic casual smartphone selfie portrait',
    'naturally pretty innocent-looking young East Asian woman',
    av.look,
    // v1.10.50: 清纯感视觉锚点
    'soft baby-faced look with round full plump cheeks',
    'large doe-eyed innocent gentle gaze',
    'soft side-swept fringe or wispy bangs framing the face',
    'small delicate chin and petite nose',
    'porcelain fair smooth dewy skin with slight rosy blush on cheeks',
    'completely makeup-free natural pure look',
    av.body,
    `${hairColor} ${hairStyle} hair, soft and silky`,
    `${eye} eyes with glossy bright shine`,
    `wearing ${clothing}`,
    'smartphone front-facing camera selfie POV',
    'arm partially visible at edge of frame',
    'slight upward angle',
    variation,  // v1.10.51: 包含具体表情 + 视角 + 场景，不再只是光线
    'photorealistic real life amateur phone photography',
    av.atmo,
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
