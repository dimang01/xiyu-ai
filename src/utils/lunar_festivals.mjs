/**
 * lunar_festivals.mjs — 农历节日公历日期（v1.21.4 PR-W3，零 API、零依赖）。
 *
 * 设计 §9：农历节日（春节/元宵/端午/中秋/重阳）是 reality facts 成员。**用天文计算而非
 * 手填日期表**——精确新月（Meeus 朔望）定农历「初一」，中气（太阳黄经 30° 整倍）定月序、
 * 判置闰（无中气之月为闰月），按标准农历规则推算节日公历日。自洽可靠、覆盖任意年份，
 * 不依赖手填可能错的对照表（契合 reality facts「不编造」红线）。清明=节气（见 solar_terms），
 * 元宵=正月十五=春节+14。
 *
 * 精度：Meeus 新月主项 ~分钟级，中气复用 solar_terms（~0.01°）→ 农历日定到「日」（上海时区）
 * 足够。fixture 用权威农历节日公历日锚定（春节/中秋/端午）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { termMomentUTC } from './solar_terms.mjs';

const RAD = Math.PI / 180;
const SYNODIC = 29.530588861;

/** 第 k 个朔（新月）的 JDE（Meeus 第 49 章主项；~分钟级，够定日）。 */
function newMoonJDE(k) {
  const T = k / 1236.85;
  let jde = 2451550.09766 + SYNODIC * k + 0.00015437 * T * T - 0.000000150 * T * T * T + 0.00000000073 * T ** 4;
  const M = (2.5534 + 29.10535670 * k - 0.0000014 * T * T) * RAD;
  const Mp = (201.5643 + 385.81693528 * k + 0.0107582 * T * T) * RAD;
  const F = (160.7108 + 390.67050284 * k - 0.0016118 * T * T) * RAD;
  const Om = (124.7746 - 1.56375588 * k + 0.0020672 * T * T) * RAD;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;
  jde += -0.40720 * Math.sin(Mp)
    + 0.17241 * E * Math.sin(M)
    + 0.01608 * Math.sin(2 * Mp)
    + 0.01039 * Math.sin(2 * F)
    + 0.00739 * E * Math.sin(Mp - M)
    - 0.00514 * E * Math.sin(Mp + M)
    + 0.00208 * E * E * Math.sin(2 * M)
    - 0.00111 * Math.sin(Mp - 2 * F)
    - 0.00057 * Math.sin(Mp + 2 * F)
    + 0.00056 * E * Math.sin(2 * Mp + M)
    - 0.00042 * Math.sin(3 * Mp)
    + 0.00042 * E * Math.sin(M + 2 * F)
    + 0.00038 * E * Math.sin(M - 2 * F)
    - 0.00024 * E * Math.sin(2 * Mp - M)
    - 0.00017 * Math.sin(Om)
    - 0.00007 * Math.sin(Mp + 2 * M)
    + 0.00004 * Math.sin(2 * Mp - 2 * F)
    + 0.00004 * Math.sin(3 * M)
    + 0.00003 * Math.sin(Mp + M - 2 * F)
    + 0.00003 * Math.sin(2 * Mp + 2 * F)
    - 0.00003 * Math.sin(Mp + M + 2 * F)
    + 0.00003 * Math.sin(Mp - M + 2 * F)
    - 0.00002 * Math.sin(Mp - M - 2 * F)
    - 0.00002 * Math.sin(3 * Mp + M)
    + 0.00002 * Math.sin(4 * Mp);
  return jde;   // TD≈UTC（ΔT~70s 对定日无影响）
}
const newMoonMs = (k) => (newMoonJDE(k) - 2440587.5) * 86400_000;
const shDateKey = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
// 上海日历日（00:00 上海）的 UTC ms——朔落在哪个上海日 = 该日 00:00 ≤ 朔 < 次日 00:00
const shDayStartMs = (ms) => { const k = shDateKey(ms); return Date.parse(k + 'T00:00:00Z') - 8 * 3600_000; };

/** 12 中气（黄经 30° 整倍）在 [year-1, year] 两年的 UTC ms，用于判置闰。 */
function zhongqiMomentsMs(gYear) {
  const lons = [270, 300, 330, 0, 30, 60, 90, 120, 150, 180, 210, 240];   // 冬至…小雪
  const out = [];
  for (const y of [gYear - 1, gYear, gYear + 1]) for (const lon of lons) out.push(termMomentUTC(y, lon).getTime());
  return out.sort((a, b) => a - b);
}

/**
 * 推算某公历年的农历节日公历日期（春节所在农历年）。
 * @returns {{春节,元宵,端午,中秋,重阳}} 各为上海日期键 'YYYY-MM-DD'
 */
export function lunarFestivalsOfYear(gYear) {
  const dz0 = termMomentUTC(gYear - 1, 270).getTime();   // 冬至(去年)→在农历11月(子月)
  const dz1 = termMomentUTC(gYear, 270).getTime();       // 冬至(今年)→下一个子月
  // 子月朔：≤ 冬至(去年) 的最后一个朔
  let k = Math.round((dz0 / 86400_000 + 2440587.5 - 2451550.09766) / SYNODIC);
  while (newMoonMs(k) > dz0) k--;
  while (newMoonMs(k + 1) <= dz0) k++;
  // 下一个子月朔：≤ 冬至(今年) 的最后一个朔
  let k2 = k;
  while (newMoonMs(k2 + 1) <= dz1) k2++;
  const numMonths = k2 - k;                               // 12=平年 / 13=闰年
  const zq = zhongqiMomentsMs(gYear);
  const monthHasZhongqi = (i) => {
    const a = newMoonMs(k + i), b = newMoonMs(k + i + 1);
    return zq.some(m => m >= a && m < b);
  };
  // 月序偏移：子月(0)→正月(寅) 正常 +2；闰月落在 [子月..正月) 之间则正月后移 +1
  let leapBeforeZhengyue = false;
  if (numMonths === 13) {
    for (let i = 1; i < numMonths; i++) {
      if (!monthHasZhongqi(i)) { if (i <= 2) leapBeforeZhengyue = true; break; }
    }
  }
  // 闰月也占一个朔位——正月之后的节日月序号需把"正月前的闰"算进 offset，
  // 正月之后的闰月由 monthHasZhongqi 在累加时跳过。这里构造 月号→朔index 映射：
  const monthNumToIdx = {};   // 农历月数字(1=正月…) → 朔在 k 基准上的 index
  {
    let num = 11;             // 子月=11月
    let sawLeap = false;
    for (let i = 0; i <= numMonths; i++) {
      const isLeap = numMonths === 13 && !sawLeap && i >= 1 && !monthHasZhongqi(i);
      if (isLeap) { sawLeap = true; continue; }   // 闰月不占月号
      if (!(num in monthNumToIdx)) monthNumToIdx[num] = i;
      num = num === 12 ? 1 : num + 1;
    }
  }
  void leapBeforeZhengyue;
  const nmDayKey = (monthNum, dayInMonth) => shDateKey(shDayStartMs(newMoonMs(k + monthNumToIdx[monthNum])) + (dayInMonth - 1) * 86400_000);
  const chunjieKey = nmDayKey(1, 1);
  return {
    春节: chunjieKey,
    元宵: shDateKey(Date.parse(chunjieKey + 'T00:00:00Z') - 8 * 3600_000 + 14 * 86400_000),   // 正月十五=春节+14
    端午: nmDayKey(5, 5),
    中秋: nmDayKey(8, 15),
    重阳: nmDayKey(9, 9),
  };
}

/** 今天（上海）是否某农历节日 → 节日名或 null。 */
export function lunarFestivalOnDate(date = new Date()) {
  const todayKey = shDateKey(date.getTime());
  const year = Number(todayKey.slice(0, 4));
  for (const y of [year - 1, year, year + 1]) {
    const f = lunarFestivalsOfYear(y);
    for (const [name, key] of Object.entries(f)) if (key === todayKey) return name;
  }
  return null;
}
