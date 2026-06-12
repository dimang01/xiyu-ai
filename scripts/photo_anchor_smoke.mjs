/**
 * photo_anchor_smoke —— PR-C planner 注入红色验证（v1.21.6）。
 * 用 deps.llm 捕获 planner 真实 prompt，断言各护栏/锚定按条件注入。
 *   - 封面护栏 / 天气护栏：总在（确定性规矩）
 *   - 日落事实：仅晚霞类场景注入，非晚霞不注入
 *   - 互拍邀请：仅 proactiveContext.inviteBack 时注入
 *   - candid 实验：默认关→不注入；env 开 + prob=1→注入
 */
import { planPhotoMessage } from '../src/photo_planner.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

const GATE = { allowed: true, reasons: [], todayCount: 0, imageProviderAvailable: true, limits: { dailyLimitPerCompanion: 3 } };
const COMPANION = { id: 1, name: '小溪', current_scene: '在家', current_mood: 'happy', clothing_style: '甜美' };
const DECLINE = JSON.stringify({ shouldSendPhoto: false, mode: 'text_only', caption: '现在不太方便' });

async function capture(opts) {
  let seen = null;
  await planPhotoMessage({ companion: COMPANION, cooldownState: GATE, ...opts },
    { llm: async ({ prompt }) => { seen = prompt; return DECLINE; } });
  return String(seen || '');
}

// 护栏总在 + candid 默认关
{
  const p = await capture({ userText: '在吗', trigger: 'user_request' });
  ok(p.includes('真实出版物护栏'), '封面护栏总在 prompt');
  ok(p.includes('天气护栏'), '天气护栏总在 prompt');
  ok(!p.includes('随手抓拍质感（实验）'), 'candid 默认关 → 不注入');
}

// 日落事实：仅晚霞场景
{
  const p = await capture({ userText: '给我看看外面的晚霞', trigger: 'user_request' });
  ok(p.includes('日落事实'), '红色验证：晚霞场景 → 日落事实注入');
}
{
  const p = await capture({ userText: '发张自拍看看你', trigger: 'user_request' });
  ok(!p.includes('日落事实'), '非晚霞场景 → 不注入日落');
}

// 互拍邀请：仅 inviteBack
{
  const p = await capture({ userText: '', trigger: 'proactive', proactiveContext: { scene: '在家', inviteBack: true } });
  ok(p.includes('互拍邀请'), '红色验证：inviteBack → caption 互拍邀请注入');
}
{
  const p = await capture({ userText: '', trigger: 'proactive', proactiveContext: { scene: '在家' } });
  ok(!p.includes('互拍邀请'), '无 inviteBack → 不注入互拍邀请');
}

// candid 实验：env 开 + prob=1 → 注入
{
  process.env.PHOTO_CANDID_EXPERIMENT = '1';
  process.env.PHOTO_CANDID_PROB = '1';
  const p = await capture({ userText: '在吗', trigger: 'user_request' });
  delete process.env.PHOTO_CANDID_EXPERIMENT;
  delete process.env.PHOTO_CANDID_PROB;
  ok(p.includes('随手抓拍质感（实验）'), 'candid 开 + prob=1 → 注入');
}

console.log(`\nphoto_anchor_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
