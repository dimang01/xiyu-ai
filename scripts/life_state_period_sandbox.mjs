/**
 * life_state_period_sandbox —— v1.22 PR-L2 周期推进沙箱（纯确定性，无 LLM/DB）。
 * 模拟 13 个 companion 跨 N 天的生理期周期，肉眼验证：防 13 同步（起点错开）+
 * 周期个体固定 + phase 推进（premenstrual→menstrual→recovering→消失→下个周期）。
 * 手动跑（不进 CI；三道门控红验在 life_state_smoke）。用法：node scripts/life_state_period_sandbox.mjs [days=90]
 */
import { periodCycleFor, periodWindowToday } from '../src/life_state.mjs';

const DAYS = Math.max(30, Number(process.argv[2] || 90));
const DAY = 86400_000;
const base = Date.parse('2026-06-01T00:00:00Z');
const ids = Array.from({ length: 13 }, (_, i) => i + 1);
const sym = { premenstrual: '·', menstrual: '#', recovering: '~' };

console.log(`\n生理期周期推进沙箱 —— 13 个 companion × ${DAYS} 天（· 经前 / # 经期 / ~ 恢复 / 空 无）\n`);
console.log('id  cyc  ' + Array.from({ length: DAYS }, (_, d) => (d % 10 === 0 ? String((d / 10) % 10) : ' ')).join(''));
for (const id of ids) {
  const { cycleLength } = periodCycleFor(id);
  let row = '';
  for (let d = 0; d < DAYS; d++) {
    const w = periodWindowToday(id, base + d * DAY);
    row += w.active ? (sym[w.phase] || '?') : ' ';
  }
  console.log(`${String(id).padStart(2)}  ${cycleLength}   ${row}`);
}

// 防同步快照：逐日同时在经期(menstrual)的人数峰值
let peak = 0, peakDay = 0;
for (let d = 0; d < DAYS; d++) {
  const n = ids.filter(id => { const w = periodWindowToday(id, base + d * DAY); return w.active && w.phase === 'menstrual'; }).length;
  if (n > peak) { peak = n; peakDay = d; }
}
const cycles = ids.map(id => periodCycleFor(id).cycleLength);
console.log(`\n同日经期人数峰值：${peak}/13（day ${peakDay}）——远小于 13 = 防同步生效`);
console.log(`周期长度分布：${cycles.join(',')}（全 ∈ [26,32]，确定性派生自 id=个体固定）`);
console.log('');
process.exit(peak < ids.length ? 0 : 1);
