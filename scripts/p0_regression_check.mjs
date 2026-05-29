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

  // /api/setup/status 返回 200 且不包含任何 secret
  try {
    const setupResp = await fetch(`${BASE}/api/setup/status`, { signal: AbortSignal.timeout(3000) });
    check('/api/setup/status 返回 200', setupResp.status === 200);
    if (setupResp.status === 200) {
      const setupBody = await setupResp.text();
      const FORBIDDEN_KEYS = ['AUTH_SECRET', 'ADMIN_SECRET', 'API_KEY', 'BOT_TOKEN', 'bot_token', 'password_hash'];
      const leaked = FORBIDDEN_KEYS.filter(k => setupBody.includes(k));
      check('/api/setup/status 响应不含敏感字段', leaked.length === 0,
        leaked.length > 0 ? `发现: ${leaked.join(', ')}` : '');
    }
  } catch (setupErr) {
    check('/api/setup/status 返回 200', false, setupErr.message);
  }

  // /api/setup/local-account 在已有用户时返回 409
  try {
    const localR = await fetch(`${BASE}/api/setup/local-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'test' }),
      signal: AbortSignal.timeout(3000),
    });
    // 已有用户 → 409；AUTH_MODE=email → 403；空库本地模式 → 201（均非 500）
    const isExpected = localR.status === 409 || localR.status === 403 || localR.status === 201;
    check('/api/setup/local-account 返回 409/403/201（非 500）', isExpected, `status=${localR.status}`);
  } catch (e2) {
    check('/api/setup/local-account 可访问', false, e2.message);
  }

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
    // P2A endpoints — event graph, achievements, persona export
    { ep: '/api/companions/1/event-graph',   method: 'GET'  },
    { ep: '/api/companions/1/achievements',  method: 'GET'  },
    { ep: '/api/companions/1/export',        method: 'GET'  },
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

// ─── 12. event_graph.mjs security static checks ──────────────────────────────
check('src/event_graph.mjs 存在', fileExists('src/event_graph.mjs'));

try {
  const eg = await import(path.join(ROOT, 'src/event_graph.mjs'));
  check('event_graph 导出 shouldProcessMemoryForGraph',      typeof eg.shouldProcessMemoryForGraph === 'function');
  check('event_graph 导出 extractSimpleEntitiesFromMemory',  typeof eg.extractSimpleEntitiesFromMemory === 'function');
  check('event_graph 导出 processMemoryForGraph',            typeof eg.processMemoryForGraph === 'function');

  // Functional tests for shouldProcessMemoryForGraph
  check('shouldProcessMemoryForGraph 拦截 sensitive_flag=1',
    eg.shouldProcessMemoryForGraph({ sensitive_flag: 1 }) === false);
  check('shouldProcessMemoryForGraph 拦截 do_not_mention=1',
    eg.shouldProcessMemoryForGraph({ do_not_mention: 1 }) === false);
  check('shouldProcessMemoryForGraph 拦截 memory_layer=emotion',
    eg.shouldProcessMemoryForGraph({ memory_layer: 'emotion' }) === false);
  check('shouldProcessMemoryForGraph 放行普通记忆',
    eg.shouldProcessMemoryForGraph({ memory_layer: 'event', sensitive_flag: 0, do_not_mention: 0, memory_status: 'active' }) === true);
} catch (e) {
  check('event_graph.mjs import 成功', false, e.message);
}

// Source-level audit: verify guard fields are referenced inside processMemoryForGraph
try {
  const { readFileSync } = await import('node:fs');
  const egSrc = readFileSync(path.join(ROOT, 'src/event_graph.mjs'), 'utf-8');

  // shouldProcessMemoryForGraph must reference sensitive_flag and do_not_mention
  check('event_graph.mjs 源码包含 sensitive_flag 判断',
    egSrc.includes('sensitive_flag'));
  check('event_graph.mjs 源码包含 do_not_mention 判断',
    egSrc.includes('do_not_mention'));
  // processMemoryForGraph must call shouldProcessMemoryForGraph
  check('processMemoryForGraph 调用 shouldProcessMemoryForGraph',
    egSrc.includes('shouldProcessMemoryForGraph'));
  // processMemoryForGraph signature must accept memoryMeta param
  check('processMemoryForGraph 接受 memoryMeta 参数',
    /processMemoryForGraph\s*\([^)]*memoryMeta/.test(egSrc));
} catch (e) {
  check('event_graph.mjs 源码审计', false, e.message);
}

// ─── 13. setup.mjs / local-first onboarding 静态检查 ─────────────────────────
check('src/setup.mjs 存在', fileExists('src/setup.mjs'));

try {
  const sm = await import(path.join(ROOT, 'src/setup.mjs'));
  check('setup 导出 getAuthMode',             typeof sm.getAuthMode === 'function');
  check('setup 导出 getSetupStatus',          typeof sm.getSetupStatus === 'function');
  check('setup 导出 isLocalhostRequest',      typeof sm.isLocalhostRequest === 'function');
  check('setup 导出 countUserAccounts',       typeof sm.countUserAccounts === 'function');
  check('setup 导出 generateLocalUsername',   typeof sm.generateLocalUsername === 'function');
  check('setup 导出 generateLocalEmail',      typeof sm.generateLocalEmail === 'function');

  // getSetupStatus 结构验证（当前可能有 DB，也可能没有 — 只检查字段存在）
  try {
    const status = sm.getSetupStatus();
    check('getSetupStatus 返回 auth_mode 字段',          typeof status.auth_mode === 'string');
    check('getSetupStatus 返回 initialized 字段',        typeof status.initialized === 'boolean');
    check('getSetupStatus 返回 user_count 字段',         typeof status.user_count === 'number');
    check('getSetupStatus 返回 email_enabled 字段',      typeof status.email_enabled === 'boolean');
    check('getSetupStatus 返回 local_setup_available 字段', typeof status.local_setup_available === 'boolean');
  } catch (e) {
    // DB 可能未初始化时仍需这些字段，只警告不 fail
    check('getSetupStatus 返回正确结构', false, e.message);
  }

  // localhost 检测逻辑验证
  check('isLocalhostRequest 识别 127.0.0.1',
    sm.isLocalhostRequest({ socket: { remoteAddress: '127.0.0.1' } }) === true);
  check('isLocalhostRequest 识别 ::1',
    sm.isLocalhostRequest({ socket: { remoteAddress: '::1' } }) === true);
  check('isLocalhostRequest 拦截远程 IP',
    sm.isLocalhostRequest({ socket: { remoteAddress: '1.2.3.4' } }) === false);

  // generateLocalEmail 不含真实域名
  const testEmail = sm.generateLocalEmail();
  check('generateLocalEmail 生成 local.xiyu 域名',     testEmail.endsWith('@local.xiyu'));
  check('generateLocalEmail 不含真实邮件域名',          !testEmail.includes('.com') && !testEmail.includes('.cn'));
} catch (e) {
  check('setup.mjs import 成功', false, e.message);
}

// API 源码审计：setup 路由不能泄露 secret
try {
  const { readFileSync } = await import('node:fs');
  const apiSrc = readFileSync(path.join(ROOT, 'src/api.mjs'), 'utf-8');
  check('/api/setup/status 路由存在',           apiSrc.includes("'/setup/status'"));
  check('/api/setup/local-account 路由存在',    apiSrc.includes("'/setup/local-account'"));
  check('setup 路由不输出 AUTH_SECRET',
    !apiSrc.slice(apiSrc.indexOf("'/setup/status'") || 0, (apiSrc.indexOf("'/setup/status'") || 0) + 500).includes('AUTH_SECRET'));
} catch (e) {
  check('setup.mjs API 路由源码审计', false, e.message);
}

// HTTP: /api/setup/status 在服务运行时返回 200 且无 secret
// 此检查在 HTTP 检查块内已覆盖 or 在服务不可用时跳过，故这里仅做静态补充。
// 动态 HTTP 检查见 Section 11 的 try 块，setup/status 200 已包含在内。

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
