/**
 * v1.21.0 冲突与和好弧——状态机转移表逐条断言（纯函数，零 LLM，零 DB）。
 * 对照 docs/CONFLICT_ARC.md §2 转移表 + §2.4 依恋风格修正 + §4 红线（safe_mode 封顶 /
 * withdrawing 硬上限）+ §5.2 防刷。任何一条转移规则被改动，这里必须红。
 */
import {
  composeSeverity, eventCategory, tickArcOnSignal, tickArcOnTime, repairNeed,
} from '../src/relationship_arc.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const NOW = new Date('2026-06-15T12:00:00Z');
const hAgo = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();

// 构造默认 ctx 的便捷工厂（每条断言只写差异部分）
const sig = (over = {}) => tickArcOnSignal({
  state: 'normal', stateChangedAt: hAgo(1), style: 'secure', safeMode: false,
  openEvent: null, todayEventCount: 0, recentArchivedType: null,
  now: NOW, rng: () => 0.99,
  signal: { kind: 'harsh_words', severity: 0 },
  ...over,
});
const tim = (over = {}) => tickArcOnTime({
  state: 'normal', stateChangedAt: hAgo(1), style: 'secure', safeMode: false,
  openEvent: null, neglectStage: 'none', interactionsSinceEvent: 0, now: NOW,
  ...over,
});
// 常用 open 事件
const ev = (over = {}) => ({
  type: 'harsh_words', severity: 3, repair_status: 'open', repair_warm: 0,
  apology_kind: null, repair_from: null, reopened: 0,
  created_at: hAgo(24), severity_updated_at: null, ...over,
});

// ── severity 合成（regex 证据 + inner OS 佐证，LLM 单独封顶 sev2）─────────
ok(composeSeverity({ regexSeverity: 3, perceivedHurt: 2 }) === 3, 'sev: regex3+hurt2 → 3');
ok(composeSeverity({ regexSeverity: 0, perceivedHurt: 3 }) === 2, 'sev: LLM 单独信号封顶 2');
ok(composeSeverity({ regexSeverity: 3, perceivedHurt: 0, jokeExempt: true }) === 2, 'sev: 玩笑语境降 1 档');
ok(composeSeverity({ regexSeverity: 4, perceivedHurt: null }) === 4, 'sev: inner OS 没跑时 regex 独立有效');
ok(composeSeverity({ regexSeverity: 0, perceivedHurt: 0 }) === 0, 'sev: 无信号为 0');

// ── 事件类别 ───────────────────────────────────────────────────────────
ok(eventCategory('taboo_hit') === 'wound' && eventCategory('harsh_words') === 'wound'
  && eventCategory('pressure_spam') === 'wound' && eventCategory('neglect') === 'distance', '类别: wound/distance 划分');

// ── normal 态入口 ──────────────────────────────────────────────────────
{
  const r = sig({ signal: { kind: 'harsh_words', severity: 2 } });
  ok(!r.changed && !r.eventOp, 'normal: sev2 不建事件不转移（小事自然消化）');
}
{
  const r = sig({ signal: { kind: 'harsh_words', severity: 3 } });
  ok(r.state === 'hurt' && r.eventOp?.op === 'create' && r.eventOp.severity === 3, 'normal: sev3 → hurt + 建事件');
}
{
  const r = sig({ signal: { kind: 'taboo_hit', severity: 3 }, rng: () => 0.3 });
  ok(r.state === 'normal' && r.voiceConcern === true && r.eventOp?.op === 'create', 'normal: secure 60% voice_concern 直说不进 hurt');
}
{
  const r = sig({ style: 'anxious', signal: { kind: 'taboo_hit', severity: 3 }, rng: () => 0.3 });
  ok(r.state === 'hurt' && !r.voiceConcern, 'normal: anxious 无 voice_concern');
}
{
  const r = sig({ signal: { kind: 'harsh_words', severity: 4 } });
  ok(r.state === 'cold' && r.eventOp?.op === 'create', 'normal: sev4 直接 cold');
}
{
  const r = sig({ style: 'anxious', signal: { kind: 'harsh_words', severity: 2, perceivedHurt: 3 } });
  ok(r.state === 'hurt', 'normal: anxious sev2+hurt3 敏感入 hurt');
  const r2 = sig({ style: 'secure', signal: { kind: 'harsh_words', severity: 2, perceivedHurt: 3 } });
  ok(!r2.changed, 'normal: secure 同信号不入（阈值最高）');
}
{
  const r = sig({ todayEventCount: 3, signal: { kind: 'harsh_words', severity: 3 } });
  ok(!r.changed && !r.eventOp && r.reason === 'daily_cap', '防刷: 每日新建事件上限 3');
}

// ── voice_concern 挂起（normal + open 事件）────────────────────────────
{
  const r = sig({ openEvent: ev({ type: 'taboo_hit' }), signal: { kind: 'apology', apologyKind: 'matched' } });
  ok(r.state === 'normal' && r.eventOp?.op === 'resolve', 'voice_concern: 道歉 → 直接 resolved（说开就好）');
}
{
  const r = sig({ openEvent: ev({ type: 'taboo_hit' }), signal: { kind: 'warm' } });
  ok(r.state === 'normal' && r.eventOp?.op === 'resolve', 'voice_concern: warm → resolved');
}
{
  const r = sig({ openEvent: ev({ type: 'taboo_hit' }), signal: { kind: 'harsh_words', severity: 2 } });
  ok(r.state === 'hurt', 'voice_concern: 继续 harsh → 进 hurt（不二次 voice_concern）');
}

// ── hurt 态 ────────────────────────────────────────────────────────────
{
  const r = sig({ state: 'hurt', openEvent: ev(), signal: { kind: 'apology', apologyKind: 'matched' } });
  ok(r.state === 'repairing' && r.eventOp?.fields?.repair_status === 'repairing'
    && r.eventOp?.fields?.repair_from === 'hurt', 'hurt: matched apology → repairing（记来源）');
}
{
  const r = sig({ state: 'hurt', openEvent: ev(), signal: { kind: 'apology', apologyKind: 'generic' } });
  ok(r.state === 'hurt' && r.eventOp?.fields?.repair_warm === 2, 'hurt: generic apology = warm×2 不直接开门');
}
{
  const r = sig({ state: 'hurt', openEvent: ev({ repair_warm: 2, created_at: hAgo(13) }), signal: { kind: 'warm' } });
  ok(r.state === 'normal' && r.eventOp?.op === 'resolve', 'hurt: warm×3 且 ≥12h → normal（小别扭哄好）');
}
{
  const r = sig({ state: 'hurt', openEvent: ev({ repair_warm: 2, created_at: hAgo(6) }), signal: { kind: 'warm' } });
  ok(r.state === 'hurt', 'hurt: warm×3 但 <12h 不转移（情绪惯性）');
}
{
  const r = sig({ state: 'hurt', openEvent: ev(), signal: { kind: 'harsh_words', severity: 2 } });
  ok(r.state === 'cold', 'hurt: 再 harsh → cold');
}
{
  const r = sig({ state: 'hurt', openEvent: ev(), signal: { kind: 'pressure_spam', severity: 2 } });
  ok(r.state === 'cold', 'hurt: 再 pressure → cold');
}

// ── cold 态 ────────────────────────────────────────────────────────────
{
  const r = sig({ state: 'cold', openEvent: ev(), signal: { kind: 'apology', apologyKind: 'matched' } });
  ok(r.state === 'repairing', 'cold: matched apology → repairing（绝不直回 normal）');
}
{
  const r = sig({ state: 'cold', openEvent: ev(), signal: { kind: 'apology', apologyKind: 'generic' } });
  ok(r.state === 'repairing' && r.eventOp?.fields?.apology_kind === 'generic', 'cold: generic apology 也开门但记 generic（修得慢）');
}
{
  const r = sig({ state: 'cold', openEvent: ev({ type: 'harsh_words', repair_warm: 4 }), signal: { kind: 'warm' } });
  ok(r.state === 'cold' && r.eventOp?.fields?.repair_warm === 5, 'cold: wound 类 warm 计数但不开门（等正面道歉）');
}
{
  const r = sig({ state: 'cold', openEvent: ev({ type: 'neglect', repair_warm: 1 }), signal: { kind: 'warm' } });
  ok(r.state === 'repairing', 'cold: distance 类 warm×2 → repairing（重逢即修复）');
}
{
  const r = sig({ state: 'cold', openEvent: ev({ severity: 3 }), signal: { kind: 'harsh_words', severity: 2 } });
  ok(r.state === 'cold' && r.eventOp?.fields?.severity === 4, 'cold: 再犯 severity+1 保持 cold');
}
{
  const r = sig({ state: 'cold', openEvent: ev({ severity: 3, severity_updated_at: hAgo(2) }), signal: { kind: 'harsh_words', severity: 2 } });
  ok(r.state === 'cold' && !(r.eventOp?.fields?.severity > 3), '防刷: 单事件 severity 升级每日 1 次');
}

// ── withdrawing 态 ─────────────────────────────────────────────────────
{
  const r = sig({ state: 'withdrawing', openEvent: ev(), signal: { kind: 'apology', apologyKind: 'matched' } });
  ok(r.state === 'repairing' && r.eventOp?.fields?.repair_from === 'withdrawing', 'withdrawing: apology → repairing（恢复系数更慢由 need 体现）');
}
{
  const r = sig({ state: 'withdrawing', openEvent: ev({ type: 'harsh_words', repair_warm: 9 }), signal: { kind: 'warm' } });
  ok(r.state === 'withdrawing', 'withdrawing: wound 类光 warm 不开门');
}

// ── repairing 态 ───────────────────────────────────────────────────────
ok(repairNeed('hurt', 'secure', 'matched') === 3 && repairNeed('cold', 'secure', 'matched') === 4
  && repairNeed('withdrawing', 'secure', 'matched') === 6, 'repairNeed: 基准 3/4/6');
ok(repairNeed('hurt', 'anxious', 'matched') === 2, 'repairNeed: anxious −1 软化快');
ok(repairNeed('hurt', 'avoidant', 'matched') === 5, 'repairNeed: avoidant +2 解冻慢');
ok(repairNeed('cold', 'secure', 'generic') === 6, 'repairNeed: generic +2');
{
  const r = sig({ state: 'repairing', stateChangedAt: hAgo(13),
    openEvent: ev({ repair_status: 'repairing', repair_from: 'hurt', repair_warm: 2 }), signal: { kind: 'warm' } });
  ok(r.state === 'normal' && r.eventOp?.op === 'resolve', 'repairing: warm 达标 + ≥12h → normal resolved');
}
{
  const r = sig({ state: 'repairing', stateChangedAt: hAgo(6),
    openEvent: ev({ repair_status: 'repairing', repair_from: 'hurt', repair_warm: 2 }), signal: { kind: 'warm' } });
  ok(r.state === 'repairing', 'repairing: 达标但未到最短时长不转移（不许秒和好）');
}
{
  const r = sig({ state: 'repairing', stateChangedAt: hAgo(13), style: 'anxious',
    openEvent: ev({ repair_status: 'repairing', repair_from: 'hurt', repair_warm: 1 }), signal: { kind: 'warm' } });
  ok(r.state === 'normal', 'repairing: anxious 2 个 warm 就够');
}
{
  const r = sig({ state: 'repairing',
    openEvent: ev({ repair_status: 'repairing', repair_from: 'cold', severity: 3 }), signal: { kind: 'harsh_words', severity: 3 } });
  ok(r.state === 'cold' && r.eventOp?.op === 'reopen' && r.eventOp.severity === 4, 'repairing: 再犯 sev3 → cold 余怒（reopen + severity+1）');
}
{
  const r = sig({ state: 'repairing',
    openEvent: ev({ repair_status: 'repairing', repair_from: 'cold', repair_warm: 3 }), signal: { kind: 'harsh_words', severity: 2 } });
  ok(r.state === 'repairing' && r.eventOp?.fields?.repair_warm === 0, 'repairing: 轻度再犯 sev2 修复进度清零');
}
{
  const r = sig({ state: 'repairing',
    openEvent: ev({ repair_status: 'repairing', repair_from: 'cold', repair_warm: 1 }), signal: { kind: 'give_space' } });
  ok(r.eventOp?.fields?.repair_warm === 2, 'repairing: give_space 计入修复（懂得给空间）');
}

// ── normal_with_scar 态 ────────────────────────────────────────────────
{
  const r = sig({ state: 'normal_with_scar', recentArchivedType: 'taboo_hit',
    signal: { kind: 'taboo_hit', severity: 3 } });
  ok(r.state === 'cold', 'scar: 同类再犯 sev+1（3→4 直接 cold，她记得）');
}
{
  const r = sig({ state: 'normal_with_scar', recentArchivedType: 'taboo_hit',
    signal: { kind: 'harsh_words', severity: 3 } });
  ok(r.state === 'hurt', 'scar: 异类按正常 sev3 → hurt');
}

// ── 时间驱动 tick ──────────────────────────────────────────────────────
{
  const r = tim({ neglectStage: 'disappointed' });
  ok(r.state === 'hurt' && r.eventOp?.op === 'create' && r.eventOp.type === 'neglect', 'time: normal + disappointed → hurt + neglect 事件');
}
{
  const r = tim({ state: 'hurt', openEvent: ev({ type: 'neglect', severity: 2 }), neglectStage: 'withdrawn' });
  ok(r.state === 'cold', 'time: hurt + withdrawn → cold');
}
{
  const r = tim({ state: 'cold', stateChangedAt: hAgo(24), openEvent: ev({ type: 'neglect', severity: 3 }), neglectStage: 'long_gone' });
  ok(r.state === 'withdrawing', 'time: cold + long_gone → withdrawing');
}
{
  const r = tim({ state: 'hurt', stateChangedAt: hAgo(80), openEvent: ev({ created_at: hAgo(80) }), interactionsSinceEvent: 6 });
  ok(r.state === 'normal' && r.eventOp?.op === 'resolve', 'time: hurt 72h+正常互动≥5轮 → 自然消化');
}
{
  const r = tim({ state: 'hurt', stateChangedAt: hAgo(50), openEvent: ev({ created_at: hAgo(50) }), interactionsSinceEvent: 0 });
  ok(r.state === 'cold', 'time: hurt 48h(secure) 零互动 → cold（伤了又晾）');
}
{
  const r = tim({ state: 'hurt', stateChangedAt: hAgo(50), style: 'avoidant', openEvent: ev({ created_at: hAgo(50) }), interactionsSinceEvent: 0 });
  ok(!r.changed, 'time: avoidant 72h 才转（憋着）');
}
{
  const r = tim({ state: 'cold', stateChangedAt: hAgo(49), openEvent: ev() });
  ok(r.state === 'withdrawing', 'time: cold 48h 无修复 → withdrawing');
}
{
  const r = tim({ state: 'cold', stateChangedAt: hAgo(25), openEvent: ev({ reopened: 1 }) });
  ok(r.state === 'withdrawing', 'time: 余怒事件 cold→withdrawing 时长减半（24h）');
}
{
  const r = tim({ state: 'withdrawing', stateChangedAt: hAgo(121), style: 'anxious', openEvent: ev() });
  ok(r.state === 'normal_with_scar' && r.eventOp?.op === 'stale' && r.trustDelta === -3, 'time: anxious 120h 上限 → scar + trust−3 + 事件归档');
}
{
  const r1 = tim({ state: 'withdrawing', stateChangedAt: hAgo(167), openEvent: ev() });
  const r2 = tim({ state: 'withdrawing', stateChangedAt: hAgo(169), openEvent: ev() });
  ok(!r1.changed && r2.state === 'normal_with_scar', 'time: secure 上限 168h 边界');
}
{
  const r1 = tim({ state: 'withdrawing', stateChangedAt: hAgo(239), style: 'avoidant', openEvent: ev() });
  const r2 = tim({ state: 'withdrawing', stateChangedAt: hAgo(241), style: 'avoidant', openEvent: ev() });
  ok(!r1.changed && r2.state === 'normal_with_scar', 'time: avoidant 上限 240h（绝无永久冷战）');
}
{
  const r = tim({ state: 'normal_with_scar', stateChangedAt: hAgo(7 * 24 + 1) });
  ok(r.state === 'normal', 'time: scar 7 天淡出 → normal');
}
{
  const r = tim({ state: 'repairing', stateChangedAt: hAgo(50), openEvent: ev({ repair_status: 'repairing', repair_from: 'cold' }), neglectStage: 'disappointed' });
  ok(r.state === 'cold', 'time: repairing 期又消失 48h → cold（道歉后没诚意）');
}
{
  const r = tim({ neglectStage: 'dormant' });
  ok(r.state === 'normal_with_scar' && r.trustDelta === -3, 'time: normal 直跳 dormant（丢拍兜底）→ scar');
}
{
  const r = tim({ state: 'cold', openEvent: ev({ type: 'neglect', severity: 3 }), neglectStage: 'withdrawn' });
  ok(!r.changed, 'time: 幂等——已 cold 再报 withdrawn 不动');
}

// ── safe_mode 封顶 hurt（未成年保护，红线 #6）──────────────────────────
{
  const r = sig({ safeMode: true, signal: { kind: 'harsh_words', severity: 4 } });
  ok(r.state === 'hurt', 'safe_mode: sev4 封顶 hurt 不进 cold');
}
{
  const r = sig({ safeMode: true, state: 'hurt', openEvent: ev(), signal: { kind: 'harsh_words', severity: 3 } });
  ok(r.state === 'hurt', 'safe_mode: hurt 再 harsh 仍封顶 hurt');
}
{
  const r = tim({ safeMode: true, state: 'hurt', stateChangedAt: hAgo(50), openEvent: ev({ created_at: hAgo(50) }), interactionsSinceEvent: 0 });
  ok(r.state !== 'cold' && r.state !== 'withdrawing', 'safe_mode: 时间路径也到不了 cold/withdrawing');
}

console.log(`conflict_arc_smoke: 通过 ${pass} 失败 ${fail}`);
process.exit(fail ? 1 : 0);
