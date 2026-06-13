/**
 * life_state_smoke —— v1.22 PR-L1 引擎 + PR-L2 生理期门控红验。纯函数零网络零真 DB。
 * 设计 docs/LIFE_STATE_DESIGN.md §2/§3/§5.1。
 * 覆盖：① kind 谱系 ② phase 推进 ③ tick 推进+归档 ④ 挂载断言 +
 *   **⑤防 13 同步 ⑥披露门控 ⑦成年门控（三道门控红验）⑧onset 零情绪副作用边界**。
 */
import { readFileSync } from 'node:fs';
import { LIFE_KIND_CONFIG, phaseForElapsed, tickLifeState, isPeriodAllowed, periodCycleFor, periodWindowToday } from '../src/life_state.mjs';
import { scrubPeriodDisclosure } from '../src/moderation.mjs';

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
  ok(planSrc.includes('refreshLifeState(comp)'), '④plan_tasks 搭 00:30 批便车（传 comp 对象做成年门控）');
  ok(modSrc.includes('DIAGNOSED_ILLNESS_RE') && modSrc.includes('activeLifeStates'), '④moderation 四档 gate 接档案');
}

// ── ⑤ 防 13 同步（PR-L2 周期锚点确定性派生自 id）──
{
  const ids = Array.from({ length: 13 }, (_, i) => i + 1);
  ok(ids.every(id => { const c = periodCycleFor(id).cycleLength; return c >= 26 && c <= 32; }), '⑤cycleLength 全 ∈ [26,32]');
  const fixed = Date.parse('2026-06-13T00:00:00Z');
  const idxs = ids.map(id => periodWindowToday(id, fixed).dayIndex);
  const distinct = new Set(idxs).size;
  ok(distinct >= 8, `⑤dayIndex 分散：13 个里 ${distinct} 个不同值（≥8=非同步）`);
  const activeCount = ids.filter(id => periodWindowToday(id, fixed).active).length;
  ok(activeCount <= 6, `⑤同日活跃 ${activeCount} ≤6（远小于 13=非同步爆发）`);
  ok(periodCycleFor(7).cycleLength === periodCycleFor(7).cycleLength && periodCycleFor(7).phaseOffset === periodCycleFor(7).phaseOffset, '⑤个体固定（同 id 同周期/同相位）');
}

// ── ⑥ 披露门控（PR-L2·批注⑥·确定性出站护栏；朋友期只表现不点明）──
{
  const lo = { affectionLevel: 30 };  // 朋友/暧昧
  const hi = { affectionLevel: 90 };  // 恋人/深爱
  ok(scrubPeriodDisclosure('姨妈来了 肚子疼', lo) !== '姨妈来了 肚子疼', '⑥拦：朋友期显式月经（姨妈来了）');
  ok(scrubPeriodDisclosure('我月经来了', lo) !== '我月经来了', '⑥拦：朋友期"月经来了"');
  ok(scrubPeriodDisclosure('痛经 难受死了', lo) !== '痛经 难受死了', '⑥拦：朋友期"痛经"');
  ok(scrubPeriodDisclosure('姨妈来了 肚子疼', hi) === '姨妈来了 肚子疼', '⑥放行：恋人期可直说');
  ok(scrubPeriodDisclosure('今天有点累 不想动', lo) === '今天有点累 不想动', '⑥放行：朋友期无月经表述零开销');
  ok(scrubPeriodDisclosure('姨妈来了', lo) === '嗯…今天有点不舒服', '⑥兜底：全剥→保留"不舒服"不点原因');
  ok(scrubPeriodDisclosure('又困了||姨妈来了 难受||晚安', lo) === '又困了||晚安', '⑥多段：只剥点明段，留其余');
}

// ── ⑦ 成年门控（PR-L2·批注①·唯一防线；任一未成年条件 → period 零出现）──
{
  ok(isPeriodAllowed({ age: 22, safe_mode: 0, role_title: '同事' }) === true, '⑦放行：成年（22/无 safe_mode/无低龄设定）');
  ok(isPeriodAllowed({ age: 16, safe_mode: 0 }) === false, '⑦拦：age 16<18');
  ok(isPeriodAllowed({ age: 22, safe_mode: 1 }) === false, '⑦拦：safe_mode=1');
  ok(isPeriodAllowed({ age: null, safe_mode: 0 }) === false, '⑦拦：age 缺失');
  ok(isPeriodAllowed({ age: 0, safe_mode: 0 }) === false, '⑦拦：age=0 异常');
  ok(isPeriodAllowed({ age: 20, safe_mode: 0, role_title: '高中生' }) === false, '⑦拦：低龄校园（高中生）');
  ok(isPeriodAllowed({ age: 20, safe_mode: 0, personality_tags: '青涩 初中同学' }) === false, '⑦拦：低龄藏 personality（初中）');
  ok(isPeriodAllowed({ age: 16, safe_mode: 0, role_title: '同班同学' }) === false, '⑦拦：生产 id=3 形态（age16 恋人 safe_mode0 同班同学）');
  ok(isPeriodAllowed(null) === false && isPeriodAllowed(undefined) === false, '⑦拦：空 companion');
}

// ── ⑧ onset 只建档案、零情绪副作用（边界确认：life_state 不碰 arc/emotion）──
{
  const lsSrc = readFileSync(new URL('../src/life_state.mjs', import.meta.url), 'utf8');
  const importLines = lsSrc.split('\n').filter(l => /^import /.test(l)).join('\n');
  ok(!/from '\.\/(emotion_state|relationship_arc|companion)/.test(importLines), '⑧life_state 零 import 情绪/arc 模块（onset 不触发情绪=L3 边界）');
  ok(lsSrc.includes('isPeriodAllowed(companion)') && lsSrc.includes("kind: 'period'"), '⑧onset 经成年门控后才 insert period');
}

console.log(`\nlife_state_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
