/**
 * reflection_heartbeat —— reflection 批产出「正向心跳」行的写/读单一格式源。
 *
 * 公理：没有报错 ≠ 有产出；批管线必须有产出统计行。该行由 plan_tasks 写(emit)、
 * arc-digest 读(parse)。两头共享同一处格式，防 regex 漂移——格式一改两头同步，
 * 否则心跳会静默退化成「永远无心跳」的假警报（监控自己制造盲区是最讽刺的 bug）。
 * reflection_heartbeat_smoke 用 round-trip 把这个契约钉死。
 */

/** 把批级计数拼成心跳行核心串（plan_tasks 再前缀 `[PlanTasks] `）。 */
export function formatReflectionRollup(kind, dateKey, ranStr, t) {
  return `${kind}-reflection done date=${dateKey} ran=${ranStr}`
    + ` candidates=${t.candidates} inserted=${t.inserted} merged=${t.merged} rejected=${t.rejected} updated=${t.updated}`;
}

export const REFLECTION_ROLLUP_RE =
  /(daily|weekly)-reflection done date=(\S+) ran=(\S+) candidates=(\d+) inserted=(\d+) merged=(\d+) rejected=(\d+) updated=(\d+)/;

/** 从一行日志解析心跳；非心跳行返回 null。 */
export function parseReflectionRollup(line) {
  const m = line.match(REFLECTION_ROLLUP_RE);
  if (!m) return null;
  return {
    kind: m[1], date: m[2], ran: m[3],
    candidates: +m[4], inserted: +m[5], merged: +m[6], rejected: +m[7], updated: +m[8],
  };
}
