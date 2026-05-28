#!/usr/bin/env node
/**
 * 交互式 setup wizard
 *
 * 用法：
 *   node scripts/setup-wizard.mjs           # 走交互流程
 *   node scripts/setup-wizard.mjs --check   # 仅检查是否已配置好，不询问；exit 0 表示已配置
 *
 * 当 stdin 不是 TTY（例如 CI / docker build / 管道）时，自动跳过交互，
 * 退化为现行行为（复制 .env.example）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT, '.env');
const ENV_EXAMPLE_PATH = resolve(ROOT, '.env.example');

// 与 src/providers/chat.mjs 的注册表保持一致
const CHAT_PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek',           keyEnv: 'DEEPSEEK_API_KEY',  link: 'https://platform.deepseek.com/api_keys', recommended: true },
  { id: 'openai',   label: 'OpenAI ChatGPT',     keyEnv: 'OPENAI_API_KEY',    link: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic',label: 'Anthropic Claude',   keyEnv: 'ANTHROPIC_API_KEY', link: 'https://console.anthropic.com/' },
  { id: 'zhipu',    label: '智谱 GLM',           keyEnv: 'ZHIPU_API_KEY',     link: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'qwen',     label: '通义千问 (DashScope)', keyEnv: 'QWEN_API_KEY',     link: 'https://dashscope.console.aliyun.com/apiKey' },
  { id: 'kimi',     label: 'Moonshot Kimi',      keyEnv: 'KIMI_API_KEY',      link: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'doubao',   label: '字节豆包 (Volcengine Ark)', keyEnv: 'DOUBAO_API_KEY', link: 'https://console.volcengine.com/ark', note: '注意：CHAT_MODEL 必须填火山方舟"接入点 ID"（ep-xxx）' },
  { id: 'xai',      label: 'xAI Grok',           keyEnv: 'XAI_API_KEY',       link: 'https://console.x.ai/' },
  { id: 'wenxin',   label: '百度文心 (千帆)',     keyEnv: 'WENXIN_API_KEY',    link: 'https://qianfan.cloud.baidu.com/' },
];

// ─── env 文件解析 / 写入 ───────────────────────────────────────────────────

function parseEnvFile(path) {
  const env = new Map();
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    env.set(trimmed.slice(0, idx), trimmed.slice(idx + 1));
  }
  return env;
}

// 把一组 (key, value) merge 进 .env：保留所有现有行的注释/顺序，只覆盖匹配的赋值；
// 新 key 追加到文件末尾。
function mergeEnvFile(path, updates) {
  const existing = existsSync(path)
    ? readFileSync(path, 'utf-8').split(/\r?\n/)
    : (existsSync(ENV_EXAMPLE_PATH)
        ? readFileSync(ENV_EXAMPLE_PATH, 'utf-8').split(/\r?\n/)
        : []);

  const updateMap = new Map(updates);
  const seen = new Set();
  const out = existing.map(line => {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!m) return line;
    const key = m[1];
    if (!updateMap.has(key)) return line;
    seen.add(key);
    return `${key}=${updateMap.get(key)}`;
  });
  for (const [k, v] of updateMap.entries()) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  writeFileSync(path, out.join('\n'), { encoding: 'utf-8' });
}

// ─── 检查是否已经"配好"了 ──────────────────────────────────────────────────

function isConfigured() {
  const env = parseEnvFile(ENV_PATH);
  // 从 process.env 兜底，便于 docker 场景检测
  function getVal(k) {
    return env.get(k) || process.env[k] || '';
  }
  const chatProvider = (getVal('CHAT_PROVIDER') || 'deepseek').toLowerCase();
  const match = CHAT_PROVIDERS.find(p => p.id === chatProvider);
  if (!match) return false;
  return Boolean(getVal(match.keyEnv));
}

// ─── 原生编译预检（better-sqlite3 用） ────────────────────────────────────
// 检查 better-sqlite3 是否能被 require；不能则说明原生模块没成功构建。
// 同时探测系统是否具备编译条件，给出可操作的修复建议（而不是让 npm install 失败一脸红字）。
function checkBetterSqlite3() {
  const modulePath = resolve(ROOT, 'node_modules', 'better-sqlite3');
  if (!existsSync(modulePath)) return { installed: false };
  // 尝试 require：检查 build/Release/better_sqlite3.node 是否能加载
  try {
    const bin = resolve(modulePath, 'build', 'Release', 'better_sqlite3.node');
    if (!existsSync(bin)) return { installed: true, native_ok: false, reason: 'prebuild_missing' };
    return { installed: true, native_ok: true };
  } catch (e) {
    return { installed: true, native_ok: false, reason: e.message };
  }
}

function detectBuildTools() {
  const checks = { python: null, cc: null };
  for (const cmd of ['python3', 'python']) {
    try {
      const v = execFileSync(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' }).trim();
      if (v) { checks.python = `${cmd} (${v})`; break; }
    } catch { /* try next */ }
  }
  for (const cmd of ['cc', 'gcc', 'clang']) {
    try {
      execFileSync(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      checks.cc = cmd;
      break;
    } catch { /* try next */ }
  }
  return checks;
}

function buildToolsHint() {
  const p = platform();
  if (p === 'darwin') {
    return '  · macOS:   xcode-select --install              (装 Command Line Tools)';
  }
  if (p === 'linux') {
    return '  · Debian/Ubuntu: sudo apt-get install -y python3 build-essential\n' +
           '  · RHEL/CentOS:   sudo dnf install -y python3 gcc-c++ make';
  }
  if (p === 'win32') {
    return '  · Windows: 推荐用 Docker 路径（docker compose up -d）跳过原生编译\n' +
           '             或用 VS Build Tools + Python 3；详见 https://github.com/nodejs/node-gyp#on-windows';
  }
  return '  · 安装 python3 + 系统 C/C++ 编译器（gcc/clang）后重试';
}

function preflight() {
  const s = checkBetterSqlite3();
  if (s.native_ok) return; // 一切正常
  console.log('\n🔧  原生模块预检');
  console.log('─────────────────────────────────────────────');
  if (!s.installed) {
    console.log('  ⚠ better-sqlite3 尚未安装。请先执行：');
    console.log('      npm install');
    return;
  }
  // 已装但 .node 文件缺失 / 不能加载 — 几乎必然是编译失败
  const tools = detectBuildTools();
  console.log('  ⚠ 检测到 better-sqlite3 已安装但原生二进制不可用：');
  console.log(`      reason=${s.reason}`);
  console.log('');
  console.log('  系统编译工具检测：');
  console.log(`      python : ${tools.python || '✗ 未找到'}`);
  console.log(`      cc/gcc : ${tools.cc    || '✗ 未找到'}`);
  console.log('');
  console.log('  修复建议：');
  console.log(buildToolsHint());
  console.log('');
  console.log('  装好编译工具后重新执行：');
  console.log('      rm -rf node_modules && npm install');
  console.log('');
  console.log('  或者直接走 Docker 路径绕过本地编译：');
  console.log('      docker compose up -d');
  console.log('');
}

// ─── 主流程 ────────────────────────────────────────────────────────────────

function maskKey(s) {
  if (!s) return '';
  return s.length <= 8 ? '****' : s.slice(0, 4) + '***' + s.slice(-2);
}

function isTty() {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

async function runInteractive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n🌸  溪语 AI · 配置向导');
  console.log('─────────────────────────────────────────────');
  console.log('回答几个问题就能跑起来。任何字段都可以稍后手动编辑 .env 调整。\n');

  // ── chat provider 选择 ──
  console.log('选一个文本对话 provider（默认 1）：\n');
  CHAT_PROVIDERS.forEach((p, i) => {
    const tag = p.recommended ? '  ★ 推荐' : '';
    console.log(`  ${String(i + 1).padStart(2)}. ${p.label.padEnd(28, ' ')} ${tag}`);
  });
  let choice;
  while (true) {
    const ans = (await rl.question('\n输入序号（直接回车 = 1）: ')).trim();
    if (!ans) { choice = 0; break; }
    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= CHAT_PROVIDERS.length) { choice = n - 1; break; }
    console.log(`  ⚠ 请输入 1–${CHAT_PROVIDERS.length}`);
  }
  const provider = CHAT_PROVIDERS[choice];
  console.log(`\n  ✓ 选择：${provider.label}`);
  if (provider.note) console.log(`  ⚠ ${provider.note}`);
  console.log(`  申请 key：${provider.link}`);

  // ── API key ──
  console.log('');
  let apiKey = '';
  while (!apiKey) {
    apiKey = (await rl.question(`粘贴 ${provider.keyEnv}（直接回车 = 跳过、稍后填）: `)).trim();
    if (!apiKey) {
      console.log('  ⚠ 跳过 API key。配置文件仍会生成，但启动后服务会提示去 /app/setup.html 配置。');
      break;
    }
    if (apiKey.length < 10) {
      console.log('  ⚠ 这个 key 看起来太短了，再确认一下？（回车跳过）');
      apiKey = '';
    }
  }

  // ── 豆包额外需要 endpoint ID ──
  let chatModel = '';
  if (provider.id === 'doubao') {
    chatModel = (await rl.question('请填火山方舟接入点 ID（CHAT_MODEL=ep-xxx）: ')).trim();
  }

  // ── 写文件 ──
  const updates = [
    ['CHAT_PROVIDER', provider.id],
  ];
  if (chatModel) updates.push(['CHAT_MODEL', chatModel]);
  if (apiKey) updates.push([provider.keyEnv, apiKey]);

  // 首次配置时，若 .env 不存在，先把 .env.example 当模板复制再合并
  if (!existsSync(ENV_PATH) && existsSync(ENV_EXAMPLE_PATH)) {
    copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
  }
  mergeEnvFile(ENV_PATH, updates);

  console.log('\n─────────────────────────────────────────────');
  console.log('✅ 已写入 .env：');
  console.log(`   CHAT_PROVIDER=${provider.id}`);
  if (chatModel) console.log(`   CHAT_MODEL=${chatModel}`);
  if (apiKey) console.log(`   ${provider.keyEnv}=${maskKey(apiKey)}（已脱敏，文件里是完整值）`);
  else        console.log(`   ${provider.keyEnv}=（未填，需稍后补上）`);
  console.log('');
  console.log('下一步：');
  console.log('  npm start              启动服务');
  console.log('');
  console.log('🌸  关于邮件验证码：');
  console.log('  未配 RESEND_API_KEY 时自动启用 dev_stdout 模式 —');
  console.log('  验证码会直接打到服务日志，不真发邮件。');
  console.log('  这意味着你可以立刻注册第一个账号，无需任何邮件服务。');
  console.log('');
  console.log('🌸  关于微信接入：');
  console.log('  登录后端 → 注册 → 创建角色 → /app/bind.html 网页扫码即可。');
  console.log('  完全无需预填 ILINK_* 环境变量。');
  console.log('  无 iLink 准入资格也能用 /app/playground.html 在网页里测试聊天。');
  console.log('');

  rl.close();
}

function runNonInteractive() {
  // 非 TTY 下退化为现行行为：复制 .env.example 后退出
  if (!existsSync(ENV_PATH)) {
    if (existsSync(ENV_EXAMPLE_PATH)) {
      copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
      console.log('[setup-wizard] 非交互式环境：已从 .env.example 生成 .env，请手动填入 *_API_KEY 后再启动。');
    } else {
      console.error('[setup-wizard] 找不到 .env 也找不到 .env.example');
      process.exitCode = 1;
    }
  } else {
    console.log('[setup-wizard] .env 已存在，未做修改。');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    process.exitCode = isConfigured() ? 0 : 1;
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npm run setup                   # 交互式（TTY）');
    console.log('       npm run setup -- --check        # 仅检测，已配置 exit 0');
    return;
  }
  // 原生编译预检（仅信息性，不阻塞）
  preflight();

  if (!isTty()) {
    runNonInteractive();
    return;
  }
  try {
    await runInteractive();
  } catch (err) {
    console.error(`[setup-wizard] 异常: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
