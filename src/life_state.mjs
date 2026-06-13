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
import { getActiveLifeStates, setLifeStatePhase, resolveLifeState, insertLifeState } from './db.mjs';

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

// ════════════════════════════════════════════════════════════════════════════
// PR-L2: 生理期 kind —— 成年门控 + 周期锚点（设计 §3.1 / §3.4②·批注①）。
// **不动 arc**：onset 只建档案，零情绪副作用（情绪路由=PR-L3）。
// ════════════════════════════════════════════════════════════════════════════

export const PERIOD_ADULT_MIN_AGE = 18;
// 低龄/校园未成年设定（结构化字段兜底；刻意不含"大学/同班同学"等成年也成立的词，避免误伤成年大学生）。
const LOW_AGE_SCHOOL_RE = /(初中|高中|中学生|初中生|高中生|高一|高二|高三|初一|初二|初三|未成年|高中部|初中部|青少年|中学部)/;

/**
 * 成年门控（批注①·创建页年龄闸 backlog 前 period 不被滥用的**唯一防线**）：
 * **运行时闸**——onset/注入/披露每个触点查实时 companion，任一成立 → period 全程零出现。
 * 既挡新建、又挡存量（生产实测 id=3 age16 已进恋人 safe_mode=0；查实时 age 天然覆盖，
 * 无需单独存量迁移——L1 从未 onset period，没有存量 period 档案）。
 */
export function isPeriodAllowed(companion) {
  if (!companion || typeof companion !== 'object') return false;
  if (Number(companion.safe_mode)) return false;                          // safe_mode 未成年保护开
  const age = Number(companion.age);
  if (!Number.isFinite(age) || age < PERIOD_ADULT_MIN_AGE || age <= 0) return false;  // age<18 / 缺失 / 异常
  const persona = `${companion.role_title || ''} ${companion.personality_tags || ''}`;
  if (LOW_AGE_SCHOOL_RE.test(persona)) return false;                      // 低龄校园设定
  return true;
}

// 周期参数（全 env 可调；个体固定 + 相位分散，确定性派生自 companion id——同 id 永远同周期/
// 同相位=个体固定，不同 id 相位错开=**防 13 同步**；无需存随机数、无需改 companions schema）。
const PERIOD_CYCLE_MIN = Math.max(20, Number(process.env.LIFE_PERIOD_CYCLE_MIN || 26));
const PERIOD_CYCLE_MAX = Math.max(PERIOD_CYCLE_MIN, Number(process.env.LIFE_PERIOD_CYCLE_MAX || 32));
const PERIOD_DURATION_DAYS = Math.max(2, Number(process.env.LIFE_PERIOD_DURATION_DAYS || 5));
const PERIOD_PMS_DAYS = Math.max(1, Number(process.env.LIFE_PERIOD_PMS_DAYS || 2));
function _hash32(n, salt) {
  let h = (2166136261 ^ salt) >>> 0;
  let x = n >>> 0;
  for (let i = 0; i < 4; i++) { h = Math.imul(h ^ (x & 0xff), 16777619) >>> 0; x >>>= 8; }
  return h >>> 0;
}
/** companion 的固定周期长度 ∈ [min,max] + 相位偏移（防同步），确定性派生自 id。 */
export function periodCycleFor(companionId) {
  const id = Number(companionId) || 0;
  const span = PERIOD_CYCLE_MAX - PERIOD_CYCLE_MIN + 1;
  const cycleLength = PERIOD_CYCLE_MIN + (_hash32(id, 1) % span);
  const phaseOffset = _hash32(id, 2) % cycleLength;
  return { cycleLength, phaseOffset };
}
/** 今天在周期里的 dayIndex + 是否在 period 窗口（pms 前导 + 经期）+ 当前 phase。 */
export function periodWindowToday(companionId, nowMs = Date.now()) {
  const { cycleLength, phaseOffset } = periodCycleFor(companionId);
  const daysSinceEpoch = Math.floor(nowMs / 86400000);
  const dayIndex = (((daysSinceEpoch + phaseOffset) % cycleLength) + cycleLength) % cycleLength;
  const windowLen = PERIOD_PMS_DAYS + PERIOD_DURATION_DAYS;
  const active = dayIndex < windowLen;
  const phase = !active ? null
    : dayIndex < PERIOD_PMS_DAYS ? 'premenstrual'
      : dayIndex < PERIOD_PMS_DAYS + PERIOD_DURATION_DAYS - 1 ? 'menstrual'
        : 'recovering';
  return { active, phase, dayIndex, cycleLength, windowLen };
}
const _iso = (ms) => new Date(ms).toISOString();

/**
 * 确定性阶段推进：period 按真实经前/经期天数分段（与 periodWindowToday 同口径）；
 * 其余 kind 按「在档时长 / 总病程」均匀分段。返回 null = 未知 kind（防御）。
 */
export function phaseForElapsed(kind, startedAtMs, expectedEndMs, nowMs) {
  const cfg = LIFE_KIND_CONFIG[kind];
  if (!cfg) return null;
  if (kind === 'period') {
    const dayInWindow = Math.floor((nowMs - startedAtMs) / 86400000);
    if (dayInWindow < PERIOD_PMS_DAYS) return 'premenstrual';
    if (dayInWindow < PERIOD_PMS_DAYS + PERIOD_DURATION_DAYS - 1) return 'menstrual';
    return 'recovering';
  }
  const phases = cfg.phases;
  const total = expectedEndMs - startedAtMs;
  if (!(total > 0)) return phases[0];
  const ratio = Math.max(0, Math.min(0.999999, (nowMs - startedAtMs) / total));
  const idx = Math.min(phases.length - 1, Math.floor(ratio * phases.length));
  return phases[idx];
}

// 经期「最重子窗」天数（批注④：bodyLowEnergy 只在 menstrual 前 1-2 天，recovering 不强制）。
const PERIOD_HEAVY_DAYS = Math.max(1, Number(process.env.LIFE_PERIOD_HEAVY_DAYS || 2));

/**
 * PR-L3 本轮 period 上下文（批注③：一次 indexed 查询，bot.mjs 同喂 arc tick + emotion hint）。
 * @param companion companion 对象（取 safe_mode/age/role/personality 做 safeModeBlocked 双保险）或 id。
 * @returns null | { stateId, phase, severity, dayIndex, phaseDayIndex, heavyWindow,
 *                   disclosed, expectedEndAt, safeModeBlocked }
 *   - heavyWindow：menstrual 最重子窗（前 PERIOD_HEAVY_DAYS 天）——**调用方据此开 bodyLowEnergy，
 *     不需知道 pms 偏移**（批注④抽象）。safeModeBlocked 时强制 false（红线②情绪路由侧双保险）。
 */
export function getActivePeriodContext(companion, nowMs = Date.now()) {
  const companionId = (companion && typeof companion === 'object') ? companion.id : companion;
  if (companionId == null) return null;
  let p;
  try { p = getActiveLifeStates(companionId).find(s => s.kind === 'period'); } catch { return null; }
  if (!p) return null;
  // 双保险：若该 companion 现在已不符成年门控（safe_mode 后开/改龄），即便存档案也不让 period 影响情绪。
  const safeModeBlocked = (companion && typeof companion === 'object') ? !isPeriodAllowed(companion) : false;
  const startedMs = Date.parse(p.started_at);
  const phaseDayIndex = Number.isFinite(startedMs) ? Math.floor((nowMs - startedMs) / 86400000) : 0;
  const dayIndex = periodWindowToday(companionId, nowMs).dayIndex;
  const heavyWindow = !safeModeBlocked && p.phase === 'menstrual'
    && (phaseDayIndex - PERIOD_PMS_DAYS) >= 0 && (phaseDayIndex - PERIOD_PMS_DAYS) < PERIOD_HEAVY_DAYS;
  return {
    stateId: p.id, phase: p.phase, severity: p.severity,
    dayIndex, phaseDayIndex, heavyWindow,
    disclosed: !!p.disclosed, expectedEndAt: p.expected_end_at, safeModeBlocked,
  };
}

/** 经期最重子窗（批注④抽象，调用方不碰 pms 偏移）。 */
export function isPeriodHeavyWindow(ctx) { return !!(ctx && ctx.heavyWindow); }

/** 本轮是否经前（PMS 影响 arc 的判定源；safeModeBlocked 时 false）。 */
export function isPmsActive(ctx) { return !!(ctx && ctx.phase === 'premenstrual' && !ctx.safeModeBlocked); }

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
export function refreshLifeState(companion, nowMs = Date.now()) {
  const companionId = (companion && typeof companion === 'object') ? companion.id : companion;
  if (companionId == null) return { advanced: 0, resolved: 0, onset: 0 };
  try {
    // PR-L2 period onset：成年门控（唯一防线）+ 周期窗口 + 无活跃 period 档案 → 建档。
    // **onset 只建档案、零情绪副作用**（情绪路由=PR-L3，边界确认）。成年门控需 companion 对象。
    let onset = 0;
    if (companion && typeof companion === 'object' && isPeriodAllowed(companion)) {
      const win = periodWindowToday(companionId, nowMs);
      if (win.active) {
        const existing = getActiveLifeStates(companionId);
        if (!existing.some(s => s.kind === 'period')) {
          const startMs = nowMs - win.dayIndex * 86400000;     // 锚到窗口起点（premenstrual day0），漏跑也对
          const endMs = startMs + win.windowLen * 86400000;
          insertLifeState(companionId, { kind: 'period', phase: win.phase, startedAt: _iso(startMs), expectedEndAt: _iso(endMs) });
          onset = 1;
        }
      }
    }
    const states = getActiveLifeStates(companionId);
    if (!states.length) return { advanced: 0, resolved: 0, onset };
    const { advance, resolve } = tickLifeState(states, nowMs);
    for (const a of advance) setLifeStatePhase(a.id, a.phase);
    for (const id of resolve) resolveLifeState(id);
    if (advance.length || resolve.length || onset)
      log('info', `[LifeState] companion=${companionId} onset=${onset} advanced=${advance.length} resolved=${resolve.length}`);
    return { advanced: advance.length, resolved: resolve.length, onset };
  } catch (e) {
    log('warn', `[LifeState] refresh 异常 companion=${companionId}: ${e?.message || e}`);
    return { advanced: 0, resolved: 0, error: true };
  }
}
