/**
 * solar_terms.mjs — 24 节气纯天文计算（v1.21.4 PR-W3，零 API、零依赖）。
 *
 * 设计 §9：节气是 reality facts 家族成员（"她的世界经得起查证"）。**用天文计算而非
 * 手填日期表**——节气 = 太阳黄经达 15° 整数倍的时刻，复用 sun_times 同款太阳黄经公式，
 * 自洽可靠，不依赖手填可能出错的日期常量（契合 reality facts「不编造」红线：错的日期
 * 表比没有更糟）。节气时刻用 Newton 迭代求解（dλ/dt≈0.9857°/天，2-3 步收敛）。
 *
 * 精度：太阳黄经公式（中心方程前三项）误差 ~arcmin 级 → 节气时刻误差分钟级，定到「日」
 * （上海时区）足够。fixture 用权威节气日期锚定验证（冬至/夏至/二分点）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

const RAD = Math.PI / 180;
const MEAN_DEG_PER_DAY = 0.98565;   // 太阳黄经平均日速（°/天）

// 24 节气（黄经 0°=春分，每 15° 一个；按黄经升序）。
const TERMS = [
  ['春分', 0], ['清明', 15], ['谷雨', 30], ['立夏', 45], ['小满', 60], ['芒种', 75],
  ['夏至', 90], ['小暑', 105], ['大暑', 120], ['立秋', 135], ['处暑', 150], ['白露', 165],
  ['秋分', 180], ['寒露', 195], ['霜降', 210], ['立冬', 225], ['小雪', 240], ['大雪', 255],
  ['冬至', 270], ['小寒', 285], ['大寒', 300], ['立春', 315], ['雨水', 330], ['惊蛰', 345],
];

/** 太阳视黄经（度，0~360）——NOAA/Meeus 低精度式（平黄经 + 中心方程），精度 ~0.01°。 */
export function sunEclipticLongitude(date = new Date()) {
  const jd = date.getTime() / 86400_000 + 2440587.5;
  const n = jd - 2451545.0;                                    // 自 J2000 连续天数
  const L = (280.46646 + 0.98564736 * n) % 360;                // 平黄经（含正确日速）
  const g = ((357.52911 + 0.98560028 * n) % 360) * RAD;        // 平近点角
  const lambda = L + 1.914602 * Math.sin(g) + 0.019993 * Math.sin(2 * g) + 0.000289 * Math.sin(3 * g);
  return ((lambda % 360) + 360) % 360;
}

// 带符号最短角差 [-180,180)
function signedDiff(a, b) { return (((a - b) % 360) + 540) % 360 - 180; }

/** 某年太阳黄经达 targetLon 的 UTC 时刻（Newton 迭代）。 */
export function termMomentUTC(year, targetLon) {
  // 起点：按 λ(Jan1)≈280° 反推 day-of-year
  const approxDay = (((targetLon - 280) % 360) + 360) % 360 / MEAN_DEG_PER_DAY;
  let t = Date.UTC(year, 0, 1) + approxDay * 86400_000;
  for (let i = 0; i < 8; i++) {
    const diff = signedDiff(sunEclipticLongitude(new Date(t)), targetLon);
    if (Math.abs(diff) < 1e-6) break;
    t -= (diff / MEAN_DEG_PER_DAY) * 86400_000;
  }
  return new Date(t);
}

/** 上海日期键（节气按上海时区定"日"）。 */
function shanghaiDateKey(date) {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 给定上海年份的全部 24 节气 [{name, lon, momentUTC, dateKey(上海)}]，按时间排序。 */
export function solarTermsOfYear(year) {
  return TERMS.map(([name, lon]) => {
    const momentUTC = termMomentUTC(year, lon);
    return { name, lon, momentUTC, dateKey: shanghaiDateKey(momentUTC) };
  }).sort((a, b) => a.momentUTC - b.momentUTC);
}

/** 今天（上海）是否恰为某节气当日 → 返回 {name} 或 null。 */
export function solarTermOnDate(date = new Date()) {
  const todayKey = shanghaiDateKey(date);
  const year = Number(todayKey.slice(0, 4));
  for (const y of [year - 1, year, year + 1]) {              // 跨年边界兜底
    for (const t of solarTermsOfYear(y)) {
      if (t.dateKey === todayKey) return { name: t.name, lon: t.lon };
    }
  }
  return null;
}

/** 下一个节气 + 距今天数（上海日历日差）。 */
export function nextSolarTerm(date = new Date()) {
  const todayKey = shanghaiDateKey(date);
  const year = Number(todayKey.slice(0, 4));
  const all = [...solarTermsOfYear(year - 1), ...solarTermsOfYear(year), ...solarTermsOfYear(year + 1)]
    .sort((a, b) => a.momentUTC - b.momentUTC);
  const todayMs = Date.parse(todayKey + 'T00:00:00Z');
  for (const t of all) {
    const tDayMs = Date.parse(t.dateKey + 'T00:00:00Z');
    if (tDayMs > todayMs) return { name: t.name, daysUntil: Math.round((tDayMs - todayMs) / 86400_000) };
  }
  return null;
}

/**
 * 节气事实短语（注入 reality facts；白天零开销原则——只在「当日是节气」或「临近(默认 ≤2 天)」
 * 才有内容，其余返回 ''，绝不每天都报"距下个节气还 N 天"的噪声）。
 */
export function solarTermFactLine(date = new Date(), { nearDays = 2 } = {}) {
  const on = solarTermOnDate(date);
  if (on) return `今天是${on.name}`;
  const nx = nextSolarTerm(date);
  if (nx && nx.daysUntil <= nearDays) return `快到${nx.name}了（还有${nx.daysUntil}天）`;
  return '';
}
