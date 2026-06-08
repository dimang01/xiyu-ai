/**
 * 主入口：multi-tenant polling pool
 *
 * 为每个 active 微信账号开一个独立的 getUpdates 长轮询。
 * 启动时从 DB 加载，运行时通过 registerBotAccount() 动态加入。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import 'dotenv/config';
import { getDb, upsertPollBuf, getPollBuf, getActiveBotAccounts, deactivateBindingIfNoCompanion } from './src/db.mjs';
import {
  getUpdates,
  notifyStart,
  readLegacyCredentials,
  startIlinkSendDrainLoop,
  DEFAULT_BASE_URL,
} from './src/ilink.mjs';
import { handleMessage } from './src/bot.mjs';
import { startApiServer, setBotPoolHandle } from './src/api.mjs';
import { startProactiveScheduler } from './src/proactive.mjs';
import { startPlanTasks } from './src/plan_tasks.mjs';
import { loadAdminCredentials } from './src/admin.mjs';
import { log } from './src/logger.mjs';

const RETRY_MS = 5_000;
const HEARTBEAT_MS = 5 * 60 * 1000;

const pool = new Map(); // botId -> { ctx, running, controller, expired, lastHeartbeat }
let shuttingDown = false;

function ctxKey(botId) { return String(botId || '').trim(); }

export function registerBotAccount(account) {
  const botId = ctxKey(account.botId);
  if (!botId) {
    log('warn', '[Pool] registerBotAccount missing botId, skip');
    return false;
  }
  if (pool.has(botId)) {
    const entry = pool.get(botId);
    if (entry.running) {
      log('info', `[Pool] bot=${shortBot(botId)} already running, skip register`);
      return false;
    }
    entry.ctx = { ...entry.ctx, ...account };
    entry.expired = false;
    log('info', `[Pool] bot=${shortBot(botId)} re-registered`);
    runLoop(botId).catch(err => log('error', `[Pool] runLoop crash bot=${shortBot(botId)}: ${err.message}`));
    return true;
  }

  const entry = {
    ctx: {
      token: account.token,
      botId,
      baseUrl: (account.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, ''),
      userId: account.userId || null,
      accountId: account.accountId || null,
    },
    running: false,
    expired: false,
    lastHeartbeat: 0,
  };
  pool.set(botId, entry);
  log('info', `[Pool] bot=${shortBot(botId)} added`);
  runLoop(botId).catch(err => log('error', `[Pool] runLoop crash bot=${shortBot(botId)}: ${err.message}`));
  return true;
}

export function unregisterBotAccount(botId) {
  const key = ctxKey(botId);
  const entry = pool.get(key);
  if (!entry) return false;
  entry.running = false;
  entry.expired = true;
  pool.delete(key);
  log('info', `[Pool] bot=${shortBot(key)} removed`);
  return true;
}

export function listBotPool() {
  const out = [];
  for (const [botId, entry] of pool.entries()) {
    out.push({
      botId,
      running: entry.running,
      expired: entry.expired,
      lastHeartbeat: entry.lastHeartbeat || null,
      userId: entry.ctx.userId,
      accountId: entry.ctx.accountId,
    });
  }
  return out;
}

async function runLoop(botId) {
  const entry = pool.get(botId);
  if (!entry || entry.running) return;
  entry.running = true;
  log('info', `[Pool] runLoop start bot=${shortBot(botId)}`);

  // 启动时 notifyStart 一次
  const ok = await notifyStart(entry.ctx);
  if (!ok) {
    log('warn', `[Pool] notifyStart failed bot=${shortBot(botId)}, will retry on next getUpdates`);
  }
  entry.lastHeartbeat = Date.now();

  let errorCount = 0;
  while (entry.running && !shuttingDown) {
    try {
      // 周期性心跳
      if (Date.now() - entry.lastHeartbeat > HEARTBEAT_MS) {
        await notifyStart(entry.ctx, { logSuccessLevel: 'debug' });
        entry.lastHeartbeat = Date.now();
      }

      const buf = getPollBuf(botId) ?? '';
      const { msgs, nextBuf, ok: updatesOk, error, sessionExpired } = await getUpdates(entry.ctx, buf);

      if (error) {
        if (sessionExpired) {
          let deactivated = false;
          try { deactivated = deactivateBindingIfNoCompanion(botId); }
          catch (e) { log('warn', `[Pool] bot=${shortBot(botId)} 停用空绑定失败: ${e.message}`); }
          if (deactivated) {
            log('info', `[Pool] bot=${shortBot(botId)} 会话过期且解析不出角色 → 已停用该死绑定（不再空轮询）`);
          } else {
            log('error', `[Pool] bot=${shortBot(botId)} session expired (errcode -14), stopping this loop. Re-bind via web QR.`);
          }
          entry.expired = true;
          entry.running = false;
          break;
        }
        errorCount++;
        log('warn', `[Pool] bot=${shortBot(botId)} getUpdates failed #${errorCount}, retry in ${RETRY_MS}ms`);
        await sleep(RETRY_MS);
        continue;
      }
      errorCount = 0;

      if (updatesOk && nextBuf !== undefined) {
        try { upsertPollBuf(botId, nextBuf); }
        catch (err) { log('error', `[Pool] bot=${shortBot(botId)} 保存 poll_state 失败: ${err.message}`); }
      }

      for (const msg of msgs) {
        await handleMessage(msg, entry.ctx).catch(err =>
          log('error', `[Pool] bot=${shortBot(botId)} handleMessage 异常: ${err.message}`)
        );
      }

      await sleep(200);

    } catch (err) {
      errorCount++;
      log('error', `[Pool] bot=${shortBot(botId)} 未捕获异常 #${errorCount}: ${err.message}`);
      await sleep(RETRY_MS);
    }
  }
  log('info', `[Pool] runLoop end bot=${shortBot(botId)}`);
}

async function bootstrap() {
  getDb();
  log('info', '[Main] 数据库初始化完成');

  // 初始化管理员凭据（首次启动会生成并打印一次密码）
  loadAdminCredentials();

  // 启动 REST API
  startApiServer();
  setBotPoolHandle({ registerBotAccount, unregisterBotAccount, listBotPool });

  // 主动消息 + 计划任务
  startProactiveScheduler();
  startPlanTasks();
  // v1.10.12: iLink send 限速队列 drain loop（撞 quota 时延后重发，不丢消息）
  startIlinkSendDrainLoop();

  // 加载 DB 里所有 active 绑定
  const accounts = getActiveBotAccounts();
  log('info', `[Main] 加载 active 绑定 count=${accounts.length}`);
  for (const account of accounts) {
    registerBotAccount({
      token: account.bot_token,
      botId: account.bot_id,
      userId: account.wechat_user_id,
      accountId: account.account_id,
    });
  }

  // ── iLink 凭据加载（优先级：env > .weixin-credentials.json） ────────────
  // env 配置：ILINK_BASE_URL / ILINK_BOT_TOKEN / ILINK_BOT_ID / ILINK_USER_ID
  // 若 env 没配，则尝试读取 ./.weixin-credentials.json（由 `npm run ilink:login` 生成）
  // 两者都没有时，服务仍会启动，仅微信功能 disabled
  if (process.env.ILINK_BOT_TOKEN && process.env.ILINK_BOT_ID) {
    const envBotId = String(process.env.ILINK_BOT_ID).trim();
    if (!pool.has(ctxKey(envBotId))) {
      log('info', `[Main] 加载 env iLink 凭据 bot=${shortBot(envBotId)} (source=env)`);
      registerBotAccount({
        token: process.env.ILINK_BOT_TOKEN,
        botId: envBotId,
        userId: process.env.ILINK_USER_ID || '',
        baseUrl: process.env.ILINK_BASE_URL || DEFAULT_BASE_URL,
        accountId: null,
      });
    }
  } else {
    const legacy = readLegacyCredentials();
    if (legacy?.botId && legacy?.token && !pool.has(ctxKey(legacy.botId))) {
      log('info', `[Main] 加载 iLink 凭据文件 bot=${shortBot(legacy.botId)} (source=credentials_file)`);
      registerBotAccount({
        token: legacy.token,
        botId: legacy.botId,
        userId: legacy.userId,
        baseUrl: legacy.baseUrl,
        accountId: null,
      });
    } else {
      log('info', '[Main] 未检测到 iLink 凭据（env 或 .weixin-credentials.json）。微信功能 disabled。可运行 `npm run ilink:login` 接入。');
    }
  }

  log('info', `[Main] bot pool size=${pool.size}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function shortBot(botId) { return String(botId || '').slice(0, 12); }

process.on('SIGTERM', () => {
  log('info', '[Main] SIGTERM 收到，退出中...');
  shuttingDown = true;
  for (const entry of pool.values()) entry.running = false;
  setTimeout(() => process.exit(0), 3000);
});
process.on('SIGINT', () => {
  log('info', '[Main] SIGINT 收到，退出中...');
  shuttingDown = true;
  for (const entry of pool.values()) entry.running = false;
  setTimeout(() => process.exit(0), 3000);
});

bootstrap().catch(err => {
  log('error', `[Main] 启动失败: ${err.message}\n${err.stack}`);
  process.exit(1);
});
