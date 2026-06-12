/**
 * sun_times_smoke —— 日出日落纯数学 + 晚霞窗口红色验证（v1.21.6 PR-C）。
 *
 * 物理合理性（默认城市≈杭州 30.25N,120.17E）：
 *   - 夏至日落晚（~19 点上海时），冬至日落早（~17 点），夏 > 冬
 *   - 日出 < 日落；正午在两者之间
 * 注入红色验证（晚霞硬锚）：
 *   - 拦：正午 / 日落前 2h / 日落后 1h → 不在窗口，sunsetFactLine 含「绝不能拍」
 *   - 放：日落时刻 / 日落±30min → 在窗口，含「可拍晚霞」
 */
import { sunTimes, isGoldenHour, sunsetFactLine, GOLDEN_HOUR_WINDOW_MIN } from '../src/utils/sun_times.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

const LOC = { lat: 30.25, lon: 120.17 };
const shHour = (d) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(d));

const summer = sunTimes(new Date('2026-06-21T04:00:00Z'), LOC.lat, LOC.lon);   // 夏至
const winter = sunTimes(new Date('2026-12-21T04:00:00Z'), LOC.lat, LOC.lon);   // 冬至

const sSet = shHour(summer.sunset), wSet = shHour(winter.sunset);
const sRise = shHour(summer.sunrise), wRise = shHour(winter.sunrise);
console.log(`  实测：夏至日出${sRise}点/日落${sSet}点  冬至日出${wRise}点/日落${wSet}点（上海时）`);

ok(sSet >= 18 && sSet <= 20, `夏至日落在 18-20 点（实测 ${sSet}）`);
ok(wSet >= 16 && wSet <= 18, `冬至日落在 16-18 点（实测 ${wSet}）`);
ok(sSet > wSet, `夏至日落晚于冬至（${sSet} > ${wSet}）`);
ok(sRise < wRise, `夏至日出早于冬至（${sRise} < ${wRise}）`);
ok(summer.sunrise < summer.sunset && winter.sunrise < winter.sunset, '日出早于日落');

// ── 窗口边界 ──
const ss = summer.sunset;
ok(isGoldenHour(ss, LOC) === true, '日落时刻在晚霞窗口');
ok(isGoldenHour(new Date(ss.getTime() - 30 * 60_000), LOC) === true, '日落前 30min 在窗口');
ok(isGoldenHour(new Date(ss.getTime() + 30 * 60_000), LOC) === true, '日落后 30min 在窗口');
ok(isGoldenHour(new Date(ss.getTime() - 2 * 3600_000), LOC) === false, '日落前 2h 不在窗口');
ok(isGoldenHour(new Date(ss.getTime() + 60 * 60_000), LOC) === false, `日落后 60min 不在窗口（>${GOLDEN_HOUR_WINDOW_MIN}）`);

// ── 注入红色验证 ──
ok(sunsetFactLine(ss, LOC).includes('可拍晚霞'), '红色验证·放：窗口内含「可拍晚霞」');
const noonUtc = new Date('2026-06-21T04:00:00Z');   // 上海正午前后
ok(sunsetFactLine(noonUtc, LOC).includes('绝不能拍'), '红色验证·拦：正午含「绝不能拍」晚霞');
ok(sunsetFactLine(new Date(ss.getTime() - 3 * 3600_000), LOC).includes('绝不能拍'), '日落前 3h 含「绝不能拍」');

console.log(`\nsun_times_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
