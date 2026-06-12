/**
 * photo_categories_smoke —— 照片品类加权采样基建（v1.21.6 PR-A）。
 *
 * 红线断言：
 *   - 总开关默认关：pickProactiveCategory() 返回 null（proactive 维持现状）
 *   - 开关开后才采样；分布大体跟随权重；env 热调（按品类权重 / DISABLE）生效
 *   - weeklyCap：cappedCategoryIds 把达上限的品类排除
 *   - fail-open：配置读不到 → categories 空 → sampleCategory 返回 null（不炸）
 *   - 真配置文件可解析且权重和>0（防手滑把 config 写坏）
 */
import {
  isCategorySamplingEnabled, loadPhotoCategoryConfig, sampleCategory,
  effectiveCategories, cappedCategoryIds, pickProactiveCategory,
} from '../src/photo_categories.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// ── 总开关默认关 ──
ok(isCategorySamplingEnabled({}) === false, '总开关默认关（无 env）');
ok(isCategorySamplingEnabled({ PHOTO_CATEGORY_SAMPLING_ENABLED: '' }) === false, '空字符串视为关');
ok(isCategorySamplingEnabled({ PHOTO_CATEGORY_SAMPLING_ENABLED: 'true' }) === true, "'true' 开");
ok(isCategorySamplingEnabled({ PHOTO_CATEGORY_SAMPLING_ENABLED: '1' }) === true, "'1' 开");
ok(pickProactiveCategory({ env: {} }) === null, '红线：开关关 → pickProactiveCategory=null（现状）');

// ── 真配置文件健康 ──
const cfg = loadPhotoCategoryConfig({ env: {} });
ok(Array.isArray(cfg.categories) && cfg.categories.length >= 6, `配置文件解析出 ${cfg.categories.length} 个品类（≥6）`);
const { total } = effectiveCategories(cfg);
ok(total > 0, `生效权重和 > 0（实测 ${total}）`);
ok(cfg.categories.some(c => c.id === 'thought_of_you' && c.weeklyCap === 2), 'thought_of_you weeklyCap=2');
ok(cfg.categories.every(c => ['ACTIVITY_POV', 'SCENERY', 'SELFIE', 'ENV_SELFIE', 'CANDID'].includes(c.shotMode)), '所有品类 shotMode 合法');

// ── 加权分布（开关开，1 万次采样，容差 ±5pct） ──
{
  const env = { PHOTO_CATEGORY_SAMPLING_ENABLED: 'true' };
  const c = loadPhotoCategoryConfig({ env });
  const N = 10000;
  const hit = {};
  for (let i = 0; i < N; i++) { const s = sampleCategory(c); if (s) hit[s.id] = (hit[s.id] || 0) + 1; }
  const food = (hit.food || 0) / N * 100;       // 期望 30
  const trophy = (hit.trophy || 0) / N * 100;   // 期望 5
  ok(Math.abs(food - 30) < 5, `food 采样占比≈30%（实测 ${food.toFixed(1)}%）`);
  ok(Math.abs(trophy - 5) < 4, `trophy 采样占比≈5%（实测 ${trophy.toFixed(1)}%）`);
  ok(Object.keys(hit).length === 6, `6 个品类都被采到（实测 ${Object.keys(hit).length}）`);
}

// ── env 热调：单类权重覆盖 + 停用 ──
{
  const env = { PHOTO_CATEGORY_SAMPLING_ENABLED: 'true', PHOTO_CAT_WEIGHT_FOOD: '0', PHOTO_CAT_DISABLE: 'selfie' };
  const c = loadPhotoCategoryConfig({ env });
  const food = c.categories.find(x => x.id === 'food');
  const selfie = c.categories.find(x => x.id === 'selfie');
  ok(food.weight === 0, 'PHOTO_CAT_WEIGHT_FOOD=0 覆盖生效');
  ok(selfie.enabled === false, 'PHOTO_CAT_DISABLE=selfie 停用生效');
  let foodHit = 0, selfieHit = 0;
  for (let i = 0; i < 3000; i++) { const s = sampleCategory(c); if (s?.id === 'food') foodHit++; if (s?.id === 'selfie') selfieHit++; }
  ok(foodHit === 0 && selfieHit === 0, 'weight=0 / disabled 品类零采样');
}

// ── weeklyCap：达上限排除 ──
{
  const c = loadPhotoCategoryConfig({ env: {} });
  ok(cappedCategoryIds({ thought_of_you: 2 }, c).has('thought_of_you'), 'thought_of_you 本周 2 张 → 达 cap(2) 排除');
  ok(!cappedCategoryIds({ thought_of_you: 1 }, c).has('thought_of_you'), 'thought_of_you 本周 1 张 → 未达 cap 不排除');
  ok(!cappedCategoryIds({ food: 999 }, c).has('food'), 'food 无 weeklyCap(0) → 不受封顶');
  // pickProactiveCategory 注入 cappedIds 后不再采到该类
  const env = { PHOTO_CATEGORY_SAMPLING_ENABLED: 'true' };
  let toyHit = 0;
  for (let i = 0; i < 5000; i++) {
    const s = pickProactiveCategory({ env, cappedIds: new Set(['thought_of_you']) });
    if (s?.id === 'thought_of_you') toyHit++;
  }
  ok(toyHit === 0, 'cappedIds 注入后 thought_of_you 零采样');
}

// ── fail-open：坏配置路径 → 空 → null，不抛 ──
{
  const c = loadPhotoCategoryConfig({ configPath: '/nonexistent/photo_categories.json', env: {} });
  ok(Array.isArray(c.categories) && c.categories.length === 0, '坏路径 → categories 空（fail-open）');
  ok(sampleCategory(c) === null, '空配置 → sampleCategory=null（退回现状）');
}

console.log(`\nphoto_categories_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
