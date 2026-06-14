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

// ── reject 两路径的单一格式源（2026-06-14·② 修）──
// 公理同上：reflection 写 reject 的 WARN、arc-digest 读它做「分级」（预期 🟡 vs 真 bug 🔴），
// 两头共享格式防漂移。两条路径**语义完全不同**，digest 绝不能混为一个 🔴（狼来了埋掉真 bug）：
//   · mapping ：layer 无边界映射（如 relationship_rule）→ 设计内可见拒绝、预期·非蒸发（待 v1.23）
//   · insert_fail：addOrMergeMemory/saveMemory 真抛错（如 CHECK 约束）→ 记忆在蒸发，必须查约束原因

/** layer 无边界映射的拒绝（预期）。reflection.mjs 用它写 WARN，arc-digest 用 parseReflectReject 读。 */
export function formatReflectRejectMapping(companionId, layer) {
  return `[Reflection] 跳过无边界映射的层 companion=${companionId} layer=${layer}`
    + `（如 relationship_rule，待 v1.23 情绪建构包决定是否开正式类型）`;
}

/** insert 真抛错（CHECK/约束等）。语义=记忆在蒸发，与 mapping 拒绝严格分开。 */
export function formatReflectInsertFail(companionId, msg) {
  return `[Reflection] insert 失败 companion=${companionId}: ${msg}`;
}

/** 解析一行 reflection reject 日志 → { kind:'mapping'|'insert_fail', companionId, layer?/msg? }，非 reject 行返回 null。 */
export function parseReflectReject(line) {
  let m = String(line).match(/\[Reflection\] 跳过无边界映射的层 companion=(\d+) layer=(\w+)/);
  if (m) return { kind: 'mapping', companionId: +m[1], layer: m[2] };
  m = String(line).match(/\[Reflection\] insert 失败 companion=(\d+): (.*)$/);
  if (m) return { kind: 'insert_fail', companionId: +m[1], msg: m[2] };
  return null;
}
