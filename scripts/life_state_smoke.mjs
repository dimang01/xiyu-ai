/**
 * life_state_smoke —— v1.22 PR-L1 通用引擎红验。纯函数零网络零真 DB。
 * 设计 docs/LIFE_STATE_DESIGN.md §2 / §5.1。
 * 覆盖：① kind 谱系配置 ② 确定性 phase 推进 ③ tick 推进+归档 ④ 挂载静态断言。
 */
import { readFileSync } from 'node:fs';
import { LIFE_KIND_CONFIG, phaseForElapsed, tickLifeState } from '../src/life_state.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

const DAY = 86400_000;
const iso = (ms) => new Date(ms).toISOString();

// ── ① kind 谱系配置 ──
ok(LIFE_KIND_CONFIG.period?.phases?.join(',') === 'premenstrual,menstrual,recovering', '①period 三阶段');
ok(LIFE_KIND_CONFIG.period?.adultOnly === true, '①period adultOnly=true（批注①元数据）');
ok(LIFE_KIND_CONFIG.minor_illness?.adultOnly === false && LIFE_KIND_CONFIG.minor_illness?.category === 'illness', '①minor_illness 非成年门控 / category=illness');
ok(LIFE_KIND_CONFIG.injury?.category === 'injury', '①injury category=injury');

// ── ② 确定性 phase 推进（均匀分段；3 段各 3 天）──
{
  const s = 0, e = 9 * DAY;
  ok(phaseForElapsed('period', s, e, 0) === 'premenstrual', '②起点→premenstrual');
  ok(phaseForElapsed('period', s, e, 4 * DAY) === 'menstrual', '②中段→menstrual');
  ok(phaseForElapsed('period', s, e, 8 * DAY) === 'recovering', '②末段→recovering');
  ok(phaseForElapsed('period', s, e, e + DAY) === 'recovering', '②超末仍 recovering（不越界）');
  ok(phaseForElapsed('unknown_kind', s, e, 0) === null, '②未知 kind→null');
}

// ── ③ tick：推进 / 归档（纯函数，零 IO）──
{
  const now = 100 * DAY;
  const r1 = tickLifeState([{ id: 1, kind: 'minor_illness', phase: 'peak', status: 'active', started_at: iso(now - 5 * DAY), expected_end_at: iso(now - DAY) }], now);
  ok(r1.resolve.includes(1) && !r1.advance.length, '③到点结束→resolve');

  const r2 = tickLifeState([{ id: 2, kind: 'minor_illness', phase: 'onset', status: 'active', started_at: iso(now - 5 * DAY), expected_end_at: iso(now + 4 * DAY) }], now); // 9 天病程过 5 天→中段 peak
  ok(r2.advance.some(a => a.id === 2 && a.phase === 'peak') && !r2.resolve.length, '③过半→advance 到 peak');

  const r3 = tickLifeState([{ id: 3, kind: 'minor_illness', phase: 'peak', status: 'active', started_at: iso(now - 5 * DAY), expected_end_at: iso(now + 4 * DAY) }], now);
  ok(!r3.advance.length && !r3.resolve.length, '③phase 已正确→不动');

  const r4 = tickLifeState([{ id: 4, kind: 'minor_illness', phase: 'onset', status: 'resolved', started_at: iso(now - 5 * DAY), expected_end_at: iso(now - DAY) }], now);
  ok(!r4.advance.length && !r4.resolve.length, '③resolved 档案忽略');

  ok(tickLifeState(null).advance.length === 0 && tickLifeState(undefined).resolve.length === 0, '③null/undefined→空');
}

// ── ④ 挂载静态断言（建表/便车/四档 gate）──
{
  const dbSrc = readFileSync(new URL('../src/db.mjs', import.meta.url), 'utf8');
  const planSrc = readFileSync(new URL('../src/plan_tasks.mjs', import.meta.url), 'utf8');
  const modSrc = readFileSync(new URL('../src/moderation.mjs', import.meta.url), 'utf8');
  ok(dbSrc.includes('migrateLifeState') && dbSrc.includes('CREATE TABLE IF NOT EXISTS companion_life_state'), '④db 建表 + 注册');
  ok(dbSrc.includes('export function getActiveLifeStates') && dbSrc.includes('export function resolveLifeState'), '④db CRUD 就位');
  ok(planSrc.includes('refreshLifeState(comp.id)'), '④plan_tasks 搭 00:30 批便车推进');
  ok(modSrc.includes('DIAGNOSED_ILLNESS_RE') && modSrc.includes('activeLifeStates'), '④moderation 四档 gate 接档案');
}

console.log(`\nlife_state_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
