/**
 * P0 Regression Check
 * Verifies that P0 (and P1) core deliverables are present and functional.
 * Run with: npm run check:p0
 *
 * Does NOT require a running server or real .env — uses file checks and
 * node --check style imports only.
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const results = [];

function check(name, ok, detail = '') {
  const status = ok ? '✓' : '✗';
  results.push({ ok, name, detail });
  if (ok) passed++; else failed++;
}

function fileExists(rel) { return existsSync(path.join(ROOT, rel)); }

// ─── 1. Key source files ──────────────────────────────────────────────────────
check('src/memory_v2.mjs 存在',     fileExists('src/memory_v2.mjs'));
check('src/persona_guard.mjs 存在', fileExists('src/persona_guard.mjs'));
check('src/emotion_state.mjs 存在', fileExists('src/emotion_state.mjs'));
check('src/proactive_engine.mjs 存在', fileExists('src/proactive_engine.mjs'));
check('src/reflection.mjs 存在',    fileExists('src/reflection.mjs'));
check('scripts/doctor.mjs 存在',    fileExists('scripts/doctor.mjs'));

// ─── 2. Public pages ─────────────────────────────────────────────────────────
check('/app/memories.html 存在',     fileExists('public/app/memories.html'));
check('/app/debug-prompt.html 存在', fileExists('public/app/debug-prompt.html'));
check('/app/dashboard.html 存在',    fileExists('public/app/dashboard.html'));

// ─── 3. memory_v2.mjs exports ────────────────────────────────────────────────
try {
  const m = await import(path.join(ROOT, 'src/memory_v2.mjs'));
  check('memory_v2 exportiert computeMemoryDecay',          typeof m.computeMemoryDecay === 'function');
  check('memory_v2 exportiert shouldWriteBackDecay',        typeof m.shouldWriteBackDecay === 'function');
  check('memory_v2 exportiert applyMemoryDecayBatch',       typeof m.applyMemoryDecayBatch === 'function');
  check('memory_v2 exportiert findSimilarMemoryByEmbedding', typeof m.findSimilarMemoryByEmbedding === 'function');
  check('memory_v2 exportiert addOrMergeMemory',            typeof m.addOrMergeMemory === 'function');
  check('memory_v2 exportiert normalizeMemoryLayer',        typeof m.normalizeMemoryLayer === 'function');
  check('memory_v2 exportiert isSensitiveMemoryContent',    typeof m.isSensitiveMemoryContent === 'function');
} catch (e) {
  check('memory_v2.mjs import 成功', false, e.message);
}

// ─── 4. persona_guard.mjs exports ────────────────────────────────────────────
try {
  const m = await import(path.join(ROOT, 'src/persona_guard.mjs'));
  const exportedFns = Object.values(m).filter(v => typeof v === 'function');
  check('persona_guard.mjs 至少导出 1 个函数', exportedFns.length >= 1);
} catch (e) {
  check('persona_guard.mjs import 成功', false, e.message);
}

// ─── 5. emotion_state.mjs exports ────────────────────────────────────────────
try {
  const m = await import(path.join(ROOT, 'src/emotion_state.mjs'));
  check('emotion_state exportiert getEmotionStateWithDefaults', typeof m.getEmotionStateWithDefaults === 'function');
  check('emotion_state exportiert updateEmotionFromUserMessage', typeof m.updateEmotionFromUserMessage === 'function');
  check('emotion_state exportiert buildEmotionPromptHint',       typeof m.buildEmotionPromptHint === 'function');
  check('emotion_state exportiert recordEmotionSnapshot',        typeof m.recordEmotionSnapshot === 'function');
  check('emotion_state exportiert getEmotionTrend',              typeof m.getEmotionTrend === 'function');
} catch (e) {
  check('emotion_state.mjs import 成功', false, e.message);
}

// ─── 6. proactive_engine.mjs exports ─────────────────────────────────────────
try {
  const m = await import(path.join(ROOT, 'src/proactive_engine.mjs'));
  check('proactive_engine exportiert evaluateProactive',   typeof m.evaluateProactive === 'function');
  check('proactive_engine exportiert computeMissingScore', typeof m.computeMissingScore === 'function');
  check('proactive_engine exportiert shouldBackoffProactive', typeof m.shouldBackoffProactive === 'function');
} catch (e) {
  check('proactive_engine.mjs import 成功', false, e.message);
}

// ─── 7. reflection.mjs exports ───────────────────────────────────────────────
try {
  const m = await import(path.join(ROOT, 'src/reflection.mjs'));
  check('reflection exportiert runDailyReflectionForCompanion',  typeof m.runDailyReflectionForCompanion === 'function');
  check('reflection exportiert runWeeklyReflectionForCompanion', typeof m.runWeeklyReflectionForCompanion === 'function');
  check('reflection exportiert buildReflectionPrompt',           typeof m.buildReflectionPrompt === 'function');
  check('reflection exportiert normalizeReflectionResult',       typeof m.normalizeReflectionResult === 'function');
  check('reflection exportiert applyReflectionMemoryUpdates',    typeof m.applyReflectionMemoryUpdates === 'function');
} catch (e) {
  check('reflection.mjs import 成功', false, e.message);
}

// ─── 8. package.json scripts ─────────────────────────────────────────────────
try {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const pkg = req(path.join(ROOT, 'package.json'));
  check('package.json scripts.start 存在',    typeof pkg.scripts?.start === 'string');
  check('package.json scripts.doctor 存在',   typeof pkg.scripts?.doctor === 'string');
  check('package.json scripts["check:p0"] 存在', typeof pkg.scripts?.['check:p0'] === 'string');
} catch (e) {
  check('package.json 读取', false, e.message);
}

// ─── 9. memory_v2 sensitive filter functional test ───────────────────────────
try {
  const m9 = await import(path.join(ROOT, 'src/memory_v2.mjs'));
  // Use a clearly fake key that matches the API key pattern (no real key)
  const fakeKey = 'sk-' + 'x'.repeat(21);
  const detects = m9.isSensitiveMemoryContent(fakeKey);
  check('memory_v2 isSensitiveMemoryContent 检测 API key', detects === true);
} catch (e) {
  check('memory_v2 isSensitiveMemoryContent 检测 API key', false, e.message);
}

// ─── 10. HTTP health / auth checks (via Node fetch if server running) ─────────
// Priority: CHECK_BASE_URL > API_PORT > PORT > 3000
const BASE = process.env.CHECK_BASE_URL
  || (process.env.API_PORT ? `http://127.0.0.1:${process.env.API_PORT}` : null)
  || (process.env.PORT     ? `http://127.0.0.1:${process.env.PORT}`     : null)
  || 'http://127.0.0.1:3000';
console.log(`\n[check:p0] HTTP 检查目标: ${BASE}`);

try {
  const healthResp = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
  check('/api/health 返回 200', healthResp.status === 200);

  const memResp = await fetch(`${BASE}/api/companions/1/memories`, { signal: AbortSignal.timeout(3000) });
  const isAuth = memResp.status === 401 || memResp.status === 403;
  check('未登录 /api/companions/1/memories 返回 401/403 (不是 500)', isAuth, `status=${memResp.status}`);

  const debugResp = await fetch(`${BASE}/api/companions/1/prompt-debug`, { signal: AbortSignal.timeout(3000) });
  const isDebugAuth = debugResp.status === 401 || debugResp.status === 403;
  check('未登录 /api/companions/1/prompt-debug 返回 401/403 (不是 500)', isDebugAuth, `status=${debugResp.status}`);

  const trendResp = await fetch(`${BASE}/api/companions/1/emotion-trend`, { signal: AbortSignal.timeout(3000) });
  const isTrendAuth = trendResp.status === 401 || trendResp.status === 403;
  check('未登录 /api/companions/1/emotion-trend 返回 401/403 (不是 500)', isTrendAuth, `status=${trendResp.status}`);
} catch (e) {
  const serverMsg = e.name === 'TimeoutError' || e.code === 'ECONNREFUSED'
    ? '服务器未运行，跳过 HTTP 检查'
    : e.message;
  check('HTTP 检查 (服务器已启动时运行)', false, serverMsg);
}

// ─── Print results ────────────────────────────────────────────────────────────
console.log('\n── P0/P1 Regression Check ──────────────────────────────');
for (const { ok, name, detail } of results) {
  const icon = ok ? '✓' : '✗';
  const color = ok ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';
  const extra = detail ? `  (${detail})` : '';
  console.log(`${color}${icon}${reset} ${name}${extra}`);
}
console.log('────────────────────────────────────────────────────────');
console.log(`  通过: ${passed}  失败: ${failed}  合计: ${passed + failed}`);
console.log('────────────────────────────────────────────────────────\n');

if (failed > 0) process.exit(1);
