#!/usr/bin/env node
/**
 * npm run setup — 溪语 AI 快速启动向导
 *
 * 行为：
 *   1. 检查 Node >= 20
 *   2. 检查 better-sqlite3 原生模块
 *   3. 如果 .env 不存在，从 .env.example 生成最小 .env（不含 API Key）
 *   4. 创建 data/ 目录
 *   5. 启动服务并提示打开 /app/setup.html 配置 Provider
 *
 * API Key 由网页设置，不在终端询问。高级用户仍可手动编辑 .env。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT, '.env');
const ENV_EXAMPLE_PATH = resolve(ROOT, '.env.example');
const DATA_DIR = resolve(ROOT, 'data');

// ─── 颜色 ─────────────────────────────────────────────────────────────────
const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', B = '\x1b[1m', D = '\x1b[0m';
const ok   = m => console.log(`${G}✅${D} ${m}`);
const warn = m => console.log(`${Y}⚠️ ${D} ${m}`);
const fail = m => console.log(`${R}❌${D} ${m}`);
const info = m => console.log(`   ${m}`);
const hr   = () => console.log('─'.repeat(52));

// ─── 1. Node 版本 ─────────────────────────────────────────────────────────
const nodeMajor = Number(process.version.match(/^v(\d+)/)?.[1] || 0);
if (nodeMajor < 20) {
  fail(`Node.js ${process.version} — 需要 >= v20`);
  info('升级：https://nodejs.org/');
  process.exit(1);
}
ok(`Node.js ${process.version}`);

// ─── 2. better-sqlite3 ───────────────────────────────────────────────────
function checkBetterSqlite3() {
  const modPath = resolve(ROOT, 'node_modules', 'better-sqlite3');
  if (!existsSync(modPath)) return { ok: false, reason: 'not_installed' };
  const bin = resolve(modPath, 'build', 'Release', 'better_sqlite3.node');
  if (!existsSync(bin)) return { ok: false, reason: 'prebuild_missing' };
  return { ok: true };
}
const sqlite = checkBetterSqlite3();
if (!sqlite.ok) {
  warn(`better-sqlite3 未就绪 (${sqlite.reason})`);
  info('请先执行：npm install');
  if (platform() === 'linux') info('Debian/Ubuntu: sudo apt-get install -y python3 build-essential');
} else {
  ok('better-sqlite3 可用');
}

// ─── 3. 创建最小 .env ────────────────────────────────────────────────────
if (!existsSync(ENV_PATH)) {
  if (existsSync(ENV_EXAMPLE_PATH)) {
    copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
    ok('.env 已从 .env.example 生成');
  } else {
    // 兜底：生成最小 .env
    const { writeFileSync } = await import('node:fs');
    writeFileSync(ENV_PATH, '# 溪语 AI 配置\n# API Key 请在 /app/setup.html 中填写\n', 'utf-8');
    ok('.env 已生成（最小模板）');
  }
  info('无需手动填写 API Key，稍后在网页向导中配置。');
} else {
  ok('.env 已存在，未修改');
}

// ─── 4. 创建 data/ 目录 ──────────────────────────────────────────────────
try {
  mkdirSync(DATA_DIR, { recursive: true });
  ok('data/ 目录已就绪');
} catch (e) {
  warn(`data/ 目录创建失败: ${e.message}`);
}

// ─── 5. 提示并启动 ───────────────────────────────────────────────────────
const port = process.env.API_PORT || '3000';

hr();
console.log(`\n${B}🌸  溪语 AI 准备就绪${D}\n`);
console.log('下一步：');
console.log(`\n  ${B}npm start${D}               启动服务`);
console.log(`\n  然后打开浏览器：`);
console.log(`\n  ${G}${B}http://localhost:${port}/app/setup.html${D}`);
console.log('');
console.log('在网页向导里：');
info('① 创建本地账号');
info('② 选择 Chat Provider（DeepSeek / OpenAI / Anthropic 等）');
info('③ 粘贴 API Key（安全保存到本地 SQLite，不写 .env）');
info('④ 测试连通 → 创建角色 → 开始聊天');
console.log('');
console.log(`高级用户也可直接编辑 .env 文件，环境变量优先于 Web 设置。`);
hr();
console.log('');

// 检测是否可以自动启动（非 --no-start 参数，且 sqlite 正常）
if (!process.argv.includes('--no-start') && sqlite.ok) {
  console.log(`${Y}提示：执行 npm start 或 node index.mjs 启动服务${D}`);
}
