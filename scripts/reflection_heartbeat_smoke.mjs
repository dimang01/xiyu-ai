/**
 * reflection_heartbeat_smoke —— 把 reflection 批产出心跳的 emit↔parse 契约钉死（2026-06-12）。
 *
 * 缘起：插桩当天，digest 端正则误带一个前缀 `\[` → 静默不匹配 → "永远无心跳"假警报。
 * 监控自己制造盲区是最讽刺的 bug，故 round-trip 锁死：plan_tasks 写出的格式，
 * arc-digest 必须能解析回原值。格式漂移(改了 emit 忘改 parse 或反之)立即变红。
 */
import {
  formatReflectionRollup, parseReflectionRollup,
  formatReflectRejectMapping, formatReflectInsertFail, parseReflectReject,
} from '../src/reflection_heartbeat.mjs';

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

// ── ② reject 分级：两条拒绝路径 emit↔parse，digest 据此打不同颜色（预期 🟡 vs 真 bug 🔴）──
// 06-14 取证：8 条蒸发全是 mapping 拒绝（relationship_rule，设计内可见拒绝），零 insert 失败；
// 若 digest 把两者混为一个 🔴 = 狼来了，每早预期拒绝的虚惊会淹没真 CHECK 失败。
const mapLine = `[2026-06-13T18:15:56.280Z] [WARN] ${formatReflectRejectMapping(3, 'relationship_rule')}`;
const mapR = parseReflectReject(mapLine);
ok(mapR && mapR.kind === 'mapping' && mapR.layer === 'relationship_rule' && mapR.companionId === 3,
  `mapping 拒绝往返（实得 kind=${mapR?.kind}/layer=${mapR?.layer}）—— digest 打 🟡 预期·非蒸发`);

const failLine = `[2026-06-12T18:16:01.777Z] [WARN] ${formatReflectInsertFail(12, 'CHECK constraint failed: memory_type IN (...)')}`;
const failR = parseReflectReject(failLine);
ok(failR && failR.kind === 'insert_fail' && failR.companionId === 12 && /CHECK/.test(failR.msg),
  `insert 失败往返（实得 kind=${failR?.kind}/msg 含 CHECK=${failR ? /CHECK/.test(failR.msg) : false}）—— digest 打 🔴 查约束`);

// ── 红验：两路径不互相误判 + 无关行返回 null ──
ok(parseReflectReject(mapLine)?.kind !== 'insert_fail', '红验：mapping 行不被误判为 insert 失败');
ok(parseReflectReject(failLine)?.kind !== 'mapping', '红验：insert 失败行不被误判为 mapping');
ok(parseReflectReject('[INFO] [Reflection] companion=3 candidates=3 inserted=2 ...') === null, '红验：正常产出行不被误判为 reject');

console.log(`\nreflection_heartbeat_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
