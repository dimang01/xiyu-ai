/**
 * retention_board_smoke —— 真实留存看板「口径」纯函数红验（PR-0，2026-06-14）。
 *
 * 看板的数字会被维护者当北极星仪表 + 实验对照基线，口径一旦悄悄漂移、决策就建在沙上。
 * 故把切分/留存/proactive/break 的口径用 round-trip fixture 钉死：留存窗口算错、proactive
 * 误判成回复、复读漏检都立即变红。纯函数，不碰 DB。
 */
import {
  shDate, addDays, computeRetention, isProactive, findProactive,
  proactiveStats, returnTouchpoints, findHardBreaks,
} from './retention-board.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };
// fixture 用 UTC 小时 <16，保证 +8h 后沪日期 == dateStr（否则像 20:00Z 会滚到沪次日，制造假 bug）。
const ms = (dateStr, hh = 12, mm = 0, ss = 0) => Date.parse(`${dateStr}T00:00:00Z`) + (hh * 3600 + mm * 60 + ss) * 1000;

// ── 时区切分：UTC 23:30 → 沪次日 ──
ok(shDate(Date.parse('2026-06-10T23:30:00Z')) === '2026-06-11', '沪时区日界：UTC23:30→沪次日');
ok(addDays('2026-06-10', 2) === '2026-06-12', 'addDays +2');

// ── 留存：Day0/Day1/Day2/Day7 ──
const r3 = computeRetention([ms('2026-06-10', 10), ms('2026-06-11', 7), ms('2026-06-12', 9)], '2026-06-14');
ok(r3.day0 === '2026-06-10' && r3.activeDays === 3, '连 3 天：Day0/活跃天数');
ok(r3.day1 && r3.day2 && r3.day7 && r3.ret2, '连 3 天：D1/D2/D7/ret2 全真');
ok(r3.lastDate === '2026-06-12' && r3.daysSinceLast === 2, '末次/距今');

const r1 = computeRetention([ms('2026-06-05', 10), ms('2026-06-05', 11)], '2026-06-14');  // 同日两条
ok(r1.activeDays === 1 && !r1.day1 && !r1.ret2 && r1.day7 === false, '单日(同日两条)：活跃1天·无回访');

const r7 = computeRetention([ms('2026-06-01', 12), ms('2026-06-06', 12)], '2026-06-14');   // Day0 + Day0+5
ok(!r7.day1 && !r7.day2 && r7.day7 && r7.ret2, 'Day0+5 回来：D1/D2 假但 D7/ret2 真');

ok(computeRetention([], '2026-06-14') === null, '无真实 user 消息 → null(不计真实用户)');

// ── proactive 判定：同 ts 有/无配对 user ──
const T = ms('2026-06-10', 9);
const reply = { role: 'assistant', syn: 0, ts: T, content: 'a' };
const userAtT = { role: 'user', syn: 0, ts: T, content: 'q' };
const standalone = { role: 'assistant', syn: 0, ts: ms('2026-06-10', 7), content: '早呀', topic: '早安' };
const turnsP = [userAtT, reply, standalone];
ok(!isProactive(reply, turnsP), 'reply(同 ts 有 user)→ 非 proactive');
ok(isProactive(standalone, turnsP), 'standalone(同 ts 无 user)→ proactive');
ok(findProactive(turnsP).length === 1, 'findProactive 只数 standalone');
ok(!isProactive({ role: 'assistant', syn: 1, ts: T + 1, content: 'x' }, turnsP), 'synthetic assistant 不算 proactive');

// ── proactive 效果：60min 回复 / 24h 零回复 / 连发 run ──
const pf = [
  { role: 'assistant', syn: 0, ts: ms('2026-06-10', 9), content: 'p1' },            // 30min 后有 user → reply60
  { role: 'user', syn: 0, ts: ms('2026-06-10', 9, 30), content: 'u1' },
  { role: 'assistant', syn: 0, ts: ms('2026-06-11', 9), content: 'p2' },            // 连发 run 起
  { role: 'assistant', syn: 0, ts: ms('2026-06-11', 12), content: 'p3' },           // 连发(无 user)→ blindRun
];
const ps = proactiveStats(pf);
ok(ps.total === 3, 'proactive total=3');
ok(ps.reply60 === 1, '60min 回复=1（p1）');
ok(ps.zero24h === 2, '24h 零回复=2（p2/p3，其后无 user）');
ok(ps.blindRuns === 1, '连续≥2 proactive 没回 run=1');

// ── 回来接力：return 首句往前找 bot 触点 ──
const tp = [
  { role: 'user', syn: 0, ts: ms('2026-06-10', 12), content: 'day0' },
  { role: 'assistant', syn: 0, ts: ms('2026-06-11', 7), content: '早呀', topic: '早安' },   // 次日 proactive 早安
  { role: 'user', syn: 0, ts: ms('2026-06-11', 7, 5), content: '好困' },                    // 回来首句
];
const ret = computeRetention(tp.filter(t => t.role === 'user' && !t.syn).map(t => t.ts), '2026-06-14');
const tps = returnTouchpoints(tp, ret);
ok(tps.length === 1 && tps[0].date === '2026-06-11', '识别 1 次回来(06-11)');
ok(tps[0].label.includes('早安') && tps[0].gapMin === 5, '回来由「早安」接回·gap 5min');

// ── hard break：复读高精度 + 凭空进食候选 ──
const hb = [
  { role: 'assistant', syn: 0, ts: ms('2026-06-13', 21), content: '那你可得带齐东西，帐篷睡袋啥的，别到时候手忙脚乱' },
  { role: 'user', syn: 0, ts: ms('2026-06-13', 21, 5), content: '知道了' },
  { role: 'assistant', syn: 0, ts: ms('2026-06-13', 22), content: '那你可得带齐东西，帐篷睡袋啥的，别到时候手忙脚乱' }, // 复读
  { role: 'assistant', syn: 0, ts: ms('2026-06-13', 23), content: '刚吃完麻辣香锅回来，撑得不想动' },                  // 凭空进食候选
];
const breaks = findHardBreaks(hb);
ok(breaks.some(b => b.kind === '复读'), '复读被检出(近重复 assistant)');
ok(breaks.some(b => b.kind === '凭空进食'), '凭空进食候选被检出');
ok(breaks.find(b => b.kind === '凭空进食').silent60 === true, '凭空进食后 60min 无 user → silent60');
// 红验：不重复的正常对话不误报复读
const hbClean = [
  { role: 'assistant', syn: 0, ts: ms('2026-06-13', 9), content: '今天天气不错呀，你那边呢' },
  { role: 'assistant', syn: 0, ts: ms('2026-06-13', 10), content: '我刚画完一张画，有点小成就感' },
];
ok(findHardBreaks(hbClean).length === 0, '红验：不同内容不误报复读');

console.log(`\nretention_board_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
