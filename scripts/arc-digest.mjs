/**
 * arc-digest.mjs —— 冲突弧观察周日报（v1.21.1 PR-B；v1.21.2 加错误签名段）。
 *
 * 用法：npm run arc:digest [-- --days N] [-- --log path/to/bot.log]
 *       生产：DB_PATH=/opt/xiyu-ai-new/data/bot.db LOG_DIR=/opt/xiyu-ai-new/logs npm run arc:digest
 *
 * 红线：**纯只读报表**（readonly 连接 + 只读日志文件）。不做任何自动调参、
 * 不接任何阈值回写——观察周的产出是运营者的人工判断，不是脚本的。
 */
import Database from 'better-sqlite3';
import { existsSync, createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isReportableErrorLine, normalizeErrorSignature } from './error_signature.mjs';
import { parseUiLayers, parityOffenders } from './memory_chip_parity_smoke.mjs';
import { parseReflectionRollup } from '../src/reflection_heartbeat.mjs';
import { parseDeadmanCycle } from '../src/proactive_heartbeat.mjs';

const DB_PATH = process.env.DB_PATH || 'data/bot.db';
const daysIdx = process.argv.indexOf('--days');
const DAYS = daysIdx > 0 ? Math.max(0.05, Number(process.argv[daysIdx + 1]) || 1) : 1;
const sinceIso = new Date(Date.now() - DAYS * 86400e3).toISOString();
const logIdx = process.argv.indexOf('--log');
const LOG_FILE = logIdx > 0
  ? process.argv[logIdx + 1]
  : path.join(process.env.LOG_DIR || 'logs', 'bot.log');

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

// ── 0. 错误签名（v1.21.2，#263 后续：那 665 条同签名错误要在第一行尖叫）────────
// 归一化 + 上报判定抽到 error_signature.mjs（可单测）。环比 = 对比上一个同长窗口；
// 新签名（上窗口没出现过）置顶高亮。纯读日志文件。
// v1.21.6：扫描范围从「只 [ERROR]」扩到「[ERROR] + 高信号 [WARN]」——planner 对象断图
// 的 400 是 [WARN][ai]，旧扫描漏了它 1.5 天（isReportableErrorLine 已对它回测过）。
async function collectErrorSignatures(file, sinceMs, untilMs) {
  const sigs = new Map();   // sig -> { count, firstAt, lastAt }
  if (!existsSync(file)) return sigs;
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!isReportableErrorLine(line)) continue;
    const tm = line.match(/^\[([^\]]+)\]/);
    const ts = tm ? new Date(tm[1]).getTime() : NaN;
    if (!Number.isFinite(ts) || ts < sinceMs || ts >= untilMs) continue;
    const sig = normalizeErrorSignature(line);
    const e = sigs.get(sig) || { count: 0, firstAt: ts, lastAt: ts };
    e.count++; e.lastAt = ts; if (ts < e.firstAt) e.firstAt = ts;
    sigs.set(sig, e);
  }
  return sigs;
}

{
  const now = Date.now();
  const winMs = DAYS * 86400e3;
  const cur = await collectErrorSignatures(LOG_FILE, now - winMs, now);
  const prev = await collectErrorSignatures(LOG_FILE, now - 2 * winMs, now - winMs);
  if (!existsSync(LOG_FILE)) {
    console.log(`（日志文件不存在：${LOG_FILE}——用 --log 或 LOG_DIR 指定）\n`);
  } else if (!cur.size) {
    console.log(`✅ 错误签名：窗口内零 [ERROR] / 零高信号 [WARN]（${LOG_FILE}）\n`);
  } else {
    const rows = [...cur.entries()]
      .map(([sig, e]) => ({ sig, ...e, prevCount: prev.get(sig)?.count || 0, isNew: !prev.has(sig) }))
      .sort((a, b) => (b.isNew - a.isNew) || (b.count - a.count));
    const total = rows.reduce((s, r) => s + r.count, 0);
    console.log(`🔴 错误签名：${rows.length} 种 / 共 ${total} 条（新签名置顶——每一条都该有人认领）`);
    for (const r of rows.slice(0, 15)) {
      const delta = r.prevCount === 0 ? (r.isNew ? '🆕 新签名' : '环比 +∞')
        : `环比 ${r.count >= r.prevCount ? '+' : ''}${(((r.count - r.prevCount) / r.prevCount) * 100).toFixed(0)}%`;
      console.log(`  ${r.isNew ? '🆕' : '  '} ×${String(r.count).padStart(4)}  ${delta.padEnd(10)}  首现 ${fmtT(new Date(r.firstAt).toISOString())}`);
      console.log(`       ${r.sig}`);
    }
    if (rows.length > 15) console.log(`  …还有 ${rows.length - 15} 种（低频）`);
    console.log('');
  }
}

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
  if (ev.trigger_text) console.log(`      起因: ${cut(ev.trigger_text, 50)}  → 标注: /app/annotate.html?companion=${ev.companion_id}`);
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

// ── 7. 照片比例分布（v1.21.2 PR-D：1:1 错了半月才被肉眼发现，下次自己跳出来）──
if (hasTable('companion_photo_log')) {
  const photos = db.prepare(`
    SELECT shot_mode, aspect, width, height, COUNT(*) AS n FROM companion_photo_log
    WHERE datetime(created_at) >= datetime(?) GROUP BY shot_mode, width, height ORDER BY n DESC`).all(sinceIso);
  console.log('\n── 照片比例分布（机位 × 实际尺寸）──');
  let bad = 0;
  for (const p of photos) {
    const ratio = p.width && p.height ? (p.width / p.height).toFixed(3) : '?';
    const wantPortrait = p.shot_mode !== 'SCENERY';
    const okMark = !p.width ? '?' : (wantPortrait ? (p.height > p.width ? '✓' : '⚠非竖屏') : '✓');
    if (okMark.startsWith('⚠')) bad++;
    console.log(`  ${String(p.shot_mode || '?').padEnd(13)} ${p.width}x${p.height} (${ratio})  ×${p.n}  ${okMark}`);
  }
  if (!photos.length) console.log('  （窗口内无照片）');
  if (bad) console.log(`  ⚠ ${bad} 种尺寸与机位预期不符——查 provider/转码链`);
}

// ── 8. proactive 素材复用 TOP（v1.21.3 PR-E：「小汤圆」3 天 3 次——账本冷却
//      生效后这里不该出现 >2 的复用；出现了就是过滤/归因哪里漏了）────────────
if (hasTable('companion_proactive_material_log')) {
  const matRows = db.prepare(`
    SELECT companion_id, material_ids FROM companion_proactive_material_log
    WHERE datetime(used_at) >= datetime(?)`).all(sinceIso);
  const matCount = new Map();
  for (const r of matRows) {
    try {
      for (const id of JSON.parse(r.material_ids)) {
        const key = `${cname(r.companion_id)} ${id}`;
        matCount.set(key, (matCount.get(key) || 0) + 1);
      }
    } catch {}
  }
  const top = [...matCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log('\n── proactive 素材复用 TOP（同素材 >2 = 去重漏了）──');
  for (const [key, n] of top) console.log(`  ${key}  × ${n}${n > 2 ? '  ⚠' : ''}`);
  if (!top.length) console.log('  （窗口内无素材引用记录）');
}

// ── 8.5 入站二级查重命中（#279 纵深：协议重推拦截统计——命中本身走 [ERROR]
//      进上面签名段，这里给个独立计数好看趋势）────────────────────────────
if (existsSync(LOG_FILE)) {
  const _dedupSinceMs = Date.now() - DAYS * 86400e3;
  let dedupHits = 0;
  const rl2 = createInterface({ input: createReadStream(LOG_FILE, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl2) {
    if (!line.includes('[InboundDedup] 协议重推拦截')) continue;
    const tm = line.match(/^\[([^\]]+)\]/);
    const ts = tm ? new Date(tm[1]).getTime() : NaN;
    if (Number.isFinite(ts) && ts >= _dedupSinceMs) dedupHits++;
  }
  console.log(`\n── 入站二级查重：窗口内协议重推拦截 ${dedupHits} 次${dedupHits ? '（iLink 在重推，关注频率）' : ''} ──`);
}

// ── 8.6 表情冒充照片拦截（#281 出口护栏：她自称"刚拍的"却没真发图——
//      命中走 [ERROR] 进上面签名段，这里独立计数看趋势）──────────────────
if (existsSync(LOG_FILE)) {
  const _piSinceMs = Date.now() - DAYS * 86400e3;
  let piHits = 0;
  const rl3 = createInterface({ input: createReadStream(LOG_FILE, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl3) {
    if (!line.includes('[PhotoImpersonation] 表情冒充照片拦截')) continue;
    const tm = line.match(/^\[([^\]]+)\]/);
    const ts = tm ? new Date(tm[1]).getTime() : NaN;
    if (Number.isFinite(ts) && ts >= _piSinceMs) piHits++;
  }
  console.log(`\n── 表情冒充照片：窗口内拦截 ${piHits} 次${piHits > 3 ? '（频繁——查 sticker prompt 是否又被绕过）' : ''} ──`);
}

// ── 8.7 照片承诺兑现（#PR-B：承诺→兑现/改期，不再"说了不做"）──────────────
if (existsSync(LOG_FILE)) {
  const _ppSinceMs = Date.now() - DAYS * 86400e3;
  let fail = 0;
  const rl4 = createInterface({ input: createReadStream(LOG_FILE, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl4) {
    if (!line.includes('[PhotoPromise]')) continue;
    const tm = line.match(/^\[([^\]]+)\]/);
    const ts = tm ? new Date(tm[1]).getTime() : NaN;
    if (Number.isFinite(ts) && ts >= _ppSinceMs && line.includes('失败')) fail++;
  }
  // 当前未履约的 her_promise（欠着的照片债）
  let owing = 0;
  if (hasTable('companion_open_loops')) {
    owing = db.prepare(`SELECT COUNT(*) n FROM companion_open_loops WHERE loop_kind='her_promise' AND status='open'`).get()?.n || 0;
  }
  console.log(`\n── 照片承诺：窗口内兑现失败 ${fail} 次 / 当前欠着未补 ${owing} 笔${owing > 5 ? '（积压——查 proactive 补发是否在跑）' : ''} ──`);
}

// ── 9. 互动历史回填状态（v1.21.3 PR-D：后台批任务静默死最难发现——#263 教训。
//      失败的 error 会进上面错误签名段，这里看队列水位）────────────────────
{
  const tiers = db.prepare(`
    SELECT COALESCE(history_backfill_tier, CASE WHEN history_backfilled_at IS NOT NULL THEN 'full(存量)' ELSE '未回填' END) AS t,
           COUNT(*) AS n
    FROM companions GROUP BY t ORDER BY n DESC`).all();
  console.log('\n── 互动历史回填分布（thin=薄版待升全量）──');
  for (const t of tiers) console.log(`  ${String(t.t).padEnd(12)} ${t.n}`);
}

// ── current_works 建档流水（v1.21.4 PR-W1：双闸的生产首考要在早报一眼可见）──
if (hasTable('companion_current_works')) {
  const works = db.prepare(`
    SELECT cw.companion_id, cw.kind, cw.title, cw.creator, cw.verify_status, cw.started_at, c.name
    FROM companion_current_works cw JOIN companions c ON c.id = cw.companion_id
    WHERE datetime(cw.started_at) >= datetime(?) ORDER BY cw.started_at DESC`).all(sinceIso);
  const nV = works.filter(w => w.verify_status === 'verified').length;
  const nG = works.filter(w => w.verify_status === 'generic').length;
  console.log(`\n── current_works 建档流水：${works.length} 条（近 ${DAYS} 天；verified ${nV} / generic 降级 ${nG}）──`);
  for (const w of works.slice(0, 20)) {
    const tag = w.verify_status === 'verified' ? '✅ verified'
      : w.verify_status === 'generic' ? '⚠ generic（降级泛读：搜不到 / provider 故障 / 日上限）'
        : 'skip(craft)';
    console.log(`  ${fmtT(w.started_at)}  ${cname(w.companion_id)}  ${w.kind}「${cut(w.title, 20)}」${w.creator ? '/' + cut(w.creator, 12) : ''}  ${tag}`);
  }
  if (!works.length) console.log('  （无——00:30 批未跑或无活跃 companion）');
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const used = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(`works_verify_${today}`);
  console.log(`  今日验证搜索：${used?.value || 0} 次 / 上限 ${process.env.WORKS_VERIFY_DAILY_CAP || 50}（异常烧配额的护栏）`);
}

// ── reflection 批产出（正向心跳：没有报错 ≠ 有产出）──
// 真源是日志里的 `[PlanTasks] *-reflection done ... candidates/inserted/merged/rejected/updated`，
// 不查 DB 的 memory_source（reflection insert 路径未落 source，DB 计数会骗人）。rejected>0=有记忆在蒸发。
{
  const rollups = [];
  if (existsSync(LOG_FILE)) {
    const rl = createInterface({ input: createReadStream(LOG_FILE, { encoding: 'utf8' }), crlfDelay: Infinity });
    const sinceMs = Date.now() - DAYS * 86400e3;
    for await (const line of rl) {
      const tm = line.match(/^\[([^\]]+)\]/);
      const ts = tm ? new Date(tm[1]).getTime() : NaN;
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      const r = parseReflectionRollup(line);
      if (r) rollups.push({ ts, ...r });
    }
  }
  if (!rollups.length) {
    console.log(`\n⚠ reflection 批产出：近 ${DAYS} 天日志无 *-reflection done 心跳行（批没跑完 / 日志未含 / 旧版无此行）`);
  } else {
    const totRej = rollups.reduce((s, r) => s + r.rejected, 0);
    console.log(`\n── reflection 批产出：${rollups.length} 批（近 ${DAYS} 天）${totRej ? ` 🔴 共 ${totRej} 条被拒蒸发` : ''} ──`);
    for (const r of rollups.slice(-7)) {
      console.log(`  ${fmtT(new Date(r.ts).toISOString())}  ${r.kind} ${r.date}  ran=${r.ran}  提议 ${r.candidates} → 入 ${r.inserted}/并 ${r.merged}/更 ${r.updated}${r.rejected ? `  🔴 拒 ${r.rejected}` : ''}`);
    }
    if (totRej) console.log('   拒>0：有记忆产出在静默蒸发（查 [Reflection] insert 失败 的 CHECK/约束原因）');
  }
}

// ── proactive 健康三桶（#263 误报修：克制 ≠ 断供）──
// 数据源：deadman 每周期写的 [Deadman] cycle 心跳行（emit↔parse 契约由 proactive_heartbeat_smoke 锁）。
// 红线同 deadman：纯只读。🟡 持续克制=正常（不发邮件，本段可见即可——per-companion 卡死 bug 在此露馅）；
// 🔴 errored>0=疑似 #263（即便同窗有 sent 也要查，别让"一次成功"遮报错）。
{
  const sumVals = (o) => Object.values(o || {}).reduce((a, b) => a + Number(b), 0);
  const cycles = [];
  if (existsSync(LOG_FILE)) {
    const rl = createInterface({ input: createReadStream(LOG_FILE, { encoding: 'utf8' }), crlfDelay: Infinity });
    const sinceMs = Date.now() - DAYS * 86400e3;
    for await (const line of rl) {
      const tm = line.match(/^\[([^\]]+)\]/);
      const ts = tm ? new Date(tm[1]).getTime() : NaN;
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      const c = parseDeadmanCycle(line);
      if (c) cycles.push({ ts, ...c });
    }
  }
  const appVal = (k) => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(k)?.value;
  const strikes = Number(appVal('proactive_deadman_strikes') || 0);
  const lastAlertMs = Number(appVal('proactive_deadman_last_alert') || 0);
  const tickRun = appVal('proactive_tick_last_run');
  const tickAgeMin = tickRun ? Math.round((Date.now() - Number(tickRun)) / 60000) : null;

  console.log(`\n── proactive 健康（近 ${DAYS} 天）strikes=${strikes}${strikes >= 2 ? ' 🔴' : ''}  tick 心跳=${tickAgeMin == null ? '⚠ 从未写入' : tickAgeMin + 'min 前'}${lastAlertMs ? `  上次告警 ${fmtT(new Date(lastAlertMs).toISOString())}` : ''} ──`);
  if (!cycles.length) {
    console.log(`  ⚠ 近 ${DAYS} 天日志无 [Deadman] cycle 心跳行（批没跑完 / 日志未含 / 旧版无此行）`);
  } else {
    const sum = cycles.reduce((a, c) => ({ sent: a.sent + c.sent, restrained: a.restrained + c.restrained, errored: a.errored + c.errored }), { sent: 0, restrained: 0, errored: 0 });
    const errWins = cycles.filter(c => c.errored > 0);
    console.log(`  三桶累计（${cycles.length} 周期）：已发送 ${sum.sent} / 克制 ${sum.restrained} / 错误 ${sum.errored}${sum.errored ? ` 🔴（${errWins.length} 个窗有 errored，即便同窗有 sent 也要查）` : ''}`);
    // per-companion 克制细分（补充③：谁·在用户活跃期被持续克制·各自主因）
    const byComp = {};
    for (const c of cycles) for (const [cid, reasons] of Object.entries(c.restrainedBy || {})) {
      byComp[cid] = byComp[cid] || {};
      for (const [rsn, n] of Object.entries(reasons)) byComp[cid][rsn] = (byComp[cid][rsn] || 0) + Number(n);
    }
    const compRows = Object.entries(byComp).sort((a, b) => sumVals(b[1]) - sumVals(a[1]));
    if (compRows.length) {
      console.log('  🟡 用户活跃期被持续克制（正当·不告警，仅可见——per-companion 卡死 bug 会在此露馅）：');
      for (const [cid, reasons] of compRows.slice(0, 8)) {
        const detail = Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([rsn, n]) => `${rsn}×${n}`).join(' ');
        console.log(`    ${cname(Number(cid))}  克制 ${sumVals(reasons)} 次：${detail}`);
      }
    }
    for (const c of errWins.slice(-5)) {
      console.log(`  🔴 ${fmtT(new Date(c.ts).toISOString())}  active=${c.active} sent=${c.sent} errored=${c.errored} bucket=${c.bucket} strikes=${c.strikes}`);
    }
  }
}

// ── 记忆 chip↔layer 对账（方向②夜间报警：有数据却无 chip = 数据藏起来了）──
// 2026-06-12 删 core_persona/relationship_rule 两 chip 后立此哨兵：reflection 若复活
// 产出 relationship_rule，这里会变红，chip 按警报回归而非凭记忆。纯只读。
{
  const layersWithData = new Set(
    db.prepare("SELECT DISTINCT memory_layer FROM companion_memories WHERE memory_status != 'deleted' AND memory_layer IS NOT NULL")
      .all().map(r => r.memory_layer),
  );
  const htmlPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/app/memories.html');
  const { chip } = parseUiLayers(readFileSync(htmlPath, 'utf8'));
  const offenders = parityOffenders(chip, layersWithData);
  if (offenders.length) {
    console.log(`\n🔴 记忆 chip 对账：${offenders.length} 个 layer 有数据却无 chip ➜ ${offenders.join(', ')}`);
    console.log('   （数据存在但用户看不见——按警报给它们加回 memories.html 的 chip）');
  } else {
    console.log(`\n✅ 记忆 chip 对账：${layersWithData.size} 个有数据 layer 全有 chip（无隐藏抽屉）`);
  }
}

// ── 部署漂移（"fix 进仓库 ≠ 进生产"的系统解：让漂移每早自报数）──
// reflection slice 修复 6-02 进仓库、6-11 还在生产报错——本机部署的 commit vs main tip 一对比
// 就能一眼看见"已合未部署"积压。纯只读：git fetch 只动 .git refs，不碰工作树/DB。最佳努力，失败不阻断。
{
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const git = (args) => execSync(`git ${args}`, { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    const head = git('rev-parse --short HEAD');
    try { git('fetch origin main --quiet'); } catch { /* 无网/无权限：用本地已知 origin/main（可能偏旧）*/ }
    const behind = Number(git('rev-list --count HEAD..origin/main') || 0);
    if (behind === 0) {
      console.log(`\n✅ 部署漂移：本机已是 main tip（${head}），无已合未部署 commit`);
    } else {
      const oldestIso = git('log HEAD..origin/main --reverse --format=%cI -1');
      const ageH = oldestIso ? Math.floor((Date.now() - new Date(oldestIso).getTime()) / 3600e3) : '?';
      const flag = ageH !== '?' && ageH >= 24 ? '🔴' : '🟡';
      console.log(`\n${flag} 部署漂移：本机(${head}) 落后 origin/main ${behind} 个 commit——最老一笔已合并 ${ageH}h 未部署（部署=pull+restart）`);
    }
  } catch (e) {
    console.log(`\n部署漂移：无法判定（${String(e.message).split('\n')[0]}）`);
  }
}

console.log('\n════ 报表完（纯只读，无任何回写）════');
