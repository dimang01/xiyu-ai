/**
 * 月相锚定 smoke（PR-C，纯数学零 API、零 LLM）。
 *
 * fixture 用物理可辩护锚点（不是查历书，是天体物理硬约束）：
 *   - 日食必在新月：2026-08-12 西班牙日全食 → 照亮≈0%
 *   - 月食必在满月：2026-03-03 月全食 → 照亮≈100%
 *   - 任务硬闸：2026-06-11 22:00 北京 = 残月、前半夜不可见（与任务判断一致才放行）
 *
 * 红色验证（注入约束的双向断言）：
 *   - 6/11 晚月相事实行必须含"不可见"——夜空场景下生成端无从虚构满月
 *   - 满月±3 天同时刻必须含"可见"——正常满月夜不被误杀
 *
 * 精度声明：均值朔望月线性外推，±1 天级——对"满月还是残月"粗判足够（不做天文计算）。
 */
import { moonPhase, moonFactLine, moonAgeDays } from '../src/utils/moon_phase.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const illum = (iso) => moonPhase(new Date(iso)).illumination;

// ── 物理锚点 fixture ──
ok(illum('2026-08-12T17:46:00Z') < 0.05, `日全食=新月：2026-08-12 照亮<5%（实测 ${(illum('2026-08-12T17:46:00Z') * 100).toFixed(1)}%）`);
ok(illum('2026-03-03T11:34:00Z') > 0.95, `月全食=满月：2026-03-03 照亮>95%（实测 ${(illum('2026-03-03T11:34:00Z') * 100).toFixed(1)}%）`);

// ── 任务硬闸：6/11 22:00 北京 = 残月、前半夜不可见 ──
const c611 = moonPhase(new Date('2026-06-11T14:00:00Z'));
ok(c611.phaseName === '残月', `6/11 22:00 北京 = 残月（实测 ${c611.phaseName} ${(c611.illumination * 100).toFixed(0)}%）`);
ok(c611.visibleFirstHalfNight === false, '6/11 22:00 北京前半夜不可见（任务硬闸）');

// ── 红色验证：注入约束双向 ──
ok(moonFactLine(new Date('2026-06-11T14:00:00Z')).includes('不可见'),
   '红色验证·拦：6/11 月相事实行含"不可见"（夜空场景无从虚构满月）');
// 满月夜（2026-03-03 月全食=满月）前半夜可见
ok(moonFactLine(new Date('2026-03-03T14:00:00Z')).includes('可见') && !moonFactLine(new Date('2026-03-03T14:00:00Z')).includes('不可见'),
   '红色验证·放：满月夜月相事实行含"可见"（正常满月不误杀）');

// ── 周期健壮性 ──
ok(moonAgeDays(new Date('2026-06-11T14:00:00Z')) >= 0 && moonAgeDays(new Date('2026-06-11T14:00:00Z')) < 29.54, '月龄在 [0,29.54)');
// 新月→上弦→满月→下弦 照亮单调性抽样
const newMoon = new Date('2026-08-12T17:46:00Z').getTime();
ok(illum(new Date(newMoon + 7.4 * 86400e3).toISOString()) > 0.4 && illum(new Date(newMoon + 7.4 * 86400e3).toISOString()) < 0.6, '新月+7.4d ≈ 上弦（~50%）');
ok(illum(new Date(newMoon + 14.8 * 86400e3).toISOString()) > 0.95, '新月+14.8d ≈ 满月（>95%）');

// ── 注入点静态断言 ──
const planner = readFileSync(new URL('../src/photo_planner.mjs', import.meta.url), 'utf8');
ok(planner.includes('moonFactLine') && planner.includes('月相事实（真实天象，不可违背）'),
   'planner 夜空场景注入月相事实');
const pro = readFileSync(new URL('../src/proactive.mjs', import.meta.url), 'utf8');
ok(pro.includes('moonFactLine') && pro.includes('绝不要凭空说"月亮好圆'),
   'proactive 夜间注入月相事实（禁凭空月亮好圆）');

console.log(`\nmoon_phase_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
