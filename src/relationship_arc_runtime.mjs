/**
 * relationship_arc_runtime.mjs —— 冲突与和好弧：IO 协调层（PR-B）。
 *
 * 状态机本体（relationship_arc.mjs）是纯函数；这里负责：
 *   1. runArcSignalTick —— reply pipeline 每条消息：先时间结算再消息信号，落库
 *   2. runArcTimeTickBatch —— 搭 plan_tasks 30 分钟批（不新增定时器）
 *   3. getArcProactivePolicy —— proactive 降频 / 禁 kind / olive_branch 台阶消息
 *   4. 事件 resolved/stale 入长期记忆（她能说出"上次你就说过不查岗"）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import {
  tickArcOnSignal, tickArcOnTime, composeArcSignal, buildArcToneDirective,
  eventCategory, ARC_PARAMS,
} from './relationship_arc.mjs';
import {
  getDb, getArcState, setArcState, getOpenRelationshipEvent, applyArcEventOp,
  countTodayRelationshipEvents, getLastArchivedEventType, updateRelationshipEvent,
  listPreferences, saveMemory, upsertEmotionState, insertArcSignalLog,
} from './db.mjs';
import { getNeglectStage, buildReunionHint, getEmotionStateWithDefaults } from './emotion_state.mjs';
import { log } from './logger.mjs';

const _hoursSince = (s, now = new Date()) => {
  const t = new Date(String(s || '').replace(' ', 'T')).getTime();
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / 3600e3) : null;
};

function _getTaboos(companionId) {
  try {
    const rows = listPreferences(companionId, { type: 'taboo' }) || [];
    return rows.map(r => ({ target: r.target, intensity: r.intensity }));
  } catch { return []; }
}

/** 事件后用户入站消息轮数（hurt 自然消化 / 伤了又晾 判定用）。取不到给 1（中性：两边都不触发） */
function _countInboundSince(wechatUserId, botId, sinceIso) {
  if (!wechatUserId || !botId || !sinceIso) return 1;
  try {
    const r = getDb().prepare(`
      SELECT COUNT(*) AS n FROM wechat_messages
      WHERE from_user = ? AND direction = 'in' AND datetime(created_at) > datetime(?)
    `).get(wechatUserId, String(sinceIso).replace(' ', 'T'));
    return r?.n ?? 1;
  } catch { return 1; }
}

/** resolved/stale 事件入长期记忆（冲突与和好都入，weight 按 severity） */
function _archiveToMemory(companion, openEvent, resolvedKind, now = new Date()) {
  try {
    if (!openEvent) return;
    const dateStr = `${now.getMonth() + 1}月${now.getDate()}日`;
    const causeMap = {
      taboo_hit: '他提到了她很在意的事', harsh_words: '他说了让她难受的话',
      pressure_spam: '他反复催促施压', neglect: '他很久没理她',
    };
    const cause = openEvent.trigger_text
      ? `因为「${String(openEvent.trigger_text).slice(0, 40)}」`
      : (causeMap[openEvent.type] || '一次小冲突');
    const ending = resolvedKind === 'resolved'
      ? (openEvent.apology_kind === 'matched' ? '他认真道了歉，两人和好了' : '后来慢慢和好了')
      : '他一直没好好回应，她自己慢慢消化、放下了，但心里留了道浅浅的痕';
    const sev = Number(openEvent.severity) || 2;
    saveMemory({
      companionId: companion.id, userId: companion.user_id, memoryType: 'event',
      content: `${dateStr}有过一次别扭：${cause}，她${sev >= 3 ? '挺受伤的' : '有点不开心'}。${ending}。`,
      importance: Math.min(7, 3 + sev),
    });
  } catch (e) {
    log('warn', `[Arc] 事件入记忆失败 companion=${companion?.id}: ${e.message}`);
  }
}

/** 把纯函数 tick 结果落库（状态 / 事件 / trust 副作用 / 记忆归档） */
function _applyResult(companion, r, { stateBefore, openEvent, triggerText = '', now = new Date() } = {}) {
  if (!r || (!r.changed && !r.eventOp && !r.trustDelta)) return;
  try {
    if (r.eventOp) {
      applyArcEventOp(companion.id, openEvent, r.eventOp, {
        stateBefore, stateAfter: r.state, triggerText, now,
      });
      if (r.eventOp.op === 'resolve') _archiveToMemory(companion, openEvent, 'resolved', now);
      if (r.eventOp.op === 'stale' || (r.eventOp.op === 'create' && r.eventOp.stale)) {
        _archiveToMemory(companion, openEvent || { type: r.eventOp.type, severity: r.eventOp.severity }, 'stale', now);
      }
    }
    if (r.state !== stateBefore) {
      setArcState(companion.id, r.state, now.toISOString());
      log('info', `[Arc] companion=${companion.id} ${stateBefore} → ${r.state} (${r.reason})`);
    }
    if (r.trustDelta) {
      const es = getEmotionStateWithDefaults(companion.id);
      const cur = Number(es.trust ?? 50);
      upsertEmotionState(companion.id, { trust: Math.max(0, Math.min(100, Math.round(cur + r.trustDelta))) });
    }
  } catch (e) {
    log('warn', `[Arc] 落库失败 companion=${companion.id}: ${e.message}`);
  }
}

/** 单 companion 时间结算（消息到来时 + 30min 批共用）。返回最新 arc_state */
export function runArcTimeTickOne(companion, now = new Date()) {
  try {
    const { arc_state, arc_state_changed_at } = getArcState(companion.id);
    const openEvent = getOpenRelationshipEvent(companion.id);
    const neglectStage = getNeglectStage(companion.last_user_reply_at, companion.attachment_style);
    const interactions = openEvent
      ? _countInboundSince(companion.wechat_user_id, companion.bot_id, openEvent.created_at)
      : 1;
    const r = tickArcOnTime({
      state: arc_state, stateChangedAt: arc_state_changed_at, style: companion.attachment_style,
      safeMode: !!Number(companion.safe_mode), openEvent, neglectStage,
      interactionsSinceEvent: interactions, now,
    });
    _applyResult(companion, r, { stateBefore: arc_state, openEvent, now });
    if (r.changed && r.state !== arc_state) {
      insertArcSignalLog(companion.id, {
        signalKind: 'time_decay', stateBefore: arc_state, stateAfter: r.state, reason: r.reason,
      });
    }
    return r.changed ? r.state : arc_state;
  } catch (e) {
    log('warn', `[Arc] time tick 失败 companion=${companion.id}: ${e.message}`);
    return 'normal';
  }
}

/**
 * 消息驱动 tick（bot.mjs reply pipeline）。
 * 返回 { arcState, active, directive, voiceConcern, category }——直接拼 prompt。
 */
export function runArcSignalTick(companion, { userText = '', escalationLevel = 0, inner = null, now = new Date() } = {}) {
  const fallback = { arcState: 'normal', active: false, directive: '', voiceConcern: false, category: 'wound' };
  try {
    // 1) 先时间结算（消除 30min 批的表达空窗：neglect 升级/超时在消息到来时即时入账）
    runArcTimeTickOne(companion, now);

    const { arc_state, arc_state_changed_at } = getArcState(companion.id);
    let openEvent = getOpenRelationshipEvent(companion.id);

    // 2) 信号合成（regex 证据 + inner OS 结构化字段）
    let signal = composeArcSignal({
      userText, taboos: _getTaboos(companion.id), escalationLevel, inner,
    });
    // give_space：冷战/修复期他不纠缠、隔半天以上回来，且这条不是伤害——算"懂得给空间"
    if (!signal && (arc_state === 'cold' || arc_state === 'withdrawing' || arc_state === 'repairing')) {
      const idleH = _hoursSince(companion.last_user_reply_at, now);
      if (idleH != null && idleH >= 12) signal = { kind: 'give_space' };
    }

    let result = null;
    if (signal) {
      result = tickArcOnSignal({
        state: arc_state, stateChangedAt: arc_state_changed_at, style: companion.attachment_style,
        safeMode: !!Number(companion.safe_mode), openEvent, signal,
        todayEventCount: countTodayRelationshipEvents(companion.id, now),
        recentArchivedType: arc_state === 'normal_with_scar' ? getLastArchivedEventType(companion.id) : null,
        now,
      });
      const isHostile = signal.kind === 'taboo_hit' || signal.kind === 'harsh_words' || signal.kind === 'pressure_spam';
      _applyResult(companion, result, {
        stateBefore: arc_state, openEvent, triggerText: isHostile ? userText : '', now,
      });
      // debug 面板信号流水：有信号 / 有转移 / 有事件操作才记
      if (result.changed || result.eventOp) {
        insertArcSignalLog(companion.id, {
          signalKind: signal.kind, severity: signal.severity ?? null,
          stateBefore: arc_state, stateAfter: result.state, reason: result.reason,
          innerTone: inner?.user_tone || null, perceivedHurt: inner?.perceived_hurt ?? null,
          userTextBrief: userText,
        });
      }
    }

    // 3) 表达上下文（用 tick 后的最新状态）
    const finalState = result?.changed ? result.state : arc_state;
    openEvent = getOpenRelationshipEvent(companion.id);
    const voiceConcern = !!result?.voiceConcern;
    const category = openEvent ? eventCategory(openEvent.type) : 'wound';
    const active = finalState !== 'normal' || voiceConcern
      || (finalState === 'normal_with_scar');
    let reunionHint = '';
    if (finalState === 'repairing' && category === 'distance') {
      const ns = getNeglectStage(companion.last_user_reply_at, companion.attachment_style);
      reunionHint = buildReunionHint(ns, companion.attachment_style, companion.last_user_reply_at) || '';
    }
    const directive = buildArcToneDirective(voiceConcern ? 'normal' : finalState, {
      category, voiceConcern, reunionHint,
      triggerText: openEvent?.trigger_text || '',
    });
    return { arcState: finalState, active: !!directive, directive, voiceConcern, category };
  } catch (e) {
    log('warn', `[Arc] signal tick 失败 companion=${companion?.id}: ${e.message}`);
    return fallback;
  }
}

/** proactive 路径的表达上下文（无消息信号，只读当前状态） */
export function getArcExpressionContext(companion) {
  try {
    const { arc_state } = getArcState(companion.id);
    if (arc_state === 'normal') return { arcState: 'normal', active: false, directive: '' };
    const openEvent = getOpenRelationshipEvent(companion.id);
    const category = openEvent ? eventCategory(openEvent.type) : 'wound';
    let reunionHint = '';
    if (arc_state === 'repairing' && category === 'distance') {
      const ns = getNeglectStage(companion.last_user_reply_at, companion.attachment_style);
      reunionHint = buildReunionHint(ns, companion.attachment_style, companion.last_user_reply_at) || '';
    }
    const directive = buildArcToneDirective(arc_state, { category, reunionHint, triggerText: openEvent?.trigger_text || '' });
    return { arcState: arc_state, active: !!directive, directive, category, openEvent };
  } catch {
    return { arcState: 'normal', active: false, directive: '' };
  }
}

/**
 * proactive 策略（docs/CONFLICT_ARC.md §5.4）：
 *   hurt ×0.7 禁告白 · cold ×0.4 禁告白/照片（anxious 留 1 条试探）·
 *   withdrawing ×0.15 基本沉默 · repairing 允许 1 条台阶消息（olive_branch）
 * 返回 { skip, forbidKinds, oliveBranch, oliveEventId, arcState }
 */
export function getArcProactivePolicy(companion, rng = Math.random) {
  const none = { skip: false, forbidKinds: [], oliveBranch: false, oliveEventId: null, arcState: 'normal' };
  try {
    const { arc_state } = getArcState(companion.id);
    if (arc_state === 'normal' || arc_state === 'normal_with_scar') return { ...none, arcState: arc_state };
    const openEvent = getOpenRelationshipEvent(companion.id);
    const oliveAvail = !!(openEvent && !Number(openEvent.olive_sent));
    const style = String(companion.attachment_style || 'secure').toLowerCase();

    if (arc_state === 'hurt') {
      return { skip: rng() > 0.7, forbidKinds: ['confession'], oliveBranch: false, oliveEventId: null, arcState: arc_state };
    }
    if (arc_state === 'cold') {
      // anxious cold 期会主动试探一条（"你还在生我气吗"式），消耗 olive 配额
      if (style === 'anxious' && oliveAvail) {
        return { skip: false, forbidKinds: ['confession', 'photo'], oliveBranch: true, oliveEventId: openEvent.id, arcState: arc_state };
      }
      return { skip: rng() > 0.4, forbidKinds: ['confession', 'photo'], oliveBranch: false, oliveEventId: null, arcState: arc_state };
    }
    if (arc_state === 'withdrawing') {
      return { skip: rng() > 0.15, forbidKinds: ['confession', 'photo'], oliveBranch: false, oliveEventId: null, arcState: arc_state };
    }
    if (arc_state === 'repairing') {
      return { skip: false, forbidKinds: ['confession'], oliveBranch: oliveAvail, oliveEventId: oliveAvail ? openEvent.id : null, arcState: arc_state };
    }
    return { ...none, arcState: arc_state };
  } catch {
    return none;
  }
}

/** 台阶消息已用（乐观置位：注入即消耗，防重复台阶） */
export function markOliveBranchSent(eventId) {
  try { updateRelationshipEvent(eventId, { olive_sent: 1 }); } catch {}
}

/** 台阶消息的 prompt 指令（proactive 注入） */
export function buildOliveBranchHint(arcState, category) {
  if (arcState === 'cold') {
    return `\n【★ 主动台阶 · 仅此一条】你们正在闹别扭，你还凉着，但你忍不住想试探一下他——发一条**短短的、放低一半姿态但不卑微**的消息："你还在生我气吗""……在忙吗"这种。不解释、不撒娇、不道歉（错不在你），就是递一个小小的台阶，看他接不接。`;
  }
  return `\n【★ 主动台阶 · 仅此一条】你们正在和好，你想主动递个台阶让气氛松一点——发一条**轻轻的、带点不好意思的**消息："那天我语气也不太好啦""晚上想吃什么，我请你"这种。一条就好，别长篇大论、别旧事重提。`;
}

/**
 * 时间批：搭 plan_tasks 30 分钟批的便车（与 runEmotionRecalcBatch 同节奏，不新增定时器）。
 * 只跑活跃绑定的 companion（与情绪批同口径）。
 */
export function runArcTimeTickBatch() {
  let updated = 0, skipped = 0, errors = 0, total = 0;
  try {
    const rows = getDb().prepare(`
      SELECT c.id, c.user_id, c.bot_id, c.last_user_reply_at, c.attachment_style, c.safe_mode,
             c.arc_state, u.wechat_user_id
      FROM companions c
      JOIN users u ON u.id = c.user_id
      JOIN wechat_accounts wa ON wa.wechat_user_id = u.wechat_user_id AND wa.bot_id = c.bot_id
      WHERE wa.is_active = 1
    `).all();
    total = rows.length;
    for (const row of rows) {
      try {
        const before = row.arc_state || 'normal';
        const after = runArcTimeTickOne(row);
        if (after !== before) updated++; else skipped++;
      } catch (e) {
        errors++;
        log('warn', `[Arc] batch tick companion=${row.id} 异常: ${e.message}`);
      }
    }
    if (updated > 0) log('info', `[Arc] batch tick done updated=${updated} skipped=${skipped} errors=${errors} total=${total}`);
  } catch (e) {
    log('warn', `[Arc] batch tick 整体失败: ${e.message}`);
  }
  return { updated, skipped, errors, total };
}
