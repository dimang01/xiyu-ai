/**
 * photo_thought_smoke —— 「看到这个想到你」品类素材选择红色验证（v1.21.6 PR-B，纯函数）。
 *
 * 任务书要求的三条硬验证：
 *   ① 配已知兴趣 → 选中素材与 sceneSeed 指向正确事物
 *   ② taboo 类素材零选用（连跑断言）
 *   ③ 连跑 14 天同素材 ≤1 次（指纹冷却）
 * 外加：隐私命中零选用 / 全过滤退回 null / 加权生效。
 */
import { buildThoughtPool, filterThoughtPool, selectThoughtMaterial, thoughtSceneSeed } from '../src/photo_thought.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

const likes = [
  { id: 1, target: '塞尔达', intensity: 5 },
  { id: 2, target: '美式咖啡', intensity: 4 },
  { id: 3, target: '前任送的杯子', intensity: 3 },   // 含雷区词
];
const lexicon = [{ id: 10, content: '小汤圆是他家橘猫' }];
const memories = [{ id: 20, content: '他最近在准备考研', importance: 8 }];
const tabooTerms = ['前任'];

// ① 指向正确 + sceneSeed 结构
{
  const m = selectThoughtMaterial({ likes: [likes[0]], lexicon: [], memories: [] });
  ok(m && m.id === 'pref:1', `选中偏好素材 id=pref:1（实测 ${m?.id}）`);
  ok(m && m.hint.includes('塞尔达'), 'hint 指向正确事物（塞尔达）');
  const seed = thoughtSceneSeed(m);
  ok(seed.includes('塞尔达') && seed.includes('无脸') && seed.includes('场景自洽'), 'sceneSeed 含素材+无脸+场景自洽约束');
  // 梗 / 记忆也能进池
  const pool = buildThoughtPool({ likes, lexicon, memories });
  ok(pool.some(p => p.id === 'joke:10') && pool.some(p => p.id === 'mem:20'), '梗(joke:)+记忆(mem:)进池');
}

// ② taboo 零选用（连跑 500 次）
{
  let tabooHits = 0;
  for (let i = 0; i < 500; i++) { const m = selectThoughtMaterial({ likes, lexicon, memories, tabooTerms }); if (m && m.id === 'pref:3') tabooHits++; }
  ok(tabooHits === 0, `红色验证·拦：雷区素材 500 次零选用（实测 ${tabooHits}）`);
  const pool = filterThoughtPool(buildThoughtPool({ likes, lexicon, memories }), { tabooTerms });
  ok(!pool.some(p => p.id === 'pref:3') && pool.length >= 3, '雷区素材被 filter 排除、其余保留（证明不是因池空）');
}

// 隐私命中零选用
{
  const isSensitive = (t) => /手机号|身份证|\d{11}/.test(t);
  const likesPriv = [{ id: 1, target: '塞尔达', intensity: 5 }, { id: 4, target: '他手机号 13800000000', intensity: 5 }];
  let privHits = 0;
  for (let i = 0; i < 300; i++) { const m = selectThoughtMaterial({ likes: likesPriv, lexicon: [], memories: [], isSensitive }); if (m && m.id === 'pref:4') privHits++; }
  ok(privHits === 0, `红色验证·拦：隐私命中素材 300 次零选用（实测 ${privHits}）`);
}

// ③ 14 天同素材 ≤1 次（指纹冷却模拟：选中→落账→进 usedIds）
{
  const used = new Set();
  const counts = {};
  for (let day = 0; day < 14; day++) {
    const m = selectThoughtMaterial({ likes, lexicon, memories, tabooTerms, usedIds: used });
    if (!m) break;                       // 池耗尽是健康的（4 个有效素材，第 5 天起 null）
    counts[m.id] = (counts[m.id] || 0) + 1;
    used.add(m.id);
  }
  const maxRepeat = Math.max(0, ...Object.values(counts));
  ok(maxRepeat <= 1, `红色验证：14 天内同素材 ≤1 次（实测最多 ${maxRepeat}）`);
  ok(!Object.keys(counts).includes('pref:3'), '14 天里雷区素材一次都没出（冷却模拟下仍守住）');
}

// 全过滤 → null（调用方退回普通场景照，不空发）
{
  ok(selectThoughtMaterial({ likes: [], lexicon: [], memories: [] }) === null, '空池 → null');
  ok(selectThoughtMaterial({ likes: [likes[2]], lexicon: [], memories: [], tabooTerms }) === null, '只剩雷区 → null（退回普通）');
  const allUsed = new Set(['pref:1', 'pref:2', 'pref:3', 'joke:10', 'mem:20']);
  ok(selectThoughtMaterial({ likes, lexicon, memories, tabooTerms, usedIds: allUsed }) === null, '全冷却 → null');
}

// 加权：高 intensity 概率更高
{
  const two = [{ id: 1, target: 'A', intensity: 5 }, { id: 2, target: 'B', intensity: 1 }];
  let a = 0;
  for (let i = 0; i < 2000; i++) { if (selectThoughtMaterial({ likes: two }).id === 'pref:1') a++; }
  ok(a > 1500, `加权：intensity5 比 intensity1 明显高频（A=${a}/2000，期望≈1667）`);
}

console.log(`\nphoto_thought_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
