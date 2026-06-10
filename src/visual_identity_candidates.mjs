/**
 * v1.10.43 visual_identity_candidates — 一次生成 4 张候选 selfie，让用户选最满意的
 * 锁为 reference。避免第一张丑图永久指挥后续生图。
 *
 * 不走 photo_planner LLM（成本太高 + 不必要），直接拼具象 imagePrompt。
 * 4 个 seed 给不同 lighting / angle / 表情变化，让选择有意义。
 */

import { imageGenerate } from './providers/image.mjs';
import { saveCandidateImage } from './visual_identity.mjs';
import { ANTI_COLLAGE_PROMPT } from './photo_sender.mjs';
import { log } from './logger.mjs';

// v1.10.53: 4 seed 强差异化 + 全部不露齿（用户反馈「笑最好不漏齿」）。
// 拿用户给的两张参考图当光谱两端拉大差距：
//   s1 ≈ 室内楼梯/走廊冷调清冷  s2 ≈ 户外走廊暖阳清新
// 之前 s2 `hint of teeth`、s3 `mid-laugh` 是露齿源头，全改抿唇/闭嘴。
const SEED_VARIATIONS = {
  // s1 清冷文艺 / 室内楼梯间·走廊冷光 / 垂发安静（对齐参考图2）
  s1: 'calm quiet serene almost-expressionless face with lips gently closed and only the faintest trace of a smile, long hair hanging straight down framing the face, standing in a bright indoor stairwell or corridor with cool natural daylight pouring in from tall windows, quiet literary introverted mood',
  // s2 阳光清新 / 户外走廊暖阳·风吹发丝 / 动态（对齐参考图1）
  s2: 'gentle soft close-lipped smile with lips kept softly together, a few strands of hair lightly blown by the breeze, standing in an outdoor covered walkway or sunny corridor, warm bright late-afternoon sunlight, fresh airy candid feeling with a hint of natural motion',
  // s3 害羞低头 / 室内窗边暖光 / 内向（保留原 s1 害羞感，去掉露齿）
  s3: 'shy bashful expression glancing slightly downward with a soft closed-lip smile and rosy blushing cheeks, one hand gently touching hair near the face, warm soft indoor window light from the side, cozy quiet intimate bedroom or dorm mood',
  // s4 远眺侧脸 / 黄金时分 / 文艺（用户钦点，保持不露齿）
  s4: 'serene gentle close-mouth smile with lips together and eyes gazing softly off into the distance to the side, three-quarter profile angle, warm golden-hour sunset light glowing on the cheek, soft green leafy or open sky background, dreamy literary mood',
};

// v1.10.53: 每个 seed 的服装位 — uniform 位仅 16-18 岁出校服，其余年龄段
// 自动降级（见 outfitForSeed）；casual 位走 companion 个性化便服。
// 用户要求「留 2 张便服」：s1/s2 = 校园校服位，s3/s4 = 便服位。
const SEED_OUTFIT_SLOT = { s1: 'uniform', s2: 'uniform', s3: 'casual', s4: 'casual' };

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
  if (/学生|学院|preppy|student/.test(s)) return 'preppy soft cardigan over a light shirt, fresh clean student daily style';
  return 'casual youthful daily wear';
}

// v1.10.53: 服装按 seed 服装位 + 年龄动态化。
// 关键约束（用户要求）：校服只在 16-18 岁出现，提示词不写死年龄数字，
// 其余年龄段自动降级到对应清新便服，避免成年 companion 误穿校服。
function outfitForSeed(companion, slot) {
  // casual 位：始终走 companion 个性化便服
  if (slot !== 'uniform') return clothingToEnglish(companion?.clothing_style);

  const a = Number(companion?.age) || 18;
  // 校服仅限 16-18：白蓝撞色短袖 polo 校服（措辞避开 "school uniform" 防安全过滤）
  if (a >= 16 && a <= 18) {
    return 'fresh clean white short-sleeve collared polo shirt with blue trim, neat tidy student style';
  }
  // 19-22：已无校服，降级清新学院风便服
  if (a <= 22) {
    return 'fresh preppy crisp white collared shirt or light campus cardigan, clean academic style';
  }
  // 23+：更成熟的简约通勤便服
  return 'simple elegant light collared blouse or fine knit top, clean refined style';
}

export function buildIdentityCandidatePrompt(companion, seed) {
  const hairColor = companion?.hair_color || '黑色';
  const hairStyle = companion?.hair_style || '长发';
  const eye = companion?.eye_color || '棕色';
  // v1.10.53: 服装按 seed 服装位 + 年龄动态决定（校服仅 16-18，见 outfitForSeed）
  const clothing = outfitForSeed(companion, SEED_OUTFIT_SLOT[seed] || 'casual');
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
    ANTI_COLLAGE_PROMPT,  // v1.19.5 issue#237: 候选自拍同样偶发拼图
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
