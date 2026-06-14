/**
 * proactive_heartbeat_smoke —— deadman cycle 心跳的 emit↔parse 契约 round-trip（2026-06-13）。
 *
 * 承 reflection 教训：格式漂移会让心跳静默退化成"永远无心跳"假警报（监控自造盲区=最讽刺的 bug）。
 * formatDeadmanCycle 写出的串，parseDeadmanCycle 必须完整还原；改了一头忘改另一头立即变红。
 */
import { formatDeadmanCycle, parseDeadmanCycle } from '../src/proactive_heartbeat.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

// ── round-trip：emit 的串（带真实日志前缀）必须被 parse 完整还原 ──
const snap = { active: 1, sent: 0, restrained: 4, errored: 0, bucket: 'restrained', strikes: 0, tickAgeMs: 120000, quiet: false, restrainedBy: { 5: { v2_deny: 3, safety: 1 } } };
const line = `[2026-06-13T10:00:00.000Z] [INFO] [Deadman] ${formatDeadmanCycle(snap)}`;
const r = parseDeadmanCycle(line);
ok(r !== null, 'emit 出的 cycle 行能被 parse（防前缀/分隔符漂移）');
ok(r && r.active === 1 && r.sent === 0 && r.restrained === 4 && r.errored === 0, `四桶数还原（实得 a${r?.active}/s${r?.sent}/r${r?.restrained}/e${r?.errored}）`);
ok(r && r.bucket === 'restrained' && r.strikes === 0, `bucket/strikes 还原（实得 ${r?.bucket}/${r?.strikes}）`);
ok(r && r.tickAgeMs === 120000, `tickAgeMs 还原（实得 ${r?.tickAgeMs}）`);
ok(r && r.quiet === false, `quiet 还原（白天=false，实得 ${r?.quiet}）`);
ok(r && r.restrainedBy['5'].v2_deny === 3 && r.restrainedBy['5'].safety === 1, 'per-companion 克制细分还原（digest 🟡 据此印"谁·为何"）');

// ── C 修红验：夜间 quiet=1 心跳必须往返（活体证明照写，digest 不再误报"无心跳"）──
const snapQ = { active: 0, sent: 0, restrained: 0, errored: 0, bucket: 'quiet', strikes: 1, tickAgeMs: 5000, quiet: true, restrainedBy: {} };
const lineQ = `[2026-06-14T01:50:51.000Z] [INFO] [Deadman] ${formatDeadmanCycle(snapQ)}`;
ok(lineQ.includes('quiet=1'), 'emit：夜间心跳串带 quiet=1（活体证明照写）');
const rQ = parseDeadmanCycle(lineQ);
ok(rQ && rQ.quiet === true && rQ.bucket === 'quiet', `夜间 quiet=1 往返（实得 quiet=${rQ?.quiet}/bucket=${rQ?.bucket}）`);

// ── 向后兼容红验：C 修之前的旧行（无 quiet 字段）仍能解析（按白天 quiet=false）──
const oldLine = '[2026-06-13T14:50:51.441Z] [INFO] [Deadman] cycle active=2 sent=1 restrained=34 errored=0 bucket=sent strikes=0 tickAgeMs=6 restrainedBy={"3":{"v2_deny":8}}';
const rOld = parseDeadmanCycle(oldLine);
ok(rOld !== null && rOld.active === 2 && rOld.bucket === 'sent', '向后兼容：旧无-quiet 行仍解析（digest 读 bot.log.1 的轮转旧行不漏）');
ok(rOld && rOld.quiet === false && rOld.restrainedBy['3'].v2_deny === 8, '向后兼容：旧行 quiet 缺省=false、restrainedBy 仍还原');

// ── tickAgeMs=null（心跳从未写入）也能往返 ──
const snap2 = { active: 1, sent: 0, restrained: 0, errored: 0, bucket: 'tick_dead', strikes: 2, tickAgeMs: null, restrainedBy: {} };
const r2 = parseDeadmanCycle(`[Deadman] ${formatDeadmanCycle(snap2)}`);
ok(r2 && r2.tickAgeMs === null && r2.bucket === 'tick_dead', `tickAgeMs=null（心跳从未写入）往返（实得 ${r2?.tickAgeMs}/${r2?.bucket}）`);

// ── 红验：非心跳行不误匹配 ──
ok(parseDeadmanCycle('[Deadman] ★ CRITICAL：proactive tick 心跳停摆') === null, '红验：CRITICAL 行不被误判为心跳');
ok(parseDeadmanCycle('[INFO] some unrelated log line') === null, '红验：无关行返回 null');

// ── errored>0 必须被读出（digest 据此标 🔴，即便 bucket=sent 也别让"一次成功"遮报错）──
const snap3 = { active: 1, sent: 1, restrained: 0, errored: 2, bucket: 'sent', strikes: 0, tickAgeMs: 0, restrainedBy: {} };
ok(parseDeadmanCycle(`[Deadman] ${formatDeadmanCycle(snap3)}`).errored === 2, '红验：sent 窗的 errored 计数被读出（digest 标 🔴）');

console.log(`\nproactive_heartbeat_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
