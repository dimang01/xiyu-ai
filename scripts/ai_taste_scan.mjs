#!/usr/bin/env node
/**
 * v1.9.1: AI 味离线扫描器
 *
 * 扫描历史 assistant 回复，按 AI 味分数排序，输出 markdown 报告。
 *
 * **用途**：开发者观察工具 / 不是 release 闸门
 * - 不进 CI（AI 味是软指标，CI 化容易为了过检测去调 case）
 * - 不接入实时主流程（避免每条消息延迟）
 * - 只读 DB，零侧效应
 *
 * **隐私边界（v1.9.1 严守）**：
 * - 只扫 companion_conversation_turns（assistant role）
 * - **跳过**任何用户消息触发 detectSafetyRisk 的对话 turn
 *   （含 safety 上下文的 assistant 回复绝不输出到 markdown）
 * - 不读 safety_events（v1.9.0 表，含高敏 source_text）
 * - 不读 companion_diary / relational_diary（私密心理画像）
 *
 * 用法：
 *   node scripts/ai_taste_scan.mjs                       # 默认：最近 200 条 / score ≥ 20
 *   node scripts/ai_taste_scan.mjs --limit 500
 *   node scripts/ai_taste_scan.mjs --since 7d            # 最近 7 天
 *   node scripts/ai_taste_scan.mjs --min-score 30
 *   node scripts/ai_taste_scan.mjs --companion 42        # 只看一个 companion
 *
 * 输出：reports/ai_taste_<YYYY-MM-DD>.md
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// ─── 解析参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name, defaultValue) {
  const idx = argv.findIndex(a => a === `--${name}`);
  if (idx === -1) return defaultValue;
  return argv[idx + 1];
}

const LIMIT      = Number(flag('limit', 200));
const MIN_SCORE  = Number(flag('min-score', 20));
const COMPANION  = flag('companion', null);
const SINCE      = flag('since', null);  // e.g. "7d" / "24h" / "2026-06-01"

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
用法：
  node scripts/ai_taste_scan.mjs [选项]

选项：
  --limit N         扫描最近 N 条 assistant 回复（默认 200）
  --since X         只扫 X 之后的（"7d" / "24h" / "2026-06-01"）
  --min-score N     报告里只保留 score ≥ N 的（默认 20）
  --companion ID    只看一个 companion
  --help            显示此帮助

输出：reports/ai_taste_<date>.md
`);
  process.exit(0);
}

// ─── 解析 since 为 timestamp ─────────────────────────────────────────────────
function parseSince(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d+)([dh])$/);
  if (m) {
    const n = Number(m[1]);
    const ms = m[2] === 'd' ? n * 86_400_000 : n * 3_600_000;
    return new Date(Date.now() - ms);
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    console.error(`无效的 --since：${s}`);
    process.exit(1);
  }
  return d;
}
const sinceDate = parseSince(SINCE);

// ─── 动态加载模块 ────────────────────────────────────────────────────────────
const dbMod          = await import(pathToFileURL(path.join(ROOT, 'src/db.mjs')).href);
const tasteMod       = await import(pathToFileURL(path.join(ROOT, 'src/ai_taste_guard.mjs')).href);
const moderationMod  = await import(pathToFileURL(path.join(ROOT, 'src/moderation.mjs')).href);

const { getDb }            = dbMod;
const { detectAiTaste }    = tasteMod;
const { detectSafetyRisk } = moderationMod;

// ─── 拉取候选 turns ──────────────────────────────────────────────────────────
// 拉 assistant turns，按时间倒序。如果指定 companion / since 加 WHERE。
const db = getDb();
const wheres = [`role = 'assistant'`];
const params = [];
if (COMPANION) { wheres.push(`companion_id = ?`); params.push(Number(COMPANION)); }
if (sinceDate) { wheres.push(`datetime(created_at) >= datetime(?)`); params.push(sinceDate.toISOString()); }
const sql = `
  SELECT id, companion_id, content, created_at
  FROM companion_conversation_turns
  WHERE ${wheres.join(' AND ')}
  ORDER BY id DESC
  LIMIT ?
`;
const turns = db.prepare(sql).all(...params, LIMIT);

if (turns.length === 0) {
  console.log('没有可扫描的 assistant 回复');
  process.exit(0);
}

console.log(`扫描 ${turns.length} 条 assistant 回复...`);

// ─── 检测 + 隐私过滤 ─────────────────────────────────────────────────────────
// 隐私过滤：对每个 assistant turn，拉它前面最近的 user turn，
// 如果 user turn 触发 detectSafetyRisk → **整段 skip**，不输出报告。
//
// 这是 v1.9.1 严守的隐私边界：含自伤/危机信号上下文的 assistant 回复
// 绝不导出到任何 markdown / 文件。

const userTurnStmt = db.prepare(`
  SELECT content FROM companion_conversation_turns
  WHERE companion_id = ? AND role = 'user' AND id < ?
  ORDER BY id DESC LIMIT 1
`);

const flagged = [];
let scanned = 0;
let safetyExcluded = 0;
let belowThreshold = 0;
let clean = 0;

for (const turn of turns) {
  scanned++;
  // 找前一条 user message
  const prevUser = userTurnStmt.get(turn.companion_id, turn.id);
  if (prevUser?.content) {
    const risk = detectSafetyRisk(prevUser.content);
    if (risk.level !== 'none') {
      safetyExcluded++;
      continue;  // ★ 隐私边界：含 safety 上下文的整段 skip
    }
  }
  // 也对 assistant 自己的内容做一次 risk 检测（极端情况下她回复里含敏感词）
  const selfRisk = detectSafetyRisk(turn.content);
  if (selfRisk.level !== 'none') {
    safetyExcluded++;
    continue;
  }

  const { score, hits } = detectAiTaste(turn.content);
  if (score < MIN_SCORE) {
    if (score === 0) clean++;
    else belowThreshold++;
    continue;
  }
  flagged.push({ ...turn, score, hits });
}

flagged.sort((a, b) => b.score - a.score);

// ─── 写报告 ──────────────────────────────────────────────────────────────────
fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
const dateStr = new Date().toISOString().slice(0, 10);
const outPath = path.join(ROOT, 'reports', `ai_taste_${dateStr}.md`);

const lines = [];
lines.push(`# AI 味扫描报告 · ${dateStr}`);
lines.push('');
lines.push(`> 配置：limit=${LIMIT}, min-score=${MIN_SCORE}` +
           (COMPANION ? `, companion=${COMPANION}` : '') +
           (SINCE ? `, since=${SINCE}` : ''));
lines.push('');
lines.push('## 统计');
lines.push('');
lines.push(`| 类目 | 数量 |`);
lines.push(`|---|---|`);
lines.push(`| 扫描总数 | ${scanned} |`);
lines.push(`| 因 safety 上下文排除 | ${safetyExcluded} |`);
lines.push(`| 完全干净（score=0） | ${clean} |`);
lines.push(`| 低于阈值（0 < score < ${MIN_SCORE}） | ${belowThreshold} |`);
lines.push(`| **报告中（score ≥ ${MIN_SCORE}）** | **${flagged.length}** |`);
lines.push('');

if (flagged.length === 0) {
  lines.push(`没有命中阈值的条目。`);
} else {
  // 按命中类型聚合统计
  const typeCount = new Map();
  for (const f of flagged) {
    for (const h of f.hits) {
      typeCount.set(h.type, (typeCount.get(h.type) || 0) + 1);
    }
  }
  lines.push('## 命中类型分布');
  lines.push('');
  lines.push(`| 类型 | 命中次数 |`);
  lines.push(`|---|---|`);
  for (const [type, n] of [...typeCount.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${type} | ${n} |`);
  }
  lines.push('');

  lines.push(`## Top ${Math.min(50, flagged.length)} 可疑回复`);
  lines.push('');
  const top = flagged.slice(0, 50);
  for (let i = 0; i < top.length; i++) {
    const f = top[i];
    lines.push(`### #${i + 1} · score=${f.score} · companion=${f.companion_id} · ${f.created_at}`);
    lines.push('');
    lines.push(`命中：`);
    for (const h of f.hits) {
      lines.push(`- \`${h.type}\` (+${h.weight}): \`${h.text.replace(/`/g, '\\`')}\``);
    }
    lines.push('');
    lines.push('原文：');
    lines.push('');
    // markdown 代码块。截到 800 字防超长。
    const safe = String(f.content).slice(0, 800).replace(/```/g, '` ` `');
    lines.push('```');
    lines.push(safe + (f.content.length > 800 ? `\n... (truncated, total ${f.content.length} chars)` : ''));
    lines.push('```');
    lines.push('');
  }
}

fs.writeFileSync(outPath, lines.join('\n'));

console.log('');
console.log(`扫描完成：`);
console.log(`  总数:        ${scanned}`);
console.log(`  safety 排除: ${safetyExcluded}`);
console.log(`  干净:        ${clean}`);
console.log(`  低于阈值:    ${belowThreshold}`);
console.log(`  报告中:      ${flagged.length}`);
console.log('');
console.log(`报告：${outPath}`);
