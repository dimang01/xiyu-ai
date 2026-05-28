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
}
export function recallContextToken(botId, userId, maxAgeMs = 24 * 60 * 60 * 1000) {
  const entry = lastContextTokenByPair.get(ctxPairKey(botId, userId));
  if (!entry) return null;
  if (Date.now() - entry.at > maxAgeMs) return null;
  return entry.token;
}

function generateClientId() {
  return `openclaw-weixin-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

// ── iLink 每个 bot 大约 7 条 / 5 分钟。预留 buffer：6 条 / 5 分钟。 ───────────
const SEND_RATE_LIMIT = 6;
const SEND_RATE_WINDOW_MS = 5 * 60 * 1000;
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
  let raw = '';
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

export async function sendMessage(ctx, msg, text) {
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
 * 发送一个 messageItem（图片 / 文件 / 视频），由 media.mjs uploadFile 产出。
 */
export async function sendMessageItem(ctx, toUserId, item, contextToken) {
  if (!toUserId) {
    log('warn', `[iLink] sendMessageItem failed missing to_user_id bot=${shortBot(ctx.botId)}`);
    return false;
  }
  if (!consumeSendQuota(ctx.botId)) {
    log('warn', `[iLink] sendMessageItem skipped (rate limit) bot=${shortBot(ctx.botId)} to=${toUserId}`);
    return false;
  }

  const clientId = generateClientId();
  try {
    const result = await requestIlink(ctx, 'ilink/bot/sendmessage', {
      msg: {
        from_user_id: ctx.botId || '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: contextToken ?? undefined,
      },
      base_info: BASE_INFO,
    }, { timeoutMs: 20_000, label: `sendImage[${shortBot(ctx.botId)}]` });
    setLastStatus(ctx.botId, 'sendImage', { ok: true, ...result });
    log('info', `[iLink] sendImage success bot=${shortBot(ctx.botId)} HTTP=${result.httpStatus} clientId=${clientId} type=${item.type}`);
    return true;
  } catch (err) {
    setLastStatus(ctx.botId, 'sendImage', { ok: false, err });
    log('warn', `[iLink] sendImage failed bot=${shortBot(ctx.botId)} HTTP=${err.httpStatus ?? 'null'} errcode=${err.errcode ?? 'null'} errmsg=${err.errmsg ?? err.message} clientId=${clientId}`);
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
