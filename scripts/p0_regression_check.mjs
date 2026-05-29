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

// ─── 13. Setup Wizard static checks ──────────────────────────────────────────
check('public/app/setup.html 存在', fileExists('public/app/setup.html'));
check('scripts/setup-wizard.mjs 存在', fileExists('scripts/setup-wizard.mjs'));

// app_settings 表定义存在于 db.mjs
try {
  const { readFileSync } = await import('node:fs');
  const dbSrc = readFileSync(path.join(ROOT, 'src/db.mjs'), 'utf-8');
  check('db.mjs 包含 app_settings 表定义', dbSrc.includes('CREATE TABLE IF NOT EXISTS app_settings'));
  check('db.mjs 导出 getAppSetting',        dbSrc.includes('export function getAppSetting'));
  check('db.mjs 导出 setAppSetting',        dbSrc.includes('export function setAppSetting'));
  check('db.mjs 不在日志输出 setting value', !dbSrc.match(/log\(.*(value|secret)/));
} catch (e) {
  check('db.mjs app_settings 静态检查', false, e.message);
}

// chat.mjs 安全：不泄露 key
try {
  const { readFileSync } = await import('node:fs');
  const chatSrc = readFileSync(path.join(ROOT, 'src/providers/chat.mjs'), 'utf-8');
  check('chat.mjs 导出 REGISTRY',               chatSrc.includes('export const REGISTRY'));
  check('chat.mjs 导出 testChatProvider',        chatSrc.includes('export async function testChatProvider'));
  check('chat.mjs provider 支持 app_settings',   chatSrc.includes('getAppSetting'));
  check('chat.mjs 不在日志输出 apiKey 明文',
    !chatSrc.match(/log\(.*apiKey/) && !chatSrc.match(/console\.log\(.*apiKey/));
} catch (e) {
  check('chat.mjs 静态检查', false, e.message);
}

// api.mjs 包含新 setup 路由
try {
  const { readFileSync } = await import('node:fs');
  const apiSrc = readFileSync(path.join(ROOT, 'src/api.mjs'), 'utf-8');
  check('api.mjs 包含 /setup/provider-status 路由', apiSrc.includes("'/setup/provider-status'"));
  check('api.mjs 包含 /setup/provider-config 路由', apiSrc.includes("'/setup/provider-config'"));
  check('api.mjs 包含 /setup/test-provider 路由',   apiSrc.includes("'/setup/test-provider'"));
  check('api.mjs /setup/provider-status 不返回完整 key',
    !apiSrc.includes('apiKey') || apiSrc.includes('maskApiKey'));
  check('api.mjs /setup/provider-config 要求 requireAuth',
    /provider-config.*\n.*requireAuth|requireAuth.*\n.*provider-config/.test(apiSrc) ||
    apiSrc.includes("'/setup/provider-config',\n  requireAuth") ||
    apiSrc.includes("'/setup/provider-config',\n  requireAuth,") ||
    apiSrc.includes("provider-config',\n  requireAuth"));
  check('api.mjs /setup/provider-status 使用 softAuth',
    apiSrc.includes("'/setup/provider-status', softAuth") ||
    apiSrc.includes("'/setup/provider-status',\n  softAuth"));
  check('api.mjs /setup/test-provider 含匿名访问限制逻辑',
    apiSrc.includes('countAllAccounts') && apiSrc.includes('isLocalhost'));
} catch (e) {
  check('api.mjs setup 路由静态检查', false, e.message);
}

// ─── 14. HTTP Setup API checks (via Node fetch if server running) ─────────────
try {
  const setupStatusResp = await fetch(`${BASE}/api/setup/status`, { signal: AbortSignal.timeout(3000) });
  check('/api/setup/status 返回 200', setupStatusResp.status === 200);

  const setupStatusBody = await setupStatusResp.json();
  // 确保不泄露 secret
  const bodyStr = JSON.stringify(setupStatusBody);
  const hasApiKey = /sk-[a-zA-Z0-9]{10}|Bearer [a-zA-Z0-9]{10}/.test(bodyStr);
  check('/api/setup/status 不泄露 secret', !hasApiKey);

  // provider-status 匿名访问：不含 masked_key、source，不含完整 key
  const psResp = await fetch(`${BASE}/api/setup/provider-status`, { signal: AbortSignal.timeout(3000) });
  check('/api/setup/provider-status 返回 200', psResp.status === 200);
  const psBody = await psResp.json();
  if (psBody.ok && psBody.data?.providers) {
    let leaksFullKey = false;
    let hasMaskedKey = false;
    let hasSource = false;
    for (const [, pInfo] of Object.entries(psBody.data.providers)) {
      if (pInfo.masked_key && pInfo.masked_key.length > 20 && !pInfo.masked_key.includes('···')) {
        leaksFullKey = true;
      }
      if ('masked_key' in pInfo) hasMaskedKey = true;
      if ('source' in pInfo) hasSource = true;
    }
    check('/api/setup/provider-status 匿名时不含完整 key', !leaksFullKey);
    check('/api/setup/provider-status 匿名时不返回 masked_key 字段', !hasMaskedKey);
    check('/api/setup/provider-status 匿名时不返回 source 字段', !hasSource);
  }

  // provider-config 未登录时返回 401
  const pcResp = await fetch(`${BASE}/api/setup/provider-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_provider: 'deepseek', api_key: 'test' }),
    signal: AbortSignal.timeout(3000),
  });
  check('未登录 POST /api/setup/provider-config 返回 401/403', pcResp.status === 401 || pcResp.status === 403,
    `status=${pcResp.status}`);

  // test-provider：已初始化或非本地时未登录应返回 401/403（不是 500）；友好返回不是 500
  const tpResp = await fetch(`${BASE}/api/setup/test-provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'deepseek' }),
    signal: AbortSignal.timeout(20_000),
  });
  const tpStatus = tpResp.status;
  check('/api/setup/test-provider 响应不是 500', tpStatus !== 500, `status=${tpStatus}`);
  if (tpStatus === 401 || tpStatus === 403) {
    let tpErrBody;
    try { tpErrBody = await tpResp.json(); } catch {}
    check('/api/setup/test-provider 401 含友好消息',
      typeof tpErrBody?.message === 'string' && tpErrBody.message.length > 0,
      `message=${JSON.stringify(tpErrBody?.message)}`);
  } else if (tpStatus === 200) {
    const tpBody = await tpResp.json();
    const tpBodyStr = JSON.stringify(tpBody);
    const hasFullKey = /sk-[a-zA-Z0-9]{20,}/.test(tpBodyStr);
    check('/api/setup/test-provider 响应不含完整 API key', !hasFullKey,
      `body=${tpBodyStr.slice(0, 80)}`);
  }
} catch (e) {
  const isTimeout = e.name === 'TimeoutError' || e.code === 'ECONNREFUSED';
  check('HTTP Setup API 检查 (需要服务运行)', false,
    isTimeout ? '服务未运行，跳过 Setup API HTTP 检查' : e.message);
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
