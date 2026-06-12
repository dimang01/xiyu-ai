/**
 * reflection_heartbeat_smoke —— 把 reflection 批产出心跳的 emit↔parse 契约钉死（2026-06-12）。
 *
 * 缘起：插桩当天，digest 端正则误带一个前缀 `\[` → 静默不匹配 → "永远无心跳"假警报。
 * 监控自己制造盲区是最讽刺的 bug，故 round-trip 锁死：plan_tasks 写出的格式，
 * arc-digest 必须能解析回原值。格式漂移(改了 emit 忘改 parse 或反之)立即变红。
 */
import { formatReflectionRollup, parseReflectionRollup } from '../src/reflection_heartbeat.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

// ── round-trip：emit 的串必须被 parse 完整还原 ──
const t = { candidates: 13, inserted: 10, merged: 1, rejected: 2, updated: 0 };
const line = `[2026-06-12T18:15:00.000Z] [INFO] [PlanTasks] ${formatReflectionRollup('daily', '2026-06-12', '3/10', t)}`;
const r = parseReflectionRollup(line);
ok(r !== null, 'emit 出的心跳行能被 parse 匹配（防前缀/分隔符漂移）');
ok(r && r.kind === 'daily', `kind=daily（实得 ${r?.kind}）`);
ok(r && r.date === '2026-06-12', `date 还原（实得 ${r?.date}）`);
ok(r && r.ran === '3/10', `ran 还原（实得 ${r?.ran}）`);
ok(r && r.candidates === 13 && r.inserted === 10 && r.merged === 1 && r.rejected === 2 && r.updated === 0,
  `五计数全还原（实得 c${r?.candidates}/i${r?.inserted}/m${r?.merged}/rej${r?.rejected}/u${r?.updated}）`);

// ── weekly 同样可解析 ──
const wLine = `[PlanTasks] ${formatReflectionRollup('weekly', '2026-06-07', '2/9', { candidates: 5, inserted: 5, merged: 0, rejected: 0, updated: 1 })}`;
ok(parseReflectionRollup(wLine)?.kind === 'weekly', 'weekly 心跳可解析');

// ── 红验：非心跳行不得误匹配 ──
ok(parseReflectionRollup('[PlanTasks] daily-reflection start date=2026-06-12 companions=10') === null,
  '红验：start 行（无 done/计数）不被误判为心跳');
ok(parseReflectionRollup('[INFO] some unrelated log line') === null, '红验：无关行返回 null');

// ── rejected>0 是「有产出在蒸发」的信号，必须能被读出来供 digest 告警 ──
ok(parseReflectionRollup(line).rejected === 2, '红验：rejected 计数被读出（digest 据此报蒸发）');

console.log(`\nreflection_heartbeat_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
