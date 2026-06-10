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

  // v1.10.0 proactive bug 防回归：v2 拒发时必须 *不* 立刻 item.sent=true
  const proSrc = readFileSync(path.join(ROOT, 'src/proactive.mjs'), 'utf-8');
  check('proactive.mjs v2 拒发时延期重试（不立即标 sent）',
    /_v2_deny_until/.test(proSrc),
    !/_v2_deny_until/.test(proSrc) ? '缺 _v2_deny_until 字段，v2 拒发会浪费配额' : '');
  check('proactive.mjs sendProactiveMessage 缺微信绑定时有 warn log',
    /未绑定微信.*wechat_user_id 缺/.test(proSrc),
    !/未绑定微信.*wechat_user_id 缺/.test(proSrc) ? '缺 silent return 日志' : '');

  // v1.10.1 proactive 审计防回归
  // 1) morning kind 必须在 sleep enabled 守卫（useSleepBase）内判定，不能在 buildDailyItems 无条件抬第一条
  check('proactive.mjs morning kind 受 useSleepBase 守卫（不无条件抬第一条 normal）',
    // v1.19.5: 窗口 400→900 — useSleepBase 块内加了 morningAlreadySent 防重判定（重启重算
    // 不再重复早安），守卫语义不变但块变长
    !/findIndex\(it => it\.kind === 'normal'\)/.test(proSrc) && /useSleepBase[\s\S]{0,900}firstNormal\.kind = 'morning'/.test(proSrc),
    '若失败：buildDailyItems 仍无条件抬 morning → 下午重启发"下午的早安" + 误清 missed');
  // v1.19.5: morning 防重双闸——排程侧跳过抬升 + 发送侧降级 normal（重复"刚醒"早安根治）
  check('proactive.mjs morning 防重：排程侧查 goodmorning_sent_for_date + 发送侧 shouldDemoteMorning',
    /goodmorning_sent_for_date === dateKey/.test(proSrc) && /shouldDemoteMorning\(/.test(proSrc),
    '若失败：服务重启丢内存排程重算 → 7 点发过"刚醒"，9 点半 morning 又来一条');
  // v1.19.6: goodnight 防重双闸（morning 同款 bug 的对称修复）——排程侧移除 + 发送侧 dup 跳过
  check('proactive.mjs goodnight 防重：排程侧 filter + 发送侧 goodnight_sent_for_date dup 跳过',
    /goodnight_sent_for_date === dateKey/.test(proSrc) && /it\.kind !== 'goodnight'/.test(proSrc)
      && /goodnight_sent_for_date === shanghaiDateKey\(\)/.test(proSrc) && /return 'dup'/.test(proSrc),
    '若失败：深夜重启丢内存排程重算 → 刚说过晚安又来一条');
  // 2) guarded 返回投递状态，tick 据此 defer 而非消耗配额
  check('proactive.mjs guarded 返回投递状态（throttled/inflight/safety/sent）',
    /return 'throttled'/.test(proSrc) && /return 'inflight'/.test(proSrc)
      && /return 'safety'/.test(proSrc) && /return 'sent'/.test(proSrc),
    '若失败：节流类 silent return 仍消耗 item → 实发条数 < target');
  // 3) 跨午夜晚安：用 bedMin < wakeMin 判定，不是死代码 bedMin >= 24*60
  check('proactive.mjs 跨午夜晚安用 bedMin < wakeMin（非死代码 >=24*60）',
    /bedMin < wakeMin \? LAST_MINUTE/.test(proSrc) && !/bedMin >= 24 \* 60/.test(proSrc),
    '若失败：凌晨入睡用户当天不发晚安 → 不触发 enterSleep');

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
    // v1.10.22: 允许中间夹 blockIfHosted 等其它 middleware
    /provider-config'[\s\S]{0,200}requireAuth/.test(apiSrc));
  check('api.mjs /setup/provider-status 使用 softAuth',
    apiSrc.includes("'/setup/provider-status', softAuth") ||
    apiSrc.includes("'/setup/provider-status',\n  softAuth"));
  check('api.mjs /setup/test-provider 含匿名访问限制逻辑',
    apiSrc.includes('countAllAccounts') && apiSrc.includes('isLocalhost'));
  check('api.mjs 包含 /auth/me 路由',
    apiSrc.includes("'/auth/me'") || apiSrc.includes('"/auth/me"'));
  check('api.mjs /auth/me 使用 softAuth',
    apiSrc.includes("'/auth/me', softAuth") || apiSrc.includes('"/auth/me", softAuth'));
  check('api.mjs /auth/me 不返回 password',
    (() => {
      // 只检查 /auth/me 路由体内（到第一个 });  为止），不含后续代码
      const start = apiSrc.indexOf("'/auth/me'");
      const end   = apiSrc.indexOf('});', start) + 3;
      const meBlock = apiSrc.slice(start, end);
      // 路由体内不应出现 password_hash；注释或响应字段名含 password 均为误判
      return !meBlock.includes('password_hash') && !meBlock.includes("'password'") && !meBlock.includes('"password"');
    })());
  check('api.mjs 包含 /setup/local-account 路由',
    apiSrc.includes("'/setup/local-account'"));
  check('api.mjs /setup/local-account 检查 user_count=0',
    apiSrc.includes("'/setup/local-account'") && apiSrc.includes('userCount > 0'));
  check('api.mjs /setup/status 返回 auth_mode 字段',
    apiSrc.includes('auth_mode:'));
  check('api.mjs /setup/status 返回 initialized 字段',
    apiSrc.includes('initialized,') || apiSrc.includes('initialized:'));
} catch (e) {
  check('api.mjs setup 路由静态检查', false, e.message);
}

// ─── 15. setup.html / auth.html 静态检查 ─────────────────────────────────
try {
  const { readFileSync } = await import('node:fs');
  const setupSrc = readFileSync(path.join(ROOT, 'public/app/setup.html'), 'utf-8');
  const authSrc  = readFileSync(path.join(ROOT, 'public/app/auth.html'), 'utf-8');

  // setup.html 不得出现邮箱验证码发送逻辑
  check('setup.html 不包含 send-code 邮件逻辑',
    !setupSrc.includes('send-code') && !setupSrc.includes('sendCode') &&
    !setupSrc.includes('验证码') && !setupSrc.includes('email') ||
    // 允许 "email mode" 提示文字，但不允许实际调用
    (!setupSrc.includes('/api/auth/send-code') && !setupSrc.includes("purpose: 'register'")));

  // setup.html 必须有状态判断关键词
  check('setup.html 包含 auth_mode 状态判断', setupSrc.includes('auth_mode'));
  check('setup.html 包含 initialized 状态判断', setupSrc.includes('initialized'));
  check('setup.html 包含 authenticated 状态判断', setupSrc.includes('authenticated'));

  // setup.html 有 local-account 调用
  check('setup.html 调用 /api/setup/local-account', setupSrc.includes('/api/setup/local-account'));

  // setup.html Step 2 按钮有 gate 条件
  check('setup.html s2-btn-next 有 disabled gate',
    setupSrc.includes('s2-btn-next') && setupSrc.includes('providerSaved'));
  // setup.html Step 3 按钮有 gate 条件
  check('setup.html s3-btn-next 有 disabled gate',
    setupSrc.includes('s3-btn-next') && (setupSrc.includes('testPassed') || setupSrc.includes('testSkipped')));

  // setup.html 处理 401/403
  check('setup.html 处理 401/403 友好提示',
    setupSrc.includes('401') && setupSrc.includes('403'));

  // auth.html 在 local 模式下有去 setup 的提示
  check('auth.html 包含 local 模式 setup 引导',
    authSrc.includes('/app/setup.html') && authSrc.includes('local'));
  check('auth.html local 未初始化时隐藏注册 tab',
    authSrc.includes('tabReg.style.display') || authSrc.includes("display = 'none'"));
} catch (e) {
  check('setup/auth.html 静态检查', false, e.message);
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
  // v1.10.20: HOSTED_MODE=true 时此端点应该 404（防 curl 抓技术栈），其它情况期望 200
  const hostedModeOn = setupStatusBody?.data?.hosted_mode === true;
  const psResp = await fetch(`${BASE}/api/setup/provider-status`, { signal: AbortSignal.timeout(3000) });
  check(
    hostedModeOn
      ? '/api/setup/provider-status hosted 模式返 404'
      : '/api/setup/provider-status 返回 200',
    hostedModeOn ? psResp.status === 404 : psResp.status === 200,
  );
  const psBody = psResp.status === 200 ? await psResp.json() : null;
  if (psBody?.ok && psBody.data?.providers) {
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

  // setup/status 应包含 auth_mode 和 initialized 字段
  check('/api/setup/status 含 auth_mode 字段',
    typeof setupStatusBody.data?.auth_mode === 'string',
    `auth_mode=${JSON.stringify(setupStatusBody.data?.auth_mode)}`);
  check('/api/setup/status 含 initialized 字段',
    typeof setupStatusBody.data?.initialized === 'boolean',
    `initialized=${JSON.stringify(setupStatusBody.data?.initialized)}`);

  // /api/auth/me 未登录时返回 authenticated=false（不是 500）
  const meResp = await fetch(`${BASE}/api/auth/me`, { signal: AbortSignal.timeout(3000) });
  check('/api/auth/me 未登录返回 200（不是 500）', meResp.status === 200,
    `status=${meResp.status}`);
  const meBody = await meResp.json();
  check('/api/auth/me 未登录时 authenticated=false',
    meBody.data?.authenticated === false,
    `authenticated=${JSON.stringify(meBody.data?.authenticated)}`);
  check('/api/auth/me 不含 password 字段',
    !JSON.stringify(meBody).toLowerCase().includes('password'),
    `body snippet=${JSON.stringify(meBody).slice(0, 80)}`);

  // /api/setup/local-account 在系统已初始化时返回 403（不是 500）
  // 注意：此 check 只适用于系统已有账号的场景（check 时服务器已运行且 DB 可能已有账号）
  const laResp = await fetch(`${BASE}/api/setup/local-account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'testuser99', password: 'testpass99' }),
    signal: AbortSignal.timeout(5000),
  });
  const laStatus = laResp.status;
  check('/api/setup/local-account 在已初始化时返回 403 或 201（不是 500）',
    laStatus !== 500, `status=${laStatus}`);

  // provider-config 未登录时返回 401
  const pcResp = await fetch(`${BASE}/api/setup/provider-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_provider: 'deepseek', api_key: 'test' }),
    signal: AbortSignal.timeout(3000),
  });
  // v1.10.22: HOSTED_MODE=true 时 blockIfHosted 在 requireAuth 之前返 404
  check(
    hostedModeOn
      ? '未登录 POST /api/setup/provider-config hosted 返 404'
      : '未登录 POST /api/setup/provider-config 返回 401/403',
    hostedModeOn ? pcResp.status === 404 : (pcResp.status === 401 || pcResp.status === 403),
    `status=${pcResp.status}`,
  );

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
