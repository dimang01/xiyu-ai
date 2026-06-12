/**
 * sun_times.mjs — 日出日落纯数学（v1.21.6 PR-C，零 API、零依赖）。
 *
 * 背景（接 [[project-photo-promise-v1215]] 月相同族）：晚霞/夕阳照不能凭空发——正午
 * 不可能有晚霞，色温对不上就是假。本模块用标准 sunrise equation（Wikipedia）算她所在
 * 城市当天的日落时刻，把"现在在不在晚霞窗口（日落±40min）"喂进 planner，杜绝瞎拍晚霞。
 *
 * 城市固定（她的人设城市，**不是用户定位**）；env PHOTO_CITY_LAT/LON 覆盖。
 * 精度分钟级——对"现在算不算黄昏"这种粗判足够，不做天文级计算。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

const RAD = Math.PI / 180;
// 默认城市经纬度（运营所在城市量级；env 覆盖）。约杭州。
const DEFAULT_LAT = 30.25, DEFAULT_LON = 120.17;
export const GOLDEN_HOUR_WINDOW_MIN = 40;

export function cityLatLon(env = process.env) {
  const lat = Number(env.PHOTO_CITY_LAT);
  const lon = Number(env.PHOTO_CITY_LON);
  return {
    lat: Number.isFinite(lat) ? lat : DEFAULT_LAT,
    lon: Number.isFinite(lon) ? lon : DEFAULT_LON,
  };
}

/**
 * 当天日出/日落（UTC Date）。标准 sunrise equation。
 * @returns {{sunrise: Date|null, sunset: Date|null, polar?: 'day'|'night'}}
 *   极昼/极夜时 sunrise/sunset 为 null（中纬度城市不会发生）。
 */
export function sunTimes(date = new Date(), lat = DEFAULT_LAT, lon = DEFAULT_LON) {
  const jdate = date.getTime() / 86400_000 + 2440587.5;        // Julian date
  const n = Math.ceil(jdate - 2451545.0 + 0.0008);             // 自 J2000 的天数
  const Jstar = n - lon / 360;                                 // 平太阳时
  const M = (357.5291 + 0.98560028 * Jstar) % 360;             // 太阳平近点角
  const Mr = M * RAD;
  const C = 1.9148 * Math.sin(Mr) + 0.0200 * Math.sin(2 * Mr) + 0.0003 * Math.sin(3 * Mr); // 中心方程
  const lambda = ((M + C + 180 + 102.9372) % 360) * RAD;       // 黄经
  const Jtransit = 2451545.0 + Jstar + 0.0053 * Math.sin(Mr) - 0.0069 * Math.sin(2 * lambda); // 太阳正午
  const delta = Math.asin(Math.sin(lambda) * Math.sin(23.44 * RAD));   // 赤纬
  const cosOmega = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * Math.sin(delta))
    / (Math.cos(lat * RAD) * Math.cos(delta));
  if (cosOmega > 1) return { sunrise: null, sunset: null, polar: 'night' };
  if (cosOmega < -1) return { sunrise: null, sunset: null, polar: 'day' };
  const omega = Math.acos(cosOmega) / RAD;                     // 时角（度）
  const toDate = (jd) => new Date((jd - 2440587.5) * 86400_000);
  return {
    sunrise: toDate(Jtransit - omega / 360),
    sunset: toDate(Jtransit + omega / 360),
  };
}

/** 现在是否在日落 ±window 分钟内（晚霞窗口）。极昼夜 → false（无晚霞概念）。 */
export function isGoldenHour(date = new Date(), { lat, lon } = cityLatLon(), windowMin = GOLDEN_HOUR_WINDOW_MIN) {
  const { sunset } = sunTimes(date, lat, lon);
  if (!sunset) return false;
  return Math.abs(date.getTime() - sunset.getTime()) <= windowMin * 60_000;
}

function shanghaiHHMM(d) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${parts.hour}:${parts.minute}`;
}

/** 给 planner 注入的一行日落事实（晚霞场景用）：在窗口才许拍晚霞，否则硬禁。 */
export function sunsetFactLine(date = new Date(), loc = cityLatLon()) {
  const { sunset } = sunTimes(date, loc.lat, loc.lon);
  if (!sunset) return '';
  const inWindow = isGoldenHour(date, loc);
  return `今天日落约 ${shanghaiHHMM(sunset)}（当地）。`
    + (inWindow
      ? `此刻在晚霞窗口内（日落±${GOLDEN_HOUR_WINDOW_MIN}min），可拍晚霞/夕阳，按真实色温描述。`
      : `**此刻不在晚霞窗口，绝不能拍晚霞/夕阳/火烧云**——天还没到那个色温，硬拍就是假。改拍别的或别发。`);
}
