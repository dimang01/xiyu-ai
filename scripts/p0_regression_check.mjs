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

// ─── 10. Companion ownership static audit ────────────────────────────────────
// Verify that no user-facing /companions/:id/* route uses bare requireCompanion
// (which only checks existence, not ownership). All such routes must use
// requireOwnedCompanion so that cross-user access returns 403.
try {
  const { readFileSync } = await import('node:fs');
  const apiSrc = readFileSync(path.join(ROOT, 'src/api.mjs'), 'utf-8');

  // Count remaining bare requireCompanion call sites (excludes function definition)
  // A call site looks like "requireCompanion(res, id); if (!c) return;"
  const bareCallSites = (apiSrc.match(/requireCompanion\(res, id\); if \(!c\) return;/g) || []).length;
  check('user 路由无 requireCompanion 调用点（全部改为 requireOwnedCompanion）', bareCallSites === 0,
    bareCallSites > 0 ? `仍有 ${bareCallSites} 处未修复` : '');

  // Verify key ownership-sensitive routes use requireOwnedCompanion
  const ownershipRoutes = [
    { path: '/companions/:id/memories',      method: 'requireOwnedCompanion' },
    { path: '/companions/:id/prompt-debug',  method: 'requireOwnedCompanion' },
    { path: '/companions/:id/emotion-trend', method: 'requireOwnedCompanion' },
    { path: '/companions/:id/user-profile',  method: 'requireOwnedCompanion' },
    { path: '/companions/:id/mood',          method: 'requireOwnedCompanion' },
    { path: '/companions/:id/scene',         method: 'requireOwnedCompanion' },
    { path: '/companions/:id/reminders',     method: 'requireOwnedCompanion' },
    { path: '/companions/:id/persona',       method: 'requireOwnedCompanion' },
    { path: '/companions/:id/avatar',        method: 'requireOwnedCompanion' },
    { path: '/companions/:id/affection',     method: 'requireOwnedCompanion' },
    { path: '/companions/:id/context',       method: 'requireOwnedCompanion' },
  ];

  for (const { path: rPath } of ownershipRoutes) {
    // Find the route declaration and check the next requireOwnedCompanion call
    // Use escaped path for regex: /companions/:id/mood → /companions\/:id\/mood
    const escaped = rPath.replace(/\//g, '\\/').replace(/:/g, ':');
    const re = new RegExp(`'${escaped}[^']*'[\\s\\S]{0,400}?requireOwnedCompanion`);
    const found = re.test(apiSrc);
    check(`${rPath} 使用 requireOwnedCompanion`, found);
  }

  // Verify DELETE /companions/:id uses req.authUser.id (not body-provided accountId).
  // Use position-based search: find the route declaration, then scan the next 1000 chars.
  const deleteRouteIdx = apiSrc.indexOf("router.delete('/companions/:id'");
  const deleteRegion = deleteRouteIdx >= 0 ? apiSrc.slice(deleteRouteIdx, deleteRouteIdx + 1200) : '';
  const usesAuthUser = deleteRegion.includes('req.authUser.id');
  const usesBodyId = deleteRegion.includes('req.query.user_id') || deleteRegion.includes('req.body?.user_id');
  check('DELETE /companions/:id 使用 req.authUser.id（不取 body user_id）', usesAuthUser && !usesBodyId);

} catch (e) {
  check('ownership 静态检查', false, e.message);
}

// ─── 11. HTTP health / auth checks (via Node fetch if server running) ─────────
// Priority: CHECK_BASE_URL > API_PORT > PORT > 3000
const BASE = process.env.CHECK_BASE_URL
  || (process.env.API_PORT ? `http://127.0.0.1:${process.env.API_PORT}` : null)
  || (process.env.PORT     ? `http://127.0.0.1:${process.env.PORT}`     : null)
  || 'http://127.0.0.1:3000';
console.log(`\n[check:p0] HTTP 检查目标: ${BASE}`);

try {
  const healthResp = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
  check('/api/health 返回 200', healthResp.status === 200);

  // All companion-specific endpoints must reject unauthenticated requests (401/403).
  // Specify the correct HTTP method for each endpoint.
  const authEndpoints = [
    { ep: '/api/companions/1/memories',      method: 'GET'  },
    { ep: '/api/companions/1/prompt-debug',  method: 'GET'  },
    { ep: '/api/companions/1/emotion-trend', method: 'GET'  },
    { ep: '/api/companions/1/mood',          method: 'PUT'  },
    { ep: '/api/companions/1/scene',         method: 'PUT'  },
    { ep: '/api/companions/1/reminders',     method: 'GET'  },
    { ep: '/api/companions/1/persona',       method: 'GET'  },
    { ep: '/api/companions/1/avatar/suggest',method: 'GET'  },
    { ep: '/api/companions/1/status',        method: 'GET'  },
    { ep: '/api/companions/1/context',       method: 'GET'  },
    { ep: '/api/companions/1/user-profile',  method: 'GET'  },
    { ep: '/api/companions/1/affection',     method: 'PUT'  },
  ];
  for (const { ep, method } of authEndpoints) {
    try {
      const r = await fetch(`${BASE}${ep}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method !== 'GET' ? '{}' : undefined,
        signal: AbortSignal.timeout(3000),
      });
      const isProtected = r.status === 401 || r.status === 403;
      check(`未登录 ${method} ${ep} 返回 401/403 (不是 500)`, isProtected, `status=${r.status}`);
    } catch (fetchErr) {
      check(`未登录 ${method} ${ep} 返回 401/403`, false, fetchErr.message);
    }
  }
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
