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
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

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
// 归一化：去时间戳、companion=N→#、长数字/hex→#、引号内容→"…"，让同类错误聚成一个签名。
// 环比 = 对比上一个同长窗口；新签名（上窗口没出现过）置顶高亮。纯读日志文件。
function normalizeErrorSignature(line) {
  return line
    .replace(/^\[[^\]]+\]\s*/, '')                       // 去时间戳前缀
    .replace(/companion[=\s]#?\d+/gi, 'companion=#')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')                  // hex id / clientId
    .replace(/\b\d{3,}\b/g, '#')                         // 长数字（端口/毫秒/计数）
    .replace(/"[^"]{0,60}"/g, '"…"').replace(/「[^」]{0,60}」/g, '「…」')
    .trim().slice(0, 140);
}

async function collectErrorSignatures(file, sinceMs, untilMs) {
  const sigs = new Map();   // sig -> { count, firstAt, lastAt }
  if (!existsSync(file)) return sigs;
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('[ERROR]')) continue;
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
    console.log(`✅ 错误签名：窗口内零 [ERROR]（${LOG_FILE}）\n`);
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

console.log('\n════ 报表完（纯只读，无任何回写）════');
