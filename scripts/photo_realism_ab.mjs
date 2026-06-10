/**
 * 照片真实感 A/B 实验（一次性，用户授权 ~50 张 gpt-image 额度，2026-06-10）。
 *
 * 背景：用户反馈生产照片"太假完全不真实"（gemini-2.5-flash-image + i2i + 现状 prompt）。
 * 变量矩阵：模型 {gemini, gpt-image-1} × prompt {现状, 强化realism} × ref {i2i, 纯文字}
 *          × 场景 {街拍自拍(复刻用户截图), 室内午后}
 * 输出 scripts/_ab_out/<组合名>.png，跑完人工(Claude 多模态)对比挑赢家。
 */
import dotenv from 'dotenv';
dotenv.config({ path: '/opt/xiyu-ai-new/.env' });
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('scripts/_ab_out');
mkdirSync(OUT, { recursive: true });

const { imageGenerate } = await import('../src/providers/image.mjs');
const { buildFinalImagePrompt } = await import('../src/photo_sender.mjs');
const { cropReferenceToFace } = await import('../src/photo_sender.mjs');

const REF_PATH = '/opt/xiyu-ai-new/data/companion_visuals/3/references/ref_001.png';

// identity：贴近生产 companion 的清纯系 spec（现状组用）
const IDENTITY = 'naturally pretty young East Asian woman in her late teens look, soft gentle facial features, long black slightly wavy hair, slim build, sweet casual style, fresh innocent vibe, consistent same adult person across photos, realistic casual phone snapshot style';

// 场景（复刻用户截图：街上自拍；加一个室内对照）
const SCENES = {
  street: 'casual smartphone front-camera selfie on a busy city shopping street in early afternoon, chest-up framing, one arm reaching toward camera, face in focus, pedestrians and storefronts softly blurred behind her, bright natural daylight, she just finished lunch and is taking a walk',
  indoor: 'casual smartphone front-camera selfie at her desk by the window in the early afternoon, chest-up framing, soft natural daylight from the side, a slightly messy real desk with a water bottle and notebooks blurred behind her, relaxed everyday moment',
};

// 强化 realism 追加（实验组）：往"普通真人随手拍"硬拉，反 AI 完美脸
const REALISM_BOOST = 'unretouched candid photo of an ordinary real person, not a model, natural skin with clearly visible pores and slightly uneven tone, a few minor blemishes, mild under-eye shadows, slightly oily T-zone shine, imperfect ambient mixed lighting, photo taken quickly by a friend, looks like a real unfiltered social media post, no beauty filter, no airbrushing, not an idealized AI-generated face';

const refBuf = readFileSync(REF_PATH);
const refCropped = await cropReferenceToFace(refBuf).catch(() => refBuf);
const refDataUrl = `data:image/png;base64,${refCropped.toString('base64')}`;

const combos = [];
for (const model of ['gemini-2.5-flash-image', 'gpt-image-1']) {
  for (const boost of [false, true]) {
    for (const useRef of [true, false]) {
      for (const [sceneName, scene] of Object.entries(SCENES)) {
        // 第一轮砍半：gemini+boost+无ref、街拍 only 等低信息组合跳过，控制在 14 张
        if (model.startsWith('gemini') && boost && !useRef) continue;
        if (sceneName === 'indoor' && boost && useRef && model.startsWith('gemini')) continue;
        combos.push({ model, boost, useRef, sceneName, scene });
      }
    }
  }
}
console.log(`组合数: ${combos.length}`);

for (const c of combos) {
  const tag = [c.model.startsWith('gpt') ? 'gpt' : 'gem', c.boost ? 'boost' : 'base', c.useRef ? 'i2i' : 'txt', c.sceneName].join('_');
  process.env.AI302_IMAGE_MODEL = c.model;
  process.env.AI302_IMAGE_MODEL_FALLBACK = c.model; // 不让 fallback 串模型
  const finalPrompt = buildFinalImagePrompt({
    identityPrompt: IDENTITY,
    scenePrompt: c.scene + (c.boost ? ', ' + REALISM_BOOST : ''),
    providerCapabilities: { referenceImage: c.useRef },
    referenceImagePath: c.useRef ? REF_PATH : null,
  });
  const t0 = Date.now();
  try {
    const url = await imageGenerate(finalPrompt, { size: '1024x1024', referenceImage: c.useRef ? refDataUrl : null });
    let buf;
    if (url.startsWith('data:image/')) {
      buf = Buffer.from(url.split(',')[1], 'base64');
    } else {
      const r = await fetch(url);
      buf = Buffer.from(await r.arrayBuffer());
    }
    writeFileSync(path.join(OUT, `${tag}.png`), buf);
    console.log(`✓ ${tag} (${((Date.now() - t0) / 1000).toFixed(0)}s, ${(buf.length / 1024).toFixed(0)}KB)`);
  } catch (e) {
    console.log(`✗ ${tag}: ${e.message.slice(0, 100)}`);
  }
}
console.log('AB 实验完成 →', OUT);
