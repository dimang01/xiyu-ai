/**
 * photo_noface_gate_smoke —— 无脸机位走「权威 shotMode」而非文本嗅探（接线第六案，2026-06-14）。
 *
 * prod 06-13 实案：food 品类(机位 ACTIVITY_POV·已落库)→caption"排队买拿铁"→却载入裁脸 i2i 参考
 * 出脸。根因=出图边界(buildFinalImagePrompt + i2i 参考载入)用 isSceneryScene 文本嗅探 LLM 写的
 * imagePrompt 重判"要不要脸"，丢掉了上游已定死的权威 shotMode；嗅探判错(食物 POV 夹了人物词/
 * 漏了 POV 词)→挂裁脸参考→出脸。修：shotMode 直穿，无脸机位确定性无脸。
 *
 * 双向红验：① 喂一个夹了"young woman/waist up"的食物 POV prompt，ACTIVITY_POV 下必须仍无脸
 * （把 LLM 漂移 R2 兜住）；② SELFIE 等有脸机位正常挂脸；③ shotMode 缺失才退回文本嗅探(老路)。
 */
import { buildFinalImagePrompt, isNoFaceShot, NO_FACE_SHOTMODES } from '../src/photo_sender.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

const CAP = { referenceImage: true };
const REF = '/tmp/ref.png';
const ID = 'IDENTITYMARKER long black hair, warm bright eyes';

// ── ① 红验核心：ACTIVITY_POV 即便 LLM 在 prompt 里夹了人物词，仍确定性无脸 ──
// （旧代码 isSceneryScene 命中 "young woman/waist up" → 判人像 → 挂裁脸参考 → 出脸，本案根因）
const leakyFoodPov = 'first-person POV overhead shot of a latte on a cafe table, a young woman holding it, waist up, warm afternoon light';
const fpPov = buildFinalImagePrompt({ identityPrompt: ID, scenePrompt: leakyFoodPov, providerCapabilities: CAP, referenceImagePath: REF, shotMode: 'ACTIVITY_POV' });
ok(/do NOT show her face/i.test(fpPov), 'ACTIVITY_POV+漏人物词：走无脸 referenceNote（do NOT show her face）');
ok(!/FACE IDENTITY/i.test(fpPov), 'ACTIVITY_POV+漏人物词：绝不挂裁脸参考 note（无 FACE IDENTITY）');
ok(!fpPov.includes('IDENTITYMARKER'), 'ACTIVITY_POV+漏人物词：不写人物 identityPrompt');

// ── 方向2：i2i 参考载入闸用同一 isNoFaceShot——权威 shotMode 压过 prompt 里的人物词 ──
ok(isNoFaceShot({ shotMode: 'ACTIVITY_POV', scenePrompt: leakyFoodPov }) === true, '权威闸：ACTIVITY_POV 压过 prompt 人物词→无脸（裁脸参考不载入）');
ok(isNoFaceShot({ shotMode: 'SCENERY', scenePrompt: 'a girl waist up' }) === true, '权威闸：SCENERY→无脸');
ok(NO_FACE_SHOTMODES.has('ACTIVITY_POV') && NO_FACE_SHOTMODES.has('SCENERY') && NO_FACE_SHOTMODES.size === 2,
  '无脸机位权威集合恰为 {ACTIVITY_POV, SCENERY}');

// ── ② 有脸机位正常挂脸（不能误伤）：SELFIE 即便 prompt 里有 POV 词，仍走脸 ──
const selfieWithPovWord = 'casual chest-up phone selfie, POV-ish, in a cafe, soft window light';
const fpSelfie = buildFinalImagePrompt({ identityPrompt: ID, scenePrompt: selfieWithPovWord, providerCapabilities: CAP, referenceImagePath: REF, shotMode: 'SELFIE' });
ok(/FACE IDENTITY/i.test(fpSelfie), 'SELFIE：正常挂裁脸参考（FACE IDENTITY）');
ok(fpSelfie.includes('IDENTITYMARKER'), 'SELFIE：写人物 identityPrompt');
ok(isNoFaceShot({ shotMode: 'SELFIE', scenePrompt: 'overhead pov latte' }) === false, '权威闸：SELFIE 压过 prompt 里 POV 词→有脸');
ok(isNoFaceShot({ shotMode: 'ENV_SELFIE' }) === false, '权威闸：ENV_SELFIE→有脸');
ok(isNoFaceShot({ shotMode: 'CANDID' }) === false, '权威闸：CANDID→有脸');

// ── ③ shotMode 缺失（user-request 老路/兜底）：退回文本嗅探，不破坏旧行为 ──
ok(isNoFaceShot({ scenePrompt: 'first-person POV overhead latte on the table' }) === true, '兜底：无 shotMode + POV 文本→无脸（退回 isSceneryScene）');
ok(isNoFaceShot({ scenePrompt: 'a young woman casual selfie at home' }) === false, '兜底：无 shotMode + 自拍文本→有脸');
const fpFallback = buildFinalImagePrompt({ identityPrompt: ID, scenePrompt: 'first-person POV of the sunset filling the frame', providerCapabilities: CAP, referenceImagePath: REF });
ok(/do NOT show her face/i.test(fpFallback) && !fpFallback.includes('IDENTITYMARKER'), '兜底：无 shotMode 的风景 POV 仍无脸（老路不退化）');

console.log(`\nphoto_noface_gate_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
