/**
 * retention-board.mjs —— 真实留存看板（PR-0，2026-06-14）。纯只读分析工具，零改动生产行为。
 *
 * 用法：DB_PATH=/opt/xiyu-ai-new/data/bot.db npm run retention:board
 *       [-- --days N]（proactive/hard-break 统计窗口，默认全量；per-user 留存恒为全量）
 *
 * ── 口径（统一·可 SQL 复跑）────────────────────────────────────────────────
 * · 真实活跃 = `companion_conversation_turns.synthetic=0 AND role='user'`。
 *   注册时 90 天模拟养成史经 backfill 批量插入置 synthetic=1；真实聊天经 saveConversationTurn
 *   为 0/null。比 :00/:30 时间戳规律可靠（实测真实长聊有 2 条恰好撞 :30 秒）。
 * · proactive(bot 单方面) = assistant turn 在「同 companion 同 created_at」找不到配对 user turn。
 *   真实回复对的 user+assistant 共享精确时间戳；standalone assistant = 主动消息/早安/场景照。
 *   等价 SQL：assistant a WHERE NOT EXISTS(user u: u.companion_id=a.companion_id AND u.created_at=a.created_at)。
 * · 锚点 today = 沪时区(UTC+8)当天。真实外部用户 = 剔除自有号 user1/2/3(test/test1/storm)。
 * · 留存只看真实 user 消息——bot 的 proactive 不算"用户回来了"。
 *
 * ⚠ 已知局限（看板对此诚实）：`companion_conversation_turns` 每 companion 只保留最新 100 条
 *   (runHourlyCleanup)，>100 turn 的高量用户**真开场可能已被裁**，per-user 表会标 [turn 满100·开场或已裁]。
 *
 * 红线：只读连接 + 不写任何东西 + 不碰 prompt/proactive/arc/emotion/persona。纯算数出表。
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */
import Database from 'better-sqlite3';
import { normalizeForSim, findCollision } from '../src/text_similarity.mjs';

const SH = 8 * 3600e3;                 // 沪时区偏移
const DAY = 86400e3;
export const toMs = (s) => new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z')).getTime();
export const shDate = (ms) => new Date(ms + SH).toISOString().slice(0, 10);
export const addDays = (dateStr, n) => new Date(Date.parse(dateStr + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

// ── 留存（一个 companion 的真实 user 活跃日历天）──────────────────────────────
export function computeRetention(realUserTurnsMs, todayDate) {
  const dates = [...new Set(realUserTurnsMs.map(shDate))].sort();
  if (!dates.length) return null;
  const day0 = dates[0];
  const has = (d) => dates.includes(d);
  const within7 = dates.some((d) => d > day0 && d <= addDays(day0, 7));
  const lastDate = dates[dates.length - 1];
  return {
    day0, dates, activeDays: dates.length,
    day1: has(addDays(day0, 1)),
    day2: has(addDays(day0, 2)),
    day7: within7,                       // (Day0, Day0+7] 内有第二个及以后活跃日
    ret2: dates.length >= 2,
    lastDate,
    daysSinceLast: Math.round((Date.parse(todayDate + 'T00:00:00Z') - Date.parse(lastDate + 'T00:00:00Z')) / DAY),
    activeRecent: lastDate >= addDays(todayDate, -2),   // 近 3 天(含今天)有真实活跃
  };
}

// ── proactive 判定：assistant turn 同 ts 无配对 user turn ────────────────────
export function isProactive(turn, sameCompanionTurns) {
  if (turn.role !== 'assistant' || turn.syn) return false;
  return !sameCompanionTurns.some((t) => t.role === 'user' && !t.syn && t.ts === turn.ts);
}
export function findProactive(turns) {
  return turns.filter((t) => isProactive(t, turns));
}

// ── proactive 效果（救人 or 赶人）────────────────────────────────────────────
export function proactiveStats(turns) {
  const userMs = turns.filter((t) => t.role === 'user' && !t.syn).map((t) => t.ts).sort((a, b) => a - b);
  const repliedWithin = (ts, win) => userMs.some((u) => u > ts && u <= ts + win);
  const pro = findProactive(turns).sort((a, b) => a.ts - b.ts);
  let reply60 = 0, zero24h = 0;
  for (const p of pro) {
    if (repliedWithin(p.ts, 60 * 60e3)) reply60++;
    if (!repliedWithin(p.ts, DAY)) zero24h++;
  }
  // 连续 ≥2 条 proactive 之间无 user turn 的"对空气连发"run 数
  const chrono = turns.slice().sort((a, b) => a.ts - b.ts);
  let runs = 0, run = 0;
  for (const t of chrono) {
    if (t.syn) continue;
    if (isProactive(t, turns)) { run++; if (run === 2) runs++; }      // 一段 run 跨过 2 时计一次
    else if (t.role === 'user') run = 0;
  }
  return { total: pro.length, reply60, reply60Rate: pro.length ? reply60 / pro.length : 0, zero24h, blindRuns: runs };
}

// ── 回来接力：每个 return 日的首条真实 user 消息，往前找最近一条 bot 消息 ──────
export function returnTouchpoints(turns, retention) {
  const out = [];
  if (!retention) return out;
  const realUser = turns.filter((t) => t.role === 'user' && !t.syn).sort((a, b) => a.ts - b.ts);
  const asst = turns.filter((t) => t.role === 'assistant' && !t.syn).sort((a, b) => a.ts - b.ts);
  for (const d of retention.dates.slice(1)) {                 // dates[0]=Day0，其余都是"回来"
    const first = realUser.find((u) => shDate(u.ts) === d);
    if (!first) continue;
    const prior = asst.filter((a) => a.ts < first.ts).pop();
    const gapMin = prior ? Math.round((first.ts - prior.ts) / 60e3) : null;
    let label;
    if (!prior) label = '冷启动·无 bot 触点';
    else if (isProactive(prior, turns)) label = `被「${prior.topic || '主动消息'}」接回`;
    else label = '续聊(上一句是回复)';
    out.push({ date: d, firstUser: first.content, label, gapMin, priorTopic: prior?.topic || null });
  }
  return out;
}

// ── hard break：复读（最易检出）+ 凭空进食（场景矛盾抽样）──────────────────────
// 身份矛盾(persona 崩)需语义判断，本看板不自动判（会把"bot 正确拒绝套身份"误报成崩）——留人眼。
const EAT_RE = /^(?:\(.*?\)|（.*?）)?\s*(刚吃完|刚喝完|刚吃了|刚喝了|刚煮了|刚点的?|刚买的?).{0,12}(面|饭|粉|奶茶|咖啡|外卖|火锅|香锅|包|蛋|肉|菜|茶)/;
export function findHardBreaks(turns) {
  const asst = turns.filter((t) => t.role === 'assistant' && !t.syn).sort((a, b) => a.ts - b.ts);
  const realUser = turns.filter((t) => t.role === 'user' && !t.syn).map((t) => t.ts).sort((a, b) => a - b);
  const userActiveAfter = (ts, win) => realUser.some((u) => u > ts && u <= ts + win);
  const breaks = [];
  const recent = [];                       // 滑窗：最近 8 条 assistant 归一化文本
  for (const a of asst) {
    const norm = normalizeForSim(a.content);
    if (norm && findCollision(a.content, recent, 0.85)) {     // ≥0.85 近重复=复读
      breaks.push({ kind: '复读', at: a.ts, content: a.content, silent60: !userActiveAfter(a.ts, 60 * 60e3) });
    } else if (EAT_RE.test(a.content)) {
      breaks.push({ kind: '凭空进食', at: a.ts, content: a.content, silent60: !userActiveAfter(a.ts, 60 * 60e3) });
    }
    recent.push(a.content);
    if (recent.length > 8) recent.shift();
  }
  return breaks;
}

// ── DB 主流程（只读）──────────────────────────────────────────────────────────
function main() {
  const DB_PATH = process.env.DB_PATH || 'data/bot.db';
  const di = process.argv.indexOf('--days');
  const DAYS = di > 0 ? Number(process.argv[di + 1]) : null;   // 仅作 proactive/break 窗口提示，全量默认
  const db = new Database(DB_PATH, { readonly: true });
  const today = shDate(Date.now());

  const rows = db.prepare(`
    SELECT c.user_id uid, c.id cid, c.name nm, ct.role, ct.content, ct.topic, COALESCE(ct.synthetic,0) syn, ct.created_at
    FROM companions c JOIN companion_conversation_turns ct ON ct.companion_id=c.id
    WHERE c.user_id NOT IN (1,2,3)
    ORDER BY c.id, ct.created_at, ct.id
  `).all().map((r) => ({ ...r, ts: toMs(r.created_at) }));

  const byComp = new Map();
  for (const r of rows) { if (!byComp.has(r.cid)) byComp.set(r.cid, []); byComp.get(r.cid).push(r); }

  const users = [];
  for (const [cid, turns] of byComp) {
    const realUserMs = turns.filter((t) => t.role === 'user' && !t.syn).map((t) => t.ts);
    const ret = computeRetention(realUserMs, today);
    if (!ret) continue;                                        // 无真实 user 消息 = 不计入真实用户
    users.push({
      cid, uid: turns[0].uid, name: turns[0].nm, ret,
      totalTurns: turns.length,
      touchpoints: returnTouchpoints(turns, ret),
      pstats: proactiveStats(turns),
      breaks: findHardBreaks(turns),
    });
  }
  db.close();
  users.sort((a, b) => b.ret.activeDays - a.ret.activeDays || a.ret.day0.localeCompare(b.ret.day0));

  const fmtGap = (m) => m == null ? '—' : m < 60 ? `${m}min` : m < 1440 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`;
  const B = (x) => x ? '✓' : '·';
  const N = users.length;
  console.log(`\n════ 真实留存看板（synthetic=0 真实聊天 · today=${today}沪 · ${DAYS ? `窗口 ${DAYS}d` : '全量'}）════`);
  console.log(`真实外部用户 N = ${N}（已剔除自有号 user1/2/3）\n`);

  // ── per-user 表 ──
  console.log('── per-user 真实留存（条数=真实user msg；満100=开场可能已裁）──');
  for (const u of users) {
    const r = u.ret;
    const cap = u.totalTurns >= 100 ? ' [turn満100·开场或已裁]' : '';
    console.log(`u${u.uid} ${u.name}  Day0=${r.day0}  活跃${r.activeDays}天  末次${r.lastDate}(${r.daysSinceLast}d前)  D1${B(r.day1)} D2${B(r.day2)} D7${B(r.day7)}  ${r.activeRecent ? '近3天活跃' : ''}${cap}`);
    for (const tp of u.touchpoints) {
      console.log(`    ↩ ${tp.date} 回来首句「${cut(tp.firstUser, 22)}」 ← ${tp.label}${tp.gapMin != null ? ` (gap ${fmtGap(tp.gapMin)})` : ''}`);
    }
  }

  // ── 漏斗 ──
  const cnt = (f) => users.filter(f).length;
  const list = (f) => users.filter(f).map((u) => `u${u.uid}`).join(' ') || '—';
  console.log(`\n── 留存漏斗（核心）──`);
  console.log(`  真实外部用户 N ............... ${N}`);
  console.log(`  Day1↩ 次日回来 .............. ${cnt(u => u.ret.day1)}  (${pct(cnt(u => u.ret.day1), N)})  ${list(u => u.ret.day1)}`);
  console.log(`  Day2↩ 第二日回来 ............ ${cnt(u => u.ret.day2)}  (${pct(cnt(u => u.ret.day2), N)})  ${list(u => u.ret.day2)}`);
  console.log(`  Day7↩ 7天内回来过 ........... ${cnt(u => u.ret.day7)}  (${pct(cnt(u => u.ret.day7), N)})  ${list(u => u.ret.day7)}`);
  console.log(`  ≥2 个真实活跃日(第二天回来过) ${cnt(u => u.ret.ret2)}  (${pct(cnt(u => u.ret.ret2), N)})  ${list(u => u.ret.ret2)}`);
  console.log(`  近3天仍活跃 ................. ${cnt(u => u.ret.activeRecent)}  (${pct(cnt(u => u.ret.activeRecent), N)})  ${list(u => u.ret.activeRecent)}`);

  // ── proactive 效果 ──
  const P = users.reduce((a, u) => ({
    total: a.total + u.pstats.total, reply60: a.reply60 + u.pstats.reply60,
    zero24h: a.zero24h + u.pstats.zero24h, blindRuns: a.blindRuns + u.pstats.blindRuns,
  }), { total: 0, reply60: 0, zero24h: 0, blindRuns: 0 });
  console.log(`\n── proactive 效果（救人 or 赶人）──`);
  console.log(`  proactive 总条数 ............... ${P.total}`);
  console.log(`  60min 内用户回复率 ............. ${pct(P.reply60, P.total)}  (${P.reply60}/${P.total})`);
  console.log(`  发后 24h 零回复（对空气表演）... ${P.zero24h}  (${pct(P.zero24h, P.total)})`);
  console.log(`  连续 ≥2 条 proactive 没回 run .. ${P.blindRuns}`);

  // ── hard break ──
  const allBreaks = users.flatMap((u) => u.breaks.map((b) => ({ ...b, uid: u.uid, name: u.name })));
  const breakUsers = [...new Set(allBreaks.map((b) => b.uid))];
  console.log(`\n── hard break 清单（复读=高精度自动检出；凭空进食=候选需对照上文场景；persona 崩需人眼不自动判）──`);
  console.log(`  命中 break 的用户：${breakUsers.length} 人；break 总数 ${allBreaks.length}（其中 复读 ${allBreaks.filter(b => b.kind === '复读').length} / 凭空进食 ${allBreaks.filter(b => b.kind === '凭空进食').length}）`);
  console.log(`  含「疑似当场流失」(break 后 60min 用户未再发言) 的：${allBreaks.filter(b => b.silent60).length} 处`);
  for (const b of allBreaks.sort((a, c) => a.at - c.at)) {
    console.log(`    [${b.kind}] u${b.uid} ${b.name} ${shTime(b.at)}${b.silent60 ? ' ⚠流失点' : ''}  「${cut(b.content, 38)}」`);
  }

  // ── 朴素判断 ──
  const ret2List = users.filter(u => u.ret.ret2);
  console.log(`\n── 最朴素判断 ──`);
  console.log(`  第二天还回来的真人：${ret2List.length}/${N}（${ret2List.map(u => 'u' + u.uid + ' ' + u.name).join('、') || '无'}）`);
  const touched = ret2List.flatMap(u => u.touchpoints).filter(t => t.label.includes('接回'));
  console.log(`  把人接回来的：${touched.length} 次"回来"由 bot proactive/早安接力（接回标签见上表 ↩ 行）`);
  console.log(`  hard break 污染留存用户：${ret2List.filter(u => u.breaks.length).length} 个回访用户的对话里检出 break（复读为主）`);
  console.log(`\n════ 看板完（纯只读，无任何回写）════`);
}

const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').replace(/\n/g, ' '); return t.length > n ? t.slice(0, n) + '…' : t; };
const pct = (x, n) => n ? (100 * x / n).toFixed(0) + '%' : '0%';
const shTime = (ms) => new Date(ms + SH).toISOString().slice(5, 16).replace('T', ' ');

// 仅作脚本运行；被 import（smoke）时不执行 main。
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
