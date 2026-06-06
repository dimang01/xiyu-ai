#!/usr/bin/env node
/**
 * v1.9.10: 字段漂移自动检查
 *
 * 防一类反复出现的 bug（v1.9.9 Bug 3 + v1.9.10 silent_mode 都是这个模式）：
 *
 *   前端读 c.xxx → 后端 companionSummary 没返回 → 永远 undefined →
 *   走前端 hardcode 默认 → 用户操作（如开 toggle）写 DB 成功 →
 *   下次刷新读不到 → "我开了又被自己关了" 体验崩
 *
 * 本脚本扫 public/app/dashboard.html 所有 `c.xxx_name` 读取，对比
 * src/api.mjs::companionSummary 实际返回的字段集，输出 diff。
 * 漂移项作为 release 阻塞警告。
 *
 * 不进 CI 闸门（路径 / 命名约定可能随版本变化），但建议每次发版前跑一遍。
 *
 * 用法: node scripts/check_summary_field_drift.mjs
 * Exit: 0 = 无漂移 / 1 = 有漂移
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 1. 从 dashboard.html 抽取所有 c.xxx 读取 ────────────────────────────
const dashboardPath = path.join(ROOT, 'public/app/dashboard.html');
const dashboardHtml = fs.readFileSync(dashboardPath, 'utf-8');
// 匹配 c.xxx 但不匹配 c.xxx(...)（函数调用通常不是字段读取）
// 注意：可能误报合法的局部变量 c（如 forEach((c) => c.label）。后面要过滤。
const dashboardFields = new Set();
for (const m of dashboardHtml.matchAll(/\bc\.([a-z_]\w*)/g)) {
  dashboardFields.add(m[1]);
}

// ── 2. 从 src/api.mjs 抽取 companionSummary 返回字段集 ──────────────────
const apiPath = path.join(ROOT, 'src/api.mjs');
const apiSrc = fs.readFileSync(apiPath, 'utf-8');
const summaryStart = apiSrc.indexOf('function companionSummary(');
if (summaryStart === -1) {
  console.error('  ✗ src/api.mjs 找不到 companionSummary 函数定义');
  process.exit(1);
}
// 找函数结束 (匹配 return { ... };)
const returnStart = apiSrc.indexOf('return {', summaryStart);
const returnEnd = apiSrc.indexOf('};', returnStart);
const returnBlock = apiSrc.slice(returnStart, returnEnd + 2);
// 抽取每行 `key:` 或 `key,`（key 是字段名）
const summaryFields = new Set();
for (const m of returnBlock.matchAll(/^\s*([a-z_]\w*)\s*[:,]/gm)) {
  summaryFields.add(m[1]);
}

// ── 3. 噪音过滤：dashboard.html 里的 c.* 可能是合法局部变量，加白名单 ─
// （JSON 字段名通常 snake_case，DOM/JS API 通常 camelCase 或单词。
//  保险起见：只关注 snake_case 字段 + 已知 companion 业务字段。）
const KNOWN_LOCAL_NOISE = new Set([
  // DOM / JS 内建（迭代变量 c 的属性）
  'classList', 'class', 'dataset', 'value', 'textContent', 'innerHTML', 'style', 'parentNode',
  'children', 'length', 'forEach', 'map', 'filter', 'push', 'slice', 'split', 'toLowerCase',
  // MediaRecorder / chat audio 用的 c（在 playground 里，dashboard 应无）
  'mime', 'ondataavailable', 'onstop',
  // 其他常见局部
  'label', 'val', 'com', 'name', 'id', 'type', 'data',
  // v1.10.53: 候选图循环变量 c（candidate），c.fname 是候选图文件名非 companion 字段
  'fname',
]);

// dashboard 真正"期待 companion 字段"的集合 = 全部读取 - 已知噪音
const expectedFields = new Set();
for (const f of dashboardFields) {
  if (KNOWN_LOCAL_NOISE.has(f)) continue;
  // 业务字段一般是 snake_case 或单词（不混 camelCase）
  if (/^[a-z][a-z_]*$/.test(f)) expectedFields.add(f);
}

// ── 4. Diff ────────────────────────────────────────────────────────────
const drift = [];
for (const f of expectedFields) {
  if (!summaryFields.has(f)) drift.push(f);
}

const extra = [];
for (const f of summaryFields) {
  if (!expectedFields.has(f) && !KNOWN_LOCAL_NOISE.has(f)) extra.push(f);
}

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  字段漂移检查 · dashboard.html ⇄ companionSummary`);
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  dashboard 引用 c.* (去噪后): ${expectedFields.size} 个字段`);
console.log(`  companionSummary 返回:        ${summaryFields.size} 个字段`);
console.log('');

if (drift.length === 0) {
  console.log('  ✓ 无漂移：所有 dashboard 期待的字段都被 companionSummary 返回');
} else {
  console.log('  🚨 漂移 — dashboard 读但 companionSummary 不返回：');
  for (const f of drift.sort()) {
    console.log(`    - c.${f}`);
  }
  console.log('');
  console.log('  影响：用户操作（toggle/slider）可以 PATCH 到 DB，但下次刷新');
  console.log('        读不到字段，前端走 hardcode 默认值，表现为"我改了又自动恢复"');
  console.log('  修法：往 src/api.mjs::companionSummary 的 return {} 里加这些字段');
}

if (extra.length > 0) {
  console.log('');
  console.log(`  ℹ️  companionSummary 返回但 dashboard 不读（可能是其他页面用）：`);
  for (const f of extra.sort()) {
    console.log(`    - ${f}`);
  }
}

console.log('');
process.exit(drift.length > 0 ? 1 : 0);
