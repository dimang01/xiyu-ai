/**
 * proactive_heartbeat —— deadman 三桶「cycle 心跳」行的写/读单一格式源（纯函数，零依赖）。
 *
 * 公理（承 reflection_heartbeat）：批管线必须有正向心跳行；该行由 proactive_deadman 写(emit)、
 * arc-digest 读(parse)。两头共享同一处格式防 regex 漂移——否则心跳静默退化成「永远无心跳」
 * 假警报（监控自造盲区=最讽刺的 bug）。proactive_heartbeat_smoke 用 round-trip 钉死契约。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

/** 三桶分桶快照 → cycle 心跳行核心串（proactive_deadman 再前缀 `[Deadman] `）。 */
export function formatDeadmanCycle(s) {
  const age = s.tickAgeMs == null ? 'null' : Math.round(s.tickAgeMs);
  let by;
  try { by = JSON.stringify(s.restrainedBy || {}); } catch { by = '{}'; }
  // quiet=1 = 夜间静默期（沪 23–9）心跳：活体证明照写，但 sent=0 不计 strike、不告警。
  // 字段插在 restrainedBy（末位贪婪 JSON）之前，保持 restrainedBy 始终是行尾锚点。
  return `cycle active=${s.active | 0} sent=${s.sent | 0} restrained=${s.restrained | 0}`
    + ` errored=${s.errored | 0} bucket=${s.bucket} strikes=${s.strikes | 0}`
    + ` tickAgeMs=${age} quiet=${s.quiet ? 1 : 0} restrainedBy=${by}`;
}

// quiet=([01]) 设为可选组：兼容 2026-06-14 C 修之前的旧行（无 quiet 字段，且旧行只在白天写=quiet0）。
export const DEADMAN_CYCLE_RE =
  /cycle active=(\d+) sent=(\d+) restrained=(\d+) errored=(\d+) bucket=(\w+) strikes=(\d+) tickAgeMs=(\d+|null)(?: quiet=([01]))? restrainedBy=(\{.*\})\s*$/;

/** 从一行日志解析 cycle 心跳；非心跳行返回 null。 */
export function parseDeadmanCycle(line) {
  const m = String(line).match(DEADMAN_CYCLE_RE);
  if (!m) return null;
  let restrainedBy;
  try { restrainedBy = JSON.parse(m[9]) || {}; } catch { restrainedBy = {}; }
  return {
    active: +m[1], sent: +m[2], restrained: +m[3], errored: +m[4],
    bucket: m[5], strikes: +m[6],
    tickAgeMs: m[7] === 'null' ? null : +m[7],
    quiet: m[8] === '1',          // 旧行无此组 → undefined → false（旧行皆白天 quiet0）
    restrainedBy,
  };
}
