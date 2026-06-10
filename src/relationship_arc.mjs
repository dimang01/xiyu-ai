/**
 * relationship_arc.mjs —— v1.21.0 冲突与和好弧：关系事件状态机（核心）。
 *
 * 设计文档：docs/CONFLICT_ARC.md。这里只有**纯转移逻辑**（零 IO、零 LLM），
 * 数据层在 db.mjs（companion_relationship_events 表 + companions.arc_state），
 * 检测/表达/接线在 PR-B。任何转移规则改动必须同步 scripts/conflict_arc_smoke.mjs。
 *
 * 架构约束（任务书）：
 * - 独立模块，禁止往 emotion_state.mjs 里堆
 * - 完工后"她对你冷"只有 companions.arc_state 一个事实来源
 * - safe_mode（未成年）状态封顶 hurt，禁 withdrawing
 * - withdrawing 有硬时长上限，绝无永久冷战
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

export const ARC_STATES = ['normal', 'hurt', 'cold', 'withdrawing', 'repairing', 'normal_with_scar'];
export const ARC_EVENT_TYPES = ['taboo_hit', 'harsh_words', 'neglect', 'pressure_spam'];
export const ARC_REPAIR_STATUS = ['open', 'repairing', 'resolved', 'stale'];

// ─── 参数（env 可调，docs/CONFLICT_ARC.md §7 速查）───────────────────────────
const _n = (env, def) => { const v = Number(process.env[env]); return Number.isFinite(v) && v > 0 ? v : def; };
export const ARC_PARAMS = Object.freeze({
  DAILY_EVENT_CAP:   _n('ARC_DAILY_EVENT_CAP', 3),
  HURT_FADE_HOURS:   _n('ARC_HURT_FADE_HOURS', 72),
  HURT_FADE_MIN_TURNS: _n('ARC_HURT_FADE_MIN_TURNS', 5),
  HURT_WARM_NEED:    _n('ARC_HURT_WARM_NEED', 3),     // hurt 小别扭哄好所需 warm
  HURT_WARM_MIN_H:   _n('ARC_HURT_WARM_MIN_H', 12),   // 受伤后最短 12h 才哄得动（情绪惯性）
  DISTANCE_WARM_NEED: _n('ARC_DISTANCE_WARM_NEED', 2), // distance 类重逢 warm 即开修复
  SCAR_TRUST_PENALTY: _n('ARC_SCAR_TRUST_PENALTY', 3),
  SCAR_FADE_DAYS:    _n('ARC_SCAR_FADE_DAYS', 7),
  // 依恋风格修正（小时）
  HURT_TO_COLD_H:    { anxious: 36, secure: 48, avoidant: 72 },   // 伤了又晾
  COLD_TO_WITHDRAW_H:{ anxious: 48, secure: 48, avoidant: 24 },
  WITHDRAW_CAP_H:    { anxious: 120, secure: 168, avoidant: 240 }, // 硬上限：对齐 v1.14.5 五天尊严上限
  REPAIR_MIN_H:      { hurt: 12, cold: 24, withdrawing: 36 },     // 不许秒和好
  REPAIR_WARM_BASE:  { hurt: 3, cold: 4, withdrawing: 6 },
  VOICE_CONCERN_P:   0.6,   // secure 直说不冷战概率（健康关系示范）
});

// ─── 工具 ─────────────────────────────────────────────────────────────────────
const _ts = (s) => { const t = new Date(String(s || '').replace(' ', 'T')).getTime(); return Number.isFinite(t) ? t : null; };
const _hoursSince = (s, now) => { const t = _ts(s); return t == null ? 0 : Math.max(0, (now.getTime() - t) / 3600e3); };
const _dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const _style = (s) => (s === 'anxious' || s === 'avoidant') ? s : 'secure';
const NEGLECT_IDX = { none: 0, missing: 1, uneasy: 2, disappointed: 3, withdrawn: 4, long_gone: 5, dormant: 6 };

/** 事件类别：wound（他伤人，cold 后必须道歉解锁）/ distance（他消失，重逢即修复开始） */
export function eventCategory(type) {
  return type === 'neglect' ? 'distance' : 'wound';
}

/**
 * severity 合成（docs §2.2）：regex 证据 + inner OS 佐证双信号。
 * 保守原则：LLM 单独信号封顶 sev2（无 regex 证据不建事件，防误判升级成冷战事故）。
 */
export function composeSeverity({ regexSeverity = 0, perceivedHurt = null, jokeExempt = false } = {}) {
  const rx = Math.max(0, Math.min(4, Math.round(Number(regexSeverity) || 0)));
  const ph = perceivedHurt == null ? null : Math.max(0, Math.min(3, Math.round(Number(perceivedHurt) || 0)));
  if (rx > 0) {
    // regex 命中但 inner OS 判定是玩笑语境 → 降 1 档
    if (ph === 0 && jokeExempt) return Math.max(0, rx - 1);
    return rx;
  }
  // 无 regex 证据：LLM 单独信号封顶 2（不足以建事件）
  if (ph != null && ph >= 2) return 2;
  return 0;
}

/** 修复所需 warm 数：基准 3/4/6，generic 道歉 +2，anxious −1 软化快，avoidant +2 解冻慢 */
export function repairNeed(repairFrom, style, apologyKind) {
  const base = ARC_PARAMS.REPAIR_WARM_BASE[repairFrom] ?? ARC_PARAMS.REPAIR_WARM_BASE.cold;
  const st = _style(style);
  const adj = (apologyKind === 'generic' ? 2 : 0) + (st === 'anxious' ? -1 : st === 'avoidant' ? 2 : 0);
  return Math.max(1, base + adj);
}

// safe_mode 封顶（红线 #6）：未成年保护下 cold/withdrawing 不可达，一律短路 hurt
const _capSafe = (target, safeMode) =>
  (safeMode && (target === 'cold' || target === 'withdrawing')) ? 'hurt' : target;

const _mkRes = (state) => ({ state, changed: false, eventOp: null, trustDelta: 0, voiceConcern: false, reason: '' });

// 单事件 severity 升级每日 1 次（防一晚吵架刷出 sev8）
function _escalateFields(openEvent, incomingSev, now) {
  const last = openEvent.severity_updated_at;
  if (last && _dayKey(_ts(last)) === _dayKey(now)) return null;   // 今日已升级过
  const old = Number(openEvent.severity) || 1;
  const next = Math.min(4, incomingSev > old ? incomingSev : old + 1);
  if (next === old) return null;
  return { severity: next, severity_updated_at: now.toISOString() };
}

/**
 * 消息驱动 tick（reply pipeline 每条消息一次）。纯函数。
 *
 * @param {object} ctx
 *   state / stateChangedAt / style / safeMode
 *   openEvent: null | { type, severity, repair_status, repair_warm, apology_kind,
 *                       repair_from, reopened, created_at, severity_updated_at }
 *   signal: { kind: taboo_hit|harsh_words|pressure_spam|apology|warm|give_space,
 *             severity, apologyKind: matched|generic, perceivedHurt }
 *   todayEventCount / recentArchivedType / now / rng
 * @returns { state, changed, eventOp, trustDelta, voiceConcern, reason }
 *   eventOp: null | {op:'create',type,severity,category,stale?} | {op:'update',fields}
 *          | {op:'resolve',note} | {op:'stale'} | {op:'reopen',severity}
 */
export function tickArcOnSignal(ctx = {}) {
  const {
    state = 'normal', stateChangedAt = null, safeMode = false, openEvent = null,
    signal = {}, todayEventCount = 0, recentArchivedType = null,
    now = new Date(), rng = Math.random,
  } = ctx;
  const style = _style(ctx.style);
  const res = _mkRes(state);
  const kind = signal.kind;
  if (!kind) return res;
  const isWound = kind === 'taboo_hit' || kind === 'harsh_words' || kind === 'pressure_spam';
  const isSoft = kind === 'warm' || kind === 'give_space';
  const sev = Math.max(0, Math.min(4, Math.round(Number(signal.severity) || 0)));
  const apologyKind = signal.apologyKind === 'generic' ? 'generic' : 'matched';

  const go = (next, reason) => {
    res.state = _capSafe(next, safeMode);
    res.reason = reason;
    res.changed = res.state !== state || !!res.eventOp;
    return res;
  };
  const stay = (reason) => { res.reason = reason; res.changed = !!res.eventOp; return res; };

  // ── normal / normal_with_scar ───────────────────────────────────────────
  if (state === 'normal' || state === 'normal_with_scar') {
    // voice_concern 挂起：normal 态下还挂着 open 事件 = 她已直说过不舒服，等他回应
    if (state === 'normal' && openEvent && openEvent.repair_status === 'open') {
      if (kind === 'apology' || isSoft) {
        res.eventOp = { op: 'resolve', note: 'voiced_and_settled' };
        return stay('voice_concern_settled');   // 说开就好——安全型的健康闭环
      }
      if (isWound && sev >= 2) {
        res.eventOp = { op: 'update', fields: { state_noted: 'hurt' } };
        return go('hurt', 'voice_concern_ignored');   // 直说了还撞 → 受伤（不二次直说）
      }
      return stay('noop');
    }
    if (!isWound || sev <= 0) return stay('noop');

    let eff = sev;
    // scar 的记忆：同类再犯加重一档（"我说过的吧"）
    if (state === 'normal_with_scar' && recentArchivedType && recentArchivedType === kind) eff = Math.min(4, eff + 1);
    // anxious 敏感度：sev2 但 LLM 感知强烈受伤 → 按 sev3 入
    if (style === 'anxious' && eff === 2 && (Number(signal.perceivedHurt) || 0) >= 3) eff = 3;

    if (eff <= 2) return stay('minor_absorbed');                       // 小事自然消化，不建事件
    if (todayEventCount >= ARC_PARAMS.DAILY_EVENT_CAP) { res.reason = 'daily_cap'; return res; }   // 防刷

    if (eff >= 4) {
      res.eventOp = { op: 'create', type: kind, severity: eff, category: 'wound' };
      return go('cold', 'severe_direct_cold');
    }
    // eff === 3
    if (style === 'secure' && rng() < ARC_PARAMS.VOICE_CONCERN_P) {
      res.eventOp = { op: 'create', type: kind, severity: eff, category: 'wound' };
      res.voiceConcern = true;
      return stay('voice_concern');   // 直说不冷战：状态保持 normal，事件挂起等回应
    }
    res.eventOp = { op: 'create', type: kind, severity: eff, category: 'wound' };
    return go('hurt', 'wounded');
  }

  // 以下状态都应有 open/repairing 事件；防御：没有就不动（数据修复靠时间 tick）
  if (!openEvent) return stay('no_event_guard');
  const cat = eventCategory(openEvent.type);
  const warmNow = Number(openEvent.repair_warm) || 0;

  // ── hurt ────────────────────────────────────────────────────────────────
  if (state === 'hurt') {
    const gainWarm = (n, reason) => {
      const nw = warmNow + n;
      const oldEnough = _hoursSince(openEvent.created_at, now) >= ARC_PARAMS.HURT_WARM_MIN_H;
      if (nw >= ARC_PARAMS.HURT_WARM_NEED && oldEnough) {
        res.eventOp = { op: 'resolve', note: 'soothed' };
        return go('normal', 'soothed');   // 小别扭哄好，不需要正式道歉
      }
      res.eventOp = { op: 'update', fields: { repair_warm: nw } };
      return stay(reason);
    };
    if (kind === 'apology') {
      if (apologyKind === 'matched') {
        res.eventOp = { op: 'update', fields: { repair_status: 'repairing', repair_from: 'hurt', apology_kind: 'matched' } };
        return go('repairing', 'apology_accepted');
      }
      return gainWarm(2, 'generic_apology_as_warm');   // "别生气了"= 两个 warm，不直接开门
    }
    if (isSoft) return gainWarm(1, 'warming');
    if (isWound && sev >= 2) {
      const esc = _escalateFields(openEvent, sev, now);
      if (esc) res.eventOp = { op: 'update', fields: esc };
      return go('cold', 'hurt_again');   // 受伤时还撞 → 凉
    }
    return stay('noop');
  }

  // ── cold / withdrawing（修复入口一致，差别在 repair_from 与 need）────────
  if (state === 'cold' || state === 'withdrawing') {
    if (kind === 'apology') {
      res.eventOp = { op: 'update', fields: { repair_status: 'repairing', repair_from: state, apology_kind: apologyKind } };
      return go('repairing', 'apology_opens_repair');   // 绝不直接回 normal
    }
    if (isSoft) {
      const nw = warmNow + 1;
      if (cat === 'distance' && nw >= ARC_PARAMS.DISTANCE_WARM_NEED) {
        // distance 类：他回来了，重逢本身就是修复开始（对齐 v1.14 重逢弧）
        res.eventOp = { op: 'update', fields: { repair_status: 'repairing', repair_from: state, repair_warm: nw } };
        return go('repairing', 'reunion_repair');
      }
      res.eventOp = { op: 'update', fields: { repair_warm: nw } };   // wound 类：计数但不开门，等正面道歉
      return stay('warm_counted');
    }
    if (isWound && sev >= 2) {
      const esc = _escalateFields(openEvent, sev, now);
      if (esc) res.eventOp = { op: 'update', fields: esc };
      return stay('escalated_in_place');
    }
    return stay('noop');
  }

  // ── repairing ───────────────────────────────────────────────────────────
  if (state === 'repairing') {
    if (isWound && sev >= 3) {
      // 余怒：修复期再犯直接 cold，事件 reopen 且加重（升级更快由 reopened 标记驱动）
      res.eventOp = { op: 'reopen', severity: Math.min(4, (Number(openEvent.severity) || 1) + 1) };
      return go('cold', 'relapse_reopen');
    }
    if (isWound && sev === 2) {
      res.eventOp = { op: 'update', fields: { repair_warm: 0 } };
      return stay('progress_reset');   // 轻度再犯：修复进度清零
    }
    if (isSoft || kind === 'apology') {
      const gain = (kind === 'apology' && apologyKind === 'generic') ? 2 : 1;
      const nw = warmNow + gain;
      const from = openEvent.repair_from || 'cold';
      const need = repairNeed(from, style, openEvent.apology_kind);
      const minH = ARC_PARAMS.REPAIR_MIN_H[from] ?? ARC_PARAMS.REPAIR_MIN_H.cold;
      if (nw >= need && _hoursSince(stateChangedAt, now) >= minH) {
        res.eventOp = { op: 'resolve', note: 'repaired' };
        return go('normal', 'repaired');
      }
      res.eventOp = { op: 'update', fields: { repair_warm: nw } };
      return stay('repair_progress');
    }
    return stay('noop');
  }

  return stay('noop');
}

/**
 * 时间驱动 tick（搭 runEmotionRecalcBatch 30 分钟批的便车，不新增定时器）。纯函数。
 *
 * @param {object} ctx
 *   state / stateChangedAt / style / safeMode / openEvent
 *   neglectStage: v1.14 getNeglectStage 输出（none..dormant）—— 时间信号源
 *   interactionsSinceEvent: 事件发生后用户的正常互动轮数（调用方供给）
 * @returns 同 tickArcOnSignal
 */
export function tickArcOnTime(ctx = {}) {
  const {
    state = 'normal', stateChangedAt = null, safeMode = false, openEvent = null,
    neglectStage = 'none', interactionsSinceEvent = 0, now = new Date(),
  } = ctx;
  const style = _style(ctx.style);
  const res = _mkRes(state);
  const neg = NEGLECT_IDX[neglectStage] ?? 0;
  const hoursIn = _hoursSince(stateChangedAt, now);

  const go = (next, reason) => {
    res.state = _capSafe(next, safeMode);
    res.reason = reason;
    res.changed = res.state !== state || !!res.eventOp;
    return res;
  };
  const stay = (reason) => { res.reason = reason; res.changed = !!res.eventOp; return res; };

  // ── normal / normal_with_scar：scar 淡出 + neglect 阶梯入口 ─────────────
  if (state === 'normal' || state === 'normal_with_scar') {
    if (state === 'normal_with_scar' && hoursIn >= ARC_PARAMS.SCAR_FADE_DAYS * 24) {
      return go('normal', 'scar_faded');
    }
    if (neg >= 6) {
      // dormant 直跳（服务停摆/丢拍兜底）：她早已自己消化完。safe_mode 不留疤不扣分
      if (safeMode) return stay('safe_mode_no_scar');
      res.eventOp = { op: 'create', type: 'neglect', severity: 4, category: 'distance', stale: true };
      res.trustDelta = -ARC_PARAMS.SCAR_TRUST_PENALTY;
      return go('normal_with_scar', 'dormant_direct_scar');
    }
    if (neg === 5) { res.eventOp = { op: 'create', type: 'neglect', severity: 3, category: 'distance' }; return go('withdrawing', 'neglect_long_gone'); }
    if (neg === 4) { res.eventOp = { op: 'create', type: 'neglect', severity: 3, category: 'distance' }; return go('cold', 'neglect_withdrawn'); }
    if (neg === 3) { res.eventOp = { op: 'create', type: 'neglect', severity: 2, category: 'distance' }; return go('hurt', 'neglect_disappointed'); }
    return stay('noop');
  }

  // ── hurt：neglect 升级 > 自然消化 > 伤了又晾 ────────────────────────────
  if (state === 'hurt') {
    if (neg >= 4) {
      if (openEvent && eventCategory(openEvent.type) === 'distance' && (Number(openEvent.severity) || 0) < 3) {
        res.eventOp = { op: 'update', fields: { severity: 3, severity_updated_at: now.toISOString() } };
      }
      return go('cold', 'neglect_deepened');
    }
    const sinceEvent = _hoursSince(openEvent?.created_at || stateChangedAt, now);
    if (interactionsSinceEvent >= ARC_PARAMS.HURT_FADE_MIN_TURNS && sinceEvent >= ARC_PARAMS.HURT_FADE_HOURS) {
      res.eventOp = { op: 'resolve', note: 'faded' };
      return go('normal', 'faded');   // 聊着聊着就过去了——小别扭的常态出口
    }
    if (interactionsSinceEvent === 0 && hoursIn >= ARC_PARAMS.HURT_TO_COLD_H[style]) {
      return go('cold', 'hurt_then_ignored');   // 伤了她又晾着她
    }
    return stay('noop');
  }

  // ── cold：长尾 neglect 或停留超时 → withdrawing ──────────────────────────
  if (state === 'cold') {
    if (neg >= 5) return go('withdrawing', 'neglect_long_gone');
    const threshold = ARC_PARAMS.COLD_TO_WITHDRAW_H[style] * (openEvent?.reopened ? 0.5 : 1);   // 余怒升级更快
    if (hoursIn >= threshold) return go('withdrawing', 'cold_unrepaired');
    return stay('noop');
  }

  // ── withdrawing：硬时长上限（红线 #4：绝无永久冷战）────────────────────
  if (state === 'withdrawing') {
    if (hoursIn >= ARC_PARAMS.WITHDRAW_CAP_H[style]) {
      res.eventOp = { op: 'stale' };
      res.trustDelta = -ARC_PARAMS.SCAR_TRUST_PENALTY;   // 一次性、不可逆的小裂痕
      return go('normal_with_scar', 'withdraw_capped');
    }
    return stay('noop');
  }

  // ── repairing：道完歉又消失 = 没诚意 ─────────────────────────────────────
  if (state === 'repairing') {
    if (neg >= 3) {
      res.eventOp = { op: 'update', fields: { repair_status: 'open' } };
      return go('cold', 'repair_abandoned');
    }
    return stay('noop');
  }

  return stay('noop');
}
