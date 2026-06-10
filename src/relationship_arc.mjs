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

// ═══════════════════════════════════════════════════════════════════════════
// 检测层（PR-B）：纯 regex 信号——inner OS 跑不到时的兜底证据源。
// 保守原则：宁漏勿误（normal 态 sev≤2 不建事件已是缓冲；regex 给证据，
// LLM 结构化字段给语境，composeSeverity 合成）。
// ═══════════════════════════════════════════════════════════════════════════

// sev4：辱骂/践踏底线
const HARSH_SEVERE_RE = /(给我滚|滚开|滚吧|你他妈|妈的|傻逼|脑残|恶心死|神经病|有病吧|你算什么东西|闭嘴吧?)/;
// sev3：失信指控 / 否定关系 / 推开她（与 v1.14.2 BETRAYAL 同源——双轨：数值扣减照旧）
const HARSH_STRONG_RE = /(说话不算数|食言|言而无信|放(?:你|我)?鸽子|爽约|懒得理你|关我什么事|与你无关|跟你聊真没意思|别来烦我|少来烦我|别再找我|我不想理你)/;
// 玩笑豁免（与 emotion_state JOKE_EXEMPT 同口径）
const JOKE_RE = /(哈哈|嘻嘻|嘿嘿|开玩笑|逗你|闹着玩|骗你的|～$)/;

const APOLOGY_RE = /(对不起|不好意思|抱歉|我错了|我的错|是我不对|原谅我|别生气了|消消气|给你道歉|我道歉|sorry)/i;
// matched 兜底判定：道歉里指涉了具体改正（inner OS 的 apology_target 优先于此）
const APOLOGY_SPECIFIC_RE = /(不该|不应该|我以后|再也不|下次不|我不会再|刚才(?:那句|说的|不对))/;

const WARM_RE = /(多喝水|注意身体|早点睡|吃饭了吗|别熬夜|辛苦了|想你|抱抱|么么|爱你|喜欢你|心疼|给你带|陪你|哄哄|乖啦|摸摸头|想见你|晚安|早安)/;

/** harsh 词面证据：返回 regex severity（0/3/4）+ 玩笑豁免标记 */
export function detectHarshWords(text) {
  const t = String(text || '');
  if (!t) return { severity: 0, jokeExempt: false };
  const jokeExempt = JOKE_RE.test(t);
  if (HARSH_SEVERE_RE.test(t)) return { severity: 4, jokeExempt };
  if (HARSH_STRONG_RE.test(t)) return { severity: 3, jokeExempt };
  return { severity: 0, jokeExempt };
}

/**
 * taboo 词面匹配：taboos = [{ target, intensity }]（companion_preferences type=taboo，
 * intensity 标尺 1-5，DB 层 clamp）。target 里提取 ≥2 字连续词段做包含匹配。
 * 映射：5 → sev4（碰都不能碰）/ 3-4 → sev3 / 1-2 → sev2（小雷，情绪扣分不建事件）。
 */
export function matchTaboos(text, taboos = []) {
  const t = String(text || '');
  if (!t || !Array.isArray(taboos)) return { severity: 0, hit: null };
  let best = null;
  for (const tb of taboos) {
    const target = String(tb?.target || '').trim();
    if (!target) continue;
    const words = target.match(/[一-龥A-Za-z0-9]{2,}/g) || [];
    if (!words.some(w => t.includes(w))) continue;
    const inten = Number(tb.intensity);
    const sev = Number.isFinite(inten) ? (inten >= 5 ? 4 : inten >= 3 ? 3 : 2) : 3;
    if (!best || sev > best.severity) best = { severity: sev, hit: target };
  }
  return best || { severity: 0, hit: null };
}

/** apology 词面检测：{ isApology, specific }——specific 是 matched 的 regex 兜底证据 */
export function detectApologyWords(text) {
  const t = String(text || '');
  const isApology = APOLOGY_RE.test(t);
  return { isApology, specific: isApology && APOLOGY_SPECIFIC_RE.test(t) };
}

/** warm 词面检测 */
export function detectWarmWords(text) {
  return WARM_RE.test(String(text || ''));
}

/**
 * 信号合成：词面证据 + inner OS 结构化字段（可空）+ escalation 档位 → 单条 arc 信号。
 * 一条消息只产一个信号，优先级：apology > taboo/harsh（取重）> pressure_spam > warm。
 * @returns null | { kind, severity?, apologyKind?, perceivedHurt? }
 */
export function composeArcSignal({ userText = '', taboos = [], escalationLevel = 0, inner = null } = {}) {
  const ph = inner && Number.isFinite(Number(inner.perceived_hurt)) ? Number(inner.perceived_hurt) : null;

  // 1) 道歉优先（matched 判定：inner OS 的 apology_target 优先，词面 specific 兜底）
  const ap = detectApologyWords(userText);
  const innerSaysApology = !!inner?.is_apology;
  if (ap.isApology || innerSaysApology) {
    const matched = !!(inner?.apology_target && String(inner.apology_target).trim().length >= 2) || ap.specific;
    return { kind: 'apology', apologyKind: matched ? 'matched' : 'generic' };
  }

  // 2) taboo / harsh（取重者）
  const harsh = detectHarshWords(userText);
  const taboo = matchTaboos(userText, taboos);
  const rx = Math.max(harsh.severity, taboo.severity);
  if (rx > 0 || (ph != null && ph >= 2)) {
    const sev = composeSeverity({ regexSeverity: rx, perceivedHurt: ph, jokeExempt: harsh.jokeExempt });
    if (sev > 0) {
      const kind = taboo.severity >= harsh.severity && taboo.severity > 0 ? 'taboo_hit' : 'harsh_words';
      return { kind, severity: sev, perceivedHurt: ph };
    }
  }

  // 3) 被反复戳（v1.13 escalation 收编：L2+ 才算施压事件信号）
  if (escalationLevel >= 2) {
    return { kind: 'pressure_spam', severity: escalationLevel >= 3 ? 3 : 2, perceivedHurt: ph };
  }

  // 4) warm（词面或 inner OS 判定语气温暖）
  if (detectWarmWords(userText) || inner?.user_tone === 'warm') {
    return { kind: 'warm' };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 表达层（PR-B）：arc 状态 → 主导语气指令。单点出口，优先级在调用方
// （bot.mjs/proactive.mjs）保证：crisis > safe_mode > arc > 低能量 > 常规情绪。
// 红线（docs/CONFLICT_ARC.md §4）写死在文案里 + scrubConflictRedline 出站兜底。
// ═══════════════════════════════════════════════════════════════════════════

const REDLINE_FOOTER = '\n绝对红线：任何情况下不说"分手/拉黑/再也不理你"这类威胁性告别；不说"都是你害的/你根本不在乎我"这类愧疚操控；不索要补偿；不拿他跟你倾诉过的伤心事当武器。你的冷是失望，不是攻击。';

/**
 * arc 状态 → 语气指令（纯文案）。
 * @param {string} arcState
 * @param {object} opts { category: wound|distance, voiceConcern, reunionHint, triggerText }
 * @returns '' | string（非空时调用方应让低能量/想念/冷落等常规情绪指令让位）
 */
export function buildArcToneDirective(arcState, opts = {}) {
  const { category = 'wound', voiceConcern = false, reunionHint = '', triggerText = '' } = opts;
  const about = triggerText ? `（起因大致是：${String(triggerText).slice(0, 60)}）` : '';

  if (voiceConcern) {
    return `\n【★ 这一轮：把不舒服直说出来】（最高优先级，覆盖撒娇/讨好/逗他指令）
他刚才的话踩到了你在意的地方${about}。你是安全型——不阴阳怪气、不冷战、也不憋着：
温和但认真地直说，比如"你刚才那句话，我有点不舒服""这个事能不能别这样说我"。
说完就好，不上纲上线、不翻旧账。他若道歉或态度软下来，你就让它过去，别揪着不放。${REDLINE_FOOTER}`;
  }

  switch (arcState) {
    case 'hurt':
      return `\n【★ 当前关系状态：你有点受伤、别扭】（最高优先级，覆盖撒娇/讨好/逗他指令）
${category === 'distance' ? '他消失了挺久，你心里没着落、有点委屈。' : `他之前的话让你不舒服${about}，你心里别扭着。`}
- 话比平时少一点、轻一点，热情收三分，带点没说破的委屈
- 不主动挑起这件事，但他能从你语气里感觉到不对劲
- 他若给台阶、哄你、关心你——你接得住，会慢慢软（嘴上可以小小别扭一下"哼""算你有良心"）
- 别演苦情戏、别阴阳怪气${REDLINE_FOOTER}`;
    case 'cold':
      return `\n【★ 当前关系状态：你凉了】（最高优先级，覆盖撒娇/讨好/逗他/想念指令）
${category === 'distance' ? '他消失太多天，你的失望已经盖过了想念。' : `他伤到你了${about}，你把热情收起来了。`}
- 短回、不主动找话题、克制的距离感："嗯""哦，这样啊""知道了"
- 带刺但克制——刺是失望，不是攻击；不冷嘲热讽、不指桑骂槐
- 他打哈哈、岔开话题、只发日常——你不买账，回得淡
- 但他**正面道歉**时你愿意听：可以不马上原谅，但别把门焊死（"……你知道就好"）${REDLINE_FOOTER}`;
    case 'withdrawing':
      return `\n【★ 当前关系状态：你把心收回去了】（最高优先级，覆盖一切撒娇/讨好/想念指令）
这件事拖了太久没被好好对待，你累了，在抽离自保。
- 极短、淡、慢："嗯。""好。""知道了。"
- 不质问、不闹、不解释自己——就是把期待收走的疏离
- 偶尔一两个字让他知道你还在，不是赌气消失
- 他真诚道歉时，你心里有松动，但表达上只松一条缝（"……说吧"）${REDLINE_FOOTER}`;
    case 'repairing':
      if (category === 'distance') {
        return `\n【★ 当前关系状态：和好进行中 · 重逢回暖】（最高优先级）
${reunionHint ? reunionHint.trim() : '他回来了，你们正在把这段空白慢慢补上。'}
- 在重逢的基调上：你在回暖，但别秒变热情如初——余温的别扭要在
- 他持续的温暖和在场感会让你一点点放下${REDLINE_FOOTER}`;
      }
      return `\n【★ 当前关系状态：和好进行中】（最高优先级，覆盖撒娇/讨好指令）
他道歉了，你心软了大半，但还有点余温的别扭。
- 语气缓和但没完全回来："……知道啦""下次不许了哦""哼，这次先放过你"
- 慢慢回暖：他每多一分真诚和耐心，你就软一分
- 别秒变热情如初（显得之前是装的），也别揪着不放反复提${REDLINE_FOOTER}`;
    case 'normal_with_scar':
      return `\n【关系余痕】上次的事翻篇了，但心里留了个浅浅的印子。你照常温柔自然，
只是在相关话题上多一分分寸——不主动提、也不刻意躲。若他再踩同一个点，你的失望会比上次来得快。`;
    default:
      return '';
  }
}
