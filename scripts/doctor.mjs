#!/usr/bin/env node
/**
 * npm run doctor — 自托管环境一键诊断工具
 *
 * 检查项：
 *  Node 版本 / npm 可用性 / better-sqlite3 可加载性 /
 *  .env 存在 / data/ 可写 / SQLite 可写 /
 *  CHAT_PROVIDER 配置 / 对应 API key 存在 /
 *  iLink 配置 / .weixin-credentials 存在 /
 *  API /health 可访问 / 端口占用情况 / 邮件模式
 *
 * 注意：本脚本不输出任何 API key / token 内容。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── Color helpers ─────────────────────────────────────────────────────────
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

const ok   = msg => console.log(`${GREEN}✅${RESET} ${msg}`);
const warn = msg => console.log(`${YELLOW}⚠️ ${RESET} ${msg}`);
const fail = msg => console.log(`${RED}❌${RESET} ${msg}`);
const info = msg => console.log(`${DIM}   ${msg}${RESET}`);
const head = msg => console.log(`\n${BOLD}── ${msg} ──${RESET}`);

let issues = 0;
let warnings = 0;

// ─── Checks ────────────────────────────────────────────────────────────────

head('运行环境');

// Node version
const nvMatch = process.version.match(/^v(\d+)/);
const nodeMajor = nvMatch ? Number(nvMatch[1]) : 0;
if (nodeMajor >= 20) {
  ok(`Node.js ${process.version} (>= 20)`);
} else {
  fail(`Node.js ${process.version} — 需要 >= v20`);
  issues++;
}

// npm
try {
  const npmVer = execSync('npm --version', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
  ok(`npm ${npmVer}`);
} catch {
  fail('npm 不可用 — 请检查 npm 安装');
  issues++;
}

// better-sqlite3
head('依赖');
try {
  const req = createRequire(path.join(ROOT, 'package.json'));
  req('better-sqlite3');
  ok('better-sqlite3 可加载');
} catch (e) {
  fail(`better-sqlite3 加载失败: ${e.message}`);
  info('运行: npm install');
  issues++;
}

// ─── .env ─────────────────────────────────────────────────────────────────
head('配置文件');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  ok('.env 文件存在');
} else {
  warn('.env 文件不存在 — 请从 .env.example 复制并填写');
  warnings++;
}

// Load env (without printing values)
let env = {};
if (fs.existsSync(envPath)) {
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !m[0].startsWith('#')) env[m[1]] = m[2].trim();
    }
  } catch {}
}
// Also read from process.env (Docker / CI)
for (const [k, v] of Object.entries(process.env)) {
  if (!env[k]) env[k] = v;
}

// .weixin-credentials
const wxCreds = path.join(ROOT, '.weixin-credentials.json');
if (fs.existsSync(wxCreds)) {
  ok('.weixin-credentials.json 存在（WeChat 已登录）');
} else {
  warn('.weixin-credentials.json 不存在 — 请运行 npm run ilink:login 绑定微信');
  warnings++;
}

// ─── data/ 目录 ─────────────────────────────────────────────────────────────
head('数据目录');
const dataDir = path.join(ROOT, 'data');
try {
  fs.mkdirSync(dataDir, { recursive: true });
  const testFile = path.join(dataDir, '.doctor_write_test');
  fs.writeFileSync(testFile, 'ok');
  fs.unlinkSync(testFile);
  ok('data/ 目录可写');
} catch (e) {
  fail(`data/ 目录不可写: ${e.message}`);
  issues++;
}

// SQLite write test
const dbPath = env.DB_PATH || path.join(dataDir, 'bot.db');
try {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS _doctor_test (x INTEGER)');
  db.exec('DROP TABLE IF EXISTS _doctor_test');
  db.close();
  ok(`SQLite 可写 (${path.relative(ROOT, dbPath)})`);
} catch (e) {
  fail(`SQLite 不可写: ${e.message}`);
  issues++;
}

// ─── Chat provider ─────────────────────────────────────────────────────────
head('AI 提供商');
const provider = env.CHAT_PROVIDER || '';
if (!provider) {
  fail('CHAT_PROVIDER 未配置 — 请在 .env 中设置 CHAT_PROVIDER');
  issues++;
} else {
  ok(`CHAT_PROVIDER = ${provider}`);

  const KEY_MAP = {
    openai:   'OPENAI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    claude:   'ANTHROPIC_API_KEY',
    anthropic:'ANTHROPIC_API_KEY',
    zhipu:    'ZHIPU_API_KEY',
    qwen:     'QWEN_API_KEY',
    doubao:   'DOUBAO_API_KEY',
    kimi:     'KIMI_API_KEY',
    wenxin:   'WENXIN_ACCESS_KEY',
    xai:      'XAI_API_KEY',
    gemini:   'GEMINI_API_KEY',
  };
  const keyName = KEY_MAP[provider.toLowerCase()];
  if (keyName) {
    const val = env[keyName] || '';
    if (val && val.length >= 8 && !val.startsWith('your_') && !val.startsWith('sk-xxx')) {
      ok(`${keyName} 已配置 (${val.length} 字符，内容已隐藏)`);
    } else {
      fail(`${keyName} 未配置或为占位符`);
      issues++;
    }
  } else {
    info(`未知 provider "${provider}"，跳过 key 检查`);
  }
}

// ─── iLink / WeChat ─────────────────────────────────────────────────────────
head('iLink / 微信');
const botToken = env.ILINK_BOT_TOKEN || '';
const botId    = env.ILINK_BOT_ID    || '';
if (!botToken || botToken.length < 8 || botToken.startsWith('your_')) {
  warn('ILINK_BOT_TOKEN 未配置 — 微信功能不可用');
  warnings++;
} else {
  ok(`ILINK_BOT_TOKEN 已配置 (已隐藏)`);
}
if (!botId || botId.startsWith('your_')) {
  warn('ILINK_BOT_ID 未配置');
  warnings++;
} else {
  ok(`ILINK_BOT_ID = ${botId}`);
}

// ─── Port & API health ───────────────────────────────────────────────────────
head('服务状态');
const port = Number(env.API_PORT || 3000);
let serviceRunning = false;

try {
  // Quick TCP check
  const check = spawnSync('sh', ['-c', `curl -sf --max-time 2 http://localhost:${port}/api/health`], {
    encoding: 'utf8',
    timeout: 4000,
  });
  if (check.status === 0 && check.stdout) {
    try {
      const h = JSON.parse(check.stdout);
      if (h.ok) {
        ok(`/api/health 响应正常 (端口 ${port})`);
        if (h.data?.provider) info(`  provider: ${h.data.provider}`);
        if (h.data?.wechat_configured !== undefined) info(`  wechat_configured: ${h.data.wechat_configured}`);
        if (h.data?.email_mode) info(`  email_mode: ${h.data.email_mode}`);
        serviceRunning = true;
      } else {
        warn(`/api/health 返回非 ok`);
        warnings++;
      }
    } catch {
      warn(`/api/health 响应无法解析`);
      warnings++;
    }
  } else {
    info(`服务未运行于端口 ${port}（或 curl 不可用）`);
  }
} catch {
  info(`无法检测端口 ${port} 服务状态`);
}

// Port conflict
try {
  const lsof = spawnSync('sh', ['-c', `lsof -ti :${port} 2>/dev/null | head -1`], { encoding: 'utf8', timeout: 2000 });
  const pid  = lsof.stdout?.trim();
  if (pid && !serviceRunning) {
    warn(`端口 ${port} 已被 PID ${pid} 占用（且非溪语服务）`);
    warnings++;
  }
} catch {}

// ─── AUTH_MODE ──────────────────────────────────────────────────────────────
head('认证模式');
const authMode = (env.AUTH_MODE || 'local').toLowerCase().trim();
if (authMode === 'local') {
  ok(`AUTH_MODE = local（本地免邮箱初始化）`);
  // Check initialization state if SQLite is accessible
  try {
    const { default: Database } = await import('better-sqlite3');
    const dbPath2 = env.DB_PATH || path.join(dataDir, 'bot.db');
    if (fs.existsSync(dbPath2)) {
      const db2 = new Database(dbPath2, { readonly: true });
      const cnt = db2.prepare('SELECT COUNT(*) AS n FROM user_accounts').get()?.n ?? 0;
      db2.close();
      if (cnt === 0) {
        info(`Local setup available: yes (首次启动，打开 http://localhost:${env.API_PORT || 3000}/app/setup.html 创建账号)`);
      } else {
        info(`Local setup available: no (已有 ${cnt} 个账号)`);
      }
    } else {
      info('Local setup available: yes (数据库尚未创建，首次启动后可用)');
    }
  } catch { /* DB 不可读时跳过 */ }
} else if (authMode === 'email') {
  ok(`AUTH_MODE = email（邮箱注册/登录）`);
  info('Email login enabled: yes — 公网/多用户部署模式');
} else {
  warn(`AUTH_MODE = ${authMode} — 未知值，将 fallback 为 local`);
  warnings++;
}

// ─── AUTH_SECRET ────────────────────────────────────────────────────────────
head('安全');
const authSecret = env.AUTH_SECRET || '';
if (!authSecret || authSecret.length < 8) {
  const authFile = path.join(ROOT, '.auth-secret');
  if (fs.existsSync(authFile)) {
    warn('AUTH_SECRET 未在 .env 显式设置 — 使用自动生成（.auth-secret），重启时 token 不失效');
    warnings++;
  } else {
    warn('AUTH_SECRET 未配置，且 .auth-secret 不存在 — 首次启动会自动创建，但重启失效');
    warnings++;
  }
} else {
  ok('AUTH_SECRET 已配置');
}

// ─── Email / Resend ──────────────────────────────────────────────────────────
head('邮件');
const emailMode = env.EMAIL_MODE || '';
const resendKey = env.RESEND_API_KEY || '';
const resendFrom = env.RESEND_FROM || '';
if (emailMode === 'dev_stdout' || env.EMAIL_DEV_MODE === '1') {
  ok('邮件模式: dev_stdout（仅打印，不发送）');
} else if (resendKey && resendKey.length > 8 && !resendKey.startsWith('re_xxx')) {
  if (resendFrom) {
    ok('邮件模式: Resend 真实发送');
    info(`  RESEND_FROM: ${resendFrom}`);
  } else {
    warn('RESEND_API_KEY 已配置，但 RESEND_FROM 未设置');
    warnings++;
  }
} else {
  ok('邮件模式: dev_stdout（未配置 Resend）');
}

// ─── Docker hint ─────────────────────────────────────────────────────────────
if (fs.existsSync('/.dockerenv') || process.env.container === 'docker') {
  head('Docker');
  ok('检测到 Docker 环境');
  info('  确保 data/ 目录已挂载为 volume 以持久化数据');
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
if (issues === 0 && warnings === 0) {
  console.log(`${GREEN}${BOLD}✅ 全部检查通过，环境配置正常${RESET}`);
} else {
  if (issues > 0)   console.log(`${RED}${BOLD}❌ ${issues} 个严重问题需修复${RESET}`);
  if (warnings > 0) console.log(`${YELLOW}⚠️  ${warnings} 个警告（不影响启动，建议处理）${RESET}`);
}
console.log('─'.repeat(50) + '\n');

process.exit(issues > 0 ? 1 : 0);
