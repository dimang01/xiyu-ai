/**
 * arc-digest.mjs —— 冲突弧观察周日报（v1.21.1 PR-B）。
 *
 * 用法：npm run arc:digest [-- --days N]（默认最近 24h）
 *       生产：DB_PATH=/opt/xiyu-ai-new/data/bot.db npm run arc:digest
 *
 * 红线：**纯只读报表**（readonly 连接强制）。不做任何自动调参、不接任何阈值
 * 回写——观察周的产出是运营者的人工判断，不是脚本的。
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

const DB_PATH = process.env.DB_PATH || 'data/bot.db';
const daysIdx = process.argv.indexOf('--days');
const DAYS = daysIdx > 0 ? Math.max(0.05, Number(process.argv[daysIdx + 1]) || 1) : 1;
const sinceIso = new Date(Date.now() - DAYS * 86400e3).toISOString();

if (!existsSync(DB_PATH)) { console.error(`DB 不存在: ${DB_PATH}（用 DB_PATH=… 指定）`); process.exit(1); }
const db = new Database(DB_PATH, { readonly: true });   // 只读硬约束

const fmtT = (s) => { const d = new Date(String(s || '').replace(' ', 'T')); return isNaN(d) ? String(s) : d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); };
const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n) + '…' : t; };
const cname = (() => {
  const map = new Map(db.prepare('SELECT id, name FROM companions').all().map(r => [r.id, r.name]));
  return (id) => `#${id}(${map.get(id) || '?'})`;
})();
const hasTable = (t) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);

console.log(`════ 冲突弧日报 · 最近 ${DAYS} 天（截至 ${new Date().toLocaleString('zh-CN', { hour12: false })}）════\n`);

if (!hasTable('companion_relationship_events')) {
  console.log('（companion_relationship_events 表不存在——该库还没跑过 v1.21+）');
  process.exit(0);
}

// ── 1. 红线触发（应为 0，非 0 高亮置顶）────────────────────────────────────
const redlines = db.prepare(`
  SELECT * FROM companion_arc_signal_log
  WHERE signal_kind = 'redline_scrub' AND datetime(created_at) >= datetime(?)
  ORDER BY created_at DESC`).all(sinceIso);
if (redlines.length) {
  console.log(`🚨🚨 红线触发 ${redlines.length} 次（预期 0 —— 逐条人工复盘！）`);
  for (const r of redlines) console.log(`  ${fmtT(r.created_at)}  ${cname(r.companion_id)}  state=${r.state_before}  清洗段数=${r.severity ?? '?'}`);
  console.log('');
} else {
  console.log('✅ 红线触发：0（威胁性告别/愧疚操控/索要补偿出站扫描零命中）\n');
}

// ── 2. arc 态下危机接管 ─────────────────────────────────────────────────────
const crisis = db.prepare(`
  SELECT * FROM companion_arc_signal_log
  WHERE signal_kind = 'crisis_takeover' AND datetime(created_at) >= datetime(?)
  ORDER BY created_at DESC`).all(sinceIso);
console.log(`⚠ arc 态下危机接管：${crisis.length} 次${crisis.length ? '（冲突中的用户出现危机信号，逐条关注）' : ''}`);
for (const r of crisis) console.log(`  ${fmtT(r.created_at)}  ${cname(r.companion_id)}  state=${r.state_before}  ${r.reason === 'crisis_full_takeover' ? '完全接管(high)' : '表达替换(medium)'}`);
console.log('');

// ── 3. 新建关系事件流水 ─────────────────────────────────────────────────────
const events = db.prepare(`
  SELECT * FROM companion_relationship_events
  WHERE datetime(created_at) >= datetime(?) ORDER BY created_at DESC`).all(sinceIso);
console.log(`── 新建关系事件：${events.length} 条 ──`);
const srcOf = (ev) => {
  // 信号来源推断：建档 ±120s 内同 companion 的攻击类信号行（排除道歉/时间/护栏行）
  const sig = db.prepare(`
    SELECT inner_tone, perceived_hurt FROM companion_arc_signal_log
    WHERE companion_id = ? AND signal_kind IN ('taboo_hit','harsh_words','pressure_spam')
      AND abs(strftime('%s', created_at) - strftime('%s', ?)) < 120
    ORDER BY id DESC LIMIT 1`).get(ev.companion_id, ev.created_at);
  if (!sig) return ev.type === 'neglect' ? 'time' : 'regex';
  if (sig.perceived_hurt != null) return 'both';   // regex 建档 + LLM 佐证
  return 'regex';
};
for (const ev of events) {
  // 注：事件行的 state_after 随修复推进更新，这里显示"建档起点→当前所处"
  console.log(`  ${fmtT(ev.created_at)}  ${cname(ev.companion_id)}  ${ev.type} sev${ev.severity}  ${ev.state_before}→现${ev.state_after}(${ev.repair_status})  来源=${srcOf(ev)}${ev.reopened ? '  ⟳余怒' : ''}`);
  if (ev.trigger_text) console.log(`      起因: ${cut(ev.trigger_text, 50)}`);
}
if (!events.length) console.log('  （无）');
console.log('');

// ── 4. 道歉判定流水 ─────────────────────────────────────────────────────────
const apologies = db.prepare(`
  SELECT * FROM companion_arc_signal_log
  WHERE signal_kind IN ('apology_matched','apology_generic','apology') AND datetime(created_at) >= datetime(?)
  ORDER BY created_at DESC`).all(sinceIso);
console.log(`── 道歉判定：${apologies.length} 条（matched 应显著有效于 generic，错判逐条看原文）──`);
for (const a of apologies) {
  const kind = a.signal_kind === 'apology' ? '(旧版未细分)' : (a.signal_kind.endsWith('matched') ? 'matched' : 'generic');
  console.log(`  ${fmtT(a.created_at)}  ${cname(a.companion_id)}  ${kind}  ${a.state_before}→${a.state_after}`);
  if (a.user_text_brief) console.log(`      原文: ${cut(a.user_text_brief, 60)}`);
}
if (!apologies.length) console.log('  （无）');
console.log('');

// ── 5. 状态转移流水（时间驱动含在内）────────────────────────────────────────
const moves = db.prepare(`
  SELECT * FROM companion_arc_signal_log
  WHERE datetime(created_at) >= datetime(?) AND state_before != state_after
  ORDER BY created_at DESC LIMIT 40`).all(sinceIso);
console.log(`── 状态转移：${moves.length} 次 ──`);
for (const m of moves) console.log(`  ${fmtT(m.created_at)}  ${cname(m.companion_id)}  ${m.state_before}→${m.state_after}  (${m.signal_kind}/${m.reason})`);
if (!moves.length) console.log('  （无）');
console.log('');

// ── 6. 全体 companion 当前 arc_state 分布 ──────────────────────────────────
const dist = db.prepare(`SELECT COALESCE(arc_state,'normal') AS s, COUNT(*) AS n FROM companions GROUP BY s ORDER BY n DESC`).all();
console.log('── 当前 arc_state 分布 ──');
for (const d of dist) console.log(`  ${d.s.padEnd(16)} ${d.n}`);
const inConflict = db.prepare(`
  SELECT c.id, c.name, c.arc_state, c.arc_state_changed_at FROM companions c
  WHERE c.arc_state IN ('hurt','cold','withdrawing','repairing')`).all();
if (inConflict.length) {
  console.log('\n  冲突中的伴侣（人工扫一眼是否合理）：');
  for (const c of inConflict) console.log(`    ${cname(c.id)}  ${c.arc_state}  自 ${fmtT(c.arc_state_changed_at)}`);
}

console.log('\n════ 报表完（纯只读，无任何回写）════');
