#!/usr/bin/env node
/**
 * retention_dashboard.mjs — 运营看板：留存 / 关系 / 主动消息健康，一条命令看全。
 *
 * 把"手动敲 SQL 查留存"固化下来，并针对性验证近期留存改动是否生效：
 *   关系阶段分布(早期关系曲线) · 每用户活跃与流失 · token 窗口(主动消息能否发出) ·
 *   读空气刹车 · 临门一脚触发 · 流失天数分布。
 *
 * 用法：node scripts/retention_dashboard.mjs
 *       DB_PATH=/opt/xiyu-ai-new/data/bot.db node scripts/retention_dashboard.mjs
 *       EXCLUDE=test,test1,storm node scripts/retention_dashboard.mjs   # 排除测试号(默认这三个)
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || './data/bot.db';
const EXCLUDE = (process.env.EXCLUDE ?? 'test,test1,storm').split(',').map(s => s.trim()).filter(Boolean);
let db;
try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
catch (e) { console.error(`✗ 打不开 DB：${DB_PATH}（用 DB_PATH 指定）\n  ${e.message}`); process.exit(1); }

const NOW = Date.now();
const DAY = 86400_000, HOUR = 3600_000;
const ts = (s) => { if (!s) return 0; const t = String(s).replace(' ', 'T'); const d = new Date(t.endsWith('Z') ? t : t + 'Z').getTime(); return Number.isFinite(d) ? d : 0; };
const fmtAgo = (ms) => { if (!ms) return '—'; const h = (NOW - ms) / HOUR; return h < 24 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}天`; };
const pct = (n, d) => d ? `${(n / d * 100).toFixed(0)}%` : '—';
const bar = (n, max, w = 10) => '█'.repeat(Math.round((n / (max || 1)) * w)) + '·'.repeat(w - Math.round((n / (max || 1)) * w));
const qmark = EXCLUDE.length ? `AND ua.username NOT IN (${EXCLUDE.map(() => '?').join(',')})` : '';

// ── 真实用户的活跃绑定 + 角色（排除测试号）──────────────────────────────────
let rows;
try {
  rows = db.prepare(`
    SELECT ua.username, c.id AS cid, c.relationship_stage AS stage, c.affection_level AS aff,
           c.created_at AS created, c.last_user_reply_at AS lastReply,
           c.proactive_unanswered AS unans, c.last_lastcall_at AS lastcall, c.became_lover_at AS lover
    FROM wechat_accounts wa
    JOIN user_accounts ua ON ua.id = wa.account_id
    JOIN companions c ON c.id = wa.companion_id
    WHERE wa.is_active = 1 ${qmark}
    ORDER BY c.last_user_reply_at DESC
  `).all(...EXCLUDE);
} catch (e) { console.error(`✗ 查询失败（库结构可能较旧）：${e.message}`); process.exit(1); }

const totalAcc = db.prepare(`SELECT COUNT(*) n FROM user_accounts ua WHERE 1=1 ${qmark}`).get(...EXCLUDE).n;
const bound = rows.length;
const active1d = rows.filter(r => ts(r.lastReply) && NOW - ts(r.lastReply) < DAY).length;
const active7d = rows.filter(r => ts(r.lastReply) && NOW - ts(r.lastReply) < 7 * DAY).length;
const new7d = rows.filter(r => ts(r.created) && NOW - ts(r.created) < 7 * DAY).length;

console.log(`\n═══════ 溪语 AI 运营看板 ═══════`);
console.log(`DB=${DB_PATH}  排除测试号=[${EXCLUDE.join(',')}]  生成于 ${new Date().toISOString().slice(0, 16)}Z\n`);
console.log(`▌ 用户`);
console.log(`  真实账号 ${totalAcc} · 活跃微信绑定 ${bound} · 今日活跃 ${active1d} · 7日活跃 ${active7d} · 7日新增 ${new7d}`);

// ── 关系阶段分布（验证 #210 早期关系曲线：目标=有人能突破到恋人）─────────────
const STAGES = ['陌生人', '朋友', '暧昧', '恋人', '深爱'];
const dist = Object.fromEntries(STAGES.map(s => [s, 0]));
for (const r of rows) if (dist[r.stage] != null) dist[r.stage]++;
const maxStage = Math.max(1, ...Object.values(dist));
const affs = rows.map(r => r.aff || 0);
const avgAff = affs.length ? (affs.reduce((a, b) => a + b, 0) / affs.length).toFixed(0) : 0;
console.log(`\n▌ 关系阶段分布  (验证 #210 关系曲线：新人期该更快奔恋人)`);
for (const s of STAGES) console.log(`  ${s.padEnd(3)} ${bar(dist[s], maxStage)} ${dist[s]}`);
console.log(`  好感度 avg ${avgAff}（min ${Math.min(...affs, 0)} / max ${Math.max(...affs, 0)}）`);
const lovers = dist['恋人'] + dist['深爱'];
console.log(lovers ? `  ✅ ${lovers} 个用户到了恋人+` : `  ⚠️ 暂无用户到恋人 —— #210(第5天到恋人)上线后重点观察新用户能否突破`);

// ── 每用户留存 + token 窗口 ───────────────────────────────────────────────────
console.log(`\n▌ 每用户留存与窗口  (沉默=距最后互动；窗口=能否给TA发主动消息 #207)`);
console.log(`  ${'用户'.padEnd(12)}${'阶段'.padEnd(6)}${'好感'.padStart(4)}  ${'活跃跨度'.padStart(8)}  ${'沉默'.padStart(7)}  窗口`);
for (const r of rows) {
  const span = (ts(r.lastReply) && ts(r.created)) ? `${((ts(r.lastReply) - ts(r.created)) / DAY).toFixed(1)}天` : '—';
  const idleH = ts(r.lastReply) ? (NOW - ts(r.lastReply)) / HOUR : Infinity;
  const win = idleH < 24 ? '✅窗口内' : '❌超窗口';
  console.log(`  ${String(r.username).padEnd(12)}${String(r.stage).padEnd(6)}${String(r.aff).padStart(4)}  ${span.padStart(8)}  ${fmtAgo(ts(r.lastReply)).padStart(7)}  ${win}`);
}

// ── 主动消息健康（验证 #207 窗口 / #211 读空气 / #208 临门一脚）──────────────
const inWin = rows.filter(r => ts(r.lastReply) && NOW - ts(r.lastReply) < 24 * HOUR).length;
const braked = rows.filter(r => (r.unans || 0) >= 3).length;
const lastcalled = rows.filter(r => Number(r.lastcall) > 0).length;
console.log(`\n▌ 主动消息健康`);
console.log(`  token 窗口内(她能主动找) ${inWin}/${bound} ｜ 超窗口(发不出 #207) ${bound - inWin}`);
console.log(`  被读空气刹车(未回≥3条已闭嘴 #211) ${braked} ｜ 触发过窗口将关临门一脚(#208) ${lastcalled}`);

// ── 流失分布 ──────────────────────────────────────────────────────────────────
const buckets = { '当天就走(<1天)': 0, '活跃1-2天': 0, '活跃3天+': 0, '从未互动': 0 };
for (const r of rows) {
  if (!ts(r.lastReply)) { buckets['从未互动']++; continue; }
  const span = (ts(r.lastReply) - ts(r.created)) / DAY;
  if (span < 1) buckets['当天就走(<1天)']++;
  else if (span < 3) buckets['活跃1-2天']++;
  else buckets['活跃3天+']++;
}
console.log(`\n▌ 流失分布(活跃跨度=注册→最后互动)`);
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(16)} ${v}  (${pct(v, bound)})`);
console.log(`\n提示：今日活跃/恋人数/活跃3天+ 是看 #210-#212 留存改动是否见效的核心指标，隔几天再跑对比。\n`);
db.close();
