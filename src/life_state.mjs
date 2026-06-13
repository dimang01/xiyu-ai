// ════════════════════════════════════════════════════════════════════════════
// src/life_state.mjs —— v1.22 life_state 身体状态引擎（PR-L1：通用引擎）。
// 设计：docs/LIFE_STATE_DESIGN.md。
//
// 本 PR 只做「通用引擎 + 数据层接线」：生命周期 tick（确定性推进 phase / 到点 resolve）
// 与 kind 谱系框架。**不含** 生理期 kind 的周期锚点 onset / 披露深度 / 情绪路由
// （= PR-L2/L3），也不含偶发 kind 的 onset（本 PR 引擎只推进/归档已存在的档案，
// 生产中档案要等 L2 的 period 周期锚点 / minor_illness 对话触发建档(backlog) 才产生）。
//
// 与 current_works / relationship_arc 同范式：纯函数（tick 零 IO 可单测）+ IO 协调层
// （refreshLifeState 搭 00:30 日程批便车，不新增定时器）。fail-open，绝不阻断主链路。
// ════════════════════════════════════════════════════════════════════════════

import { log } from './logger.mjs';
import { getActiveLifeStates, setLifeStatePhase, resolveLifeState } from './db.mjs';

/**
 * kind 谱系配置（声明式；新增 kind 只加一条）。设计 §2.3。
 * - phases：阶段序列（确定性推进，跨段才写库）。
 * - category：#317 四档 gate 的诊断类别归属（moderation 侧 KIND_TO_CATEGORY 同源——
 *   两处都引用「kind→诊断类别」，改一处务必同步另一处，见 moderation.mjs 注释）。
 * - adultOnly：仅成年 companion 可挂载（period=true，批注①；L2 在 onset 处硬做门控，
 *   引擎本身不 onset，故此标志是给 L2/审计读的元数据）。
 */
export const LIFE_KIND_CONFIG = {
  // period 的周期锚点 / onset / 披露 = PR-L2；此处只登记阶段框架供引擎推进。
  period:        { phases: ['premenstrual', 'menstrual', 'recovering'], category: 'period',  adultOnly: true },
  minor_illness: { phases: ['onset', 'peak', 'recovering'],             category: 'illness', adultOnly: false },
  injury:        { phases: ['onset', 'peak', 'recovering'],             category: 'injury',  adultOnly: false },
};

/**
 * 确定性阶段推进：按「在档时长 / 总病程」落到 phases 的哪一段（单调、跨段才写）。
 * 本 PR 用均匀分段（实现简单且确定）；L2 可为 period 覆盖按真实经前/经期天数分段。
 * 返回 null = 未知 kind（防御）。
 */
export function phaseForElapsed(kind, startedAtMs, expectedEndMs, nowMs) {
  const cfg = LIFE_KIND_CONFIG[kind];
  if (!cfg) return null;
  const phases = cfg.phases;
  const total = expectedEndMs - startedAtMs;
  if (!(total > 0)) return phases[0];
  const ratio = Math.max(0, Math.min(0.999999, (nowMs - startedAtMs) / total));
  const idx = Math.min(phases.length - 1, Math.floor(ratio * phases.length));
  return phases[idx];
}

/**
 * 纯函数 tick：给定 active 档案数组 + now，算出每条该推进到的 phase / 该 resolve 的 id。
 * 零 IO，可单测（设计 §5.1）。返回 { advance:[{id,phase}], resolve:[id] }。
 */
export function tickLifeState(states, nowMs = Date.now()) {
  const advance = [];
  const resolve = [];
  for (const s of (Array.isArray(states) ? states : [])) {
    if (!s || s.status !== 'active') continue;
    const startedMs = Date.parse(s.started_at);
    const endMs = s.expected_end_at ? Date.parse(s.expected_end_at) : NaN;
    // 到点结束：康复基线是常态（健康才是默认，§2.2）——period 的 next_onset 续期 = L2。
    if (Number.isFinite(endMs) && nowMs >= endMs) { resolve.push(s.id); continue; }
    if (Number.isFinite(startedMs) && Number.isFinite(endMs)) {
      const want = phaseForElapsed(s.kind, startedMs, endMs, nowMs);
      if (want && want !== s.phase) advance.push({ id: s.id, phase: want });
    }
  }
  return { advance, resolve };
}

/**
 * IO 协调：推进 / 归档 active 档案（搭 00:30 日程批便车，plan_tasks 调）。
 * 本 PR 不含 onset——故无 active 档案时是 no-op（直到 L2 产生 period 档案）。
 * fail-open：任何异常只 warn，不阻断日程批。
 */
export function refreshLifeState(companionId, nowMs = Date.now()) {
  try {
    const states = getActiveLifeStates(companionId);
    if (!states.length) return { advanced: 0, resolved: 0 };
    const { advance, resolve } = tickLifeState(states, nowMs);
    for (const a of advance) setLifeStatePhase(a.id, a.phase);
    for (const id of resolve) resolveLifeState(id);
    if (advance.length || resolve.length)
      log('info', `[LifeState] companion=${companionId} advanced=${advance.length} resolved=${resolve.length}`);
    return { advanced: advance.length, resolved: resolve.length };
  } catch (e) {
    log('warn', `[LifeState] refresh 异常 companion=${companionId}: ${e?.message || e}`);
    return { advanced: 0, resolved: 0, error: true };
  }
}
