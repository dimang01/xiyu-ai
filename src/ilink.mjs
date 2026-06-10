/**
 * iLink HTTP/JSON 协议封装（stateless）。
 *
 * 每个 web 账号绑定后拥有自己的 bot_token，所有 API 调用必须显式传入
 * { baseUrl, token }，由调用方（pollers / api routes / bot handler）负责
 * 持有自己的 BotContext。
 *
 * 仍然导出 readLegacyCredentials() 让 main loop 可以把 .weixin-credentials.json
 * 当成一个 fallback account 加进池里。
  *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { log } from './logger.mjs';
import { uploadFile } from './media.mjs';
import { persistContextToken, loadPersistedContextToken } from './db.mjs';

const PLUGIN_VERSION = '2.4.4';
const ILINK_APP_ID = 'bot';
const [vmaj, vmin, vpat] = PLUGIN_VERSION.split('.').map(Number);
const CLIENT_VERSION = String(((vmaj & 0xff) << 16) | ((vmin & 0xff) << 8) | (vpat & 0xff));
const BASE_INFO = { channel_version: PLUGIN_VERSION, bot_agent: 'OpenClaw' };
const CREDENTIALS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.weixin-credentials.json');

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const SESSION_TIMEOUT_ERRCODE = -14;
export const MsgItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
export const MessageType = { NONE: 0, USER: 1, BOT: 2 };
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 };
export const BOT_TYPE = '3';

const lastStatusByBot = new Map();
// 缓存每个 (botId, userId) 最近一次的 context_token，用于主动消息 / context 过期兜底
const lastContextTokenByPair = new Map();
function ctxPairKey(botId, userId) { return `${botId || ''}|${userId || ''}`; }
export function rememberContextToken(botId, userId, token) {
  if (!botId || !userId || !token) return;
  lastContextTokenByPair.set(ctxPairKey(botId, userId), { token, at: Date.now() });
  // v1.4.0 hotfix: 同步持久化到 sqlite，让重启 / 独立脚本也能取到。
  // 失败静默，不阻塞热路径。
  try { persistContextToken(botId, userId, token); } catch { /* DB 不可用时降级到纯内存 */ }
}
export function recallContextToken(botId, userId, maxAgeMs = 24 * 60 * 60 * 1000) {
  const entry = lastContextTokenByPair.get(ctxPairKey(botId, userId));
  if (entry && (Date.now() - entry.at) <= maxAgeMs) return entry.token;
  // miss → 回查持久化表（解决进程重启 / 独立脚本场景）
  try {
    const persisted = loadPersistedContextToken(botId, userId, maxAgeMs);
    if (persisted) {
      // 回填内存 cache，下次走快路径
      lastContextTokenByPair.set(ctxPairKey(botId, userId), { token: persisted, at: Date.now() });
      return persisted;
    }
  } catch { /* DB miss 不阻塞 */ }
  return null;
}

function generateClientId() {
  return `openclaw-weixin-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

// ── iLink 每个 bot 大约 7 条 / 5 分钟。预留 buffer：6 条 / 5 分钟。 ───────────
// 可经 env 调（自托管/本地沙箱用；默认不变）。
const SEND_RATE_LIMIT = Number(process.env.ILINK_SEND_RATE_LIMIT) || 6;
const SEND_RATE_WINDOW_MS = Number(process.env.ILINK_SEND_RATE_WINDOW_MS) || 5 * 60 * 1000;
const sendHistoryByBot = new Map(); // botId -> timestamps[]

function consumeSendQuota(botId) {
  if (!botId) return true;
  const now = Date.now();
  const arr = sendHistoryByBot.get(botId) || [];
  const fresh = arr.filter(t => now - t < SEND_RATE_WINDOW_MS);
  if (fresh.length >= SEND_RATE_LIMIT) {
    sendHistoryByBot.set(botId, fresh);
    return false;
  }
  fresh.push(now);
  sendHistoryByBot.set(botId, fresh);
  return true;
}

// v1.10.12: 不消耗 quota 看一眼是否能发（drain loop 用）。
// v1.20.1: export 给 photo caption 的"尽力而为"判断——caption 撞限速会排队
// 3 分钟后才到（生产实测 13:02 发图 → 13:05 才到配文），上下文早走了，不如不发。
export function peekSendQuota(botId) {
  if (!botId) return true;
  const now = Date.now();
  const arr = sendHistoryByBot.get(botId) || [];
  return arr.filter(t => now - t < SEND_RATE_WINDOW_MS).length < SEND_RATE_LIMIT;
}

// v1.10.12: 撞限速时把消息入 per-bot FIFO 队列，drain loop 每 30s 在 quota 恢复后重发。
// 之前 sendMessage / sendMessageItem 撞限速直接 return false → AI 回复凭空消失。
// 内存队列（不持久化），restart 会丢；考虑到 iLink session 也是内存态、restart 本来就要重新建立，可接受。
const pendingSendByBot = new Map(); // botId -> [{ kind, ctx, msg|toUserId|item|text|contextToken, addedAt }]
const MAX_PENDING_PER_BOT = 50;
const PENDING_TTL_MS = 30 * 60 * 1000;
const DRAIN_INTERVAL_MS = 30 * 1000;

function enqueuePendingSend(botId, payload) {
  const q = pendingSendByBot.get(botId) || [];
  if (q.length >= MAX_PENDING_PER_BOT) {
    const dropped = q.shift();
    log('warn', `[iLink] pending queue full bot=${shortBot(botId)} dropping oldest kind=${dropped.kind}`);
  }
  q.push({ ...payload, addedAt: Date.now() });
  pendingSendByBot.set(botId, q);
  log('info', `[iLink] sendMessage queued (rate limit) bot=${shortBot(botId)} kind=${payload.kind} size=${q.length}`);
}

async function drainPendingForBot(botId) {
  const q = pendingSendByBot.get(botId);
  if (!q || !q.length) return;
  while (q.length) {
    const now = Date.now();
    if (now - q[0].addedAt > PENDING_TTL_MS) {
      const dropped = q.shift();
      log('warn', `[iLink] pending expired bot=${shortBot(botId)} kind=${dropped.kind} age=${Math.round((now - dropped.addedAt) / 1000)}s`);
      continue;
    }
    if (!peekSendQuota(botId)) break;
    const head = q.shift();
    try {
      if (head.kind === 'text') {
        await sendMessage(head.ctx, head.msg, head.text, { _allowQueue: false });
      } else if (head.kind === 'item') {
        await sendMessageItem(head.ctx, head.toUserId, head.item, head.contextToken, { _allowQueue: false });
      }
      log('info', `[iLink] drained pending bot=${shortBot(botId)} kind=${head.kind} remaining=${q.length}`);
    } catch (e) {
      log('warn', `[iLink] drain send failed bot=${shortBot(botId)}: ${e.message}`);
    }
  }
  pendingSendByBot.set(botId, q);
}

let _drainLoopHandle = null;
export function startIlinkSendDrainLoop() {
  if (_drainLoopHandle) return _drainLoopHandle;
  _drainLoopHandle = setInterval(() => {
    for (const botId of [...pendingSendByBot.keys()]) {
      drainPendingForBot(botId).catch(err => log('warn', `[iLink] drain loop error bot=${shortBot(botId)}: ${err.message}`));
    }
  }, DRAIN_INTERVAL_MS);
  log('info', `[iLink] send drain loop started interval=${DRAIN_INTERVAL_MS}ms`);
  return _drainLoopHandle;
}

function stableWechatUin(seed) {
  const key = seed || randomBytes(4).readUInt32BE(0);
  if (!seed) return Buffer.from(String(key), 'utf-8').toString('base64');
  const n = createHash('sha256').update(String(seed)).digest().readUInt32BE(0);
  return Buffer.from(String(n), 'utf-8').toString('base64');
}

function commonHeaders() {
  return {
    'Content-Type': 'application/json',
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': CLIENT_VERSION,
  };
}

function authedHeaders(token, uinSeed) {
  return {
    ...commonHeaders(),
    'AuthorizationType': 'ilink_bot_token',
    'Authorization': `Bearer ${token}`,
    'X-WECHAT-UIN': stableWechatUin(uinSeed),
  };
}

function businessOk(data) {
  const ret = data?.ret;
  const errcode = data?.errcode;
  return (ret == null || ret === 0) && (errcode == null || errcode === 0);
}

function resultFields(data) {
  return {
    ret: data?.ret ?? null,
    errcode: data?.errcode ?? null,
    errmsg: data?.errmsg ?? null,
  };
}

function normBase(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
}

/**
 * Core HTTP wrapper.
 * @param {object} ctx - { baseUrl, token, uinSeed? }
 * @param {string} path
 * @param {object} body
 * @param {object} options - { timeoutMs, label, requireAuth }
 */
export async function requestIlink(ctx, path, body = {}, options = {}) {
  const baseUrl = normBase(ctx.baseUrl);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const label = options.label || path;
  const url = `${baseUrl}/${path.replace(/^\//, '')}`;
  const requireAuth = options.requireAuth !== false;

  if (requireAuth && !ctx.token) {
    const err = new Error(`iLink ${label} failed: token EMPTY`);
    err.httpStatus = null;
    err.data = {};
    throw err;
  }

  const headers = requireAuth && ctx.token
    ? authedHeaders(ctx.token, ctx.uinSeed)
    : commonHeaders();

  let response;
  let raw;
  let data = {};
  try {
    response = await fetch(url, {
      method: options.method || 'POST',
      headers,
      body: options.method === 'GET' ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    raw = await response.text();
    data = raw ? JSON.parse(raw) : {};
  } catch (err) {
    log('warn', `[iLink] ${label} failed network=${err.name || 'Error'} message=${err.message}`);
    err.httpStatus = response?.status ?? null;
    err.data = data;
    throw err;
  }

  const fields = resultFields(data);
  const ok = response.ok && businessOk(data);
  if (!ok) {
    const err = new Error(`iLink ${label} failed HTTP=${response.status} ret=${fields.ret ?? 'null'} errcode=${fields.errcode ?? 'null'} errmsg=${fields.errmsg ?? 'null'}`);
    err.httpStatus = response.status;
    err.data = data;
    err.ret = fields.ret;
    err.errcode = fields.errcode;
    err.errmsg = fields.errmsg;
    if (fields.errcode === SESSION_TIMEOUT_ERRCODE || String(fields.errmsg || '').toLowerCase().includes('session timeout')) {
      err.sessionExpired = true;
    }
    throw err;
  }

  return { httpStatus: response.status, data, ...fields };
}

async function rawGet(baseUrl, endpoint, timeoutMs) {
  const url = `${normBase(baseUrl)}/${endpoint.replace(/^\//, '')}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: commonHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  let data = {};
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = { raw }; }
  }
  if (!response.ok) {
    const err = new Error(`iLink HTTP ${response.status}`);
    err.httpStatus = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ─── QR 登录流程 ─────────────────────────────────────────────────────────────

export async function getBotQrcode(baseUrl = DEFAULT_BASE_URL) {
  const result = await requestIlink({ baseUrl }, `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, {
    local_token_list: [],
  }, { timeoutMs: 10_000, label: 'getBotQrcode', requireAuth: false });
  const d = result.data || {};
  return {
    qrcode: d.qrcode || null,
    qrcodeImgContent: d.qrcode_img_content || null,
    raw: d,
  };
}

/**
 * Poll get_qrcode_status for a single iteration.
 * Returns one of: 'wait', 'scaned', 'need_verifycode', 'scaned_but_redirect',
 *                 'binded_redirect', 'expired', 'verify_code_blocked', 'confirmed'
 * For 'confirmed': { status: 'confirmed', botToken, botId, userId, baseUrl }
 * For 'scaned_but_redirect': { status, redirectHost }
 */
export async function getQrcodeStatus(qrcodeKey, baseUrl = DEFAULT_BASE_URL, options = {}) {
  const timeoutMs = options.timeoutMs ?? 35_000;
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeKey)}`;
  if (options.verifyCode) endpoint += `&verify_code=${encodeURIComponent(options.verifyCode)}`;
  try {
    const data = await rawGet(baseUrl, endpoint, timeoutMs);
    return normalizeQrStatus(data);
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return { status: 'wait' };
    throw err;
  }
}

function normalizeQrStatus(data) {
  const status = String(data?.status || '').toLowerCase();
  if (status === 'confirmed') {
    return {
      status: 'confirmed',
      botToken: data.bot_token || null,
      botId: data.ilink_bot_id || null,
      userId: data.ilink_user_id || null,
      baseUrl: data.baseurl || DEFAULT_BASE_URL,
      raw: data,
    };
  }
  if (status === 'scaned_but_redirect') {
    return { status, redirectHost: data.redirect_host || null, raw: data };
  }
  return { status: status || 'wait', raw: data };
}

// ─── 业务接口 ─────────────────────────────────────────────────────────────────

export async function notifyStart(ctx, { logSuccessLevel = 'info' } = {}) {
  try {
    const result = await requestIlink(ctx, 'ilink/bot/msg/notifystart', { base_info: BASE_INFO }, {
      timeoutMs: 10_000,
      label: `notifyStart[${shortBot(ctx.botId)}]`,
    });
    setLastStatus(ctx.botId, 'notifyStart', { ok: true, ...result });
    log(logSuccessLevel, `[iLink] notifyStart success bot=${shortBot(ctx.botId)} HTTP=${result.httpStatus} ret=${result.ret ?? 'null'}`);
    return true;
  } catch (err) {
    setLastStatus(ctx.botId, 'notifyStart', { ok: false, err });
    log(err.sessionExpired ? 'error' : 'warn', `[iLink] notifyStart failed bot=${shortBot(ctx.botId)} HTTP=${err.httpStatus ?? 'null'} errcode=${err.errcode ?? 'null'} errmsg=${err.errmsg ?? err.message}`);
    return false;
  }
}

export async function getUpdates(ctx, buf, abortSignal) {
  try {
    const result = await requestIlink(ctx, 'ilink/bot/getupdates', {
      get_updates_buf: buf ?? '',
      base_info: BASE_INFO,
    }, {
      timeoutMs: 35_000,
      label: `getUpdates[${shortBot(ctx.botId)}]`,
      abortSignal,
    });

    const data = result.data;
    const msgs = Array.isArray(data?.msgs) ? data.msgs : [];
    const nextBuf = data?.get_updates_buf ?? buf ?? '';
    setLastStatus(ctx.botId, 'getUpdates', { ok: true, count: msgs.length });
    log('info', `[iLink] getUpdates success bot=${shortBot(ctx.botId)} HTTP=${result.httpStatus} ret=${result.ret ?? 'null'} received=${msgs.length}`);
    return { msgs, nextBuf, ok: true };
  } catch (err) {
    setLastStatus(ctx.botId, 'getUpdates', { ok: false, err });
    const expired = Boolean(err.sessionExpired || err.errcode === SESSION_TIMEOUT_ERRCODE);
    log(expired ? 'error' : 'warn', `[iLink] getUpdates failed bot=${shortBot(ctx.botId)} HTTP=${err.httpStatus ?? 'null'} errcode=${err.errcode ?? 'null'} errmsg=${err.errmsg ?? err.message}`);
    return { msgs: [], nextBuf: buf ?? '', error: true, sessionExpired: expired, errcode: err.errcode ?? null };
  }
}

export async function sendMessage(ctx, msg, text, opts = {}) {
  const contextToken = msg?.context_token ?? msg?.contextToken ?? null;
  const toUserId = msg?.to_user_id ?? msg?.toUserId ?? msg?.from_user_id ?? msg?.fromUser ?? null;
  if (!toUserId) {
    log('warn', `[iLink] sendMessage failed missing to_user_id bot=${shortBot(ctx.botId)}`);
    return false;
  }
  if (!contextToken) {
    log('warn', `[iLink] sendMessage missing context_token bot=${shortBot(ctx.botId)} to=${toUserId}`);
  }

  if (!consumeSendQuota(ctx.botId)) {
    // v1.10.12: 入队 + drain loop backoff 重发，避免直接吞消息。_allowQueue=false 是 drain 回调，避免递归入队。
    if (opts._allowQueue !== false) {
      enqueuePendingSend(ctx.botId, { kind: 'text', ctx, msg, text });
      return true;
    }
    log('warn', `[iLink] sendMessage skipped (rate limit) bot=${shortBot(ctx.botId)} to=${toUserId}`);
    return false;
  }

  const clientId = generateClientId();
  // 没传 contextToken 时尝试用缓存里最近的
  let useToken = contextToken;
  if (!useToken) {
    const cached = recallContextToken(ctx.botId, toUserId);
    if (cached) {
      useToken = cached;
      log('debug', `[iLink] sendMessage using cached context_token bot=${shortBot(ctx.botId)}`);
    }
  }

  async function attempt(tokenToUse) {
    return requestIlink(ctx, 'ilink/bot/sendmessage', {
      msg: {
        from_user_id: ctx.botId || '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [
          { type: MsgItemType.TEXT, text_item: { text: String(text ?? '') } },
        ],
        context_token: tokenToUse ?? undefined,
      },
      base_info: BASE_INFO,
    }, { timeoutMs: 15_000, label: `sendMessage[${shortBot(ctx.botId)}]` });
  }

  try {
    const result = await attempt(useToken);
    setLastStatus(ctx.botId, 'sendMessage', { ok: true, ...result });
    log('info', `[iLink] sendMessage success bot=${shortBot(ctx.botId)} HTTP=${result.httpStatus} ret=${result.ret ?? 'null'} clientId=${clientId}`);
    return true;
  } catch (err) {
    const errMsg = String(err.errmsg || err.message || '').toLowerCase();
    const looksExpired = errMsg.includes('context') && (errMsg.includes('expir') || errMsg.includes('invalid') || errMsg.includes('过期'));
    if (looksExpired) {
      const cached = recallContextToken(ctx.botId, toUserId);
      if (cached && cached !== useToken) {
        log('warn', `[iLink] context_token expired; retrying with cached bot=${shortBot(ctx.botId)}`);
        try {
          const result2 = await attempt(cached);
          setLastStatus(ctx.botId, 'sendMessage', { ok: true, retried: true, ...result2 });
          log('info', `[iLink] sendMessage retry success bot=${shortBot(ctx.botId)} clientId=${clientId}`);
          return true;
        } catch (err2) {
          log('warn', `[iLink] sendMessage retry also failed: ${err2.errmsg ?? err2.message}`);
        }
      }
    }
    setLastStatus(ctx.botId, 'sendMessage', { ok: false, err });
    log('warn', `[iLink] sendMessage failed bot=${shortBot(ctx.botId)} HTTP=${err.httpStatus ?? 'null'} errcode=${err.errcode ?? 'null'} errmsg=${err.errmsg ?? err.message} clientId=${clientId}`);
    return false;
  }
}

export async function sendTextMessage(ctx, toUserId, text, contextToken) {
  return sendMessage(ctx, { to_user_id: toUserId, context_token: contextToken }, text);
}

/**
 * 发送一条语音（SILK）消息。v1.4.0 Sprint 2。
 * 流程：CDN 加密上传 silk 字节 → 构造 voice_item → sendmessage。
 * 任何一步失败抛错 → caller 负责降级（src/proactive.mjs 会回退到文本）。
 *
 * @param {object} ctx           - { baseUrl, token, botId }
 * @param {string} toUserId      - 接收方 wechat_user_id
 * @param {Buffer} silk          - SILK v3 字节流
 * @param {number} durationMs    - 音频时长毫秒
 * @param {string} [contextToken]
 * @returns {Promise<boolean>}   - true = 发送成功
 */
export async function sendVoiceMessage(ctx, toUserId, silk, durationMs, contextToken) {
  if (!toUserId) {
    log('warn', `[iLink] sendVoiceMessage missing to_user_id bot=${shortBot(ctx.botId)}`);
    return false;
  }
  if (!silk || !silk.length) {
    log('warn', `[iLink] sendVoiceMessage empty silk bot=${shortBot(ctx.botId)}`);
    return false;
  }
  if (!durationMs || durationMs <= 0) {
    log('warn', `[iLink] sendVoiceMessage bad duration=${durationMs} bot=${shortBot(ctx.botId)}`);
    return false;
  }
  // 1. CDN 上传（uploadFile 失败会抛）
  const { item } = await uploadFile({
    data: silk,
    fileName: `voice_${Date.now()}.silk`,
    toUserId,
    ctx,
    mediaType: 'voice',
    durationMs,
  });
  // 2. 走通用 sendMessageItem 通道（拿到 voice item 后就和图片/文件一样了）
  return sendMessageItem(ctx, toUserId, item, contextToken);
}

/**
 * 发送一个 messageItem（图片 / 文件 / 视频），由 media.mjs uploadFile 产出。
 */
export async function sendMessageItem(ctx, toUserId, item, contextToken, opts = {}) {
  if (!toUserId) {
    log('warn', `[iLink] sendMessageItem failed missing to_user_id bot=${shortBot(ctx.botId)}`);
    return false;
  }
  if (!consumeSendQuota(ctx.botId)) {
    // v1.10.12: 同 sendMessage — 入队让 drain loop 重发。
    if (opts._allowQueue !== false) {
      enqueuePendingSend(ctx.botId, { kind: 'item', ctx, toUserId, item, contextToken });
      return true;
    }
    log('warn', `[iLink] sendMessageItem skipped (rate limit) bot=${shortBot(ctx.botId)} to=${toUserId}`);
    return false;
  }

  // v1.4.0 hotfix: 主动消息（语音 / 图片 / sticker）没有原始入站 msg → context_token
  // 是 null。iLink 协议要求 voice 必须带一个合法 context；不带的话服务端虽然返 HTTP 200
  // 但实际不会推送给微信端（用户看不到消息）。sendMessage 一直有 cached token 兜底，
  // sendMessageItem 之前漏了 → 主动语音永远收不到。这里补齐。
  let useToken = contextToken;
  if (!useToken) {
    const cached = recallContextToken(ctx.botId, toUserId);
    if (cached) {
      useToken = cached;
      log('debug', `[iLink] sendMessageItem using cached context_token bot=${shortBot(ctx.botId)}`);
    } else {
      log('warn', `[iLink] sendMessageItem no context_token (neither passed nor cached) bot=${shortBot(ctx.botId)} to=${toUserId} type=${item?.type}`);
    }
  }

  const clientId = generateClientId();
  const itemKind = item?.type === 3 ? 'sendVoice' : 'sendImage';
  try {
    const result = await requestIlink(ctx, 'ilink/bot/sendmessage', {
      msg: {
        from_user_id: ctx.botId || '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: useToken ?? undefined,
      },
      base_info: BASE_INFO,
    }, { timeoutMs: 20_000, label: `${itemKind}[${shortBot(ctx.botId)}]` });
    setLastStatus(ctx.botId, itemKind, { ok: true, ...result });
    log('info', `[iLink] ${itemKind} success bot=${shortBot(ctx.botId)} HTTP=${result.httpStatus} clientId=${clientId} type=${item.type}`);
    return true;
  } catch (err) {
    setLastStatus(ctx.botId, itemKind, { ok: false, err });
    log('warn', `[iLink] ${itemKind} failed bot=${shortBot(ctx.botId)} HTTP=${err.httpStatus ?? 'null'} errcode=${err.errcode ?? 'null'} errmsg=${err.errmsg ?? err.message} clientId=${clientId}`);
    return false;
  }
}

const typingTicketCache = new Map(); // botId+userId -> { ticket, at }
const TYPING_TICKET_TTL_MS = 10 * 60 * 1000;

async function getTypingTicket(ctx, ilinkUserId, contextToken) {
  const key = `${ctx.botId}|${ilinkUserId}`;
  const cached = typingTicketCache.get(key);
  if (cached && Date.now() - cached.at < TYPING_TICKET_TTL_MS) return cached.ticket;
  try {
    const result = await requestIlink(ctx, 'ilink/bot/getconfig', {
      ilink_user_id: ilinkUserId,
      context_token: contextToken ?? undefined,
      base_info: BASE_INFO,
    }, { timeoutMs: 8_000, label: `getConfig[${shortBot(ctx.botId)}]` });
    const ticket = result.data?.typing_ticket || null;
    if (ticket) typingTicketCache.set(key, { ticket, at: Date.now() });
    return ticket;
  } catch {
    return null;
  }
}

export async function sendTyping(ctx, toUserId, contextToken) {
  if (!ctx.token || !toUserId) return;
  try {
    const ticket = await getTypingTicket(ctx, toUserId, contextToken);
    if (!ticket) return;
    await requestIlink(ctx, 'ilink/bot/sendtyping', {
      ilink_user_id: toUserId,
      typing_ticket: ticket,
      status: 1,
      base_info: BASE_INFO,
    }, { timeoutMs: 8_000, label: `sendTyping[${shortBot(ctx.botId)}]` });
  } catch {
    // best-effort
  }
}

export function parseMessage(msg, defaultBotId = null) {
  const msgId = msg?.client_id ?? msg?.msg_id ?? msg?.message_id ?? String(Date.now() + Math.random());
  const fromUser = msg?.from_user_id ?? msg?.fromUserId ?? '';
  const botId = msg?.bot_id ?? msg?.to_user_id ?? defaultBotId;
  const contextToken = msg?.context_token ?? null;
  const createTime = msg?.create_time ?? msg?.created_at ?? msg?.timestamp ?? null;
  const items = Array.isArray(msg?.item_list) ? msg.item_list : [];

  let msgType = 'unknown';
  let text = null;
  let imageItem = null;
  let voiceItem = null;

  for (const item of items) {
    if (item.type === MsgItemType.TEXT) {
      msgType = 'text';
      text = item.text_item?.text ?? '';
    } else if (item.type === MsgItemType.IMAGE) {
      msgType = 'image';
      imageItem = item.image_item ?? item;
    } else if (item.type === MsgItemType.VOICE) {
      msgType = 'voice';
      voiceItem = item.voice_item ?? item;
    } else if (item.type === MsgItemType.FILE) {
      msgType = 'file';
    } else if (item.type === MsgItemType.VIDEO) {
      msgType = 'video';
    }
  }

  return {
    msgId, fromUser, from_user_id: fromUser,
    botId, bot_id: botId,
    msgType, text, imageItem, voiceItem,
    contextToken, context_token: contextToken,
    createTime, raw: msg,
  };
}

// ─── legacy / file credentials ──────────────────────────────────────────────
//
// 兼容两种字段命名（旧版 dashboard / 新版 ilink_login.mjs）：
//   { botToken, botId, userId, baseUrl, savedAt|loginAt|createdAt }
//   { bot_token, ilink_bot_id, ilink_user_id, baseurl, created_at }
export function readLegacyCredentials() {
  if (!existsSync(CREDENTIALS_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
    if (!raw || typeof raw !== 'object') return null;
    const token = raw.bot_token || raw.botToken || raw.token;
    const botId = raw.ilink_bot_id || raw.botId;
    if (!token || !botId) return null;
    return {
      token,
      botId,
      userId: raw.ilink_user_id || raw.userId || '',
      baseUrl: (raw.baseurl || raw.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, ''),
      savedAt: raw.created_at || raw.savedAt || raw.loginAt || raw.createdAt || null,
    };
  } catch (err) {
    log('warn', `[iLink] readLegacyCredentials parse failed: ${err.message}`);
    return null;
  }
}

// 检测 WeChat iLink 配置来源（不泄露 token / botId 全量）
//   优先级：env (ILINK_BOT_TOKEN+ILINK_BOT_ID) > credentials file > 未配置
export function getWechatConfigStatus() {
  if (process.env.ILINK_BOT_TOKEN && process.env.ILINK_BOT_ID) {
    return { configured: true, source: 'env' };
  }
  if (existsSync(CREDENTIALS_PATH)) {
    const c = readLegacyCredentials();
    if (c) return { configured: true, source: 'credentials_file' };
  }
  return { configured: false };
}

// ─── status snapshot ────────────────────────────────────────────────────────

function setLastStatus(botId, key, value) {
  if (!botId) return;
  const entry = lastStatusByBot.get(botId) || {};
  entry[key] = { at: new Date().toISOString(), ...value };
  lastStatusByBot.set(botId, entry);
}

function shortBot(botId) {
  if (!botId) return 'none';
  return String(botId).slice(0, 12);
}

export function getIlinkStatusSnapshot() {
  const accounts = {};
  for (const [botId, entry] of lastStatusByBot.entries()) {
    accounts[botId] = entry;
  }
  return {
    accounts,
    legacyCredentials: !!readLegacyCredentials(),
  };
}
