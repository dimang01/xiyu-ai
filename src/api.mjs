/**
 * REST API 服务
 *
 * Companion CRUD:
 *   POST   /api/companions                      创建
 *   PUT    /api/companions/:id                  更新（支持局部更新）
 *   GET    /api/companions/:id                  查询（by DB id）
 *   GET    /api/companions/user/:uid            查询（by wechat_user_id，?bot_id=...）
 *   GET    /api/companions/:id/prompt           预览 system prompt
 *   GET    /api/companions/:id/context          获取最近对话上下文
 *   DELETE /api/companions/:id/context          清空最近对话上下文
 *
 * 礼物系统:
 *   GET    /api/gifts/catalog                   获取礼物目录
 *   GET    /api/companions/:id/gifts            查看送礼历史
 *   POST   /api/companions/:id/gifts            送礼并增加好感度
 *
 * 图片反应记忆:
 *   POST   /api/companions/:id/image-reaction   根据图片描述提取记忆并返回反应文案
 *
 * 节日/纪念日提醒:
 *   GET    /api/companions/:id/reminders        列出提醒
 *   POST   /api/companions/:id/reminders        新增提醒
 *   PUT    /api/companions/:id/reminders/:rid   更新提醒
 *   DELETE /api/companions/:id/reminders/:rid   删除提醒
 *   GET    /api/companions/:id/reminders/due    查询到期提醒
 *
 * 状态面板:
 *   GET    /api/companions/:id/status           心情/好感度/场景/阶段/记忆数
 *   PUT    /api/companions/:id/mood             手动设置心情
 *   PUT    /api/companions/:id/scene            切换场景
 *   PUT    /api/companions/:id/affection        手动调整好感度
 *   PUT    /api/companions/:id/chat-mode        切换对话模式
 *
 * 长期记忆:
 *   GET    /api/companions/:id/memories         列出所有记忆
 *   POST   /api/companions/:id/memories         手动添加记忆
 *   DELETE /api/companions/:id/memories/:mid    删除单条记忆
 *   DELETE /api/companions/:id/memories         清空所有记忆
 *
 * 用户画像:
 *   GET    /api/companions/:id/user-profile     获取用户画像
 *   PUT    /api/companions/:id/user-profile     更新用户画像
  *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import QRCode from 'qrcode';
import { log }  from './logger.mjs';
import { signToken, requireAuth, softAuth } from './auth.mjs';
import {
  signAdminToken, requireAdmin, verifyAdminCredentials,
  regenerateAdminPassword, loadAdminCredentials,
} from './admin.mjs';
import { rateLimit } from './ratelimit.mjs';
import {
  getIlinkStatusSnapshot, getBotQrcode, getQrcodeStatus, DEFAULT_BASE_URL,
  getWechatConfigStatus,
} from './ilink.mjs';
import { getEmailMode } from './email.mjs';
import { buildSystemPrompt } from './companion.mjs';
import { buildImageReactionText, computeRelationshipStage, extractImageMemories } from './memory.mjs';
import { generatePersonaFacts, generateAvatarCandidates, embedText } from './ai.mjs';
import { getActiveChatProvider } from './providers/chat.mjs';
import { getActiveImageProvider } from './providers/image.mjs';
import { getActiveVisionProvider } from './providers/vision.mjs';
import { getActiveAsrProvider } from './providers/asr.mjs';
import { getActiveEmbeddingProvider } from './providers/embedding.mjs';

// 异步生成元认知（不阻塞主响应）。所有 category 数组扁平化为 facts 列表存表
async function asyncGeneratePersonaFacts(companion) {
  try {
    const data = await generatePersonaFacts(companion);
    if (!data || typeof data !== 'object') {
      log('warn', `[Persona] generate 返回空 companion=${companion.id}`);
      return;
    }
    const facts = [];
    for (const cat of ['childhood', 'school', 'family', 'friends', 'pets', 'important_events', 'values', 'love_view', 'fears', 'habits', 'secrets', 'linguistic_quirks']) {
      const list = Array.isArray(data[cat]) ? data[cat] : [];
      for (const item of list) {
        const content = String(item || '').trim();
        if (content) facts.push({ category: cat, content });
      }
    }
    if (facts.length === 0) {
      log('warn', `[Persona] 解析出 0 条 facts companion=${companion.id}`);
      return;
    }
    savePersonaFacts(companion.id, facts);
    log('info', `[Persona] companion=${companion.id} ${companion.name} 元认知已生成 ${facts.length} 条 (categories=${Object.keys(data).filter(k => data[k]?.length).join(',')})`);
  } catch (e) {
    log('error', `[Persona] async 生成失败 companion=${companion.id}: ${e.message}`);
  }
}
import { sendVerificationEmail } from './email.mjs';
// 支付/订阅模块在开源版本中未包含。如需启用，请自行接入支付宝/微信支付等并实现 billing.mjs。
// import {
//   PLAN_CATALOG, isAlipayConfigured, buildPagePayUrl,
//   verifyNotifySignature, queryTrade,
// } from './billing.mjs';
import {
  getCompanionById, getCompanion, ensureCompanion, createCompanion, updateCompanion, patchCompanion,
  getMemories, saveMemory, saveMemories, deleteMemory, clearMemories, recallMemories,
  saveImageReaction,
  getConversationContext, clearConversationContext,
  GIFT_CATALOG, getGiftById, saveCompanionGift, getCompanionGifts,
  getReminders, createReminder, updateReminder, deleteReminder, getDueReminders,
  getUserProfile, upsertUserProfile,
  getDb, getUserPlan, getUserAgeStatus,
  // BILLING_DISABLED: 保留 db helper 以便 18 岁后恢复
  createBillingOrder, getBillingOrder, listBillingOrdersByAccount,
  markOrderPaid, updateOrderStatus, grantProToAccount,
  getLastVerificationSend, countVerificationSendsSince, saveVerificationCode,
  getVerificationCode, deleteVerificationCode,
  createUserAccount, getUserAccountByUsername, getUserAccountByEmail,
  getUserAccountById, getUserAccountWithPassword, updateUserPassword,
  getCompanionTimeline, getStageMilestones,
  savePersonaFacts, getPersonaFacts, hasPersonaFacts,
  getDailySchedule, shanghaiDateKey,
  matchAvatarPresets, countAvatarPresets,
  setAccountBanned, isAccountBanned,
  listAllAccounts, countAllAccounts,
  getAccountUsageSummary, getAccountUsageHistory, getGlobalUsageToday,
  bindWechatAccount, rebindWechatAccount, getWechatAccountByAccountId, getCompanionByAccountId,
  createPendingBindSession, getPendingBindSession,
  deleteCompanionForAccount,
} from './db.mjs';

// 由 index.mjs 注入：{ registerBotAccount, unregisterBotAccount, listBotPool }
let botPoolHandle = null;
export function setBotPoolHandle(handle) { botPoolHandle = handle; }

// session_id -> { qrcode, baseUrl, accountId, status, botToken?, botId?, userId?, abortController }
const ilinkQrSessions = new Map();

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');

// ─── 工具 ─────────────────────────────────────────────────────────────────────
function ok(res, data, code = 200)            { return res.status(code).json({ ok: true, data }); }
function err(res, msg, code = 400, extra = {}) { return res.status(code).json({ ok: false, error: msg, ...extra }); }
function intId(s) { const n = Number(s); return Number.isInteger(n) && n > 0 ? n : null; }
function localYmd(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function authOk(res, message, code = 200) { return res.status(code).json({ success: true, message }); }
function authErr(res, message, code = 400, extra = {}) { return res.status(code).json({ success: false, message, ...extra }); }
function noStore(res) { res.set('Cache-Control', 'no-store'); return res; }

const VERIFICATION_PURPOSES = new Set(['login', 'register', 'reset_password']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_SENDS = 5;
const WECHAT_QR_TTL_MS = 5 * 60 * 1000;
const scryptAsync = promisify(crypto.scrypt);
const wechatLoginSessions = new Map();
const ILINK_PLUGIN_VERSION = '2.4.4';
const ILINK_BOT_TYPE = '3';
const [ilinkVmaj, ilinkVmin, ilinkVpat] = ILINK_PLUGIN_VERSION.split('.').map(Number);
const ILINK_CLIENT_VERSION = String(((ilinkVmaj & 0xff) << 16) | ((ilinkVmin & 0xff) << 8) | (ilinkVpat & 0xff));

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function isValidPurpose(purpose) {
  return typeof purpose === 'string' && VERIFICATION_PURPOSES.has(purpose);
}

function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(email, purpose, code) {
  return crypto.createHash('sha256').update(`${email}:${purpose}:${code}`).digest('hex');
}

function normalizeUsername(username) {
  return typeof username === 'string' ? username.trim().toLowerCase() : '';
}

function publicAccount(row) {
  return row ? { id: row.id, username: row.username, email: row.email } : null;
}

function ilinkConfig() {
  return {
    baseUrl: (process.env.ILINK_BASE_URL || 'https://ilinkai.weixin.qq.com').replace(/\/$/, ''),
    token: process.env.ILINK_BOT_TOKEN || '',
    botId: process.env.ILINK_BOT_ID || '',
  };
}

function ilinkCommonHeaders() {
  return {
    'Content-Type': 'application/json',
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': ILINK_CLIENT_VERSION,
  };
}

async function postIlinkLogin(pathname, body) {
  const { baseUrl } = ilinkConfig();
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: ilinkCommonHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let data = {};
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = { raw }; }
  }
  if (!response.ok) {
    const e = new Error(`iLink HTTP ${response.status}: ${raw.slice(0, 200)}`);
    e.status = response.status;
    e.data = data;
    throw e;
  }
  return data;
}

async function getIlinkLogin(pathname, timeoutMs = 37_000) {
  const { baseUrl } = ilinkConfig();
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      method: 'GET',
      headers: ilinkCommonHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') return { status: 'wait' };
    throw e;
  }
  const raw = await response.text();
  let data = {};
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = { raw }; }
  }
  if (!response.ok) {
    const e = new Error(`iLink HTTP ${response.status}: ${raw.slice(0, 200)}`);
    e.status = response.status;
    e.data = data;
    throw e;
  }
  return data;
}

async function getIlinkBotQr() {
  const data = await postIlinkLogin(`/ilink/bot/get_bot_qrcode?bot_type=${ILINK_BOT_TYPE}`, {
    local_token_list: [],
  });
  const qrUrl = data.qrcode_img_content || data.qr_url || data.url || null;
  return {
    raw: data,
    qrUrl,
    qrImage: await toQrImageDataUrl(qrUrl, null),
  };
}

async function toQrImageDataUrl(qrUrl, qrBase64) {
  if (qrBase64) {
    return String(qrBase64).startsWith('data:')
      ? String(qrBase64)
      : `data:image/png;base64,${qrBase64}`;
  }
  if (!qrUrl) return null;
  return QRCode.toDataURL(String(qrUrl), {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 360,
    color: {
      dark: '#111111',
      light: '#ffffff',
    },
  });
}

async function getWechatStatusFromIlink(session) {
  const { token } = ilinkConfig();
  if (session.mode === 'openclaw') {
    const data = await getIlinkLogin(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.uuid)}`, 3_500);
    return normalizeWechatStatus(data);
  }
  const data = await postIlinkLogin('/cgi-bin/im/getLoginStatus', { token, uuid: session.uuid });
  return normalizeWechatStatus(data);
}

function deepFind(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  for (const value of Object.values(obj)) {
    const found = deepFind(value, keys);
    if (found !== undefined && found !== null && found !== '') return found;
  }
  return undefined;
}

function normalizeQrPayload(data) {
  return {
    uuid: String(deepFind(data, ['uuid', 'qr_uuid', 'qrcode_uuid', 'session_id']) || ''),
    qrUrl: deepFind(data, ['qrcode_url', 'qr_code_url', 'qr_url', 'url']),
    qrBase64: deepFind(data, ['qrcode_base64', 'qr_code_base64', 'qr_base64', 'base64']),
  };
}

function normalizeWechatStatus(data) {
  const rawStatus = deepFind(data, ['status', 'state', 'login_status', 'scan_status']);
  const code = deepFind(data, ['code', 'errcode']);
  const text = String(rawStatus ?? code ?? '').toLowerCase();
  let status = 'pending';

  if (['expired', 'timeout', '4', '408'].includes(text) || /expire|timeout|过期/.test(text)) {
    status = 'expired';
  } else if (['confirmed', 'success', 'ok', 'login', '2', '200'].includes(text) || /confirm|success|登录成功|确认/.test(text)) {
    status = 'confirmed';
  } else if (['scanned', 'scaned', 'scan', '1'].includes(text) || /scan|扫码|已扫/.test(text)) {
    status = 'scanned';
  }

  const wechatUserId = deepFind(data, [
    'wechat_user_id', 'wechatUserId', 'ilink_user_id', 'ilinkUserId',
    'user_id', 'userId', 'openid', 'open_id',
  ]);
  if (wechatUserId && status !== 'expired') status = 'confirmed';

  return {
    status,
    wechatUserId: wechatUserId ? String(wechatUserId) : null,
    displayName: deepFind(data, ['display_name', 'displayName', 'nickname', 'nick_name']),
    avatarUrl: deepFind(data, ['avatar_url', 'avatarUrl', 'headimgurl']),
  };
}

function cleanupWechatSessions() {
  const now = Date.now();
  for (const [sessionId, session] of wechatLoginSessions.entries()) {
    if (session.expiresAtMs <= now) wechatLoginSessions.delete(sessionId);
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt}$${key.toString('hex')}`;
}

async function verifyPassword(password, passwordHash) {
  const [algorithm, n, r, p, salt, storedHex] = String(passwordHash || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !storedHex) return false;
  const stored = Buffer.from(storedHex, 'hex');
  const derived = await scryptAsync(password, salt, stored.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return stored.length === derived.length && crypto.timingSafeEqual(stored, derived);
}

function isValidRegisterCode(email, code) {
  if (!/^\d{6}$/.test(code)) return false;
  const record = getVerificationCode(email, 'register');
  if (!record || record.expires_at_ms < Date.now()) {
    if (record) deleteVerificationCode(email, 'register');
    return false;
  }
  const receivedHash = hashCode(email, 'register', code);
  return crypto.timingSafeEqual(Buffer.from(receivedHash), Buffer.from(record.code_hash));
}

function isValidResetCode(email, code) {
  if (!/^\d{6}$/.test(code)) return false;
  const record = getVerificationCode(email, 'reset_password');
  if (!record || record.expires_at_ms < Date.now()) {
    if (record) deleteVerificationCode(email, 'reset_password');
    return false;
  }
  const receivedHash = hashCode(email, 'reset_password', code);
  return crypto.timingSafeEqual(Buffer.from(receivedHash), Buffer.from(record.code_hash));
}

function requireCompanion(res, id) {
  const c = getCompanionById(id);
  if (!c) { err(res, 'companion 不存在', 404); return null; }
  return c;
}

function fallbackText(value, fallback = '') {
  return value === undefined || value === null || value === '' ? fallback : value;
}

function companionSummary(companion) {
  if (!companion) return null;
  const db = getDb();
  const memoryCount = db.prepare('SELECT COUNT(*) as n FROM companion_memories WHERE companion_id = ?').get(companion.id)?.n ?? 0;
  return {
    id: companion.id,
    name: fallbackText(companion.name, '溪语'),
    avatar_url: fallbackText(companion.avatar_url, null),
    age: fallbackText(companion.age, ''),
    height: fallbackText(companion.height, ''),
    persona: fallbackText(companion.role_title || companion.persona_prompt, ''),
    role_title: fallbackText(companion.role_title, ''),
    intimacy_level: fallbackText(companion.intimacy_level, ''),
    background: fallbackText(companion.backstory || companion.how_met || companion.shared_memory, ''),
    how_met: fallbackText(companion.how_met, ''),
    shared_memory: fallbackText(companion.shared_memory, ''),
    relationship_status: fallbackText(companion.relationship_status, ''),
    persona_prompt: fallbackText(companion.persona_prompt, ''),
    relationship_stage: fallbackText(companion.relationship_stage, '陌生人'),
    affection: companion.affection_level ?? 0,
    mood: fallbackText(companion.current_mood, '平静'),
    scene: fallbackText(companion.current_scene, '在家'),
    chat_mode: fallbackText(companion.chat_mode_active, '日常聊天'),
    memory_count: memoryCount,
    proactive_enabled: !!companion.proactive_enabled,
    sticker_reply_enabled: !!companion.sticker_reply_enabled,
    voice_reply_enabled: !!companion.voice_reply_enabled,
    memory_enabled: companion.memory_enabled !== false,
  };
}

function normalizeCompanionConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const data = { ...source };
  const first = (...keys) => {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  };

  const roleTitle = first('role_title', 'identity', 'persona_tag', 'persona');
  if (roleTitle !== undefined && data.role_title === undefined) data.role_title = roleTitle;

  const prompt = first('persona_prompt', 'extra_persona', 'extraPersona');
  if (prompt !== undefined && data.persona_prompt === undefined) data.persona_prompt = prompt;

  const personality = first('personality_tags', 'personality');
  if (personality !== undefined && data.personality_tags === undefined) {
    data.personality_tags = Array.isArray(personality)
      ? personality
      : String(personality).split(/[，,\s]+/).map(s => s.trim()).filter(Boolean);
  }

  const background = first('backstory', 'background');
  if (background !== undefined && data.backstory === undefined) data.backstory = background;

  const affection = first('affection_level', 'affection');
  if (affection !== undefined && data.affection_level === undefined) data.affection_level = Number(affection);

  const mood = first('current_mood', 'mood');
  if (mood !== undefined && data.current_mood === undefined) data.current_mood = mood;

  const scene = first('current_scene', 'scene');
  if (scene !== undefined && data.current_scene === undefined) data.current_scene = scene;

  const chatMode = first('chat_mode_active', 'chat_mode');
  if (chatMode !== undefined && data.chat_mode_active === undefined) data.chat_mode_active = chatMode;

  delete data.identity;
  delete data.persona_tag;
  delete data.persona;
  delete data.extra_persona;
  delete data.extraPersona;
  delete data.personality;
  delete data.background;
  delete data.affection;
  delete data.mood;
  delete data.scene;
  delete data.chat_mode;

  return data;
}

function giftReactionText(companion, gift, message) {
  const name = companion?.name || '我';
  const note = message ? `还写了"${String(message).slice(0, 60)}"，` : '';
  if (gift.id === 'flower') return `谢谢你送我的花，${note}${name}会好好珍惜的。`;
  if (gift.id === 'milk_tea') return `奶茶来得刚刚好，${note}感觉心情都变甜了。`;
  if (gift.id === 'necklace') return `这条项链我很喜欢，${note}下次见你一定戴给你看。`;
  if (gift.id === 'ring') return `这枚戒指太特别了，${note}我会认真收好的。`;
  return `谢谢你的礼物，${note}我真的很开心。`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 邮箱验证码
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/send-code
router.post('/auth/send-code',
  rateLimit({ scope: 'send-code', maxPerWindow: 10, windowMs: 60 * 60 * 1000, message: '验证码请求过于频繁，请 1 小时后再试' }),
  async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const purpose = req.body?.purpose || 'login';
  if (!EMAIL_RE.test(email)) return authErr(res, '邮箱格式不正确');
  if (!isValidPurpose(purpose)) return authErr(res, 'purpose 无效');

  const now = Date.now();
  const lastSend = getLastVerificationSend(email);
  if (lastSend && now - lastSend.sent_at_ms < RESEND_COOLDOWN_MS) {
    const retryAfter = Math.ceil((RESEND_COOLDOWN_MS - (now - lastSend.sent_at_ms)) / 1000);
    return authErr(res, '发送太频繁，请稍后再试', 429, { retryAfter });
  }

  const recentCount = countVerificationSendsSince(email, now - RATE_WINDOW_MS);
  if (recentCount >= RATE_MAX_SENDS) {
    return authErr(res, '发送太频繁，请稍后再试', 429);
  }

  const code = generateCode();
  try {
    await sendVerificationEmail(email, code);
    saveVerificationCode({
      email,
      purpose,
      codeHash: hashCode(email, purpose, code),
      expiresAtMs: now + CODE_TTL_MS,
      sentAtMs: now,
    });
    log('info', `[API] 邮箱验证码已发送 purpose=${purpose}`);
    return authOk(res, '验证码已发送');
  } catch (e) {
    log('error', `[API] send-code 失败: ${e.message}`);
    return authErr(res, '验证码发送失败，请稍后再试', 500);
  }
});

// POST /api/auth/verify-code
router.post('/auth/verify-code', (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const purpose = req.body?.purpose || 'login';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!EMAIL_RE.test(email)) return authErr(res, '邮箱格式不正确');
  if (!isValidPurpose(purpose)) return authErr(res, 'purpose 无效');
  if (!/^\d{6}$/.test(code)) return authErr(res, '验证码错误或已过期');

  const record = getVerificationCode(email, purpose);
  if (!record || record.expires_at_ms < Date.now()) {
    if (record) deleteVerificationCode(email, purpose);
    return authErr(res, '验证码错误或已过期');
  }

  const receivedHash = hashCode(email, purpose, code);
  const okHash = crypto.timingSafeEqual(Buffer.from(receivedHash), Buffer.from(record.code_hash));
  if (!okHash) return authErr(res, '验证码错误或已过期');

  deleteVerificationCode(email, purpose);
  return authOk(res, '验证成功');
});

// 用户协议层面禁止未满 18 周岁使用；不强制 KYC 收集生日，注册只要求勾选协议。
// AI 虚拟角色（companion）的年龄合规另算：见 MIN_COMPANION_AGE。
const TERMS_VERSION = '2026-05-26';

// POST /api/auth/register
router.post('/auth/register',
  rateLimit({ scope: 'register', maxPerWindow: 10, windowMs: 60 * 60 * 1000, message: '注册请求过于频繁' }),
  async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const agreed = req.body?.terms_accepted === true || req.body?.terms_accepted === 'true';

  if (!USERNAME_RE.test(username)) return authErr(res, '用户名格式不正确');
  if (!EMAIL_RE.test(email)) return authErr(res, '邮箱格式不正确');
  if (password.length < 8) return authErr(res, '密码至少 8 位');
  if (!agreed) return authErr(res, '需要同意《用户协议》和《隐私政策》才能注册');

  if (getUserAccountByUsername(username)) return authErr(res, '用户名已存在', 409);
  if (getUserAccountByEmail(email)) return authErr(res, '邮箱已存在', 409);
  if (!isValidRegisterCode(email, code)) return authErr(res, '邮箱验证码错误或已过期');

  try {
    const passwordHash = await hashPassword(password);
    const user = createUserAccount({
      username, email, passwordHash,
      termsVersion: TERMS_VERSION,
    });
    deleteVerificationCode(email, 'register');
    log('info', `[API] 用户注册成功 user_id=${user.id}`);
    const token = signToken({ id: user.id, username: user.username });
    return res.status(201).json({
      success: true,
      message: '注册成功',
      user: publicAccount(user),
      token,
    });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return authErr(res, '用户名或邮箱已存在', 409);
    }
    log('error', `[API] register 失败: ${e.message}`);
    return authErr(res, '注册失败，请稍后再试', 500);
  }
});

// POST /api/auth/login
router.post('/auth/login',
  rateLimit({ scope: 'login', maxPerWindow: 20, windowMs: 10 * 60 * 1000, message: '登录尝试过于频繁，请稍后再试' }),
  async (req, res) => {
  const rawAccount = typeof req.body?.account === 'string' ? req.body.account.trim() : '';
  const account = rawAccount.includes('@') ? normalizeEmail(rawAccount) : normalizeUsername(rawAccount);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!account || !password) return authErr(res, '账号或密码错误', 401);

  try {
    const user = getUserAccountWithPassword(account);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return authErr(res, '账号或密码错误', 401);
    }
    if (user.is_banned) {
      log('info', `[API] 封禁账号尝试登录 user_id=${user.id}`);
      return authErr(res, `账号已被封禁${user.banned_reason ? '：' + user.banned_reason : ''}`, 403);
    }

    log('info', `[API] 用户登录成功 user_id=${user.id}`);
    const token = signToken({ id: user.id, username: user.username });
    return res.json({ success: true, message: '登录成功', user: publicAccount(user), token });
  } catch (e) {
    log('error', `[API] login 失败: ${e.message}`);
    return authErr(res, '账号或密码错误', 401);
  }
});

// POST /api/auth/reset-password — 通过邮箱验证码重置密码
router.post('/auth/reset-password',
  rateLimit({ scope: 'reset-password', maxPerWindow: 10, windowMs: 60 * 60 * 1000, message: '操作过于频繁，请稍后再试' }),
  async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : '';

  if (!EMAIL_RE.test(email)) return authErr(res, '邮箱格式不正确');
  if (newPassword.length < 8) return authErr(res, '新密码至少 8 位');
  if (!isValidResetCode(email, code)) return authErr(res, '验证码错误或已过期');

  const account = getUserAccountByEmail(email);
  if (!account) {
    // 不暴露"邮箱未注册"避免账号枚举；统一返回验证码错误
    log('warn', `[API] reset-password 收到正确码但账号不存在 email=${email.slice(0,3)}***`);
    return authErr(res, '验证码错误或已过期');
  }

  try {
    const passwordHash = await hashPassword(newPassword);
    const okFlag = updateUserPassword(account.id, passwordHash);
    if (!okFlag) return authErr(res, '密码更新失败', 500);
    deleteVerificationCode(email, 'reset_password');
    log('info', `[API] 用户重置密码成功 user_id=${account.id}`);
    return authOk(res, '密码已重置，请用新密码登录');
  } catch (e) {
    log('error', `[API] reset-password 失败: ${e.message}`);
    return authErr(res, '密码重置失败，请稍后再试', 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan 识别 + 支付预插件接口
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_LIMITS = {
  free: {
    plan: 'free',
    daily_inbound_messages: 50,
    daily_summary_retention_days: 30,
    weekly_summary: false,
    monthly_summary: false,
    sticker_send: true,
    image_recognition: false,
    voice_recognition: false,
  },
  pro: {
    plan: 'pro',
    daily_inbound_messages: -1,
    daily_summary_retention_days: 180,
    weekly_summary: true,
    monthly_summary: true,
    sticker_send: true,
    image_recognition: true,
    voice_recognition: true,
  },
};

// GET /api/me/export — 导出当前用户全部数据（JSON 下载）
router.get('/me/export', requireAuth, (req, res) => {
  const accountId = req.authUser.id;
  const db = getDb();
  const account = getUserAccountById(accountId);
  if (!account) return err(res, '用户不存在', 404);

  const bindings = db.prepare('SELECT * FROM wechat_accounts WHERE account_id = ?').all(accountId);
  const wechatUserIds = bindings.map(b => b.wechat_user_id).filter(Boolean);
  const placeholders = wechatUserIds.length ? wechatUserIds.map(() => '?').join(',') : "'__none__'";

  const companions = wechatUserIds.length
    ? db.prepare(`
        SELECT c.* FROM companions c
        JOIN users u ON u.id = c.user_id
        WHERE u.wechat_user_id IN (${placeholders})
      `).all(...wechatUserIds)
    : [];
  const companionIds = companions.map(c => c.id);
  const compPh = companionIds.length ? companionIds.map(() => '?').join(',') : "'__none__'";

  const memories = companionIds.length
    ? db.prepare(`SELECT * FROM companion_memories WHERE companion_id IN (${compPh})`).all(...companionIds)
    : [];
  const messages = wechatUserIds.length
    ? db.prepare(`
        SELECT * FROM wechat_messages
        WHERE from_user IN (${placeholders}) OR to_user IN (${placeholders})
        ORDER BY created_at ASC LIMIT 10000
      `).all(...wechatUserIds, ...wechatUserIds)
    : [];
  const turns = companionIds.length
    ? db.prepare(`SELECT * FROM companion_conversation_turns WHERE companion_id IN (${compPh}) ORDER BY created_at ASC LIMIT 10000`).all(...companionIds)
    : [];

  log('info', `[API] data export account=${accountId}`);
  res.set('Content-Disposition', `attachment; filename="xiyuai-export-${accountId}-${Date.now()}.json"`);
  return res.json({
    exported_at: new Date().toISOString(),
    account: { id: account.id, username: account.username, email: account.email, created_at: account.created_at },
    bindings,
    companions,
    memories,
    conversation_turns: turns,
    messages,
  });
});

// DELETE /api/me/account — 彻底删除账号 + 所有关联数据
router.delete('/me/account', requireAuth, (req, res) => {
  const accountId = req.authUser.id;
  const db = getDb();

  const bindings = db.prepare('SELECT wechat_user_id FROM wechat_accounts WHERE account_id = ?').all(accountId);
  const wechatUserIds = bindings.map(b => b.wechat_user_id).filter(Boolean);

  const tx = db.transaction(() => {
    if (wechatUserIds.length) {
      const ph = wechatUserIds.map(() => '?').join(',');
      // 找到所有关联 companions
      const cids = db.prepare(`
        SELECT c.id FROM companions c
        JOIN users u ON u.id = c.user_id
        WHERE u.wechat_user_id IN (${ph})
      `).all(...wechatUserIds).map(r => r.id);
      if (cids.length) {
        const cph = cids.map(() => '?').join(',');
        db.prepare(`DELETE FROM companion_memories WHERE companion_id IN (${cph})`).run(...cids);
        db.prepare(`DELETE FROM companion_conversation_turns WHERE companion_id IN (${cph})`).run(...cids);
        db.prepare(`DELETE FROM companion_gifts WHERE companion_id IN (${cph})`).run(...cids);
        db.prepare(`DELETE FROM companion_reminders WHERE companion_id IN (${cph})`).run(...cids);
        db.prepare(`DELETE FROM companion_image_reactions WHERE companion_id IN (${cph})`).run(...cids);
        db.prepare(`DELETE FROM user_profiles WHERE companion_id IN (${cph})`).run(...cids);
        db.prepare(`DELETE FROM companions WHERE id IN (${cph})`).run(...cids);
      }
      db.prepare(`DELETE FROM wechat_messages WHERE from_user IN (${ph}) OR to_user IN (${ph})`).run(...wechatUserIds, ...wechatUserIds);
      db.prepare(`DELETE FROM users WHERE wechat_user_id IN (${ph})`).run(...wechatUserIds);
    }
    db.prepare('DELETE FROM wechat_accounts WHERE account_id = ?').run(accountId);
    db.prepare('DELETE FROM pending_bind_sessions WHERE user_id = ?').run(accountId);
    db.prepare('DELETE FROM user_accounts WHERE id = ?').run(accountId);
  });
  tx();

  // 通知 pool 把对应 botId 摘掉
  if (botPoolHandle?.unregisterBotAccount) {
    for (const b of bindings) if (b.wechat_user_id) {
      // bindings 里有 bot_id？让我们再查一次
    }
  }

  log('info', `[API] account deleted account=${accountId} bindings=${wechatUserIds.length}`);
  return ok(res, { deleted: true });
});

// GET /api/me/plan?user_id=...
router.get('/me/plan', requireAuth, (req, res) => {
  const accountId = intId(req.query.user_id ?? req.query.account_id ?? req.get('x-user-id'));
  if (!accountId) return err(res, '缺少 user_id');
  const account = getUserAccountById(accountId);
  if (!account) return err(res, '用户不存在', 404);

  const binding = getWechatAccountByAccountId(accountId);
  // userId 优先从 wechat 绑定关联的 users.id 取，没有就退回 accountId
  const userId = binding?.user_id || accountId;
  const plan = getUserPlan(userId);
  const limits = PLAN_LIMITS[plan.isPro ? 'pro' : 'free'];

  return ok(res, {
    plan: plan.isPro ? 'pro' : 'free',
    plan_expires_at: plan.plan_expires_at,
    is_pro: plan.isPro,
    limits,
  });
});

// ─── BILLING (开源版默认禁用) ────────────────────────────────────────────────
// 下面的路由块需要 billing.mjs（实现支付宝/微信支付）。
// 启用方式：实现 src/billing.mjs，恢复上方 import，再删除下面的 /* ... */ 注释块。
/* BILLING_DISABLED_BEGIN
// GET /api/billing/plans — 套餐目录（前端读这里渲染价格）
router.get('/billing/plans', (req, res) => {
  return ok(res, {
    plans: PLAN_CATALOG,
    alipay_configured: isAlipayConfigured(),
  });
});

// POST /api/billing/create-order
//   body: { user_id, period: 'monthly' | 'yearly' }
//   resp: { order_no, amount_cny, pay_url, status }
router.post('/billing/create-order', requireAuth, (req, res) => {
  const accountId = req.authUser.id;
  const period = String(req.body?.period || 'monthly');
  const planSpec = PLAN_CATALOG[period];
  if (!planSpec) return err(res, 'period 无效（monthly / yearly）');

  const account = getUserAccountById(accountId);
  if (!account) return err(res, '用户不存在', 404);

  // 防刷：同一账号 60 秒内最多创建 3 个 pending 订单
  const recent = listBillingOrdersByAccount(accountId, 10)
    .filter(o => o.status === 'pending' && Date.now() - new Date(o.created_at.replace(' ', 'T') + 'Z').getTime() < 60_000);
  if (recent.length >= 3) return err(res, '请稍后再试', 429);

  const orderNo = `xyu${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const { pay_url, raw_params } = buildPagePayUrl({
    outTradeNo: orderNo,
    totalAmount: planSpec.amount_cny,
    subject: planSpec.subject,
  });

  createBillingOrder({
    orderNo, accountId,
    plan: planSpec.plan, period: planSpec.period,
    amountCny: planSpec.amount_cny,
    provider: pay_url ? 'alipay' : 'stub',
    payUrl: pay_url,
    rawCreateResp: raw_params ? JSON.stringify({ gateway_params: '<<signed>>' }) : null,
  });

  log('info', `[Billing] order created account=${accountId} period=${period} order=${orderNo} alipay=${!!pay_url}`);
  return ok(res, {
    order_no: orderNo,
    plan: planSpec.plan,
    period: planSpec.period,
    amount_cny: planSpec.amount_cny,
    pay_url: pay_url || null,
    status: 'pending',
    note: pay_url ? null : '支付宝密钥尚未配置，请联系运营手动升级（保留订单号）',
  });
});

// GET /api/billing/orders — 当前用户订单列表
router.get('/billing/orders', requireAuth, (req, res) => {
  const orders = listBillingOrdersByAccount(req.authUser.id, 50)
    .map(o => ({
      order_no: o.order_no, plan: o.plan, period: o.period,
      amount_cny: o.amount_cny, status: o.status,
      pay_url: o.status === 'pending' ? o.pay_url : null,
      paid_at: o.paid_at, created_at: o.created_at,
    }));
  return ok(res, { orders });
});

// GET /api/billing/orders/:orderNo — 查单（也用作支付完成后前端轮询）
router.get('/billing/orders/:orderNo', requireAuth, (req, res) => {
  const order = getBillingOrder(req.params.orderNo);
  if (!order || order.account_id !== req.authUser.id) return err(res, '订单不存在', 404);
  return ok(res, {
    order_no: order.order_no, plan: order.plan, period: order.period,
    amount_cny: order.amount_cny, status: order.status,
    pay_url: order.status === 'pending' ? order.pay_url : null,
    paid_at: order.paid_at, created_at: order.created_at,
  });
});

// POST /api/billing/alipay/notify — 支付宝异步通知（重要：必须验签）
//   支付宝以 application/x-www-form-urlencoded 推送；express 默认能解析
router.post('/billing/alipay/notify', (req, res) => {
  const params = { ...(req.body || {}) };
  log('info', `[Billing] alipay notify order=${params.out_trade_no} status=${params.trade_status}`);

  if (!verifyNotifySignature(params)) {
    log('warn', `[Billing] alipay notify 签名校验失败 order=${params.out_trade_no}`);
    return res.status(200).send('failure');
  }

  const orderNo = params.out_trade_no;
  const order = getBillingOrder(orderNo);
  if (!order) {
    log('warn', `[Billing] alipay notify 未找到订单 order=${orderNo}`);
    return res.status(200).send('success'); // 让支付宝停止重试
  }

  // 金额校验
  const notifyAmount = Number(params.total_amount);
  if (Math.abs(notifyAmount - order.amount_cny) > 0.001) {
    log('error', `[Billing] alipay notify 金额不一致 order=${orderNo} notify=${notifyAmount} expected=${order.amount_cny}`);
    return res.status(200).send('failure');
  }

  const tradeStatus = params.trade_status;
  if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
    const ok = markOrderPaid(orderNo, {
      providerTradeNo: params.trade_no,
      rawNotify: JSON.stringify(params),
    });
    if (ok) {
      const planSpec = PLAN_CATALOG[order.period];
      grantProToAccount(order.account_id, planSpec.days);
      log('info', `[Billing] order paid + pro granted account=${order.account_id} order=${orderNo} days=${planSpec.days}`);
    }
  } else if (tradeStatus === 'TRADE_CLOSED') {
    updateOrderStatus(orderNo, 'closed', JSON.stringify(params));
  }

  return res.status(200).send('success');
});

// POST /api/billing/alipay/query/:orderNo — 主动查单（前端跳回后轮询时调用）
router.post('/billing/alipay/query/:orderNo', requireAuth, async (req, res) => {
  const order = getBillingOrder(req.params.orderNo);
  if (!order || order.account_id !== req.authUser.id) return err(res, '订单不存在', 404);
  if (order.status !== 'pending') return ok(res, { status: order.status });

  if (!isAlipayConfigured()) return ok(res, { status: order.status, note: 'alipay 未配置' });

  try {
    const r = await queryTrade(order.order_no);
    const status = r?.trade_status;
    if (status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED') {
      const okFlag = markOrderPaid(order.order_no, {
        providerTradeNo: r.trade_no,
        rawNotify: JSON.stringify(r),
      });
      if (okFlag) {
        const planSpec = PLAN_CATALOG[order.period];
        grantProToAccount(order.account_id, planSpec.days);
      }
      return ok(res, { status: 'paid' });
    }
    return ok(res, { status: 'pending', alipay_status: status });
  } catch (e) {
    log('error', `[Billing] alipay query 异常 order=${order.order_no}: ${e.message}`);
    return err(res, '查询失败', 500);
  }
});
BILLING_DISABLED_END */

// 内测期：返回一个简单的 stub 给前端，告诉它"现在是内测期免费"
router.get('/billing/plans', (req, res) => {
  return ok(res, {
    plans: {},
    alipay_configured: false,
    beta_free: true,
    notice: '内测期所有功能免费',
  });
});

// POST /api/billing/admin/grant-pro  (运营手动开通，需要 admin token)
//   header: x-admin-token
//   body: { user_id, days }
router.post('/billing/admin/grant-pro', (req, res) => {
  const adminToken = req.get('x-admin-token') || '';
  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected || adminToken !== expected) return err(res, '权限拒绝', 403);

  const accountId = intId(req.body?.user_id);
  const days = Math.max(1, Math.min(3650, Number(req.body?.days) || 30));
  if (!accountId) return err(res, '缺少 user_id');
  const account = getUserAccountById(accountId);
  if (!account) return err(res, '用户不存在', 404);

  const binding = getWechatAccountByAccountId(accountId);
  const userId = binding?.user_id || accountId;

  const expiresAt = new Date(Date.now() + days * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
  getDb().prepare(`
    UPDATE users
    SET plan = 'pro', plan_expires_at = ?
    WHERE id = ?
  `).run(expiresAt, userId);

  log('info', `[Billing] admin grant pro user=${userId} days=${days} expires=${expiresAt}`);
  return ok(res, { user_id: userId, plan: 'pro', plan_expires_at: expiresAt });
});

// GET /api/me/companion
router.get('/me/companion', requireAuth, (req, res) => {
  const accountId = intId(req.query.user_id ?? req.query.account_id ?? req.get('x-user-id'));
  if (!accountId) return authErr(res, '缺少 user_id');

  const account = getUserAccountById(accountId);
  if (!account) return authErr(res, '用户不存在', 404);

  const binding = getWechatAccountByAccountId(accountId);
  if (!binding?.wechat_user_id || !binding?.bot_id || binding.is_active === 0) {
    return ok(res, null);
  }

  const companion = getCompanionByAccountId(accountId);
  if (!companion) return ok(res, null);

  return ok(res, {
    companion_id: companion.id,
    companion: companionSummary(companion),
    binding: {
      account_id: binding.account_id,
      wechat_user_id: binding.wechat_user_id,
      bot_id: binding.bot_id,
      companion_id: companion.id,
      bound_at: binding.bound_at,
    },
  });
});

// GET /api/me/wechat
router.get('/me/wechat', requireAuth, (req, res) => {
  const accountId = intId(req.query.user_id ?? req.query.account_id ?? req.get('x-user-id'));
  if (!accountId) return err(res, '缺少 user_id');

  const account = getUserAccountById(accountId);
  if (!account) return err(res, '用户不存在', 404);

  const binding = getWechatAccountByAccountId(accountId);
  if (!binding?.wechat_user_id || binding.is_active === 0) {
    return ok(res, null);
  }

  return ok(res, {
    wechat_user_id: binding.wechat_user_id,
    bot_id: binding.bot_id || null,
    companion_id: binding.companion_id ?? getCompanionByAccountId(accountId)?.id ?? null,
    is_active: true,
  });
});

// POST /api/wechat/bind-session
// 新流程：
//   1. 调 get_bot_qrcode 拿一个全新的 bot QR
//   2. 同时后台启动 get_qrcode_status 长轮询
//   3. confirmed 后：把 (bot_token, bot_id, ilink_user_id) 写入 wechat_accounts 关联到 web 账号，
//      并通知 botPool 注册一个新的 polling loop
//   4. 前端继续 poll /wechat/bind-session/:id，看到 status='success' 就跳 dashboard
router.post('/wechat/bind-session', requireAuth, async (req, res) => {
  noStore(res);
  const accountId = intId(req.body?.user_id ?? req.body?.account_id ?? req.get('x-user-id'));
  const isRebind = req.body?.rebind === true || req.body?.rebind === 'true';
  if (!accountId) return err(res, '缺少 user_id');

  const account = getUserAccountById(accountId);
  if (!account) return err(res, '用户不存在', 404);

  try {
    if (isRebind) {
      getDb().prepare(`
        UPDATE wechat_accounts
        SET is_active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE account_id = ? AND is_active = 1
      `).run(accountId);
      log('info', `[API] 重新绑定已停用旧微信 account=${accountId}`);
    }

    const baseUrl = (process.env.ILINK_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
    const [session, qr] = await Promise.all([
      Promise.resolve(createPendingBindSession({ accountId })),
      getBotQrcode(baseUrl),
    ]);
    if (!qr.qrcode || !qr.qrcodeImgContent) {
      log('error', `[API] 获取 iLink QR 失败 raw=${JSON.stringify(qr.raw).slice(0, 200)}`);
      return err(res, '获取微信二维码失败', 500);
    }

    const qrImage = await toQrImageDataUrl(qr.qrcodeImgContent, null);

    const controller = new AbortController();
    ilinkQrSessions.set(session.id, {
      qrcode: qr.qrcode,
      baseUrl,
      accountId,
      status: 'pending',
      botToken: null,
      botId: null,
      userId: null,
      controller,
      createdAt: Date.now(),
    });
    runQrcodeStatusLoop(session.id).catch(err =>
      log('error', `[API] QR status loop crash session=${session.id}: ${err.message}`)
    );
    log('info', `[API] 微信 pending 绑定已创建 user=${accountId} session=${session.id} qrcode=${qr.qrcode.slice(0, 8)}`);
    return ok(res, {
      session_id: session.id,
      bind_code: session.bind_code || null,
      expires_in: Math.max(0, Math.floor((new Date(session.expires_at).getTime() - Date.now()) / 1000)),
      status: session.status,
      qr_url: qr.qrcodeImgContent,
      qr_base64: qrImage,
    });
  } catch (e) {
    log('error', `[API] pending bind-session 创建失败: ${e.message}`);
    return err(res, '绑定会话创建失败', 500);
  }
});

const QR_STATUS_MAX_ITERATIONS = 30;          // ≈30 × 2s ≈ 1 分钟（实际由 get_qrcode_status 长轮询 hold）
const QR_STATUS_MAX_DURATION_MS = 5 * 60_000;  // 5 分钟超时

async function runQrcodeStatusLoop(sessionId) {
  const sess = ilinkQrSessions.get(sessionId);
  if (!sess) return;
  const startedAt = Date.now();
  let qrcode = sess.qrcode;
  let baseUrl = sess.baseUrl;
  let iteration = 0;

  while (true) {
    if (sess.controller.signal.aborted) {
      log('info', `[API] QR session=${sessionId} aborted`);
      ilinkQrSessions.delete(sessionId);
      return;
    }
    if (Date.now() - startedAt > QR_STATUS_MAX_DURATION_MS) {
      sess.status = 'expired';
      log('info', `[API] QR session=${sessionId} expired (timeout)`);
      return;
    }

    let resp;
    try {
      resp = await getQrcodeStatus(qrcode, baseUrl, { timeoutMs: 30_000 });
    } catch (err) {
      log('warn', `[API] QR session=${sessionId} polling error: ${err.message}`);
      await sleep(2_000);
      continue;
    }

    if (resp.status === 'wait' || resp.status === 'scaned') {
      iteration++;
      if (iteration > QR_STATUS_MAX_ITERATIONS) {
        await sleep(500);
        iteration = 0;
      }
      continue;
    }

    if (resp.status === 'scaned_but_redirect') {
      if (resp.redirectHost) {
        baseUrl = `https://${resp.redirectHost}`;
        sess.baseUrl = baseUrl;
        log('info', `[API] QR session=${sessionId} IDC redirect -> ${baseUrl}`);
      }
      await sleep(500);
      continue;
    }

    if (resp.status === 'expired') {
      sess.status = 'expired';
      log('info', `[API] QR session=${sessionId} 二维码过期`);
      return;
    }

    if (resp.status === 'binded_redirect' || resp.status === 'verify_code_blocked' || resp.status === 'need_verifycode') {
      sess.status = 'failed';
      sess.errorMessage = `QR 状态需要人工处理: ${resp.status}`;
      log('warn', `[API] QR session=${sessionId} 需要人工干预 status=${resp.status}`);
      return;
    }

    if (resp.status === 'confirmed') {
      const { botToken, botId, userId } = resp;
      if (!botToken || !botId) {
        sess.status = 'failed';
        sess.errorMessage = '服务端确认但未返回 token';
        log('error', `[API] QR session=${sessionId} confirmed 但缺少 token raw=${JSON.stringify(resp.raw).slice(0, 200)}`);
        return;
      }
      sess.botToken = botToken;
      sess.botId = botId;
      sess.userId = userId;
      sess.baseUrl = resp.baseUrl || baseUrl;
      sess.status = 'confirmed';
      log('info', `[API] QR session=${sessionId} confirmed bot=${botId.slice(0, 12)} user=${(userId || '').slice(0, 20)}`);
      try {
        await finalizeBindSession(sessionId);
      } catch (err) {
        log('error', `[API] finalize bind session=${sessionId} 失败: ${err.message}`);
        sess.status = 'failed';
        sess.errorMessage = err.message;
      }
      return;
    }

    log('warn', `[API] QR session=${sessionId} 未知 status=${resp.status}`);
    await sleep(2_000);
  }
}

async function finalizeBindSession(sessionId) {
  const sess = ilinkQrSessions.get(sessionId);
  if (!sess) throw new Error('QR session not found');
  if (!sess.botToken || !sess.botId || !sess.userId) throw new Error('缺少 token/botId/userId');

  // 通过 db 层创建/更新绑定
  const result = consumeQrcodeBindSession({
    sessionId,
    accountId: sess.accountId,
    wechatUserId: sess.userId,
    botId: sess.botId,
    botToken: sess.botToken,
  });

  // 把新账号加进 polling pool
  if (botPoolHandle?.registerBotAccount) {
    botPoolHandle.registerBotAccount({
      token: sess.botToken,
      botId: sess.botId,
      userId: sess.userId,
      baseUrl: sess.baseUrl,
      accountId: sess.accountId,
    });
  }
  log('info', `[API] bind 完成并已加入 pool session=${sessionId} account=${sess.accountId} bot=${sess.botId.slice(0, 12)}`);
  return result;
}

// 自己实现一遍 consume 流程（不依赖原来的 consumePendingBindSessionForWechat，因为我们已经从 iLink 拿到 wechatUserId）
function consumeQrcodeBindSession({ sessionId, accountId, wechatUserId, botId, botToken }) {
  const db = getDb();
  const tx = db.transaction(() => {
    // 找到 pending session
    const session = db.prepare(`
      SELECT * FROM pending_bind_sessions
      WHERE id = ? AND user_id = ?
    `).get(sessionId, accountId);
    if (!session) throw new Error('pending bind session not found');

    // 停用该账号下旧的绑定
    db.prepare(`
      UPDATE wechat_accounts
      SET is_active = 0, updated_at = CURRENT_TIMESTAMP
      WHERE account_id = ? AND is_active = 1
    `).run(accountId);

    // 取/创 companion
    const existingCompanion = db.prepare(`
      SELECT c.id FROM companions c
      JOIN users u ON u.id = c.user_id
      WHERE u.wechat_user_id = ? AND c.bot_id = ?
      LIMIT 1
    `).get(wechatUserId, botId);

    // 同步 users 表
    db.prepare(`
      INSERT INTO users (wechat_user_id, last_active)
      VALUES (?, CURRENT_TIMESTAMP)
      ON CONFLICT(wechat_user_id) DO UPDATE SET last_active = CURRENT_TIMESTAMP
    `).run(wechatUserId);

    // 创建新绑定记录
    db.prepare(`
      INSERT INTO wechat_accounts
        (account_id, user_id, wechat_user_id, bot_id, bot_token, companion_id, login_session_id, is_active, bound_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(accountId, accountId, wechatUserId, botId, botToken, existingCompanion?.id ?? null, sessionId);

    // 标记 pending session 成功
    db.prepare(`
      UPDATE pending_bind_sessions
      SET status = 'success',
          wechat_user_id = ?,
          companion_id = ?,
          consumed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(wechatUserId, existingCompanion?.id ?? null, sessionId);

    return {
      companionId: existingCompanion?.id ?? null,
      binding: db.prepare('SELECT * FROM wechat_accounts WHERE account_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1').get(accountId),
    };
  });
  return tx();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// GET /api/wechat/bind-session/:session_id
router.get('/wechat/bind-session/:session_id', requireAuth, (req, res) => {
  noStore(res);
  const sessionId = typeof req.params.session_id === 'string' ? req.params.session_id.trim() : '';
  const session = sessionId ? getPendingBindSession(sessionId) : null;
  if (!session) return err(res, '绑定会话不存在或已过期', 404);

  // 同步查 QR loop 当前状态作为补充信息
  const qrState = ilinkQrSessions.get(sessionId);

  // 已 success
  if (session.status === 'success') {
    const binding = getWechatAccountByAccountId(session.user_id);
    return ok(res, {
      status: 'success',
      bind_code: session.bind_code || null,
      expires_in: Math.max(0, Math.floor((new Date(session.expires_at).getTime() - Date.now()) / 1000)),
      wechat_user_id: binding?.wechat_user_id || session.wechat_user_id || null,
      bot_id: binding?.bot_id || null,
      companion_id: binding?.companion_id ?? session.companion_id ?? null,
    });
  }

  if (session.status === 'failed') {
    return res.status(409).json({ ok: false, message: session.error_message || qrState?.errorMessage || '绑定失败' });
  }

  // 把 QR loop 的 scaned 等中间状态透传给前端
  const intermediateStatus = qrState?.status === 'expired' ? 'expired'
    : qrState?.status === 'failed' ? 'failed'
    : session.status;

  return ok(res, {
    status: intermediateStatus,
    bind_code: session.bind_code || null,
    expires_in: Math.max(0, Math.floor((new Date(session.expires_at).getTime() - Date.now()) / 1000)),
    wechat_user_id: session.wechat_user_id || null,
    companion_id: session.companion_id ?? null,
  });
});

// POST /api/auth/wechat-bind
router.post('/auth/wechat-bind', requireAuth, (req, res) => {
  const accountId = intId(req.body?.user_id ?? req.body?.account_id);
  const sessionId = typeof req.body?.session_id === 'string' ? req.body.session_id.trim() : '';
  const receivedToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const directWechatUserId = typeof req.body?.wechat_user_id === 'string' ? req.body.wechat_user_id.trim() : '';
  const isRebind = req.body?.rebind === true || req.body?.rebind === 'true';
  const personaConfig = req.body?.persona_config && typeof req.body.persona_config === 'object'
    ? normalizeCompanionConfig(req.body.persona_config)
    : null;

  if (!accountId) return authErr(res, '缺少 user_id');
  const account = getUserAccountById(accountId);
  if (!account) return authErr(res, '用户不存在', 404);

  const session = sessionId ? wechatLoginSessions.get(sessionId) : null;
  if (sessionId && !session) return authErr(res, '二维码会话不存在或已过期', 404);
  if (session && session.status !== 'confirmed') return authErr(res, '微信尚未确认登录', 409, { status: session.status });
  if (session && session.token && receivedToken !== session.token) return authErr(res, '绑定 token 无效', 401);

  const wechatUserId = session?.wechatUserId || directWechatUserId;
  if (!wechatUserId) return authErr(res, '缺少 wechat_user_id');

  const { botId, token: botToken } = ilinkConfig();
  if (!botId || !botToken) return authErr(res, 'iLink 配置不完整', 500);

  try {
    if (isRebind) {
      const result = rebindWechatAccount({
        accountId,
        wechatUserId,
        botId,
        botToken,
        displayName: session?.displayName || account.username,
        avatarUrl: session?.avatarUrl || null,
        loginSessionId: sessionId || null,
      });
      if (sessionId) wechatLoginSessions.delete(sessionId);
      log('info', `[API] 微信重新绑定成功 account=${accountId} companion=${result.companionId ?? 'none'}`);
      return res.json({
        ok: true,
        success: true,
        message: '微信已重新绑定',
        data: {
          wechat_user_id: result.binding.wechat_user_id,
          companion_id: result.companionId ?? null,
        },
        wechat_user_id: result.binding.wechat_user_id,
        companion_id: result.companionId ?? null,
      });
    }

    const binding = bindWechatAccount({
      accountId,
      wechatUserId,
      botId,
      botToken,
      displayName: session?.displayName || account.username,
      avatarUrl: session?.avatarUrl || null,
      loginSessionId: sessionId || null,
    });
    let companion = ensureCompanion(binding.wechat_user_id, binding.bot_id);
    if (personaConfig && Object.keys(personaConfig).length > 0) {
      companion = updateCompanion(companion.id, personaConfig);
    }
    // 如果是新建 / 还没有人生背景，异步生成
    if (!hasPersonaFacts(companion.id)) {
      asyncGeneratePersonaFacts(companion);
    }
    const existing = getWechatAccountByAccountId(accountId);
    if (sessionId) wechatLoginSessions.delete(sessionId);
    log('info', `[API] 微信绑定成功 account=${accountId}`);
    return res.json({
      success: true,
      message: '微信绑定成功',
      wechat_user_id: binding.wechat_user_id,
      companion_id: companion.id,
      companion: companionSummary(companion),
      binding: {
        id: existing.id,
        account_id: existing.account_id,
        wechat_user_id: existing.wechat_user_id,
        bot_id: existing.bot_id,
        companion_id: companion.id,
        bound_at: existing.bound_at,
      },
    });
  } catch (e) {
    if (e.code === 'WECHAT_BOUND') {
      return res.status(409).json({ ok: false, success: false, message: '该微信已绑定其他账号' });
    }
    if (e.code === 'WECHAT_HAS_COMPANION') {
      return res.status(409).json({ ok: false, success: false, message: e.message });
    }
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return authErr(res, '该微信已绑定其他账号', 409);
    }
    log('error', `[API] wechat-bind 失败: ${e.message}`);
    return authErr(res, '微信绑定失败', 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Companion CRUD
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/ilink-status
router.get('/admin/ilink-status', (_req, res) => {
  return ok(res, getIlinkStatusSnapshot());
});

// POST /api/admin/companions/:id/send-photo — 手动触发一次场景照分享（不等 2 天）
router.post('/admin/companions/:id/send-photo', requireAdmin, async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return err(res, 'id 无效');
  const c = getCompanionById(id);
  if (!c) return err(res, 'companion 不存在', 404);
  try {
    const { sendScenePhotoManually } = await import('./proactive.mjs');
    sendScenePhotoManually(c).catch(e =>
      log('error', `[Admin] 手动发场景照失败: ${e.message}`)
    );
    log('info', `[Admin] 手动触发场景照 companion=${id} by=${req.adminUser.username}`);
    return ok(res, { triggered: true, note: '已异步触发，几秒后用户会收到' });
  } catch (e) {
    return err(res, e.message, 500);
  }
});

// POST /api/admin/stickers/reload  — 需要管理员登录
router.post('/admin/stickers/reload', requireAdmin, async (req, res) => {
  const { reloadStickers } = await import('./stickers.mjs');
  const { stickers } = reloadStickers();
  log('info', `[API] stickers reloaded count=${stickers.length} by=${req.adminUser.username}`);
  return ok(res, { count: stickers.length });
});

// GET /api/companions/user/:uid
router.get('/companions/user/:uid', requireAuth, (req, res) => {
  const { uid } = req.params;
  const botId   = req.query.bot_id || process.env.ILINK_BOT_ID || '';
  if (!botId) return err(res, '缺少 bot_id 参数');
  const c = getCompanion(uid, botId);
  if (!c) return err(res, 'companion 不存在', 404);
  return ok(res, c);
});

// GET /api/companions/:id/summary
router.get('/companions/:id/summary', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireCompanion(res, id); if (!c) return;
  return ok(res, companionSummary(c));
});

// GET /api/companions/:id/persona — 看她的人生背景
router.get('/companions/:id/persona', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireCompanion(res, id); if (!c) return;
  const facts = getPersonaFacts(id);
  // 按 category 分组
  const grouped = {};
  for (const f of facts) {
    if (!grouped[f.category]) grouped[f.category] = [];
    grouped[f.category].push(f.content);
  }
  return ok(res, { companion_id: id, total: facts.length, facts: grouped });
});

// GET /api/companions/:id/avatar/suggest — 从预生成池里匹配 top 4
router.get('/companions/:id/avatar/suggest', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireCompanion(res, id); if (!c) return;
  const stats = countAvatarPresets();
  if (stats.enabled === 0) {
    return err(res, '预设池为空，请先跑 scripts/gen_avatar_presets.mjs', 503);
  }
  // 派生 companion 的语义描述（融合人设 + 元认知）
  let hobbies = '';
  try { hobbies = JSON.parse(c.hobbies || '[]').join('、'); } catch {}
  let personality = '';
  try { personality = JSON.parse(c.personality_tags || '[]').join('、'); } catch {}
  // 取部分元认知（习惯 + 价值观 + 对感情看法）作为额外信号
  const facts = getPersonaFacts(id);
  const relevantFacts = facts
    .filter(f => ['values', 'love_view', 'habits', 'linguistic_quirks'].includes(f.category))
    .slice(0, 6)
    .map(f => f.content).join('；');
  const queryText = `${c.age || 20}岁 ${c.role_title || ''} ${personality} ${c.hair_color || ''}${c.hair_style || ''} ${c.clothing_style || ''}风格 爱好${hobbies}。${relevantFacts}`;
  const qEmb = await embedText(queryText).catch(() => null);
  const matches = matchAvatarPresets(c, qEmb, 4);
  log('info', `[Avatar] suggest companion=${id} matches=${matches.length} pool=${stats.enabled}`);
  return ok(res, { matches, pool_size: stats.enabled, query_text: queryText });
});

// POST /api/companions/:id/avatar/select-preset — 选用预设头像
router.post('/companions/:id/avatar/select-preset', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireCompanion(res, id); if (!c) return;
  const fileName = typeof req.body?.file_name === 'string' ? req.body.file_name.trim() : '';
  if (!fileName || !/^[a-zA-Z0-9_\-.]+\.webp$/.test(fileName)) return err(res, 'file_name 无效');
  // 验证文件存在
  const AVATAR_DIR = process.env.AVATAR_PRESET_DIR || path.resolve(process.cwd(), 'public/avatars/preset');
  if (!existsSync(path.join(AVATAR_DIR, fileName))) return err(res, '该预设不存在', 404);
  const avatarUrl = `/avatars/preset/${fileName}`;
  patchCompanion(id, { avatar_url: avatarUrl });
  log('info', `[Avatar] companion=${id} 选用预设 ${fileName}`);
  return ok(res, { avatar_url: avatarUrl });
});

// POST /api/companions/:id/avatar/generate — 用 AI 自动生成 4 张候选头像
router.post('/companions/:id/avatar/generate', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireCompanion(res, id); if (!c) return;
  try {
    const { prompt, urls } = await generateAvatarCandidates(c, 4);
    if (urls.length === 0) return err(res, '生成失败，请稍后重试', 502);
    log('info', `[Avatar] AI 生成候选 companion=${id} count=${urls.length}`);
    return ok(res, { urls, prompt });
  } catch (e) {
    log('error', `[Avatar] AI generate 失败 companion=${id}: ${e.message}`);
    return err(res, e.message || '生成失败', 500);
  }
});

// POST /api/companions/:id/avatar/from-url — 从 URL 下载图片并保存为头像
router.post('/companions/:id/avatar/from-url', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireCompanion(res, id); if (!c) return;
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!/^https?:\/\//.test(url)) return err(res, 'url 无效');
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return err(res, `下载失败 HTTP ${r.status}`, 502);
    const ct = r.headers.get('content-type') || 'image/jpeg';
    if (!ct.startsWith('image/')) return err(res, '响应不是图片', 400);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 10 * 1024 * 1024) return err(res, '图片过大', 413);

    const AVATAR_DIR = process.env.AVATAR_DIR || path.resolve(process.cwd(), 'public/avatars');
    if (!existsSync(AVATAR_DIR)) mkdirSync(AVATAR_DIR, { recursive: true });
    const ts = Date.now();
    const tmpPath = path.join(AVATAR_DIR, `_tmp_${id}_${ts}`);
    const outName = `${id}_${ts}.webp`;
    const outPath = path.join(AVATAR_DIR, outName);
    writeFileSync(tmpPath, buf);
    // 切顶部去水印（针对 AI 生成图，对真实图也无害——只稍微 zoom 13%）
    await new Promise((resolve, reject) => {
      const proc = spawn('convert', [
        tmpPath, '-auto-orient',
        '-resize', '578x578^',
        '-gravity', 'north',
        '-crop', '512x512+0+0', '+repage',
        '-strip', '-quality', '85', outPath,
      ]);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error('convert code=' + code)));
      proc.on('error', reject);
    });
    try { unlinkSync(tmpPath); } catch {}
    const avatarUrl = `/avatars/${outName}`;
    patchCompanion(id, { avatar_url: avatarUrl });
    log('info', `[Avatar] from-url 完成 companion=${id} → ${avatarUrl}`);
    return ok(res, { avatar_url: avatarUrl });
  } catch (e) {
    log('error', `[Avatar] from-url 失败: ${e.message}`);
    return err(res, '保存失败', 500);
  }
});

// POST /api/companions/:id/avatar — 上传头像（base64），自动转 512x512 webp
router.post('/companions/:id/avatar', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireCompanion(res, id); if (!c) return;
  const dataUrl = typeof req.body?.image_base64 === 'string' ? req.body.image_base64 : '';
  if (dataUrl.length < 100) return err(res, '缺少图片数据');

  const m = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/i);
  if (!m) return err(res, '图片格式无效（需 png/jpg/webp/gif）');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) return err(res, '图片过大（>5MB）', 413);
  if (buf.length < 200) return err(res, '图片数据异常');

  // 存到 nginx 静态目录，让 nginx 直接 serve（不经过 node）
  const AVATAR_DIR = process.env.AVATAR_DIR || path.resolve(process.cwd(), 'public/avatars');
  if (!existsSync(AVATAR_DIR)) mkdirSync(AVATAR_DIR, { recursive: true });
  const ts = Date.now();
  const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
  const tmpPath = path.join(AVATAR_DIR, `_tmp_${id}_${ts}.${ext}`);
  const outName = `${id}_${ts}.webp`;
  const outPath = path.join(AVATAR_DIR, outName);
  writeFileSync(tmpPath, buf);

  // 调 imagemagick 转 512x512 webp（裁剪居中）
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('convert', [
        tmpPath,
        '-auto-orient',
        '-resize', '512x512^',
        '-gravity', 'center',
        '-extent', '512x512',
        '-strip',
        '-quality', '85',
        outPath,
      ]);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error('convert failed code=' + code)));
      proc.on('error', reject);
    });
    try { unlinkSync(tmpPath); } catch {}
  } catch (e) {
    try { unlinkSync(tmpPath); } catch {}
    log('error', `[Avatar] 转换失败 companion=${id}: ${e.message}`);
    return err(res, '图片处理失败', 500);
  }

  const avatarUrl = `/avatars/${outName}`;
  patchCompanion(id, { avatar_url: avatarUrl });
  log('info', `[Avatar] companion=${id} 上传完成 → ${avatarUrl}`);
  return ok(res, { avatar_url: avatarUrl });
});

// POST /api/companions/:id/persona/regenerate — 重新生成人生背景
router.post('/companions/:id/persona/regenerate', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireCompanion(res, id); if (!c) return;
  // 同步生成（让前端能 spinner 一下）
  try {
    const data = await generatePersonaFacts(c);
    if (!data) return err(res, '生成失败，请稍后重试', 500);
    const facts = [];
    for (const cat of ['childhood', 'school', 'family', 'friends', 'pets', 'important_events', 'values', 'love_view', 'fears', 'habits', 'secrets', 'linguistic_quirks']) {
      const list = Array.isArray(data[cat]) ? data[cat] : [];
      for (const item of list) {
        const content = String(item || '').trim();
        if (content) facts.push({ category: cat, content });
      }
    }
    savePersonaFacts(id, facts);
    log('info', `[Persona] 重生成 companion=${id} ${facts.length} 条 by=${req.authUser.id}`);
    return ok(res, { companion_id: id, total: facts.length });
  } catch (e) {
    log('error', `[Persona] 重生成异常: ${e.message}`);
    return err(res, '生成失败', 500);
  }
});

// POST /api/setup/test-chat — 给 setup.html 用：用最低 token 数发一次 ping，验证
// 当前 CHAT_PROVIDER + 对应的 API key 是否能跑通。不需要鉴权（首次启动时还没账号），
// 但限速防滥用。
router.post('/setup/test-chat',
  rateLimit({ scope: 'test-chat', maxPerWindow: 10, windowMs: 60_000, message: '测试过于频繁，请稍后再试' }),
  async (_req, res) => {
    try {
      const { chatComplete, getActiveChatProvider } = await import('./providers/chat.mjs');
      const t0 = Date.now();
      const r = await chatComplete({
        system: 'You answer with exactly one short word.',
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        temperature: 0,
        max_tokens: 8,
      });
      const ms = Date.now() - t0;
      return ok(res, {
        provider: getActiveChatProvider(),
        ok: true,
        latency_ms: ms,
        sample: String(r?.text || '').slice(0, 40),
      });
    } catch (e) {
      // 不要把异常 stack 直接抛给浏览器，只回 message 的安全前缀
      const msg = String(e?.message || 'unknown error').slice(0, 200);
      log('warn', `[Setup] test-chat failed: ${msg}`);
      return res.status(200).json({ ok: false, error: msg });
    }
  }
);

// POST /api/companions/:id/playground-chat — 浏览器端跟 companion 聊天（不走微信）
// 让未拿到腾讯 iLink/ClawBot 准入的用户也能完整体验 AI 人设、记忆、关系演进
router.post('/companions/:id/playground-chat',
  requireAuth,
  rateLimit({ scope: 'playground-chat', maxPerWindow: 30, windowMs: 60_000, message: '聊太快了，等一会儿再发' }),
  async (req, res) => {
    const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
    const c = requireCompanion(res, id); if (!c) return;
    const text = String(req.body?.text ?? req.body?.message ?? '').trim();
    if (!text) return err(res, '消息不能为空');
    if (text.length > 2000) return err(res, '消息过长（>2000 字）');
    try {
      const { playgroundChat } = await import('./playground.mjs');
      const result = await playgroundChat(c, text);
      return ok(res, result);
    } catch (e) {
      log('error', `[API] playground-chat companion=${id}: ${e.message}`);
      return err(res, e.message || 'AI 生成失败', 500);
    }
  }
);

// GET /api/companions/:id/today — 她今天的日程 + 当前情绪段 + 此刻状态
router.get('/companions/:id/today', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireCompanion(res, id); if (!c) return;
  const todayKey = shanghaiDateKey();
  const sched = getDailySchedule(id, todayKey);
  // 计算上海当前分钟
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  const nowMin = Number(p.hour) * 60 + Number(p.minute);

  let currentActivity = null, nextActivity = null, previousActivity = null;
  if (sched?.items?.length) {
    for (const it of sched.items) {
      const m = (it.time || '').match(/^(\d{1,2}):(\d{2})/);
      const itMin = m ? Number(m[1]) * 60 + Number(m[2]) : -1;
      if (itMin <= nowMin) {
        previousActivity = currentActivity;
        currentActivity = it;
      } else if (!nextActivity) {
        nextActivity = it;
      }
    }
  }

  let segmentMood = null;
  if (sched?.mood_segments) {
    if (nowMin < 12 * 60) segmentMood = sched.mood_segments.morning;
    else if (nowMin < 18 * 60) segmentMood = sched.mood_segments.afternoon;
    else segmentMood = sched.mood_segments.evening;
  }

  return ok(res, {
    date: todayKey,
    now: `${String(Math.floor(nowMin/60)).padStart(2,'0')}:${String(nowMin%60).padStart(2,'0')}`,
    has_schedule: !!sched,
    current_activity: currentActivity,
    previous_activity: previousActivity,
    next_activity: nextActivity,
    segment_mood: segmentMood,
    mood_arc: sched?.mood_arc || null,
    items: sched?.items || [],
  });
});

// GET /api/companions/:id/timeline — 我们的故事
router.get('/companions/:id/timeline', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireCompanion(res, id); if (!c) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const data = getCompanionTimeline(id, limit);
  if (!data) return err(res, 'companion 不存在', 404);
  return ok(res, data);
});

// GET /api/companions/:id/prompt
router.get('/companions/:id/prompt', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireCompanion(res, id); if (!c) return;
  const userProfile = getUserProfile(c.user_id, id);
  const memories    = recallMemories(id, c.user_id, '', 10);
  const recentTurns = getConversationContext(id, 10);
  const prompt = buildSystemPrompt(c, { memories, userProfile, recentTurns });
  return ok(res, { companion_id: id, name: c.name, prompt });
});

// GET /api/companions/:id/context
router.get('/companions/:id/context', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireCompanion(res, id); if (!c) return;
  const lim = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const turns = getConversationContext(id, lim);
  return ok(res, { companion_id: id, total: turns.length, turns });
});

// DELETE /api/companions/:id/context
router.delete('/companions/:id/context', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireCompanion(res, id); if (!c) return;
  const deleted = clearConversationContext(id);
  log('info', `[API] 清空最近上下文 companion=${id} deleted=${deleted}`);
  return ok(res, { companion_id: id, cleared: true, deleted });
});

// GET /api/companions/:id
router.get('/companions/:id', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireCompanion(res, id); if (!c) return;
  return ok(res, c);
});

// 找到拥有该 wechat_user_id 的 web account_id（用于 plan / 配额查询）
function resolveAccountIdByWechat(wechatUserId) {
  if (!wechatUserId) return null;
  const row = getDb().prepare(`
    SELECT account_id FROM wechat_accounts
    WHERE wechat_user_id = ? AND is_active = 1
    ORDER BY updated_at DESC LIMIT 1
  `).get(wechatUserId);
  return row?.account_id || null;
}

const MIN_COMPANION_AGE = 16;
const ADULT_COMPANION_AGE = 18;

/**
 * AI 虚拟角色（companion）年龄合规守门：
 *   - age < MIN_COMPANION_AGE → 抛错（调用方应返回 400）
 *   - MIN_COMPANION_AGE <= age < ADULT_COMPANION_AGE → 强制 nsfw_level = 0
 *   - age >= ADULT_COMPANION_AGE → 按用户设置
 *   - age 未提供（PATCH 场景）→ 不做改动
 */
function applyCompanionAgeGuard(data, existingCompanion = null) {
  const out = { ...data };
  let age = null;
  if (out.age !== undefined && out.age !== null && out.age !== '') {
    age = Number(out.age);
    if (!Number.isFinite(age)) {
      const err = new Error('age 必须是数字');
      err.code = 'INVALID_AGE';
      throw err;
    }
    if (age < MIN_COMPANION_AGE) {
      const err = new Error(`AI 角色年龄不得低于 ${MIN_COMPANION_AGE} 岁`);
      err.code = 'AGE_TOO_LOW';
      throw err;
    }
    out.age = age;
  } else if (existingCompanion?.age != null) {
    age = Number(existingCompanion.age);
  }
  if (age != null && age < ADULT_COMPANION_AGE) {
    if ((out.nsfw_level ?? 0) > 0) {
      log('warn', `[API] companion age guard: forcing nsfw_level=0 (age=${age}, was nsfw=${out.nsfw_level})`);
    }
    out.nsfw_level = 0;
  }
  return out;
}

// POST /api/companions
router.post('/companions', requireAuth, (req, res) => {
  const { wechat_user_id, bot_id, ...data } = req.body || {};
  if (!wechat_user_id) return err(res, '缺少 wechat_user_id');
  // multi-tenant：bot_id 优先从入参取，否则从该 wechat 用户的活绑定里查
  let botId = bot_id || '';
  if (!botId) {
    const row = getDb().prepare(`
      SELECT bot_id FROM wechat_accounts
      WHERE wechat_user_id = ? AND is_active = 1
      ORDER BY updated_at DESC LIMIT 1
    `).get(wechat_user_id);
    botId = row?.bot_id || process.env.ILINK_BOT_ID || '';
  }
  if (!botId) return err(res, '缺少 bot_id');
  const accountId = resolveAccountIdByWechat(wechat_user_id);
  // 数量上限：免费 1 个 / Pro 3 个
  if (accountId) {
    const plan = getUserPlan(accountId);
    const limit = plan.isPro ? 3 : 1;
    const existing = getDb().prepare(`
      SELECT COUNT(*) AS n FROM companions c
      JOIN users u ON u.id = c.user_id
      JOIN wechat_accounts wa ON wa.wechat_user_id = u.wechat_user_id AND wa.is_active = 1
      WHERE wa.account_id = ?
    `).get(accountId)?.n ?? 0;
    if (existing >= limit) {
      return err(res, plan.isPro ? `Pro 用户最多 ${limit} 个人设` : `免费用户最多 ${limit} 个人设，升级 Pro 后可创建更多`, 409);
    }
  }
  let guarded;
  try {
    guarded = applyCompanionAgeGuard(data);
  } catch (e) {
    return err(res, e.message, e.code === 'AGE_TOO_LOW' ? 400 : 400);
  }
  if ((guarded.nsfw_level ?? 0) >= 1) log('warn', `[API] nsfw_level=${guarded.nsfw_level} user=${wechat_user_id}`);
  try {
    const c = createCompanion(wechat_user_id, botId, normalizeCompanionConfig(guarded));
    getDb().prepare(`
      UPDATE wechat_accounts
      SET companion_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE wechat_user_id = ? AND bot_id = ? AND is_active = 1
    `).run(c.id, wechat_user_id, botId);
    log('info', `[API] 创建 companion id=${c.id} user=${wechat_user_id}`);
    // 异步生成"元认知 / 人生背景"——不阻塞返回
    asyncGeneratePersonaFacts(c);
    return ok(res, c, 201);
  } catch (e) {
    if (e.code === 'EXISTS') return err(res, e.message, 409, { existing_id: e.id });
    log('error', `[API] createCompanion: ${e.message}`);
    return err(res, '服务器内部错误', 500);
  }
});

// PUT /api/companions/:id
router.put('/companions/:id', requireAuth, (req, res) => {
  const id   = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const existing = getCompanionById(id);
  if (!existing) return err(res, 'companion 不存在', 404);
  let guarded;
  try {
    guarded = applyCompanionAgeGuard(req.body || {}, existing);
  } catch (e) {
    return err(res, e.message, 400);
  }
  const data = normalizeCompanionConfig(guarded);
  if (Object.keys(data).length === 0) return err(res, '请求体为空');
  try {
    const c = updateCompanion(id, data);
    log('info', `[API] 更新 companion id=${id}`);
    return ok(res, c);
  } catch (e) {
    if (e.code === 'NOT_FOUND') return err(res, e.message, 404);
    log('error', `[API] updateCompanion: ${e.message}`);
    return err(res, '服务器内部错误', 500);
  }
});

// DELETE /api/companions/:id
router.delete('/companions/:id', requireAuth, (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ ok: false, message: 'id 无效' });
  const accountId = intId(req.query.user_id ?? req.query.account_id ?? req.get('x-user-id') ?? req.body?.user_id ?? req.body?.account_id);
  if (!accountId) return res.status(401).json({ ok: false, message: '缺少 user_id' });
  const account = getUserAccountById(accountId);
  if (!account) return res.status(401).json({ ok: false, message: '用户不存在' });

  try {
    const result = deleteCompanionForAccount(accountId, id);
    log('info', `[API] 删除 companion id=${id} account=${accountId}`);
    return res.json({ ok: true, message: '人设已删除', cleaned: result.cleaned });
  } catch (e) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ ok: false, message: '人设不存在' });
    if (e.code === 'FORBIDDEN') return res.status(403).json({ ok: false, message: '无权删除该人设' });
    log('error', `[API] deleteCompanion: ${e.message}`);
    return res.status(500).json({ ok: false, message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 状态面板
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/status
router.get('/companions/:id/status', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireCompanion(res, id); if (!c) return;
  const db = getDb();
  const memCount = db.prepare('SELECT COUNT(*) as n FROM companion_memories WHERE companion_id = ?').get(id)?.n ?? 0;
  return ok(res, {
    name:               c.name,
    current_mood:       c.current_mood,
    mood_updated_at:    c.mood_updated_at,
    affection_level:    c.affection_level,
    relationship_stage: c.relationship_stage,
    current_scene:      c.current_scene,
    chat_mode_active:   c.chat_mode_active,
    memory_enabled:     c.memory_enabled,
    memory_count:       memCount,
    intimacy_level:     c.intimacy_level,
    updated_at:         c.updated_at,
  });
});

// PUT /api/companions/:id/mood
router.put('/companions/:id/mood', requireAuth, (req, res) => {
  const id  = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c   = requireCompanion(res, id); if (!c) return;
  const { mood } = req.body || {};
  const allowed = ['开心','平静','委屈','想念','兴奋'];
  if (!mood || !allowed.includes(mood)) return err(res, `mood 必须是：${allowed.join('/')}`);
  patchCompanion(id, { current_mood: mood, mood_updated_at: new Date().toISOString() });
  log('info', `[API] 手动设置心情 id=${id} mood=${mood}`);
  return ok(res, { companion_id: id, current_mood: mood });
});

// PUT /api/companions/:id/scene
router.put('/companions/:id/scene', requireAuth, (req, res) => {
  const id    = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c     = requireCompanion(res, id); if (!c) return;
  const { scene } = req.body || {};
  if (!scene) return err(res, '缺少 scene 字段');
  const history = [...(c.scene_history || []), { scene: c.current_scene, time: new Date().toISOString() }].slice(-10);
  patchCompanion(id, { current_scene: scene, scene_history: JSON.stringify(history) });
  log('info', `[API] 切换场景 id=${id} → ${scene}`);
  return ok(res, { companion_id: id, current_scene: scene, scene_history: history });
});

// PUT /api/companions/:id/affection
router.put('/companions/:id/affection', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireCompanion(res, id); if (!c) return;
  const { delta, set } = req.body || {};
  let newVal;
  if (set !== undefined) {
    newVal = Math.min(Math.max(Number(set), 0), 100);
  } else if (delta !== undefined) {
    newVal = Math.min(Math.max((c.affection_level ?? 0) + Number(delta), 0), 100);
  } else {
    return err(res, '需要 delta（增减量）或 set（绝对值）');
  }
  const stage = computeRelationshipStage(newVal);
  patchCompanion(id, { affection_level: newVal, relationship_stage: stage });
  log('info', `[API] 调整好感度 id=${id} → ${newVal} stage=${stage}`);
  return ok(res, { companion_id: id, affection_level: newVal, relationship_stage: stage });
});

// PUT /api/companions/:id/chat-mode
router.put('/companions/:id/chat-mode', requireAuth, (req, res) => {
  const id   = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c    = requireCompanion(res, id); if (!c) return;
  const { mode } = req.body || {};
  const allowed = ['日常聊天','角色扮演','睡前故事','早安问候','情感倾诉'];
  if (!mode || !allowed.includes(mode)) return err(res, `mode 必须是：${allowed.join('/')}`);
  patchCompanion(id, { chat_mode_active: mode });
  log('info', `[API] 切换对话模式 id=${id} → ${mode}`);
  return ok(res, { companion_id: id, chat_mode_active: mode });
});

// ─────────────────────────────────────────────────────────────────────────────
// 礼物系统
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/gifts/catalog
router.get('/gifts/catalog', (_req, res) => {
  return ok(res, { gifts: GIFT_CATALOG });
});

// GET /api/companions/:id/gifts
router.get('/companions/:id/gifts', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireCompanion(res, id); if (!c) return;
  const lim = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const gifts = getCompanionGifts(id, lim);
  return ok(res, { companion_id: id, total: gifts.length, gifts });
});

// POST /api/companions/:id/gifts
router.post('/companions/:id/gifts', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireCompanion(res, id); if (!c) return;
  const giftId = typeof req.body?.gift_id === 'string' ? req.body.gift_id.trim() : '';
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const gift = getGiftById(giftId);
  if (!gift) return err(res, 'gift_id 不存在', 404);

  const newAffection = Math.min(Math.max((c.affection_level ?? 0) + gift.affection_delta, 0), 100);
  const stage = computeRelationshipStage(newAffection);
  const mood = gift.affection_delta >= 10 ? '兴奋' : '开心';

  saveCompanionGift({ companionId: id, gift, message });
  patchCompanion(id, {
    affection_level: newAffection,
    relationship_stage: stage,
    current_mood: mood,
    mood_updated_at: new Date().toISOString(),
  });

  const reactionText = giftReactionText(c, gift, message);
  log('info', `[API] 送礼 companion=${id} gift=${gift.id} affection=${newAffection}`);
  return res.status(201).json({
    success: true,
    message: '礼物已送出',
    affection: newAffection,
    reaction_text: reactionText,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 图片反应记忆
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/companions/:id/image-reaction
router.post('/companions/:id/image-reaction', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireCompanion(res, id); if (!c) return;
  const imageUrl = typeof req.body?.image_url === 'string' ? req.body.image_url.trim() : '';
  const imageDescription = typeof req.body?.image_description === 'string' ? req.body.image_description.trim() : '';
  const userMessage = typeof req.body?.user_message === 'string' ? req.body.user_message.trim() : '';
  if (!imageDescription) return err(res, '缺少 image_description');

  const extracted = extractImageMemories(imageDescription, userMessage);
  const memoriesToSave = extracted.map(m => ({
    companionId: id,
    userId: c.user_id,
    memoryType: m.memory_type,
    content: m.content,
    importance: Math.min(Math.max(Number(m.importance) || 5, 1), 10),
  }));

  if (memoriesToSave.length > 0) saveMemories(memoriesToSave);
  const reactionText = buildImageReactionText(extracted, imageDescription);
  saveImageReaction({
    companionId: id,
    imageUrl,
    imageDescription,
    userMessage,
    reactionText,
    memories: extracted,
  });

  log('info', `[API] 图片反应记忆 companion=${id} memories=${extracted.length}`);
  return res.status(201).json({
    success: true,
    reaction_text: reactionText,
    memories_added: extracted,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 节日/纪念日提醒
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/reminders
router.get('/companions/:id/reminders', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireCompanion(res, id); if (!c) return;
  const reminders = getReminders(id, req.query.limit);
  return ok(res, { companion_id: id, total: reminders.length, reminders });
});

// GET /api/companions/:id/reminders/due
router.get('/companions/:id/reminders/due', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireCompanion(res, id); if (!c) return;
  const today = typeof req.query.date === 'string' ? req.query.date.trim() : undefined;
  if (today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(today)) return err(res, 'date 必须是 YYYY-MM-DD');
  const reminders = getDueReminders(id, today);
  return ok(res, {
    companion_id: id,
    date: today || localYmd(),
    total: reminders.length,
    reminders,
  });
});

// POST /api/companions/:id/reminders
router.post('/companions/:id/reminders', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireCompanion(res, id); if (!c) return;
  try {
    const reminder = createReminder(id, req.body || {});
    log('info', `[API] 新增提醒 companion=${id} reminder=${reminder.id}`);
    return ok(res, reminder, 201);
  } catch (e) {
    if (e.code === 'VALIDATION') return err(res, e.message);
    log('error', `[API] createReminder: ${e.message}`);
    return err(res, '服务器内部错误', 500);
  }
});

// PUT /api/companions/:id/reminders/:rid
router.put('/companions/:id/reminders/:rid', requireAuth, (req, res) => {
  const id  = intId(req.params.id);  if (!id)  return err(res, 'id 无效');
  const rid = intId(req.params.rid); if (!rid) return err(res, 'reminder id 无效');
  const c   = requireCompanion(res, id); if (!c) return;
  try {
    const reminder = updateReminder(id, rid, req.body || {});
    return ok(res, reminder);
  } catch (e) {
    if (e.code === 'NOT_FOUND') return err(res, e.message, 404);
    if (e.code === 'VALIDATION') return err(res, e.message);
    log('error', `[API] updateReminder: ${e.message}`);
    return err(res, '服务器内部错误', 500);
  }
});

// DELETE /api/companions/:id/reminders/:rid
router.delete('/companions/:id/reminders/:rid', requireAuth, (req, res) => {
  const id  = intId(req.params.id);  if (!id)  return err(res, 'id 无效');
  const rid = intId(req.params.rid); if (!rid) return err(res, 'reminder id 无效');
  const c   = requireCompanion(res, id); if (!c) return;
  const deleted = deleteReminder(id, rid);
  if (!deleted) return err(res, 'reminder 不存在', 404);
  return ok(res, { companion_id: id, reminder_id: rid, deleted: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 长期记忆
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/memories
router.get('/companions/:id/memories', requireAuth, (req, res) => {
  const id  = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c   = requireCompanion(res, id); if (!c) return;
  const lim = Math.min(Number(req.query.limit) || 50, 200);
  const list = getMemories(id, c.user_id, lim);
  return ok(res, { total: list.length, memories: list });
});

// POST /api/companions/:id/memories
router.post('/companions/:id/memories', requireAuth, (req, res) => {
  const id   = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c    = requireCompanion(res, id); if (!c) return;
  const { memory_type, content, importance = 5 } = req.body || {};
  const types = ['fact','preference','event','emotion','image','daily_summary','weekly_summary','monthly_summary'];
  if (!content)                   return err(res, '缺少 content');
  if (!types.includes(memory_type)) return err(res, `memory_type 必须是：${types.join('/')}`);
  saveMemory({ companionId: id, userId: c.user_id, memoryType: memory_type, content, importance });
  log('info', `[API] 手动添加记忆 companion=${id} type=${memory_type}`);
  return ok(res, { companion_id: id, memory_type, content, importance }, 201);
});

// DELETE /api/companions/:id/memories/:mid
router.delete('/companions/:id/memories/:mid', requireAuth, (req, res) => {
  const id  = intId(req.params.id);  if (!id)  return err(res, 'id 无效');
  const mid = intId(req.params.mid); if (!mid) return err(res, 'memory id 无效');
  requireCompanion(res, id); // validate exists
  deleteMemory(mid, id);
  return ok(res, { deleted: true, memory_id: mid });
});

// DELETE /api/companions/:id/memories
router.delete('/companions/:id/memories', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireCompanion(res, id); if (!c) return;
  clearMemories(id, c.user_id);
  log('info', `[API] 清空记忆 companion=${id}`);
  return ok(res, { companion_id: id, cleared: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 用户画像
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/user-profile
router.get('/companions/:id/user-profile', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireCompanion(res, id); if (!c) return;
  const profile = getUserProfile(c.user_id, id);
  return ok(res, profile || {});
});

// PUT /api/companions/:id/user-profile
router.put('/companions/:id/user-profile', requireAuth, (req, res) => {
  const id   = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c    = requireCompanion(res, id); if (!c) return;
  const data = req.body || {};
  if (Object.keys(data).length === 0) return err(res, '请求体为空');
  const profile = upsertUserProfile(c.user_id, id, data);
  log('info', `[API] 更新用户画像 companion=${id}`);
  return ok(res, profile);
});

// ─────────────────────────────────────────────────────────────────────────────
// 管理员后台
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/admin/login
router.post('/admin/login',
  rateLimit({ scope: 'admin-login', maxPerWindow: 10, windowMs: 10 * 60 * 1000, message: '尝试过于频繁，请稍后再试' }),
  (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password) return err(res, '用户名或密码错误', 401);
  if (!verifyAdminCredentials(username, password)) {
    log('warn', `[Admin] 登录失败 username=${username.slice(0, 32)}`);
    return err(res, '用户名或密码错误', 401);
  }
  const token = signAdminToken({ username });
  log('info', `[Admin] 登录成功 username=${username}`);
  return ok(res, { token, expires_in: 30 * 60 });
});

// GET /api/admin/accounts?search=&limit=&offset=
router.get('/admin/accounts', requireAdmin, (req, res) => {
  const search = typeof req.query.search === 'string' && req.query.search.trim()
    ? req.query.search.trim()
    : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const accounts = listAllAccounts({ limit, offset, search });
  const total = countAllAccounts(search);

  const enriched = accounts.map(a => {
    const usage = getAccountUsageSummary(a.id);
    const binding = getWechatAccountByAccountId(a.id);
    return {
      id: a.id,
      username: a.username,
      email: a.email,
      is_banned: !!a.is_banned,
      banned_reason: a.banned_reason || null,
      banned_at: a.banned_at || null,
      created_at: a.created_at,
      wechat_bound: !!binding?.wechat_user_id,
      wechat_user_id: binding?.wechat_user_id || null,
      today_tokens: usage.today.total_tokens,
      today_messages: usage.today.message_count,
      total_tokens: usage.total.total_tokens,
      total_messages: usage.total.message_count,
    };
  });

  return ok(res, { total, limit, offset, accounts: enriched });
});

// GET /api/admin/accounts/:id
router.get('/admin/accounts/:id', requireAdmin, (req, res) => {
  const id = intId(req.params.id);
  if (!id) return err(res, 'id 无效');
  const account = getDb().prepare('SELECT * FROM user_accounts WHERE id = ?').get(id);
  if (!account) return err(res, '账号不存在', 404);

  const usage = getAccountUsageSummary(id);
  const history = getAccountUsageHistory(id, 30);
  const binding = getWechatAccountByAccountId(id);
  const companion = getCompanionByAccountId(id);

  return ok(res, {
    account: {
      id: account.id,
      username: account.username,
      email: account.email,
      is_banned: !!account.is_banned,
      banned_reason: account.banned_reason || null,
      banned_at: account.banned_at || null,
      created_at: account.created_at,
      updated_at: account.updated_at,
      terms_accepted_at: account.terms_accepted_at,
      birthday: account.birthday,
    },
    binding: binding ? {
      wechat_user_id: binding.wechat_user_id,
      bot_id: binding.bot_id,
      bound_at: binding.bound_at,
      is_active: !!binding.is_active,
    } : null,
    companion: companion ? {
      id: companion.id,
      name: companion.name,
      affection_level: companion.affection_level,
      relationship_stage: companion.relationship_stage,
    } : null,
    usage,
    history,
  });
});

// POST /api/admin/accounts/:id/ban
router.post('/admin/accounts/:id/ban', requireAdmin, (req, res) => {
  const id = intId(req.params.id);
  if (!id) return err(res, 'id 无效');
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 200) : null;
  const okFlag = setAccountBanned(id, true, reason);
  if (!okFlag) return err(res, '账号不存在', 404);
  log('info', `[Admin] 封禁账号 id=${id} reason=${reason || '<无>'} by=${req.adminUser.username}`);
  return ok(res, { id, is_banned: true, banned_reason: reason });
});

// POST /api/admin/accounts/:id/unban
router.post('/admin/accounts/:id/unban', requireAdmin, (req, res) => {
  const id = intId(req.params.id);
  if (!id) return err(res, 'id 无效');
  const okFlag = setAccountBanned(id, false, null);
  if (!okFlag) return err(res, '账号不存在', 404);
  log('info', `[Admin] 解封账号 id=${id} by=${req.adminUser.username}`);
  return ok(res, { id, is_banned: false });
});

// POST /api/admin/accounts/:id/reset-password — 生成新随机密码并返回明文（仅此一次）
router.post('/admin/accounts/:id/reset-password', requireAdmin, async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return err(res, 'id 无效');
  const account = getUserAccountById(id);
  if (!account) return err(res, '账号不存在', 404);

  // 生成 12 位随机密码（足够安全又方便用户输入）
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  let newPassword = '';
  for (let i = 0; i < 12; i++) newPassword += chars[bytes[i] % chars.length];

  try {
    const passwordHash = await hashPassword(newPassword);
    updateUserPassword(id, passwordHash);
    log('info', `[Admin] 重置用户密码 id=${id} by=${req.adminUser.username}`);
    return ok(res, {
      id,
      username: account.username,
      email: account.email,
      new_password: newPassword,
      note: '此密码仅显示一次，请复制后告知用户',
    });
  } catch (e) {
    log('error', `[Admin] reset password 失败: ${e.message}`);
    return err(res, '密码重置失败', 500);
  }
});

// GET /api/admin/stats/today
router.get('/admin/stats/today', requireAdmin, (req, res) => {
  const stats = getGlobalUsageToday();
  const db = getDb();
  const totalAccounts = countAllAccounts();
  const bannedAccounts = db.prepare('SELECT COUNT(*) AS n FROM user_accounts WHERE is_banned = 1').get()?.n ?? 0;
  const totalCompanions = db.prepare('SELECT COUNT(*) AS n FROM companions').get()?.n ?? 0;
  return ok(res, {
    today: stats,
    total_accounts: totalAccounts,
    banned_accounts: bannedAccounts,
    total_companions: totalCompanions,
  });
});

// POST /api/admin/regenerate-password — 管理员自己重置自己的密码
router.post('/admin/regenerate-password', requireAdmin, (req, res) => {
  const newPassword = regenerateAdminPassword();
  log('info', `[Admin] 管理员密码已重新生成 by=${req.adminUser.username}`);
  return ok(res, {
    username: loadAdminCredentials().username,
    new_password: newPassword,
    note: '请立即保存，关闭页面后无法再查看',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 创建并启动 Express
// ─────────────────────────────────────────────────────────────────────────────
export function startApiServer() {
  const app  = express();
  const port = Number(process.env.API_PORT) || 3000;

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));   // 支付宝异步通知用 form 编码
  app.use((req, _res, next) => { log('debug', `[API] ${req.method} ${req.path}`); next(); });
  app.use(express.static(PUBLIC_DIR));

  // 健康检查 + 当前激活的 AI provider（开源版本提供，便于排查"为什么没回复"）
  // wechat 字段只暴露 configured + source，绝不输出 token / botId
  app.get('/api/health', (_req, res) => {
    const chat = getActiveChatProvider();
    // chat provider 是否已配置对应的 *_API_KEY
    // 与 providers/chat.mjs / scripts/setup-wizard.mjs 的映射保持一致
    const CHAT_KEY_ENV = {
      deepseek: 'DEEPSEEK_API_KEY',
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      xai: 'XAI_API_KEY',
      zhipu: 'ZHIPU_API_KEY',
      doubao: 'DOUBAO_API_KEY',
      qwen: 'QWEN_API_KEY',
      kimi: 'KIMI_API_KEY',
      wenxin: 'WENXIN_API_KEY',
    };
    const chatKeyEnv = CHAT_KEY_ENV[String(chat?.id || '').toLowerCase()];
    const chatConfigured = chatKeyEnv ? Boolean(process.env[chatKeyEnv]) : false;
    const setupRequired = !chatConfigured;

    res.json({
      ok: true,
      status: 'running',
      setup_required: setupRequired,                          // 用于首次启动浏览器引导
      setup: setupRequired
        ? { reason: 'chat_provider_unconfigured', chat_provider: chat?.id, missing_env: chatKeyEnv }
        : null,
      providers: {
        chat: { ...chat, configured: chatConfigured },
        image: getActiveImageProvider(),
        vision: getActiveVisionProvider(),
        asr: getActiveAsrProvider(),
        embedding: getActiveEmbeddingProvider(),
      },
      wechat: getWechatConfigStatus(),
      email: { mode: getEmailMode() },  // resend | dev_stdout
      time: new Date().toISOString(),
    });
  });

  app.use('/api', router);
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'not found' }));
  app.use((error, _req, res, _next) => {
    log('error', `[API] 未捕获异常: ${error.message}`);
    res.status(500).json({ ok: false, error: '服务器内部错误' });
  });

  app.listen(port, '0.0.0.0', () => log('info', `[API] REST 服务已启动 port=${port}`));
  return app;
}
