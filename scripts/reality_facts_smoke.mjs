/**
 * reality_facts_smoke —— PR-W3 reality facts 红验（2026-06-13）。纯函数零网络。
 * 设计 §9：节气/农历节日天文计算准确 + 统一注入纪律（拿不到的字段绝不编造）。
 *
 * 红验：①节气 fixture(冬至/夏至/二分点/立春/清明,权威日期)②农历节日 fixture(春节/中秋/端午/
 *   重阳,含 2028 闰五月)③**注入纪律：无节气无节日的普通日，buildRealityFacts 白天=空，
 *   绝不凭空说节日**（reality facts 核心红线）④月相白天不注入夜才注入⑤life_state 预留槽。
 */
import { solarTermsOfYear, nextSolarTerm } from '../src/utils/solar_terms.mjs';
import { lunarFestivalsOfYear } from '../src/utils/lunar_festivals.mjs';
import { buildRealityFacts, festivalOnDate } from '../src/utils/reality_facts.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };
const D = (s) => new Date(s);

// ── ① 节气 fixture（权威公历日，上海时区）──
{
  const T = (y) => Object.fromEntries(solarTermsOfYear(y).map(t => [t.name, t.dateKey]));
  const t26 = T(2026), t27 = T(2027);
  const want26 = { 立春: '2026-02-04', 春分: '2026-03-20', 清明: '2026-04-05', 夏至: '2026-06-21', 秋分: '2026-09-23', 冬至: '2026-12-22' };
  for (const [n, d] of Object.entries(want26)) ok(t26[n] === d, `节气 2026 ${n}=${d}（算 ${t26[n]}）`);
  ok(t27['春分'] === '2027-03-21' && t27['冬至'] === '2027-12-22', '节气 2027 春分/冬至（跨年准确）');
  ok(solarTermsOfYear(2026).length === 24, '一年 24 节气');
}

// ── ② 农历节日 fixture（含 2028 闰五月——置闰算法）──
{
  const f26 = lunarFestivalsOfYear(2026);
  const w26 = { 春节: '2026-02-17', 元宵: '2026-03-03', 端午: '2026-06-19', 中秋: '2026-09-25', 重阳: '2026-10-18' };
  for (const [n, d] of Object.entries(w26)) ok(f26[n] === d, `农历 2026 ${n}=${d}（算 ${f26[n]}）`);
  const f28 = lunarFestivalsOfYear(2028);   // 2028 闰五月
  ok(f28['春节'] === '2028-01-26', '农历 2028 春节=01-26');
  ok(f28['端午'] === '2028-05-28' && f28['中秋'] === '2028-10-03', '农历 2028 端午/中秋（闰五月年置闰正确）');
}

// ── ③ 注入纪律红线：无节气无节日的普通日，白天=空（绝不编造节日）──
{
  // 2026-06-13 白天：非节气非节日 → 必空
  ok(buildRealityFacts(D('2026-06-13T04:00:00Z')) === '', '普通日白天 → 空注入（不凭空编节日，核心红线）');
  ok(festivalOnDate(D('2026-06-13T04:00:00Z')) === '', '普通日 festivalOnDate=空');
  // 节日/节气日 → 必提
  ok(buildRealityFacts(D('2026-12-22T04:00:00Z')).includes('冬至'), '冬至日注入含"冬至"');
  ok(buildRealityFacts(D('2026-02-17T04:00:00Z')).includes('春节'), '春节日注入含"春节"');
  ok(buildRealityFacts(D('2026-10-01T04:00:00Z')).includes('国庆节'), '国庆日注入含"国庆节"（公历固定）');
  // 注入段自带"绝不编造"纪律句
  ok(buildRealityFacts(D('2026-12-22T04:00:00Z')).includes('绝不') && buildRealityFacts(D('2026-12-22T04:00:00Z')).includes('凭空'),
     '注入段含"绝不凭空说节日"纪律句');
}

// ── ④ 月相白天不注入 / 夜注入 ──
{
  const dayFestival = buildRealityFacts(D('2026-12-22T04:00:00Z'), { includeNightSky: false });   // 冬至白天
  ok(dayFestival.includes('冬至') && !dayFestival.includes('月相'), '白天：有节气、无月相');
  const nightPlain = buildRealityFacts(D('2026-06-13T13:00:00Z'), { includeNightSky: true });       // 普通日夜
  ok(nightPlain.includes('月相'), '夜间：注入月相（即便无节气节日）');
}

// ── ⑤ life_state 预留槽：extraFacts 并列注入（v1.22 身体事实挂此）──
{
  const withBody = buildRealityFacts(D('2026-06-13T04:00:00Z'), { extraFacts: ['她这两天有点感冒，没什么力气'] });
  ok(withBody.includes('感冒') && withBody.includes('真实世界'), 'extraFacts 槽位生效（life_state 未来挂此）');
  const src = (await import('node:fs')).readFileSync(new URL('../src/utils/reality_facts.mjs', import.meta.url), 'utf8');
  ok(src.includes('life_state 预留位') && src.includes('extraFacts'), 'reality_facts 注释标明 life_state 预留位');
}

// ── 临近提示 ──
{
  ok(/快到冬至/.test(buildRealityFacts(D('2026-12-21T04:00:00Z'))), '冬至前1天："快到冬至"临近提示');
  const nx = nextSolarTerm(D('2026-06-13T04:00:00Z'));
  ok(nx && nx.name === '夏至' && nx.daysUntil > 0, `nextSolarTerm 6/13→夏至（还 ${nx?.daysUntil} 天）`);
}

console.log(`\nreality_facts_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
