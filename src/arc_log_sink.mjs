/**
 * arc_log_sink.mjs —— 冲突弧观察埋点的可注入 sink（v1.21.1 PR-B）。
 *
 * 为什么不直接 import db：埋点的源头卡口在 moderation.mjs（scrubConflictRedline
 * 命中时）和 relationship_arc.mjs（applyCrisisOverride 接管时）——前者是零依赖
 * 底层模块、后者有"纯函数零 IO"的架构约束。用注入解耦：本模块零依赖，
 * relationship_arc_runtime 加载时把 insertArcSignalLog 注册进来；单测/未注册时
 * sink 为空，纯函数行为不变。
 *
 * fail-open 铁律：埋点抛任何错都只打日志，绝不阻断回复链路（有 smoke 盯防）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

let _sink = null;

/** runtime 启动时注册真实写库函数；测试可注册 spy/抛错函数验证 fail-open */
export function setArcLogSink(fn) {
  _sink = typeof fn === 'function' ? fn : null;
}

/** 埋点入口：吞掉一切异常（fail-open），companionId 缺失时静默跳过 */
export function arcLog(companionId, row) {
  if (!_sink || !companionId) return;
  try {
    _sink(companionId, row);
  } catch (e) {
    try { console.warn(`[ArcLogSink] 埋点失败（已忽略，不阻断回复）: ${e?.message}`); } catch { /* 连 console 都不信 */ }
  }
}
