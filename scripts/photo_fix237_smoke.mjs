/**
 * issue #237 三连修复回归 smoke（纯函数，零 LLM，确定性）。
 * 验：#1 detectPhotoPromise 答应检测（强/弱/否定/无关）
 *     #2 decideShotMode 上下文兜底（泛索图+上下文作业→ACTIVITY_POV；当前意图永远优先）
 *     #3 buildFinalImagePrompt 反拼图追加（且在 900 字截断后存活）
 */
import { detectPhotoPromise } from '../src/photo_intent.mjs';
import { decideShotMode } from '../src/photo_planner.mjs';
import { buildFinalImagePrompt, ANTI_COLLAGE_PROMPT } from '../src/photo_sender.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// ── #1 答应检测 ──────────────────────────────────────────────
// issue #237 实测案例：她答应了"你看吧"，用户在要看作业
ok(detectPhotoPromise('那你看吧，别笑我字丑就行', '我看下我会不会做').promised, '#1 弱答应+用户要看 → 触发（issue 实例）');
ok(detectPhotoPromise('等下拍给你', '发我看看').promised, '#1 强答应"等下拍给你"');
ok(detectPhotoPromise('这就拍 || 等我两分钟', '想看你现在的样子').promised, '#1 强答应"这就拍"');
ok(detectPhotoPromise('马上发你一张照片哈', '好啊').promised, '#1 强答应"发你照片"');
ok(detectPhotoPromise('给你拍个我桌上的', '在干嘛').promised, '#1 强答应"给你拍"');
// 负例
ok(!detectPhotoPromise('今天拍不了啦，下次吧', '发张自拍').promised, '#1 否定"拍不了"不触发');
ok(!detectPhotoPromise('我才不拍呢', '拍一张嘛').promised, '#1 否定"不拍"不触发');
ok(!detectPhotoPromise('你看吧，我就说他会迟到', '他今天又迟到了').promised, '#1 弱答应但用户没要看 → 不触发');
ok(!detectPhotoPromise('吃了呀，你呢', '吃了吗').promised, '#1 无关闲聊不触发');
ok(!detectPhotoPromise('', '看看').promised, '#1 空回复不触发');

// ── #2 shot mode 上下文兜底 ──────────────────────────────────
const HOMEWORK_CTX = '数学题好难 啊？作业有啥好看的 就一堆公式，乱糟糟的 那你看吧，别笑我字丑就行';
// issue #237 实测案例：泛索图 + 上下文聊的是作业 → 拍作业不拍脸
ok(decideShotMode({ userText: '你是不是发不了照片啊？', recentText: HOMEWORK_CTX, trigger: 'user_request' }) === 'ACTIVITY_POV', '#2 泛索图+作业上下文 → ACTIVITY_POV（issue 实例）');
// 当前意图永远优先：明确要自拍，上下文有作业也得给自拍
ok(decideShotMode({ userText: '发张自拍看看', recentText: HOMEWORK_CTX, trigger: 'user_request' }) === 'SELFIE', '#2 明确自拍压过作业上下文');
// 当前消息直接要看作业
ok(decideShotMode({ userText: '拍一下你的作业', recentText: '', trigger: 'user_request' }) === 'ACTIVITY_POV', '#2 当前消息要作业 → ACTIVITY_POV');
// 泛索图、上下文也没活动话题 → 默认自拍（原行为不回归）
ok(decideShotMode({ userText: '再发一张', recentText: '今天天气真好 是呀', trigger: 'user_request' }) === 'SELFIE', '#2 泛索图无活动上下文 → SELFIE');
// 看景优先级不受影响
ok(decideShotMode({ userText: '拍一下外面的晚霞', recentText: HOMEWORK_CTX, trigger: 'user_request' }) === 'SCENERY', '#2 明确看景 → SCENERY');
// 主动场景照（非用户请求）+ 风景场景 → SCENERY（原行为）
ok(decideShotMode({ userText: '', recentText: '', currentScene: '在江边散步看晚霞', trigger: 'proactive_scene' }) === 'SCENERY', '#2 主动+景场景 → SCENERY');

// ── #3 反拼图 ────────────────────────────────────────────────
const final1 = buildFinalImagePrompt({ identityPrompt: 'a young woman with long black hair', scenePrompt: 'sitting at her desk writing math homework, warm desk lamp', providerCapabilities: {}, referenceImagePath: null });
ok(final1.includes('no photo grid'), '#3 最终 prompt 含反拼图约束');
ok(final1.includes('single photo'), '#3 最终 prompt 含 single photo');
// 截断后反拼图词仍存活（追加在 sanitize 之后）
const longScene = 'a cozy bedroom with fairy lights, '.repeat(40);
const final2 = buildFinalImagePrompt({ identityPrompt: 'a young woman', scenePrompt: longScene, providerCapabilities: {}, referenceImagePath: null });
ok(final2.includes('no photo grid'), '#3 超长 prompt 截断后反拼图词存活');
ok(final2.endsWith(ANTI_COLLAGE_PROMPT), '#3 反拼图词在末尾完整保留');

// ── v1.20.1 (用户反馈"照片太假")：i2i 全量拼装下 realism 质感词必须存活 ──
// 历史 bug：sanitizePhotoPrompt 双重 900 字截断（入口+出口各一道）把尾部的
// REALISM_PERSON 整个吃掉——i2i 的 referenceNote 占 ~400 字，质感词在生产
// i2i 路径从没生效过，模型裸跑默认磨皮假脸。任何一道截断回退都在这红。
{
  const finalI2i = buildFinalImagePrompt({
    identityPrompt: 'naturally pretty young East Asian woman, long black wavy hair, slim build, sweet casual style, fresh vibe, consistent same adult person across photos, realistic casual phone snapshot style',
    scenePrompt: 'casual smartphone front-camera selfie on a busy city shopping street in early afternoon, chest-up framing, one arm reaching toward camera, face in focus, pedestrians softly blurred behind her, bright natural daylight',
    providerCapabilities: { referenceImage: true },
    referenceImagePath: '/tmp/fake-ref.png',
  });
  ok(finalI2i.includes('clearly visible pores'), 'realism: 毛孔质感词在 i2i 全量拼装下存活');
  ok(finalI2i.includes('strictly keep the exact composition'), 'realism: 构图锚定句存活（防场景跑偏）');
  ok(finalI2i.includes('not an idealized AI-generated face'), 'realism: 反 AI 理想脸句存活');
  ok(finalI2i.includes('no photo grid'), 'realism: 反拼图与质感词共存');
}

console.log(`photo_fix237_smoke: 通过 ${pass} 失败 ${fail}`);
process.exit(fail ? 1 : 0);
