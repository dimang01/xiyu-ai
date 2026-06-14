/**
 * digest_log_rotation_smoke —— digest 轮转感知日志读取的集成红验（2026-06-14·B 修）。
 *
 * 教训（06-14 晨 digest 假警报·承本 PR ③）：心跳类测试只锁 emit↔parse 单元契约**不够**——
 * 本案契约没坏（cycle 行格式完美），漏的是**集成路径**：夜间 skip + 日志轮转 + 扫描窗口三者
 * 叠加，让早上跑的 digest 扫不到昨天白天写进 bot.log.1 的 cycle 行 → 误报"无心跳"。
 * 本 smoke 就钉这条集成路径：iterLogLines 必须跨 bot.log + bot.log.1 + .gz 读，按时间窗过滤，
 * 让跨午夜的白天行重新可见；并验 reject 分级能在真读到的行上判对路径。
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { iterLogLines, logFileCandidates } from './digest_log_sources.mjs';
import { parseDeadmanCycle } from '../src/proactive_heartbeat.mjs';
import { parseReflectReject } from '../src/reflection_heartbeat.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

const dir = mkdtempSync(path.join(tmpdir(), 'xiyu-digest-rot-'));
const LOG = path.join(dir, 'bot.log');
const iso = (ms) => new Date(ms).toISOString();
const now = Date.parse('2026-06-14T01:01:00.000Z');   // 沪 09:01——正是误报现场的时刻
const H = 3600e3;

try {
  // 当前 bot.log：沪午夜后（夜间窗）——只有 quiet=1 心跳，无白天判定行（复刻误报现场）。
  writeFileSync(LOG, [
    `[${iso(now - 1 * H)}] [INFO] [Deadman] cycle active=0 sent=0 restrained=0 errored=0 bucket=quiet strikes=0 tickAgeMs=5000 quiet=1 restrainedBy={}`,
    `[${iso(now - 0.2 * H)}] [INFO] [iLink] getUpdates success received=0`,
  ].join('\n') + '\n');

  // bot.log.1（轮转·未压缩）：昨天白天的判定行——含一条旧格式（无 quiet 字段，向后兼容）+ 一条 reject。
  writeFileSync(`${LOG}.1`, [
    `[${iso(now - 12 * H)}] [INFO] [Deadman] cycle active=2 sent=1 restrained=34 errored=0 bucket=sent strikes=0 tickAgeMs=6 restrainedBy={"3":{"v2_deny":8}}`,
    `[${iso(now - 11 * H)}] [WARN] [Reflection] 跳过无边界映射的层 companion=3 layer=relationship_rule（如 relationship_rule，待 v1.23 情绪建构包决定是否开正式类型）`,
  ].join('\n') + '\n');

  // bot.log.2.gz（更老·gzip）：再前一天的白天行 + 一条窗外（应被 sinceMs 丢弃）。
  writeFileSync(`${LOG}.2.gz`, gzipSync([
    `[${iso(now - 20 * H)}] [INFO] [Deadman] cycle active=1 sent=0 restrained=2 errored=1 bucket=error strikes=1 tickAgeMs=3 quiet=0 restrainedBy={"7":{"throttled":2}}`,
    `[${iso(now - 60 * H)}] [INFO] [Deadman] cycle active=9 sent=9 restrained=0 errored=0 bucket=sent strikes=0 tickAgeMs=1 quiet=0 restrainedBy={}`,   // 窗外（>1 天）
  ].join('\n') + '\n'));

  // ── 候选文件枚举：旧→新（让 push 出的数组时间升序）──
  const cands = logFileCandidates(LOG);
  ok(cands.length === 3, `枚举到 3 个日志件（实得 ${cands.length}）`);
  ok(cands[0].endsWith('.2.gz') && cands[2].endsWith('bot.log'), '排序旧→新（.gz 在前、当前 bot.log 在后）');

  // ── 跨轮转读 cycle 行：DAYS=1 窗口内，三类来源都应读到，窗外行被丢 ──
  // 直接喂固定 sinceMs 调真 iterLogLines（不复刻逻辑，才是 ③ 要的"测真集成路径"）。
  const sinceMs = now - 1 * 86400e3;
  const cycles = [];
  const rejects = [];
  for await (const { line } of iterLogLines(LOG, sinceMs)) {
    const c = parseDeadmanCycle(line);
    if (c) { cycles.push(c); continue; }
    const rej = parseReflectReject(line);
    if (rej) rejects.push(rej);
  }

  // 期望读到 3 条 cycle（当前 quiet + bot.log.1 旧格式白天 + .gz error 白天），窗外那条被丢。
  ok(cycles.length === 3, `跨 bot.log+bot.log.1+.gz 读到 3 条窗内 cycle（实得 ${cycles.length}）—— B 修：早上不再漏昨天白天行`);
  ok(cycles.some(c => c.quiet === true && c.bucket === 'quiet'), '读到当前 bot.log 的夜间 quiet=1 心跳');
  ok(cycles.some(c => c.bucket === 'sent' && c.quiet === false), '读到 bot.log.1 的旧格式白天行（向后兼容·无 quiet 字段→false）');
  ok(cycles.some(c => c.bucket === 'error' && c.errored === 1), '读到 .gz 里的白天 error 周期（gunzip 流式解压通）');
  ok(!cycles.some(c => c.active === 9), '窗外行（>1 天，active=9）被 sinceMs 丢弃');

  // ── reject 分级：真读到的 mapping 行被判为 mapping（digest 据此打 🟡 而非 🔴）──
  ok(rejects.length === 1 && rejects[0].kind === 'mapping' && rejects[0].layer === 'relationship_rule',
    `从轮转件读到 mapping reject 并判对路径（实得 ${rejects[0]?.kind}/${rejects[0]?.layer}）`);

  console.log(`\ndigest_log_rotation_smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
