/**
 * 照片比例 smoke（v1.21.2 PR-D；零 LLM，ImageMagick 真转码）。
 *
 * ① aspectForShot 机位路由逐条断言
 * ② writeConvertedPhoto 真跑：喂任意比例输入 → 输出必须等于目标比例
 *    （这里是 '谁家好人自拍 1:1' 的总根因卡口——v1.10.0 起无条件 crop 1024x1024）
 * ③ 红色验证：用旧版逻辑的产物（1024x1024 方图）过"比例 ∈ 机位允许集合"断言必须红
 * ④ i2i 参考裁剪：输出窗口必须是目标比例（锁脸不锁方）
 */
process.env.DB_PATH = '/tmp/aspect_smoke.db';
import sharp from 'sharp';
import { unlinkSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const { aspectForShot } = await import('../src/photo_planner.mjs');
const sender = await import('../src/photo_sender.mjs');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// ── ① 机位路由 ────────────────────────────────────────────────────────────
ok(aspectForShot('SELFIE') === '3:4', '路由: SELFIE → 3:4（手机前摄竖拍）');
ok(aspectForShot('ENV_SELFIE') === '3:4', '路由: ENV_SELFIE → 3:4');
ok(aspectForShot('ACTIVITY_POV') === '3:4', '路由: ACTIVITY_POV → 3:4');
ok(aspectForShot('CANDID') === '3:4', '路由: CANDID → 3:4');
ok(aspectForShot('SCENERY', 'sunset over the sea 晚霞海面') === '4:3', '路由: SCENERY 宽景 → 4:3 横');
ok(aspectForShot('SCENERY', '深夜的小巷 narrow alley') === '3:4', '路由: SCENERY 窄竖景 → 3:4');

// ── ② 转码卡口真跑（data URL 喂入，免起 http）────────────────────────────
const ALLOWED = { portrait: [[768, 1024]], landscape: [[1024, 768]] };
const checkAspect = ([w, h], wantPortrait) =>
  (wantPortrait ? ALLOWED.portrait : ALLOWED.landscape).some(([aw, ah]) => aw === w && ah === h);

async function makeImg(w, h) {
  const buf = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 150, b: 150 } } }).png().toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
}
async function convertAndProbe(dataUrl, aspect) {
  // writeConvertedPhoto 未导出——经导出的 __testWriteConvertedPhoto 钩子（仅测试）
  const { outPath } = await sender.__testWriteConvertedPhoto(dataUrl, 9001, aspect);
  const m = await sharp(outPath).metadata();
  try { unlinkSync(outPath); } catch { /* 清理失败不影响断言 */ }
  return [m.width, m.height];
}

{
  const [w, h] = await convertAndProbe(await makeImg(1024, 1024), '3:4');
  ok(checkAspect([w, h], true), `转码: 方图输入 + 3:4 → 768x1024（实际 ${w}x${h}）`);
}
{
  const [w, h] = await convertAndProbe(await makeImg(864, 1184), '3:4');
  ok(checkAspect([w, h], true), `转码: 竖图输入 + 3:4 → 768x1024（实际 ${w}x${h}）`);
}
{
  const [w, h] = await convertAndProbe(await makeImg(1024, 1024), '4:3');
  ok(checkAspect([w, h], false), `转码: 方图输入 + 4:3 → 1024x768（实际 ${w}x${h}）`);
}

// ── ③ 红色验证：旧版产物（1024x1024）过机位断言必须红 ────────────────────
{
  const legacy = [1024, 1024];   // v1.10.0-v1.21.1 所有照片的真实形态
  ok(checkAspect(legacy, true) === false, '红色验证: 旧版 1024x1024 过 SELFIE 比例断言必须不通过');
}

// ── ④ i2i 参考裁剪：锁脸不锁方 ────────────────────────────────────────────
{
  const sq = await sharp({ create: { width: 800, height: 800, channels: 3, background: { r: 180, g: 160, b: 150 } } }).png().toBuffer();
  const out = await sender.cropReferenceToFace(sq, '3:4');
  const m = await sharp(out).metadata();
  const ratio = m.width / m.height;
  ok(Math.abs(ratio - 0.75) < 0.02, `i2i 裁剪: 方形参考 → 3:4 竖窗（实际 ${m.width}x${m.height}, ${ratio.toFixed(3)}）——gemini 输出跟随 ref 比例`);
}

for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
console.log(`photo_aspect_smoke: 通过 ${pass} 失败 ${fail}`);
process.exit(fail ? 1 : 0);
