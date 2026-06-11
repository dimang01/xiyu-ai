/**
 * moon_phase.mjs — 月相纯数学计算（v1.21.5 PR-C，零 API、零依赖）。
 *
 * 背景（生产案 A）：proactive 凭空说"月亮好圆"——而 6/11 晚其实是残月、前半夜
 * 根本看不见。LLM 无从知道真实月相，只能瞎编满月。本模块用朔望月周期纯计算，
 * 把"今晚月相事实"喂进 proactive/planner 场景上下文，让生成端无从虚构。
 *
 * 算法：已知新月历元 + 朔望月 29.530588 天线性外推月龄（age days）。
 *   照亮比例 illumination = (1 - cos(2π·age/period)) / 2
 *   相名按月龄八分；前半夜可见性按"日落后到午夜这段天空有没有月亮"粗判：
 *     - 新月前后：与日同升落，前半夜基本不可见
 *     - 上弦~满月：前半夜高悬，可见
 *     - 满月~下弦：后半夜才升，前半夜渐不可见
 *     - 残月（下弦后到新月）：后半夜/黎明才升，前半夜不可见
 *   这是肉眼级粗判（不做地平高度精算），够"她该不该说看见月亮"用。
 *
 * 精度声明：线性朔望月外推，相位误差约 ±1 天——对"满月还是残月"这种粗判足够，
 * 不用于天文计算。fixture 用权威新月日期锚定验证。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

const SYNODIC_MONTH = 29.530588;   // 朔望月（天）
// 历元新月：2000-01-06 18:14 UTC（J2000 附近一个标准参考新月，JD 2451550.1）
const EPOCH_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14, 0);

const PHASE_NAMES = [
  '新月', '娥眉月', '上弦月', '盈凸月', '满月', '亏凸月', '下弦月', '残月',
];

/** 月龄（距最近一次新月的天数，0 ~ 29.53） */
export function moonAgeDays(date = new Date()) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  const days = (ms - EPOCH_NEW_MOON_MS) / 86400_000;
  const age = days % SYNODIC_MONTH;
  return age < 0 ? age + SYNODIC_MONTH : age;
}

/**
 * 月相事实。
 * @returns {{age, illumination(0-1), phaseName, waxing, visibleFirstHalfNight}}
 */
export function moonPhase(date = new Date()) {
  const age = moonAgeDays(date);
  const frac = age / SYNODIC_MONTH;                          // 0~1 周期相位
  const illumination = (1 - Math.cos(2 * Math.PI * frac)) / 2;
  const idx = Math.round(frac * 8) % 8;                      // 八分相名
  const phaseName = PHASE_NAMES[idx];
  const waxing = age < SYNODIC_MONTH / 2;                    // 上半月渐盈
  // 前半夜（日落~午夜）可见性：上弦(age≈7.4)到满月(≈14.8)再到稍过满月前半夜可见；
  // 新月±2 天、下弦之后（age>22）前半夜不可见。粗判用月龄区间。
  const visibleFirstHalfNight = age >= 5.5 && age <= 18.5;
  return { age, illumination, phaseName, waxing, visibleFirstHalfNight };
}

/** 给 prompt 注入的一行中文事实（夜空场景用），白天/不涉及月亮可不注入 */
export function moonFactLine(date = new Date()) {
  const m = moonPhase(date);
  const pct = Math.round(m.illumination * 100);
  const vis = m.visibleFirstHalfNight ? '前半夜可见' : '前半夜基本不可见（后半夜或黎明才升）';
  return `今晚月相：${m.phaseName}（约 ${pct}% 照亮），${vis}`;
}
