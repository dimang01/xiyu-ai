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
 * P2A — 导入/导出:
 *   GET    /api/companions/:id/export           导出角色 JSON (?include_memories=1)
 *   POST   /api/companions/import               导入角色 JSON
 *
 * P2A — 成就/里程碑:
 *   GET    /api/companions/:id/achievements     查看成就列表
 *
 * P2A — 事件图谱:
 *   GET    /api/companions/:id/event-graph      获取轻量事件图谱
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
import { getActiveChatProvider, REGISTRY as CHAT_REGISTRY } from './providers/chat.mjs';
import { getActiveImageProvider } from './providers/image.mjs';
import { getActiveVisionProvider, REGISTRY as VISION_REGISTRY } from './providers/vision.mjs';
import { getActiveAsrProvider, REGISTRY as ASR_REGISTRY } from './providers/asr.mjs';
import { getActiveEmbeddingProvider } from './providers/embedding.mjs';
import { downloadImageWithGuards } from './security/netguard.mjs';
import { synthesizeMp3Only } from './voice_pipeline.mjs';
import { recognizeVoice } from './ai.mjs';
import { REGISTRY as TTS_REGISTRY, getTtsStatus } from './providers/tts.mjs';
import { getActiveSearchProvider, REGISTRY as SEARCH_REGISTRY } from './web_search.mjs';
import {
  buildCompanionExport, validateCompanionImport, importCompanionForUser,
  MAX_IMPORT_BYTES,
} from './persona_export.mjs';
import { checkAndUnlockAchievements, getCompanionAchievements, tryAchievement } from './achievements.mjs';
import { getCompanionEventGraph, processMemoryForGraph } from './event_graph.mjs';
import { loadProviderPricing, estimateProviderCost } from './provider_costs.mjs';

// 异步生成元认知（不阻塞主响应）。所有 category 数组扁平化为 facts 列表存表
async function asyncGeneratePersonaFacts(companion) {
  try {
    const data = await generatePersonaFacts(companion);
    if (!data || typeof data !== 'object') {
      log('warn', `[Persona] generate 返回空 companion=${companion.id}`);
      return;
    }
    const facts = [];
    // v1.5.2: 类目 12 → 19（加 neighbors/teachers/first_crush/food_taste/music_taste/place_attachment/worldview）
    for (const cat of [
      'childhood', 'school', 'family', 'neighbors', 'teachers',
      'friends', 'first_crush', 'pets', 'important_events',
      'values', 'love_view', 'fears',
      'food_taste', 'music_taste', 'place_attachment',
      'habits', 'secrets', 'linguistic_quirks', 'worldview',
    ]) {
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
  getOrCreateSingleUserOwner,
  getCompanionTimeline, getStageMilestones,
  savePersonaFacts, getPersonaFacts, hasPersonaFacts,
  getDailySchedule, shanghaiDateKey,
  matchAvatarPresets, countAvatarPresets,
  setAccountBanned, isAccountBanned,
  listAllAccounts, countAllAccounts,
  getAccountUsageSummary, getAccountUsageHistory, getGlobalUsageToday,
  bindWechatAccount, rebindWechatAccount, getWechatAccountByAccountId, getCompanionByAccountId,
  createPendingBindSession, getPendingBindSession,
  findCurrentCompanionForAccount, ensureCompanionBot,
  deleteCompanionForAccount,
  getMemoriesV2, patchMemory, softDeleteMemory, archiveMemory, touchMemory,
  isCompanionOwnedByAccount,
  listPreferences, upsertPreference, deletePreference,  // v1.8.0 #3
  getEmotionState, upsertEmotionState,
  getEmotionHistoryTrend,
  getDiaryEntries, countDiaryEntries,
  getDailyThought, getRecentDailyThoughts,
  getAppSetting, setAppSetting, deleteAppSetting,
} from './db.mjs';
import { MEMORY_LAYERS, MEMORY_STATUSES, MEMORY_SOURCES, normalizeMemoryLayer, normalizeMemoryWeight } from './memory_v2.mjs';
import { getEmotionTrend, getEmotionStateWithDefaults, getMissingLevel, getMissingLabel } from './emotion_state.mjs';
import { generateDailyThoughtForCompanion } from './thoughts.mjs';
import { generateOfflineLetter, renderLetterToText, parseLetterText, verifyLetterSignature } from './letter.mjs';
import {
  insertTimeCapsule, listTimeCapsulesForCompanion, getTimeCapsule, deleteTimeCapsule,
  listRelationalDiariesForCompanion, getRelationalDiaryById, updateRelationalDiaryBody, softDeleteRelationalDiary,
} from './db.mjs';
import { openOneCapsule } from './time_capsule.mjs';
import { generateRelationalDiaryForCompanion } from './relational_diary.mjs';
// v1.9.9 Bug 1：让 dashboard 打开时如果今天日程缺失就立即触发生成
import { ensureScheduleForCompanion } from './plan_tasks.mjs';

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

// v1.10.22: 部署版屏蔽所有 setup/* 写端点和 provider 改动入口，避免用户改自托管 key
function blockIfHosted(_req, res, next) {
  if (String(process.env.HOSTED_MODE || '').toLowerCase() === 'true') {
    return res.status(404).json({ ok: false, message: 'not available' });
  }
  next();
}

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

function requestIp(req) {
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function isLocalhostRequest(req) {
  if (!process.env.TRUST_PROXY && req.get('x-forwarded-for')) return false;
  const ip = requestIp(req);
  return ip === '127.0.0.1' || ip === '::1';
}

function setupTokenMatches(req) {
  // 可选远程初始化令牌：设置 XIYU_SETUP_TOKEN 后，远程请求必须通过 header/body 提供同值 token。
  const expected = process.env.XIYU_SETUP_TOKEN || '';
  if (!expected) return false;
  const provided = req.get('xiyu-setup-token') || req.get('x-setup-token') || req.body?.setup_token || req.body?.token || '';
  if (typeof provided !== 'string') return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

function canAnonymousSetupTest(req) {
  const isLocalMode = (process.env.AUTH_MODE || 'local').toLowerCase() !== 'email';
  let userCount = 0;
  try { userCount = countAllAccounts(); } catch {}
  return isLocalhostRequest(req) && isLocalMode && userCount === 0;
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

function requireOwnedCompanion(req, res, id) {
  const c = getCompanionById(id);
  if (!c) { err(res, 'companion 不存在', 404); return null; }
  if (!isCompanionOwnedByAccount(id, req.authUser.id)) {
    err(res, '无权访问此 companion', 403);
    return null;
  }
  return c;
}

function fallbackText(value, fallback = '') {
  return value === undefined || value === null || value === '' ? fallback : value;
}

// Parse a system prompt string into named sections for the debug panel
function parsePromptSections(prompt) {
  const SECTION_PATTERNS = [
    { key: 'core_persona',       re: /【你叫[\s\S]*?(?=\n【|\n★|\z)/m },
    { key: 'relationship_stage', re: /【当前关系】[\s\S]*?(?=\n【|\n★|\z)/m },
    { key: 'emotion_hint',       re: /【当前情绪状态】[\s\S]*?(?=\n【|\n★|\z)/m },
    { key: 'memory_recall',      re: /【你记得的关于他的片段】[\s\S]*?(?=\n【|\n★|\z)/m },
    { key: 'daily_schedule',     re: /【你今天的安排】[\s\S]*?(?=\n【|\n★|\z)/m },
    { key: 'safety_rules',       re: /【重要规则】[\s\S]*?(?=\n【|\n★|\z)/m },
    { key: 'recent_context',     re: /【最近对话上下文】[\s\S]*?(?=\n【|\n★|\z)/m },
  ];

  const sections = {};
  for (const { key, re } of SECTION_PATTERNS) {
    const m = prompt.match(re);
    sections[key] = m ? m[0].trim().slice(0, 1200) : '';
  }
  return sections;
}

// Strip obvious secret patterns before returning prompt content to the client.
// This is a defence-in-depth measure; ownership is already checked by requireOwnedCompanion.
function redactSecretPatterns(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/sk-proj-[A-Za-z0-9\-_]{20,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9]{10,}/g, '[REDACTED]')
    .replace(/AIza[A-Za-z0-9\-_]{35}/g, '[REDACTED]')
    .replace(/ghp_[A-Za-z0-9]{36}/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9\-_.~+/]{20,}/g, 'Bearer [REDACTED]');
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
    // v1.9.9 Bug 3 修复：之前漏返回这个字段，导致 dashboard slider 始终回默认 10。
    proactive_daily_target: Number.isFinite(Number(companion.proactive_daily_target))
      ? Number(companion.proactive_daily_target)
      : 10,
    sticker_reply_enabled: !!companion.sticker_reply_enabled,
    voice_reply_enabled: !!companion.voice_reply_enabled,
    memory_enabled: companion.memory_enabled !== false,
    // v1.9.10 Bug 5：dashboard 有沉默模式 toggle 但之前漏返回 silent_mode 字段，
    // 用户开了刷新就回关（同 Bug 3 模式）。
    silent_mode: !!companion.silent_mode,
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

// v1.10.0: Cloudflare Turnstile 人机验证（service-side siteverify）
// secret 走 .env，site key 可放前端。失败时返回明确错误，不消耗验证码额度。
// 配置 TURNSTILE_SECRET 后才启用；未配置 → 退回旧行为（不强制人机验证），便于本地 dev。
const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return { ok: true, skipped: true };  // 未配置 secret → 不强制
  if (!token || typeof token !== 'string') {
    return { ok: false, code: 'missing-token', message: '请先完成人机验证' };
  }
  const form = new URLSearchParams();
  form.append('secret', secret);
  form.append('response', token);
  if (remoteIp) form.append('remoteip', remoteIp);
  try {
    const resp = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const json = await resp.json().catch(() => ({}));
    if (json?.success === true) return { ok: true };
    return {
      ok: false,
      code: (json?.['error-codes'] || []).join(',') || 'verify-failed',
      message: '人机验证失败，请重试',
    };
  } catch (e) {
    log('warn', `[Turnstile] siteverify network error: ${e.message}`);
    // 网络故障保守起见放行 OR 拦截？这里选择拦截，避免被绕过。
    return { ok: false, code: 'verify-network-error', message: '人机验证服务暂时不可用，请稍后重试' };
  }
}

// POST /api/auth/send-code
router.post('/auth/send-code',
  rateLimit({ scope: 'send-code', maxPerWindow: 10, windowMs: 60 * 60 * 1000, message: '验证码请求过于频繁，请 1 小时后再试' }),
  async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const purpose = req.body?.purpose || 'login';
  if (!EMAIL_RE.test(email)) return authErr(res, '邮箱格式不正确');
  if (!isValidPurpose(purpose)) return authErr(res, 'purpose 无效');

  // v1.10.0: 先 Turnstile 校验（注册场景必须；secret 未配置时跳过）
  const remoteIp = (req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .toString().split(',')[0].trim();
  const tsToken = typeof req.body?.turnstile_token === 'string' ? req.body.turnstile_token : '';
  const ts = await verifyTurnstile(tsToken, remoteIp);
  if (!ts.ok) {
    log('info', `[API] send-code Turnstile 失败 code=${ts.code} ip=${remoteIp}`);
    return authErr(res, ts.message || '人机验证失败', 400, { turnstile_failed: true });
  }

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

// POST /api/auth/single-user-login (v1.5.1)
// 仅当 SINGLE_USER=true 时可用，无需密码，自动登录 owner 账号。
// 用于自托管单用户场景：本地/内网/已用反代加保护时跳过登录页。
router.post('/auth/single-user-login',
  rateLimit({ scope: 'single-user-login', maxPerWindow: 30, windowMs: 10 * 60 * 1000, message: '请求过于频繁' }),
  (req, res) => {
    const singleUser = String(process.env.SINGLE_USER || '').toLowerCase() === 'true';
    if (!singleUser) {
      return res.status(403).json({ success: false, message: 'SINGLE_USER 模式未开启' });
    }
    try {
      const owner = getOrCreateSingleUserOwner();
      log('info', `[API] single-user 自动登录 user_id=${owner.id} username=${owner.username}`);
      const token = signToken({ id: owner.id, username: owner.username });
      return res.json({ success: true, message: '自动登录成功', user: publicAccount(owner), token });
    } catch (e) {
      log('error', `[API] single-user-login 失败: ${e.message}`);
      return res.status(500).json({ success: false, message: e.message });
    }
  },
);

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

// GET /api/auth/me — 返回当前登录状态（不含 password / secret / API key）
router.get('/auth/me', softAuth, (req, res) => {
  if (!req.authUser) return res.json({ ok: true, data: { authenticated: false } });
  return res.json({
    ok: true,
    data: {
      authenticated: true,
      user: {
        id: req.authUser.id,
        display_name: req.authUser.username || String(req.authUser.id),
      },
    },
  });
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

// v1.3.4: 开源版无 free/pro 区分。两条记录保留是为兼容前端读取，但 free 已和 pro 等价。
const PLAN_LIMITS = {
  free: {
    plan: 'open',
    daily_inbound_messages: -1,
    daily_summary_retention_days: 60,
    weekly_summary: true,
    monthly_summary: true,
    sticker_send: true,
    image_recognition: true,
    voice_recognition: true,
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
// v1.3.4: 开源版无套餐分级；统一返回"开源"plan + 全部功能开放。
// 老前端字段保留兼容（plan/is_pro/limits）。
router.get('/me/plan', requireAuth, (req, res) => {
  const accountId = intId(req.query.user_id ?? req.query.account_id ?? req.get('x-user-id'));
  if (!accountId) return err(res, '缺少 user_id');
  const account = getUserAccountById(accountId);
  if (!account) return err(res, '用户不存在', 404);
  return ok(res, {
    plan: 'open',
    plan_expires_at: null,
    is_pro: true,
    limits: PLAN_LIMITS.pro, // 开源版所有 limits 都按 pro 给（无限）
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
// user_id 来源优先级：query.user_id > query.account_id > x-user-id 头 > req.authUser.id（兜底）
// 微信绑定仅作为附加信息；没绑微信但有 companion 也返回 companion（前端 memories/dashboard 能用）。
router.get('/me/companion', requireAuth, (req, res) => {
  const accountId = intId(
    req.query.user_id ?? req.query.account_id ?? req.get('x-user-id') ?? req.authUser?.id,
  );
  if (!accountId) return authErr(res, '缺少 user_id');

  const account = getUserAccountById(accountId);
  if (!account) return authErr(res, '用户不存在', 404);

  const companion = getCompanionByAccountId(accountId);
  if (!companion) return ok(res, null);

  const binding = getWechatAccountByAccountId(accountId);
  const hasActiveBinding = Boolean(binding?.wechat_user_id && binding?.bot_id && binding.is_active !== 0);

  return ok(res, {
    companion_id: companion.id,
    companion: companionSummary(companion),
    binding: hasActiveBinding ? {
      account_id: binding.account_id,
      wechat_user_id: binding.wechat_user_id,
      bot_id: binding.bot_id,
      companion_id: companion.id,
      bound_at: binding.bound_at,
    } : null,
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

    // v1.10.11 fix: 用 accountId 找当前 companion（对齐 rebindWechatAccount / consumePendingBindSessionForWechat）。
    // 旧实现按 (wechatUserId, botId) 反查 existingCompanion — 但每次扫码 iLink 都会
    // 分到新 bot，老 companion 的 bot_id 还是旧的 → 查不到 → wa.companion_id 写 NULL，
    // companion 与活跃 bot 脱钩，proactive SQL JOIN 不上，主动消息永久静默。
    const currentCompanion = findCurrentCompanionForAccount(db, accountId, botId);
    const companionId = currentCompanion?.id ?? null;

    // 同步 users 表
    db.prepare(`
      INSERT INTO users (wechat_user_id, last_active)
      VALUES (?, CURRENT_TIMESTAMP)
      ON CONFLICT(wechat_user_id) DO UPDATE SET last_active = CURRENT_TIMESTAMP
    `).run(wechatUserId);

    // 把当前 companion 的 bot_id 同步到新 bot（防御性兜底，避免孤儿化）
    ensureCompanionBot(db, companionId, botId);

    // 停用该账号下旧的绑定
    db.prepare(`
      UPDATE wechat_accounts
      SET is_active = 0, updated_at = CURRENT_TIMESTAMP
      WHERE account_id = ? AND is_active = 1
    `).run(accountId);

    // 创建新绑定记录
    db.prepare(`
      INSERT INTO wechat_accounts
        (account_id, user_id, wechat_user_id, bot_id, bot_token, companion_id, login_session_id, is_active, bound_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(accountId, accountId, wechatUserId, botId, botToken, companionId, sessionId);

    // 标记 pending session 成功
    db.prepare(`
      UPDATE pending_bind_sessions
      SET status = 'success',
          wechat_user_id = ?,
          companion_id = ?,
          consumed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(wechatUserId, companionId, sessionId);

    return {
      companionId,
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
router.get('/admin/ilink-status', requireAdmin, (_req, res) => {
  const snapshot = getIlinkStatusSnapshot();
  const accounts = {};
  for (const [botId, status] of Object.entries(snapshot.accounts || {})) {
    const safeStatus = {};
    for (const [name, item] of Object.entries(status || {})) {
      safeStatus[name] = {
        at: item?.at || null,
        ok: Boolean(item?.ok),
        httpStatus: item?.httpStatus ?? item?.err?.httpStatus ?? null,
        ret: item?.ret ?? item?.err?.ret ?? null,
        errcode: item?.errcode ?? item?.err?.errcode ?? null,
        errmsg: typeof (item?.errmsg ?? item?.err?.errmsg) === 'string'
          ? String(item.errmsg ?? item.err.errmsg).slice(0, 80)
          : null,
        count: typeof item?.count === 'number' ? item.count : undefined,
        sessionExpired: Boolean(item?.err?.sessionExpired),
      };
    }
    accounts[maskApiKey(botId)] = safeStatus;
  }
  return ok(res, {
    accounts,
    account_count: Object.keys(accounts).length,
    legacyCredentials: Boolean(snapshot.legacyCredentials),
  });
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
  if (!isCompanionOwnedByAccount(c.id, req.authUser.id)) {
    return err(res, '无权访问此 companion', 403);
  }
  return ok(res, c);
});

// GET /api/companions/:id/summary
router.get('/companions/:id/summary', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  return ok(res, companionSummary(c));
});

// GET /api/companions/:id/persona — 看她的人生背景
router.get('/companions/:id/persona', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
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
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
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
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
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
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
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
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!/^https?:\/\//.test(url)) return err(res, 'url 无效');
  try {
    const { buffer: buf } = await downloadImageWithGuards(url, {
      timeoutMs: 15_000,
      maxBytes: 5 * 1024 * 1024,
      maxRedirects: 3,
    });

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
    return err(res, e.expose ? e.message : '保存失败', e.statusCode || 500);
  }
});

// POST /api/companions/:id/avatar — 上传头像（base64），自动转 512x512 webp
router.post('/companions/:id/avatar', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
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
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  // 同步生成（让前端能 spinner 一下）
  try {
    const data = await generatePersonaFacts(c);
    if (!data) return err(res, '生成失败，请稍后重试', 500);
    const facts = [];
    // v1.5.2: 类目 12 → 19（加 neighbors/teachers/first_crush/food_taste/music_taste/place_attachment/worldview）
    for (const cat of [
      'childhood', 'school', 'family', 'neighbors', 'teachers',
      'friends', 'first_crush', 'pets', 'important_events',
      'values', 'love_view', 'fears',
      'food_taste', 'music_taste', 'place_attachment',
      'habits', 'secrets', 'linguistic_quirks', 'worldview',
    ]) {
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

// ─── Setup Wizard API ─────────────────────────────────────────────────────────

// 辅助：掩码 key，只保留首 4 + 末 4 字符
function maskApiKey(s) {
  if (!s || s.length < 8) return '****';
  return s.slice(0, 4) + '···' + s.slice(-4);
}

// GET /api/setup/status — 轻量状态（不含 secret，给 setup.html 首屏用）
router.get('/setup/status', (_req, res) => {
  const chat = getActiveChatProvider();
  const entry = CHAT_REGISTRY[chat.id];
  const keyEnv = entry?.apiKeyEnv;
  const hasEnvKey  = keyEnv ? Boolean(process.env[keyEnv]) : false;
  const hasDbKey   = keyEnv && !hasEnvKey ? Boolean(getAppSetting(keyEnv)) : false;
  const configured = hasEnvKey || hasDbKey;
  // 是否有至少一个账号（判断系统是否已初始化，只返回布尔值，不返回实际数量）
  let initialized = false;
  try { initialized = countAllAccounts() > 0; } catch {}
  // auth 模式：只返回 'local' 或 'email'，不泄露其他配置
  const authMode = (process.env.AUTH_MODE || 'local').toLowerCase() === 'email' ? 'email' : 'local';
  // v1.5.1: SINGLE_USER 单用户模式 — 跳过登录页，自动注册/复用 owner 账号
  const singleUser = String(process.env.SINGLE_USER || '').toLowerCase() === 'true';
  // v1.10.20: HOSTED_MODE = 部署版（SaaS）。前端不渲染"模型设置"和"开源版"等暴露技术栈的 UI。
  const hostedMode = String(process.env.HOSTED_MODE || '').toLowerCase() === 'true';
  return ok(res, {
    setup_required: !configured,
    chat_provider: hostedMode ? null : chat.id,
    chat_label: hostedMode ? null : chat.label,
    configured,
    source: hostedMode ? null : (hasEnvKey ? 'env' : hasDbKey ? 'app_settings' : 'missing'),
    auth_mode: authMode,
    single_user: singleUser,
    hosted_mode: hostedMode,
    initialized,
  });
});

// GET /api/setup/provider-status — 各 provider 配置状态
// 未登录：只返回 configured 布尔值，不返回 masked_key / source（防信息泄露）
// 已登录：额外返回 masked_key 和 source
router.get('/setup/provider-status', softAuth, (req, res) => {
  // v1.10.20: 部署版（HOSTED_MODE=true）完全屏蔽 provider 状态，避免暴露技术栈
  if (String(process.env.HOSTED_MODE || '').toLowerCase() === 'true') {
    return res.status(404).json({ ok: false, message: 'not available' });
  }
  const isAuthed = Boolean(req.authUser);
  const active = getActiveChatProvider();
  const providers = {};
  for (const [id, entry] of Object.entries(CHAT_REGISTRY)) {
    const envVal  = process.env[entry.apiKeyEnv] || '';
    const dbVal   = envVal ? '' : (getAppSetting(entry.apiKeyEnv) || '');
    const rawKey  = envVal || dbVal;
    // 自定义兼容 provider 需要额外的 base_url + model 状态
    let customBaseURL = '';
    let customModel   = '';
    if (entry.custom) {
      if (entry.baseURLEnv) {
        customBaseURL = process.env[entry.baseURLEnv] || getAppSetting(entry.baseURLEnv) || '';
      }
      if (entry.modelEnv) {
        customModel = process.env[entry.modelEnv] || getAppSetting(entry.modelEnv) || '';
      }
    }
    const configured = entry.custom
      ? Boolean(rawKey && customBaseURL && customModel)
      : Boolean(rawKey);

    if (configured) {
      const info = { configured: true, label: entry.label };
      // 模型预设列表（公开元信息，前端用来 build 下拉），匿名也返回
      if (Array.isArray(entry.models) && entry.models.length) info.models = entry.models;
      if (entry.defaultModel) info.default_model = entry.defaultModel;
      if (isAuthed) {
        info.source     = envVal ? 'env' : 'app_settings';
        info.masked_key = maskApiKey(rawKey);
        if (entry.custom) {
          info.base_url = customBaseURL;
          info.model    = customModel;
        }
      }
      providers[id] = info;
    } else {
      const info = { configured: false, label: entry.label };
      if (Array.isArray(entry.models) && entry.models.length) info.models = entry.models;
      if (entry.defaultModel) info.default_model = entry.defaultModel;
      // 自定义 provider 即使未完全配置，也回显已填部分给已登录用户做编辑
      if (isAuthed && entry.custom) {
        if (customBaseURL) info.base_url = customBaseURL;
        if (customModel)   info.model    = customModel;
        if (rawKey)        info.masked_key = maskApiKey(rawKey);
      }
      providers[id] = info;
    }
  }
  // 当前 CHAT_MODEL override（已登录返回）
  let currentChatModel = '';
  try {
    currentChatModel = process.env.CHAT_MODEL || getAppSetting('CHAT_MODEL') || '';
  } catch {}
  // 附加：可选能力 vision / asr 的当前状态
  // 匿名只返回 enabled + label；已登录额外返回 model + masked_key
  function buildOptionalSection(REG, providerEnvKey, modelEnvKey, active) {
    const items = {};
    for (const [id, entry] of Object.entries(REG)) {
      const rawKey = process.env[entry.apiKeyEnv] || (entry.apiKeyEnv ? getAppSetting(entry.apiKeyEnv) : '') || '';
      const info = { label: entry.label, configured: Boolean(rawKey) };
      if (entry.stub) info.stub = true;
      if (isAuthed && rawKey) info.masked_key = maskApiKey(rawKey);
      items[id] = info;
    }
    return {
      active: active.id,
      active_model: active.model,
      active_configured: Boolean(active.configured),
      extras: active.extras || {},
      providers: items,
    };
  }
  const visionActive = getActiveVisionProvider();
  const asrActive    = getActiveAsrProvider();
  const ttsActive    = getTtsStatus();   // { active, configured, voice_id, ... }
  // 联网搜索 search section（独立结构：无 model 概念，custom provider 是 searxng 用 base URL）
  const searchActive = getActiveSearchProvider();
  const searchProviders = {};
  for (const [id, entry] of Object.entries(SEARCH_REGISTRY)) {
    const envKey = entry.apiKeyEnv ? (process.env[entry.apiKeyEnv] || getAppSetting(entry.apiKeyEnv) || '') : '';
    const baseURL = entry.baseURLEnv ? (process.env[entry.baseURLEnv] || getAppSetting(entry.baseURLEnv) || '') : '';
    const configured = entry.custom ? Boolean(baseURL) : Boolean(envKey);
    const info = { label: entry.label, configured };
    if (entry.custom) info.requires_base_url = true;
    if (entry.note) info.note = entry.note;
    if (isAuthed) {
      if (envKey)  info.masked_key = maskApiKey(envKey);
      if (baseURL) info.base_url   = baseURL;
    }
    searchProviders[id] = info;
  }

  return ok(res, {
    chat_provider: active.id,
    chat_model: active.model || '',
    chat_model_override: isAuthed ? (currentChatModel || null) : null,
    providers,
    vision: buildOptionalSection(VISION_REGISTRY, 'VISION_PROVIDER', 'VISION_MODEL', visionActive),
    asr:    buildOptionalSection(ASR_REGISTRY,    'ASR_PROVIDER',    'ASR_MODEL',    asrActive),
    tts:    {
      active: ttsActive.active || null,
      configured: !!ttsActive.configured,
      label: ttsActive.label || null,
      model: ttsActive.model || null,
      voice_id: ttsActive.voice_id || null,
      extras: ttsActive.extras || {},
      providers: ttsActive.providers || Object.keys(TTS_REGISTRY),
    },
    search: {
      active: searchActive.id,
      active_configured: Boolean(searchActive.configured),
      providers: searchProviders,
    },
  });
});

// POST /api/setup/provider-config — 保存 chat provider + API key（需登录）
router.post('/setup/provider-config',
  blockIfHosted,
  requireAuth,
  async (req, res) => {
    const capability = (req.body?.capability || 'chat').toLowerCase();

    // ── 可选能力：vision / asr / tts ──────────────────────────────────────
    // 字段：{ capability: 'vision'|'asr'|'tts', provider, model?, api_key?, clear? }
    // tts 额外字段：voice_id?
    // 保存：<CAP>_PROVIDER（非 secret） + <CAP>_MODEL（非 secret） +
    //       <entry.apiKeyEnv>（secret，对应 provider 共用 key，如 MINIMAX_API_KEY）
    if (capability === 'vision' || capability === 'asr' || capability === 'tts') {
      const REG = capability === 'vision' ? VISION_REGISTRY
               : capability === 'asr'    ? ASR_REGISTRY
               : TTS_REGISTRY;
      const PROVIDER_KEY = capability === 'vision' ? 'VISION_PROVIDER'
                         : capability === 'asr'    ? 'ASR_PROVIDER'
                         : 'TTS_PROVIDER';
      const MODEL_KEY    = capability === 'vision' ? 'VISION_MODEL'
                         : capability === 'asr'    ? 'ASR_MODEL'
                         : 'TTS_MODEL';
      const { provider, api_key, model, voice_id, extras = {}, clear = false } = req.body || {};
      if (clear) {
        // 仅停用：删 PROVIDER_KEY + MODEL_KEY（让 capability inactive）。
        // 保留 api_key / voice_id / region / appid / cluster，避免误删被其它 capability 复用的字段
        // （如 MiniMax key、Azure region），用户重启用时无需重填。
        deleteAppSetting(PROVIDER_KEY);
        deleteAppSetting(MODEL_KEY);
        log('info', `[Setup] provider-config: ${capability} 已停用（key/extras 保留）`);
        return ok(res, { capability, cleared: true });
      }
      if (!provider || typeof provider !== 'string') return err(res, 'provider 不能为空');
      const pName = provider.toLowerCase().trim();
      if (!REG[pName]) return err(res, `未知 ${capability} provider: ${pName}`);
      const pEntry = REG[pName];
      if (pEntry.stub) return err(res, `${pEntry.label} 当前仅为占位实现`);
      setAppSetting(PROVIDER_KEY, pName, { secret: 0 });
      const trimmedModel = typeof model === 'string' ? model.trim() : '';
      if (trimmedModel) setAppSetting(MODEL_KEY, trimmedModel, { secret: 0 });
      const trimmedKey = typeof api_key === 'string' ? api_key.trim() : '';
      let keySaved = false;
      if (trimmedKey.length >= 8) {
        setAppSetting(pEntry.apiKeyEnv, trimmedKey, { secret: 1 });
        keySaved = true;
        log('info', `[Setup] provider-config: ${capability}/${pName} ${pEntry.apiKeyEnv} 已更新（已隐藏）`);
      }
      // voice_id 只 tts 用；extras 按 entry 声明的 env 字段保存（vision/asr/tts 通用）
      let voiceIdSaved = false;
      const extrasSaved = [];
      if (capability === 'tts') {
        const trimmedVoice = typeof voice_id === 'string' ? voice_id.trim() : '';
        if (trimmedVoice) {
          setAppSetting('TTS_VOICE_ID', trimmedVoice, { secret: 0 });
          voiceIdSaved = true;
        }
      }
      if (pEntry.regionEnv && typeof extras.region === 'string' && extras.region.trim()) {
        setAppSetting(pEntry.regionEnv, extras.region.trim(), { secret: 0 });
        extrasSaved.push('region');
      }
      if (pEntry.appidEnv && typeof extras.appid === 'string' && extras.appid.trim()) {
        setAppSetting(pEntry.appidEnv, extras.appid.trim(), { secret: 0 });
        extrasSaved.push('appid');
      }
      if (pEntry.clusterEnv && typeof extras.cluster === 'string' && extras.cluster.trim()) {
        setAppSetting(pEntry.clusterEnv, extras.cluster.trim(), { secret: 0 });
        extrasSaved.push('cluster');
      }
      return ok(res, {
        capability,
        provider: pName,
        label: pEntry.label,
        model_saved: Boolean(trimmedModel),
        key_saved: keySaved,
        voice_id_saved: voiceIdSaved,
        extras_saved: extrasSaved,
      });
    }

    // ── 联网搜索：capability=search ──────────────────────────────────────
    // 字段：{ capability:'search', provider, api_key?, base_url?, clear? }
    if (capability === 'search') {
      const { provider, api_key, base_url, clear = false } = req.body || {};
      if (clear) {
        deleteAppSetting('SEARCH_PROVIDER');
        log('info', '[Setup] provider-config: search 已清除');
        return ok(res, { capability: 'search', cleared: true });
      }
      if (!provider || typeof provider !== 'string') return err(res, 'provider 不能为空');
      const pName = provider.toLowerCase().trim();
      if (!SEARCH_REGISTRY[pName]) return err(res, `未知 search provider: ${pName}`);
      const pEntry = SEARCH_REGISTRY[pName];
      setAppSetting('SEARCH_PROVIDER', pName, { secret: 0 });

      let keySaved = false;
      let baseUrlSaved = false;
      // SearXNG 自托管：只接受 base URL（http(s)://）
      if (pEntry.custom) {
        if (typeof base_url !== 'string' || !base_url.trim()) {
          return err(res, `${pEntry.label} 需要 base_url`);
        }
        const trimmedBase = base_url.trim();
        if (!/^https?:\/\/[^\s]+$/i.test(trimmedBase)) {
          return err(res, 'base_url 必须是合法的 http(s) URL');
        }
        setAppSetting(pEntry.baseURLEnv, trimmedBase, { secret: 0 });
        baseUrlSaved = true;
      } else {
        // 其它 provider：用 API key
        const trimmedKey = typeof api_key === 'string' ? api_key.trim() : '';
        if (trimmedKey.length >= 8) {
          setAppSetting(pEntry.apiKeyEnv, trimmedKey, { secret: 1 });
          keySaved = true;
          log('info', `[Setup] provider-config: search/${pName} ${pEntry.apiKeyEnv} 已更新（已隐藏）`);
        }
      }
      return ok(res, {
        capability: 'search',
        provider: pName,
        label: pEntry.label,
        key_saved: keySaved,
        base_url_saved: baseUrlSaved,
      });
    }

    // ── Chat（默认）──────────────────────────────────────────────────────
    const { chat_provider, api_key, clear_key = false, base_url, model } = req.body || {};
    if (!chat_provider || typeof chat_provider !== 'string') return err(res, 'chat_provider 不能为空');
    const name = chat_provider.toLowerCase().trim();
    if (!CHAT_REGISTRY[name]) {
      return err(res, `未知 provider: ${name}，可选：${Object.keys(CHAT_REGISTRY).join(', ')}`);
    }
    const entry = CHAT_REGISTRY[name];
    // 保存 CHAT_PROVIDER（非 secret）
    setAppSetting('CHAT_PROVIDER', name, { secret: 0 });
    // 处理 API key
    const trimmedKey = typeof api_key === 'string' ? api_key.trim() : '';
    if (trimmedKey.length >= 8) {
      setAppSetting(entry.apiKeyEnv, trimmedKey, { secret: 1 });
      log('info', `[Setup] provider-config: ${name} API key 已更新（已隐藏）`);
    } else if (clear_key) {
      deleteAppSetting(entry.apiKeyEnv);
      log('info', `[Setup] provider-config: ${name} API key 已清除`);
    }
    // 模型处理：
    //   - openai-compatible: 写到自家的 OPENAI_COMPATIBLE_MODEL（custom path）
    //   - 其它 provider: 写到全局 CHAT_MODEL（chat.mjs activeModel 会读它）
    let baseUrlSaved = false;
    let modelSaved   = false;
    if (entry.custom) {
      if (entry.baseURLEnv && typeof base_url === 'string') {
        const trimmedBase = base_url.trim();
        if (trimmedBase) {
          // 基本校验：必须是 http(s) URL
          if (!/^https?:\/\/[^\s]+$/i.test(trimmedBase)) {
            return err(res, 'base_url 必须是合法的 http(s) URL');
          }
          setAppSetting(entry.baseURLEnv, trimmedBase, { secret: 0 });
          baseUrlSaved = true;
        }
      }
      if (entry.modelEnv && typeof model === 'string') {
        const trimmedModel = model.trim();
        if (trimmedModel) {
          setAppSetting(entry.modelEnv, trimmedModel, { secret: 0 });
          modelSaved = true;
        }
      }
    } else if (typeof model === 'string') {
      // 非 custom provider：model 字段写到全局 CHAT_MODEL，clear 时删除
      const trimmedModel = model.trim();
      if (trimmedModel) {
        setAppSetting('CHAT_MODEL', trimmedModel, { secret: 0 });
        modelSaved = true;
      } else if (model === '' && req.body?.clear_model === true) {
        deleteAppSetting('CHAT_MODEL');
      }
    }
    return ok(res, {
      chat_provider: name,
      label: entry.label,
      key_saved: trimmedKey.length >= 8,
      base_url_saved: baseUrlSaved,
      model_saved: modelSaved,
    });
  },
);

// POST /api/setup/test-provider — 测试指定 provider 连通性
// 允许匿名访问的唯一场景：AUTH_MODE!=email + user_count=0 + 请求来自 localhost
// 其他情况一律 requireAuth
router.post('/setup/test-provider',
  blockIfHosted,
  rateLimit({ scope: 'test-provider', maxPerWindow: 10, windowMs: 60_000, message: '测试过于频繁，请稍后再试' }),
  softAuth,
  async (req, res) => {
    // 权限检查
    if (!req.authUser) {
      // 仅首次本地初始化阶段（user_count=0 + 本地请求 + local 模式）允许匿名
      if (!canAnonymousSetupTest(req)) {
        return res.status(401).json({ ok: false, success: false, message: '请先登录后再测试 Provider 配置' });
      }
    }
    const { provider, capability = 'chat' } = req.body || {};
    if (!provider || typeof provider !== 'string') return err(res, 'provider 不能为空');
    const name = provider.toLowerCase().trim();
    const cap  = String(capability).toLowerCase();

    const REG = cap === 'vision' ? VISION_REGISTRY
              : cap === 'asr'    ? ASR_REGISTRY
              : cap === 'search' ? SEARCH_REGISTRY
              : CHAT_REGISTRY;
    if (!REG[name]) return err(res, `未知 ${cap} provider: ${name}`);

    try {
      let result;
      if (cap === 'vision') {
        const { testVisionProvider } = await import('./providers/vision.mjs');
        result = await testVisionProvider(name);
      } else if (cap === 'asr') {
        const { testAsrProvider } = await import('./providers/asr.mjs');
        result = await testAsrProvider(name);
      } else if (cap === 'search') {
        const { testSearchProvider } = await import('./web_search.mjs');
        result = await testSearchProvider(name);
      } else {
        const { testChatProvider } = await import('./providers/chat.mjs');
        result = await testChatProvider(name);
      }
      return ok(res, result);
    } catch (e) {
      const msg = String(e?.message || 'unknown error').slice(0, 200);
      log('warn', `[Setup] test-provider ${cap}/${name} 失败（已隐藏详情）`);
      return res.status(200).json({ ok: false, error: msg });
    }
  },
);

// POST /api/setup/local-account — 首次本地部署时创建第一个账号
// 仅允许：AUTH_MODE=local 且 user_count=0，默认必须来自 localhost。
// 如需远程初始化，可设置 XIYU_SETUP_TOKEN，并通过 xiyu-setup-token header 或 body.setup_token 传入。
router.post('/setup/local-account',
  blockIfHosted,
  rateLimit({ scope: 'local-account', maxPerWindow: 5, windowMs: 60 * 60 * 1000, message: '操作过于频繁，请稍后再试' }),
  async (req, res) => {
    const authMode = (process.env.AUTH_MODE || 'local').toLowerCase();
    if (authMode === 'email') {
      return res.status(403).json({ ok: false, message: '当前为邮箱登录模式，请前往 /app/auth.html 注册账号' });
    }
    let userCount = 0;
    try { userCount = countAllAccounts(); } catch {}
    if (userCount > 0) {
      return res.status(403).json({ ok: false, message: '系统已完成初始化，请登录现有账号' });
    }
    if (!isLocalhostRequest(req) && !setupTokenMatches(req)) {
      return res.status(403).json({ ok: false, message: '首次初始化仅允许本机访问，或提供有效 setup token' });
    }
    const rawUsername = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password    = typeof req.body?.password === 'string' ? req.body.password        : '';
    const username    = rawUsername.toLowerCase();
    if (!username || username.length < 3 || username.length > 32) {
      return res.status(400).json({ ok: false, message: '用户名须为 3–32 位' });
    }
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(rawUsername)) {
      return res.status(400).json({ ok: false, message: '用户名只能包含字母、数字、下划线（3–32 位）' });
    }
    if (password.length < 6) {
      return res.status(400).json({ ok: false, message: '本地登录密码至少 6 位' });
    }
    try {
      if (getUserAccountByUsername(username)) {
        return res.status(409).json({ ok: false, message: '用户名已存在' });
      }
      const passwordHash = await hashPassword(password);
      // 本地模式不需要真实邮箱；占位邮箱满足 NOT NULL UNIQUE 约束
      const user = createUserAccount({
        username,
        email: `${username}@localhost.local`,
        passwordHash,
        termsVersion: null,
      });
      const token = signToken({ id: user.id, username: user.username });
      log('info', `[API] 本地首次账号已创建 user_id=${user.id}`);
      return res.status(201).json({
        ok: true,
        message: '本地账号创建成功',
        token,
        user: { id: user.id, display_name: user.username },
      });
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ ok: false, message: '用户名已存在' });
      }
      log('error', `[API] local-account 失败: ${e.message}`);
      return res.status(500).json({ ok: false, message: '创建失败，请稍后再试' });
    }
  },
);

// POST /api/setup/test-chat — 给 setup.html 用：用最低 token 数发一次 ping，验证
// 当前 CHAT_PROVIDER + 对应的 API key 是否能跑通。
// 匿名访问仅限首次本机初始化阶段，其他情况必须登录。
router.post('/setup/test-chat',
  blockIfHosted,
  rateLimit({ scope: 'test-chat', maxPerWindow: 10, windowMs: 60_000, message: '测试过于频繁，请稍后再试' }),
  softAuth,
  async (req, res) => {
    if (!req.authUser && !canAnonymousSetupTest(req)) {
      return res.status(401).json({ ok: false, success: false, message: '请先登录后再测试 Chat Provider 配置' });
    }
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
    const c = requireOwnedCompanion(req, res, id); if (!c) return;
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
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  const todayKey = shanghaiDateKey();
  const sched = getDailySchedule(id, todayKey);
  // v1.9.9 Bug 1：今天日程缺失时**异步**触发生成（不 await，避免阻塞响应）。
  // ensureScheduleForCompanion 内部 30 分钟 idempotent cooldown，不会重复发起。
  // 用户下次刷新 dashboard 时通常已生成完毕。
  if (!sched) {
    ensureScheduleForCompanion(id, todayKey).catch(err =>
      log('warn', `[API] today auto-ensure failed companion=${id}: ${err.message}`)
    );
  }
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
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const data = getCompanionTimeline(id, limit);
  if (!data) return err(res, 'companion 不存在', 404);
  return ok(res, data);
});

// GET /api/companions/:id/prompt
router.get('/companions/:id/prompt', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const userProfile = getUserProfile(c.user_id, id);
  const memories    = recallMemories(id, c.user_id, '', 10);
  const recentTurns = getConversationContext(id, 10);
  const prompt = buildSystemPrompt(c, { memories, userProfile, recentTurns });
  return ok(res, { companion_id: id, name: c.name, prompt });
});

// GET /api/companions/:id/context
router.get('/companions/:id/context', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const lim = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const turns = getConversationContext(id, lim);
  return ok(res, { companion_id: id, total: turns.length, turns });
});

// DELETE /api/companions/:id/context
router.delete('/companions/:id/context', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const deleted = clearConversationContext(id);
  log('info', `[API] 清空最近上下文 companion=${id} deleted=${deleted}`);
  return ok(res, { companion_id: id, cleared: true, deleted });
});

// GET /api/companions/:id
router.get('/companions/:id', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
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
  // v1.3.4: 开源版无 companion 数量上限。自托管想加上限可在此处加 hard cap。

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
  const existing = requireOwnedCompanion(req, res, id); if (!existing) return;
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
  const accountId = req.authUser.id;

  // v1.9.6 纵深防御：路由层再做一次所有权检查（deleteCompanionForAccount 内部
  // 也查，但删除这种破坏性操作值得双保险，与其它 /companions/:id/* 路由一致）
  const c = requireOwnedCompanion(req, res, id); if (!c) return;

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
// v1.8.0 #3: companion preferences CRUD（结构化偏好账本）
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/preferences[?type=like|dislike|taboo|neutral]
router.get('/companions/:id/preferences', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  if (!requireOwnedCompanion(req, res, id)) return;
  const type = req.query.type ? String(req.query.type) : null;
  const list = listPreferences(id, { type });
  return ok(res, { items: list });
});

// POST /api/companions/:id/preferences  body: { type, target, intensity?, reason?, source? }
router.post('/companions/:id/preferences', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  if (!requireOwnedCompanion(req, res, id)) return;
  const { type, target, intensity = 3, reason = null, source = 'user' } = req.body || {};
  try {
    upsertPreference({ companionId: id, type, target, intensity: Number(intensity), reason, source: String(source).slice(0,20) });
    return ok(res, { ok: true });
  } catch (e) {
    return err(res, e.message, 400);
  }
});

// DELETE /api/companions/:id/preferences  body: { type, target }
router.delete('/companions/:id/preferences', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  if (!requireOwnedCompanion(req, res, id)) return;
  const { type, target } = req.body || {};
  if (!type || !target) return err(res, 'type & target 必填', 400);
  const changes = deletePreference(id, type, target);
  return ok(res, { deleted: changes });
});

// ─────────────────────────────────────────────────────────────────────────────
// 状态面板
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/status
router.get('/companions/:id/status', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
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
  const c   = requireOwnedCompanion(req, res, id); if (!c) return;
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
  const c     = requireOwnedCompanion(req, res, id); if (!c) return;
  const { scene } = req.body || {};
  if (!scene) return err(res, '缺少 scene 字段');
  const history = [...(c.scene_history || []), { scene: c.current_scene, time: new Date().toISOString() }].slice(-10);
  patchCompanion(id, { current_scene: scene, scene_history: JSON.stringify(history) });
  log('info', `[API] 切换场景 id=${id} → ${scene}`);
  return ok(res, { companion_id: id, current_scene: scene, scene_history: history });
});

// ─── v1.10.0 作息与睡眠 ──────────────────────────────────────────────────────
// GET /api/companions/:id/sleep — 当前作息 + 状态
router.get('/companions/:id/sleep', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  try {
    const { getSleepStatus } = await import('./sleep.mjs');
    return ok(res, getSleepStatus(id));
  } catch (e) {
    log('error', `[Sleep] get failed id=${id}: ${e.message}`);
    return err(res, e.message || '读取失败', 500);
  }
});

// PUT /api/companions/:id/sleep — 用户手动设置作息
//   body: { enabled?: boolean, bed_time?: "HH:MM", wake_time?: "HH:MM", jitter_min?: 0-90 }
router.put('/companions/:id/sleep', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  try {
    const { setUserSchedule, getSleepStatus } = await import('./sleep.mjs');
    setUserSchedule(id, req.body || {});
    log('info', `[Sleep] user set companion=${id} body=${JSON.stringify(req.body)}`);
    return ok(res, getSleepStatus(id));
  } catch (e) {
    log('error', `[Sleep] put failed id=${id}: ${e.message}`);
    return err(res, e.message || '保存失败', 400);
  }
});

// POST /api/companions/:id/sleep/wake — 打电话叫醒
router.post('/companions/:id/sleep/wake', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  try {
    const { wakeUpByCall } = await import('./sleep.mjs');
    const r = wakeUpByCall(id);
    if (!r.ok) return err(res, r.message || '当前不能叫醒', 400);
    // 情绪影响：annoyance/anger 上升，patience 下降
    try {
      const baseAnnoy = 8;
      const baseAnger = 5;
      const extra = Math.min(20, (r.woken_today - 1) * 4);  // 同天多次叫醒线性升级
      upsertEmotionState(id, {});  // 触发 ensureRow
      const { getEmotionState } = await import('./db.mjs');
      const es = getEmotionState(id) || {};
      upsertEmotionState(id, {
        annoyance: Math.min(100, (es.annoyance || 0) + baseAnnoy + extra),
        patience:  Math.max(0,   (es.patience  || 60) - 3 - extra),
        mood: 'tired',
      });
    } catch (e) {
      log('warn', `[Sleep] wake emotion update failed: ${e.message}`);
    }
    // 让 AI 立刻发一条"被吵醒"回执（异步，不阻塞响应）
    (async () => {
      try {
        const { generateReply } = await import('./ai.mjs');
        const { getCompanionById, getBotContextForCompanion, saveConversationTurn } = await import('./db.mjs');
        const { sendTextMessage } = await import('./ilink.mjs');
        const comp = getCompanionById(id);
        if (!comp || !comp.wechat_user_id) return;
        const ctx = getBotContextForCompanion(id);
        if (!ctx?.token) return;
        const sys = `你叫${comp.name || '溪语'}。当前场景：用户刚刚打电话把你从熟睡中吵醒。
你必须以被吵醒的真实反应回复：含糊、不耐烦、抱怨、想再睡，但不骂人。
${r.prompt_hint}`;
        let reply = await generateReply(sys, [], '（铃声响起，你被吵醒）', {
          temperature: 0.85,
          max_tokens: 80,
        });
        reply = (reply || '').replace(/^["「『]+|["」』]+$/g, '').trim();
        if (!reply) reply = '……几点啊';
        for (const seg of reply.split('||').map(s => s.trim()).filter(Boolean).slice(0, 3)) {
          await sendTextMessage(ctx, comp.wechat_user_id, seg, null);
          await new Promise(r => setTimeout(r, 700 + Math.floor(Math.random() * 800)));
        }
        saveConversationTurn(id, 'assistant', reply, '被叫醒');
      } catch (e) {
        log('warn', `[Sleep] wake auto-reply failed companion=${id}: ${e.message}`);
      }
    })();
    return ok(res, { woken_today: r.woken_today, hint: r.prompt_hint });
  } catch (e) {
    log('error', `[Sleep] wake failed id=${id}: ${e.message}`);
    return err(res, e.message || '叫醒失败', 500);
  }
});

// POST /api/companions/:id/sleep/reset-learn — 重置学习期（清空样本，回 observing）
router.post('/companions/:id/sleep/reset-learn', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  try {
    const { resetLearn, getSleepStatus } = await import('./sleep.mjs');
    resetLearn(id);
    log('info', `[Sleep] reset learn companion=${id}`);
    return ok(res, getSleepStatus(id));
  } catch (e) {
    log('error', `[Sleep] reset-learn failed id=${id}: ${e.message}`);
    return err(res, e.message || '重置失败', 500);
  }
});

// v1.10.43: 一次生成 4 张候选自拍 — 让用户挑最满意的一张锁为 reference，
// 避免第一张丑图永久指挥后续生图。
router.post('/companions/:id/visual-identity/generate-candidates', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  try {
    const { generateIdentityCandidates } = await import('./visual_identity_candidates.mjs');
    const companion = getCompanionById(id);
    if (!companion) return err(res, 'companion 不存在', 404);
    const t0 = Date.now();
    const { candidates, errors } = await generateIdentityCandidates(companion);
    log('info', `[API] identity candidates companion=${id} ok=${candidates.length} errs=${errors.length} ${Date.now() - t0}ms`);
    if (candidates.length === 0) return err(res, `候选图全部生成失败: ${errors[0]?.error || 'unknown'}`, 500);
    return ok(res, { candidates, errors });
  } catch (e) {
    log('error', `[API] identity candidates failed id=${id}: ${e.message}`);
    return err(res, e.message || '生成失败', 500);
  }
});

// v1.10.43: 用户选定一张 → 重置旧 identity + 把这张写为 ref_001.png
router.post('/companions/:id/visual-identity/lock', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  const url = String(req.body?.url || '').trim();
  if (!url) return err(res, 'url 缺失');
  try {
    const { saveReferenceImage, resetVisualIdentity } = await import('./visual_identity.mjs');
    let buffer;
    if (url.startsWith('data:image/')) {
      const m = url.match(/^data:image\/[a-z+]+;base64,(.+)$/i);
      if (!m) return err(res, 'invalid data url');
      buffer = Buffer.from(m[1], 'base64');
    } else if (/^https?:\/\//.test(url)) {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) return err(res, `下载失败 HTTP ${resp.status}`, 502);
      buffer = Buffer.from(await resp.arrayBuffer());
    } else {
      return err(res, '不支持的 url 格式');
    }
    if (!buffer || buffer.length < 1024) return err(res, '图片数据无效');
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const tmpPath = path.join(os.tmpdir(), `identity-${id}-${Date.now()}.png`);
    await fs.writeFile(tmpPath, buffer);
    resetVisualIdentity(id);
    const saved = saveReferenceImage(id, tmpPath);
    await fs.unlink(tmpPath).catch(() => {});
    if (!saved) return err(res, '保存 reference 失败', 500);
    log('info', `[API] identity locked companion=${id} bytes=${buffer.length}`);
    return ok(res, { locked: true });
  } catch (e) {
    log('error', `[API] identity lock failed id=${id}: ${e.message}`);
    return err(res, e.message || '锁定失败', 500);
  }
});

// POST /api/companions/:id/reset-to-crush  (v1.4.2)
// 把 companion 一键拉回「她暗恋你」的默认起步状态。
// 影响：affection=35 / stage='暧昧' / mood='shy' / dependency=40。
// 不动：记忆 / 对话历史 / 日记 / 想念记录 —— 历史情感保留。
router.post('/companions/:id/reset-to-crush', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  try {
    patchCompanion(id, { affection_level: 35, relationship_stage: '暧昧', current_mood: '害羞' });
    // 顺手把情绪状态也拨回"暗恋"基线
    upsertEmotionState(id, { mood: 'shy', dependency: 40, affection: 35, trust: 50 });
    log('info', `[API] reset-to-crush id=${id}`);
    return ok(res, { companion_id: id, affection_level: 35, relationship_stage: '暧昧', mood: 'shy' });
  } catch (e) {
    log('error', `[API] reset-to-crush 失败 id=${id}: ${e.message}`);
    return err(res, e.message || '重置失败', 500);
  }
});

// PUT /api/companions/:id/affection
router.put('/companions/:id/affection', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
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
  const c    = requireOwnedCompanion(req, res, id); if (!c) return;
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
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const lim = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const gifts = getCompanionGifts(id, lim);
  return ok(res, { companion_id: id, total: gifts.length, gifts });
});

// POST /api/companions/:id/gifts
router.post('/companions/:id/gifts', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
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
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
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
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const reminders = getReminders(id, req.query.limit);
  return ok(res, { companion_id: id, total: reminders.length, reminders });
});

// GET /api/companions/:id/reminders/due
router.get('/companions/:id/reminders/due', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
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
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
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
  const c   = requireOwnedCompanion(req, res, id); if (!c) return;
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
  const c   = requireOwnedCompanion(req, res, id); if (!c) return;
  const deleted = deleteReminder(id, rid);
  if (!deleted) return err(res, 'reminder 不存在', 404);
  return ok(res, { companion_id: id, reminder_id: rid, deleted: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 长期记忆 v2（Memory Control Panel）
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/memories
// query: layer, status (default 'active'), q, limit, offset
router.get('/companions/:id/memories', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const layer  = req.query.layer  || null;
  const status = req.query.status || 'active';
  const q      = req.query.q     || null;
  const limit  = Math.min(Number(req.query.limit)  || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0,  0);
  if (layer  && !MEMORY_LAYERS.includes(layer))   return err(res, `layer 必须是：${MEMORY_LAYERS.join('/')}`);
  if (status && !['all', ...MEMORY_STATUSES].includes(status)) return err(res, `status 必须是：all/${MEMORY_STATUSES.join('/')}`);
  const effectiveStatus = status === 'all' ? null : status;
  const result = getMemoriesV2(id, { layer, status: effectiveStatus, q, limit, offset });
  return ok(res, result);
});

// POST /api/companions/:id/memories — 手动添加
router.post('/companions/:id/memories', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const { content, memory_layer, memory_type, memory_weight, memory_source = 'user', importance = 5 } = req.body || {};
  if (!content) return err(res, '缺少 content');
  const layer  = normalizeMemoryLayer(memory_layer || memory_type || 'event');
  const weight = normalizeMemoryWeight(memory_weight ?? 3);
  const types  = ['fact','preference','event','emotion','image','daily_summary','weekly_summary','monthly_summary'];
  const legacyType = types.includes(memory_type) ? memory_type : 'fact';
  const source = MEMORY_SOURCES.includes(memory_source) ? memory_source : 'user';
  saveMemory({ companionId: id, userId: c.user_id, memoryType: legacyType, content, importance });
  // Apply v3 fields via patch on the last inserted row
  const db = getDb();
  const row = db.prepare('SELECT id FROM companion_memories WHERE companion_id = ? ORDER BY id DESC LIMIT 1').get(id);
  if (row) patchMemory(row.id, id, { memory_layer: layer, memory_weight: weight, memory_source: source, memory_status: 'active' });
  log('info', `[API] 手动添加记忆 companion=${id} layer=${layer}`);
  // 首次记忆保存成就（静默）
  tryAchievement(id, 'first_memory_saved');
  // 轻量事件图谱（静默）
  // 传入 memory_layer meta 作为快速短路；memoryId 存在时 processMemoryForGraph
  // 还会再做一次 DB 查询校验 sensitive_flag / do_not_mention
  try {
    processMemoryForGraph(id, content, row?.id ?? null, { memory_layer: layer });
  } catch { /* 非阻塞 */ }
  return ok(res, { companion_id: id, memory_layer: layer, content, memory_weight: weight }, 201);
});

// PUT /api/companions/:id/memories/:memoryId — 编辑内容 / 属性
router.put('/companions/:id/memories/:memoryId', requireAuth, (req, res) => {
  const id  = intId(req.params.id);       if (!id)  return err(res, 'id 无效');
  const mid = intId(req.params.memoryId); if (!mid) return err(res, 'memory id 无效');
  const c   = requireOwnedCompanion(req, res, id); if (!c) return;
  const allowed = ['content', 'memory_layer', 'memory_weight', 'importance', 'memory_source'];
  const body = req.body || {};
  const fields = {};
  for (const key of allowed) {
    if (body[key] !== undefined) {
      if (key === 'memory_layer')  fields[key] = normalizeMemoryLayer(body[key]);
      else if (key === 'memory_weight') fields[key] = normalizeMemoryWeight(body[key]);
      else fields[key] = body[key];
    }
  }
  if (Object.keys(fields).length === 0) return err(res, '无可更新字段');
  patchMemory(mid, id, fields);
  log('info', `[API] 更新记忆 companion=${id} mid=${mid}`);
  return ok(res, { updated: true, memory_id: mid, fields });
});

// DELETE /api/companions/:id/memories/:memoryId — 软删除
router.delete('/companions/:id/memories/:memoryId', requireAuth, (req, res) => {
  const id  = intId(req.params.id);       if (!id)  return err(res, 'id 无效');
  const mid = intId(req.params.memoryId); if (!mid) return err(res, 'memory id 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  softDeleteMemory(mid, id);
  log('info', `[API] 软删除记忆 companion=${id} mid=${mid}`);
  return ok(res, { deleted: true, memory_id: mid });
});

// DELETE /api/companions/:id/memories — 清空（软删除 active 状态）
router.delete('/companions/:id/memories', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const db = getDb();
  const changes = db.prepare(
    "UPDATE companion_memories SET memory_status='deleted', updated_at=datetime('now') WHERE companion_id = ? AND COALESCE(memory_status,'active') != 'deleted'"
  ).run(id).changes;
  log('info', `[API] 软清空记忆 companion=${id} changes=${changes}`);
  return ok(res, { companion_id: id, cleared: true, changes });
});

// POST /api/companions/:id/memories/:memoryId/archive
router.post('/companions/:id/memories/:memoryId/archive', requireAuth, (req, res) => {
  const id  = intId(req.params.id);       if (!id)  return err(res, 'id 无效');
  const mid = intId(req.params.memoryId); if (!mid) return err(res, 'memory id 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  archiveMemory(mid, id);
  return ok(res, { archived: true, memory_id: mid });
});

// POST /api/companions/:id/memories/:memoryId/pin
router.post('/companions/:id/memories/:memoryId/pin', requireAuth, (req, res) => {
  const id  = intId(req.params.id);       if (!id)  return err(res, 'id 无效');
  const mid = intId(req.params.memoryId); if (!mid) return err(res, 'memory id 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  patchMemory(mid, id, { pinned: 1 });
  // 首次置顶记忆成就（静默）
  tryAchievement(id, 'first_pinned_memory');
  return ok(res, { pinned: true, memory_id: mid });
});

// POST /api/companions/:id/memories/:memoryId/unpin
router.post('/companions/:id/memories/:memoryId/unpin', requireAuth, (req, res) => {
  const id  = intId(req.params.id);       if (!id)  return err(res, 'id 无效');
  const mid = intId(req.params.memoryId); if (!mid) return err(res, 'memory id 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  patchMemory(mid, id, { pinned: 0 });
  return ok(res, { pinned: false, memory_id: mid });
});

// POST /api/companions/:id/memories/:memoryId/lock
router.post('/companions/:id/memories/:memoryId/lock', requireAuth, (req, res) => {
  const id  = intId(req.params.id);       if (!id)  return err(res, 'id 无效');
  const mid = intId(req.params.memoryId); if (!mid) return err(res, 'memory id 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  patchMemory(mid, id, { locked: 1 });
  return ok(res, { locked: true, memory_id: mid });
});

// POST /api/companions/:id/memories/:memoryId/unlock
router.post('/companions/:id/memories/:memoryId/unlock', requireAuth, (req, res) => {
  const id  = intId(req.params.id);       if (!id)  return err(res, 'id 无效');
  const mid = intId(req.params.memoryId); if (!mid) return err(res, 'memory id 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  patchMemory(mid, id, { locked: 0 });
  return ok(res, { locked: false, memory_id: mid });
});

// POST /api/companions/:id/memories/:memoryId/do-not-mention
router.post('/companions/:id/memories/:memoryId/do-not-mention', requireAuth, (req, res) => {
  const id  = intId(req.params.id);       if (!id)  return err(res, 'id 无效');
  const mid = intId(req.params.memoryId); if (!mid) return err(res, 'memory id 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  const flag = req.body?.flag !== false ? 1 : 0;
  patchMemory(mid, id, { do_not_mention: flag });
  return ok(res, { do_not_mention: !!flag, memory_id: mid });
});

// ─────────────────────────────────────────────────────────────────────────────
// 用户画像
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/user-profile
router.get('/companions/:id/user-profile', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const profile = getUserProfile(c.user_id, id);
  return ok(res, profile || {});
});

// PUT /api/companions/:id/user-profile
router.put('/companions/:id/user-profile', requireAuth, (req, res) => {
  const id   = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c    = requireOwnedCompanion(req, res, id); if (!c) return;
  const data = req.body || {};
  if (Object.keys(data).length === 0) return err(res, '请求体为空');
  const profile = upsertUserProfile(c.user_id, id, data);
  log('info', `[API] 更新用户画像 companion=${id}`);
  return ok(res, profile);
});

// ─────────────────────────────────────────────────────────────────────────────
// 情绪趋势
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/emotion-trend?days=7
router.get('/companions/:id/emotion-trend', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
  const points = getEmotionTrend(id, { days });
  return ok(res, { days, points });
});

// GET /api/companions/:id/diary?limit=30&offset=0&kind=daily|weekly
// 「她的日记」只读视图。日记由 plan_tasks 的每日/每周 cron 自动生成（src/diary.mjs）。
router.get('/companions/:id/diary', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const limit  = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const kind   = (req.query.kind === 'daily' || req.query.kind === 'weekly') ? req.query.kind : null;
  const entries = getDiaryEntries(id, { limit, offset, kind });
  const total   = countDiaryEntries(id, { kind });
  return ok(res, { total, limit, offset, kind: kind || 'all', entries });
});

// GET /api/me/capabilities  (v1.4.2)
// 给前端 dashboard/playground/diary 用的"哪些能力可用"轻量查询。
// 不暴露 key 任何片段，只返 boolean。
router.get('/me/capabilities', requireAuth, (_req, res) => {
  const tts = getTtsStatus();
  return ok(res, {
    tts:    !!tts.configured,
    voice_id: tts.voice_id || null,
    // 其它能力按需扩展（vision/asr/search 各自有专门状态接口，前端按需查）
  });
});

// GET /api/companions/:id/daily-thought  (v1.4.1)
// 返回「今天她想对你说的话」+ 实时算出的想念档（meter）
// 没有今日记录时，自愈触发一次生成（异步，不阻塞此次返回）。
router.get('/companions/:id/daily-thought', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;

  const tz = 'Asia/Shanghai';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());

  const thought = getDailyThought(id, today);
  const emotion = getEmotionStateWithDefaults(id);
  const missingLevel = getMissingLevel(emotion, c.last_user_reply_at);
  const recent = getRecentDailyThoughts(id, 7);

  // 自愈：今日还没有 thought 时（首次安装 / cron 没跑到 / 新建 companion），
  // 后台异步生成一次。当前请求仍按现状返回（thought 可能为 null）。
  if (!thought) {
    generateDailyThoughtForCompanion(id, { dateKey: today })
      .catch(e => log('warn', `[API] daily-thought 自愈生成失败 companion=${id}: ${e.message}`));
  }

  return ok(res, {
    today,
    thought: thought || null,
    missing: {
      level: missingLevel,
      label: getMissingLabel(missingLevel),
      dependency: emotion.dependency ?? 30,
      mood: emotion.mood || 'neutral',
    },
    recent_thoughts: recent,
  });
});

// POST /api/companions/:id/daily-thought/regenerate  (v1.4.1, dev/手动用)
// 强制生成今日的 thought（force=true 覆盖现有）。
router.post('/companions/:id/daily-thought/regenerate', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  try {
    const r = await generateDailyThoughtForCompanion(id, { force: true });
    return ok(res, r);
  } catch (e) {
    return err(res, e.message || 'thought 生成失败', 500);
  }
});

// POST /api/companions/:id/tts-preview  (v1.4.0 Sprint 1)
// body: { text: string }    text 长度限 100 字符
// query: ?voice_id=...      可选覆盖（让 dashboard 试听任意音色）
// 返回：audio/mpeg 字节流 (mp3)。不返 SILK——浏览器试听用 mp3 简单。
// SILK 转码留给微信路径（Sprint 2 才接进 proactive）。
router.post('/companions/:id/tts-preview', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const text = String(req.body?.text || '').trim();
  if (!text) return err(res, '缺少 text');
  if (text.length > 100) return err(res, 'text 最长 100 字符');
  const voice_id = req.query.voice_id || c.voice_id || undefined; // 让 provider 自取默认
  const speed = c.voice_speed || 1.0;
  try {
    const { mp3 } = await synthesizeMp3Only(text, { voice_id, speed });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', mp3.length);
    return res.status(200).end(mp3);
  } catch (e) {
    log('warn', `[API] tts-preview 失败 companion=${id}: ${e.message}`);
    return err(res, e.message || 'TTS 调用失败', 500);
  }
});

// POST /api/companions/:id/asr-transcribe  (v1.4.0 Sprint 2.5)
// body: { audio_base64: string, mime: 'audio/webm' | 'audio/ogg' | 'audio/mp4' | ... }
// → { ok: true, data: { text: '识别出的中文文本' } }
// 用于 playground 录音 → 识别 → 当普通文本继续走 playground-chat。
router.post('/companions/:id/asr-transcribe', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const b64 = String(req.body?.audio_base64 || '').trim();
  const mime = String(req.body?.mime || 'audio/webm').toLowerCase();
  if (!b64) return err(res, '缺少 audio_base64');
  let buf;
  try { buf = Buffer.from(b64, 'base64'); }
  catch { return err(res, 'audio_base64 解码失败'); }
  if (!buf.length || buf.length > 1.5 * 1024 * 1024) {
    return err(res, '音频过大或为空（≤1.5MB / ≤60s 建议）');
  }
  try {
    const text = await recognizeVoice(buf, mime);
    return ok(res, { text: (text || '').trim() });
  } catch (e) {
    log('warn', `[API] asr-transcribe 失败 companion=${id}: ${e.message}`);
    return err(res, e.message || 'ASR 调用失败', 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Debug Panel
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/prompt-debug
router.get('/companions/:id/prompt-debug', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;

  // 普通用户只能查看自己的 companion prompt（已由 requireOwnedCompanion 保证）
  try {
    const memories      = recallMemories(id, c.user_id, '', 10);
    const userProfile   = getUserProfile(c.user_id, id);
    const recentTurns   = getConversationContext(id, 6);
    const personaFacts  = getPersonaFacts(id);
    const dateKey       = shanghaiDateKey();
    const dailySchedule = getDailySchedule(id, dateKey);

    const fullPrompt = buildSystemPrompt(c, {
      memories, userProfile, recentTurns, personaFacts, dailySchedule,
    });

    // Parse the full prompt into labeled sections for the debug UI
    const sections = parsePromptSections(fullPrompt);
    const safePrompt = redactSecretPatterns(fullPrompt);

    return ok(res, {
      sections,
      full_prompt: safePrompt,
      redacted: true,
      warning: '调试用途 — 包含角色设定和记忆摘要，请勿分享。',
    });
  } catch (e) {
    log('error', `[API] prompt-debug 失败 companion=${id}: ${e.message}`);
    return err(res, 'prompt-debug 生成失败', 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 用户 AI 用量（自查）
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/me/ai-usage?days=7
router.get('/me/ai-usage', requireAuth, (req, res) => {
  noStore(res);
  const accountId = req.authUser.id;
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));

  const history = getAccountUsageHistory(accountId, days);
  const totals = history.reduce((acc, row) => {
    acc.prompt_tokens     += row.prompt_tokens     || 0;
    acc.completion_tokens += row.completion_tokens || 0;
    acc.message_count     += row.message_count     || 0;
    return acc;
  }, { prompt_tokens: 0, completion_tokens: 0, message_count: 0 });

  const pricing = loadProviderPricing();
  const providerName = (process.env.CHAT_PROVIDER || 'unknown').toLowerCase();
  const { estimated_cost, currency } = estimateProviderCost({
    provider: providerName,
    model_type: 'chat',
    prompt_tokens: totals.prompt_tokens,
    completion_tokens: totals.completion_tokens,
  }, pricing);

  return ok(res, {
    days,
    totals: {
      prompt_tokens:     totals.prompt_tokens,
      completion_tokens: totals.completion_tokens,
      total_tokens:      totals.prompt_tokens + totals.completion_tokens,
      message_count:     totals.message_count,
      estimated_cost,
      currency,
    },
    by_day: history,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2A: Persona Export / Import
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/export
router.get('/companions/:id/export', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  try {
    const includeMemories = req.query.include_memories === '1';
    const payload = buildCompanionExport(id, { includeMemories });
    noStore(res);
    return ok(res, payload);
  } catch (e) {
    if (e.status === 404) return err(res, '角色不存在', 404);
    log('error', `[API] export 失败 companion=${id}: ${e.message}`);
    return err(res, '导出失败', 500);
  }
});

// POST /api/companions/import
router.post('/companions/import', requireAuth, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return err(res, '请求体无效');

  // Size guard
  const rawSize = Buffer.byteLength(JSON.stringify(body));
  if (rawSize > MAX_IMPORT_BYTES) return err(res, `导入文件过大（最大 ${MAX_IMPORT_BYTES / 1024} KB）`, 413);

  const validation = validateCompanionImport(body);
  if (!validation.valid) return err(res, `导入格式无效: ${validation.error}`, 400);

  const accountId = req.authUser.id;

  // Resolve userId via wechat binding; fall back to using accountId as userId
  // (same pattern used by getCompanionByAccountId which joins c.user_id = wa.account_id)
  const binding = getWechatAccountByAccountId(accountId);
  const userId = binding
    ? (getDb().prepare('SELECT id FROM users WHERE wechat_user_id = ? LIMIT 1').get(binding.wechat_user_id)?.id ?? accountId)
    : accountId;

  const botId = binding?.bot_id || `imported_${accountId}_${Date.now()}`;

  try {
    const importMemories = req.query.include_memories === '1';
    const result = await importCompanionForUser(userId, accountId, botId, body, { importMemories });
    log('info', `[API] 导入角色 account=${accountId} new_companion=${result.companionId}`);
    return ok(res, { companion_id: result.companionId });
  } catch (e) {
    log('error', `[API] import 失败 account=${accountId}: ${e.message}`);
    return err(res, '导入失败', 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P2A: Achievements / Milestones
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/achievements
router.get('/companions/:id/achievements', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const achievements = getCompanionAchievements(id);
  return ok(res, { achievements });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2A: Event Graph
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/event-graph
router.get('/companions/:id/event-graph', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const options = {
    limit: parseInt(req.query.limit, 10) || 100,
    entityType: req.query.entity_type,
  };
  try {
    const graph = getCompanionEventGraph(id, options);
    return ok(res, graph);
  } catch (e) {
    log('error', `[API] event-graph 失败 companion=${id}: ${e.message}`);
    return err(res, '获取事件图谱失败', 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.6 PR I: 3 个月模拟时间线 backfill
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/backfill-status
router.get('/companions/:id/backfill-status', requireAuth, async (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const { getCompanionBackfillStatus } = await import('./db.mjs');
  return ok(res, getCompanionBackfillStatus(id));
});

// POST /api/companions/:id/backfill-history
// body: { days_back?: number, event_count?: number, force?: boolean }
router.post('/companions/:id/backfill-history',
  rateLimit({ scope: 'backfill-history', maxPerWindow: 3, windowMs: 24 * 60 * 60 * 1000, message: '每日最多生成 3 次' }),
  requireAuth,
  async (req, res) => {
    const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
    const c  = requireOwnedCompanion(req, res, id); if (!c) return;
    const daysBack   = Number(req.body?.days_back) || 90;
    const eventCount = Number(req.body?.event_count) || 35;
    const force      = !!req.body?.force;
    try {
      const { backfillTimelineForCompanion } = await import('./backfill_history.mjs');
      const r = await backfillTimelineForCompanion(c, {
        daysBack, eventCount, force,
        accountId: req.authUser?.id || null,
      });
      if (r.error) return err(res, r.error, 500);
      if (r.skipped === 'already-backfilled' && !force) {
        return err(res, '已经生成过历史时间线了，加 force=true 可覆盖重生', 409);
      }
      return ok(res, r);
    } catch (e) {
      log('error', `[API] backfill-history failed companion=${id}: ${e.message}`);
      return err(res, e.message || '生成失败', 500);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// v1.5: 离线留言胶囊（offline letter）
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/companions/:id/offline-letter
// body: { hint?: string }   ← 可选，用户想让她提到的事
// 返回 .txt 文件流（Content-Type: text/plain; charset=utf-8 + Content-Disposition: attachment）
router.post('/companions/:id/offline-letter',
  rateLimit({ scope: 'offline-letter', maxPerWindow: 10, windowMs: 60 * 60 * 1000, message: '生成过于频繁，请稍后再试' }),
  requireAuth,
  async (req, res) => {
    const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
    const c  = requireOwnedCompanion(req, res, id); if (!c) return;
    const hint = typeof req.body?.hint === 'string' ? req.body.hint.slice(0, 200) : '';
    try {
      const letter = await generateOfflineLetter(c, { hint, accountId: req.authUser?.id || null });
      const hostHint = req.get('host') ? `${req.protocol}://${req.get('host')}` : '';
      const text = renderLetterToText(letter, { hostHint });
      const filename = `xiyu-letter-${c.id}-${letter.issued}.txt`;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      log('info', `[API] offline-letter ok companion=${id} len=${letter.body.length}`);
      return res.send(text);
    } catch (e) {
      log('warn', `[API] offline-letter 失败 companion=${id}: ${e.message}`);
      return err(res, e.message || '生成失败', 500);
    }
  },
);

// POST /api/verify-letter   （独立，无需登录 — 任何人拿信件都能来验真）
// body: { text: string }   或   { companion_id, issued, body, signature }
// 返回 { valid: boolean, companion?: { id, name }, issued?, issued_human? }
router.post('/verify-letter',
  rateLimit({ scope: 'verify-letter', maxPerWindow: 30, windowMs: 60 * 60 * 1000, message: '验证过于频繁，请稍后再试' }),
  (req, res) => {
    let { companion_id, issued, body, signature, text } = req.body || {};
    if (text && typeof text === 'string') {
      const parsed = parseLetterText(text);
      if (!parsed) return ok(res, { valid: false, reason: '无法解析文本：缺少签名段或正文分隔符' });
      companion_id = parsed.companionId;
      issued = parsed.issued;
      body = parsed.body;
      signature = parsed.signature;
    }
    if (!companion_id || !issued || !body || !signature) {
      return err(res, '缺少必填字段（text 或 companion_id+issued+body+signature）');
    }
    const valid = verifyLetterSignature({ companionId: Number(companion_id), issued: Number(issued), body, signature });
    let companion = null;
    if (valid) {
      try {
        const row = getDb().prepare('SELECT id, name FROM companions WHERE id = ?').get(Number(companion_id));
        if (row) companion = { id: row.id, name: row.name };
      } catch { /* ignore */ }
    }
    return ok(res, {
      valid,
      companion,
      issued: Number(issued),
      issued_human: new Date(Number(issued) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// v1.5: 时光胶囊（time capsule）
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/time-capsules?status=all|pending|opened
router.get('/companions/:id/time-capsules', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const status = ['all', 'pending', 'opened'].includes(req.query.status) ? req.query.status : 'all';
  try {
    const rows = listTimeCapsulesForCompanion(id, { status });
    return ok(res, { capsules: rows, status });
  } catch (e) {
    log('error', `[API] time-capsules list failed companion=${id}: ${e.message}`);
    return err(res, '加载失败', 500);
  }
});

// POST /api/companions/:id/time-capsules
// body: { body: string (≤2000), title?: string (≤80), unlock_at: number (seconds, future) }
router.post('/companions/:id/time-capsules',
  rateLimit({ scope: 'time-capsule-create', maxPerWindow: 20, windowMs: 60 * 60 * 1000, message: '创建过于频繁，请稍后再试' }),
  requireAuth,
  (req, res) => {
    const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
    const c  = requireOwnedCompanion(req, res, id); if (!c) return;
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 80) : null;
    const unlockAtRaw = Number(req.body?.unlock_at);
    if (body.length < 5) return err(res, '内容太短（至少 5 字）');
    if (body.length > 2000) return err(res, '内容过长（最多 2000 字）');
    if (!Number.isFinite(unlockAtRaw) || unlockAtRaw <= 0) return err(res, 'unlock_at 无效');
    const nowSec = Math.floor(Date.now() / 1000);
    if (unlockAtRaw <= nowSec + 60) return err(res, '解锁时间必须在未来（至少 1 分钟后）');
    // 上限：100 年（防止数值溢出 / 误填）
    if (unlockAtRaw > nowSec + 100 * 365 * 86400) return err(res, '解锁时间不能超过 100 年后');
    try {
      const row = insertTimeCapsule({
        userId: req.authUser.id,
        companionId: id,
        body, title,
        unlockAt: unlockAtRaw,
      });
      log('info', `[API] time-capsule created id=${row.id} companion=${id} unlock-in=${unlockAtRaw - nowSec}s`);
      return ok(res, { capsule: row });
    } catch (e) {
      log('error', `[API] time-capsule create failed: ${e.message}`);
      return err(res, '保存失败', 500);
    }
  },
);

// DELETE /api/companions/:id/time-capsules/:capsuleId  —— 只能删未开封的
router.delete('/companions/:id/time-capsules/:capsuleId', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const cid = intId(req.params.capsuleId); if (!cid) return err(res, 'capsuleId 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  const capsule = getTimeCapsule(cid);
  if (!capsule || capsule.companion_id !== id) return err(res, '胶囊不存在', 404);
  if (capsule.opened_at) return err(res, '已开封的胶囊不能删除（属于历史回忆）');
  const ok2 = deleteTimeCapsule(cid, req.authUser.id);
  if (!ok2) return err(res, '删除失败（可能已被他人操作）', 409);
  return ok(res, { deleted: true });
});

// POST /api/companions/:id/time-capsules/:capsuleId/open-now  —— 强制立即解封
// 用于"等不及，让她现在就看"。严格限速防滥用。
router.post('/companions/:id/time-capsules/:capsuleId/open-now',
  rateLimit({ scope: 'time-capsule-open-now', maxPerWindow: 5, windowMs: 60 * 60 * 1000, message: '强制解封过于频繁' }),
  requireAuth,
  async (req, res) => {
    const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
    const cid = intId(req.params.capsuleId); if (!cid) return err(res, 'capsuleId 无效');
    const c = requireOwnedCompanion(req, res, id); if (!c) return;
    const capsule = getTimeCapsule(cid);
    if (!capsule || capsule.companion_id !== id) return err(res, '胶囊不存在', 404);
    if (capsule.opened_at) return err(res, '已经打开过了', 409);
    try {
      const r = await openOneCapsule(capsule, { accountId: req.authUser.id });
      if (r.status === 'error') return err(res, r.error || '生成失败', 500);
      const updated = getTimeCapsule(cid);
      return ok(res, { capsule: updated });
    } catch (e) {
      log('error', `[API] time-capsule open-now failed id=${cid}: ${e.message}`);
      return err(res, e.message || '开封失败', 500);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// v1.5: 反向日记（relational diary）
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companions/:id/relational-diary?limit=30
router.get('/companions/:id/relational-diary', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const c  = requireOwnedCompanion(req, res, id); if (!c) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200);
  try {
    const entries = listRelationalDiariesForCompanion(id, { limit });
    return ok(res, { entries });
  } catch (e) {
    log('error', `[API] relational-diary list failed companion=${id}: ${e.message}`);
    return err(res, '加载失败', 500);
  }
});

// PUT /api/companions/:id/relational-diary/:diaryId
// body: { body: string }
router.put('/companions/:id/relational-diary/:diaryId', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const did = intId(req.params.diaryId); if (!did) return err(res, 'diaryId 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (body.length < 10) return err(res, '内容太短（至少 10 字）');
  if (body.length > 1500) return err(res, '内容过长（最多 1500 字）');
  const ok2 = updateRelationalDiaryBody(did, id, body);
  if (!ok2) return err(res, '未找到该日记或已被删除', 404);
  return ok(res, { entry: getRelationalDiaryById(did) });
});

// DELETE /api/companions/:id/relational-diary/:diaryId  （软删）
router.delete('/companions/:id/relational-diary/:diaryId', requireAuth, (req, res) => {
  const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
  const did = intId(req.params.diaryId); if (!did) return err(res, 'diaryId 无效');
  const c = requireOwnedCompanion(req, res, id); if (!c) return;
  const ok2 = softDeleteRelationalDiary(did, id);
  if (!ok2) return err(res, '未找到该日记或已被删除', 404);
  return ok(res, { deleted: true });
});

// POST /api/companions/:id/relational-diary/regenerate
// body: { date_key?: 'YYYY-MM-DD' }   默认昨天；强制重生（绕过 exists 检查）
router.post('/companions/:id/relational-diary/regenerate',
  rateLimit({ scope: 'rel-diary-regen', maxPerWindow: 5, windowMs: 60 * 60 * 1000, message: '重新生成过于频繁' }),
  requireAuth,
  async (req, res) => {
    const id = intId(req.params.id); if (!id) return err(res, 'id 无效');
    const c  = requireOwnedCompanion(req, res, id); if (!c) return;
    const dateKey = typeof req.body?.date_key === 'string' ? req.body.date_key.trim() : null;
    try {
      const r = await generateRelationalDiaryForCompanion(id, {
        dateKey, force: true,
        accountId: req.authUser?.id || null,
      });
      if (r.error) return err(res, r.error, 500);
      if (r.skipped) return err(res, '跳过：' + r.skipped, 409);
      return ok(res, { entry: r.entry });
    } catch (e) {
      log('error', `[API] relational-diary regen failed companion=${id}: ${e.message}`);
      return err(res, e.message || '生成失败', 500);
    }
  },
);

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

// v1.9.11: GET /api/admin/user-profile/:account_id?with_llm=1
// 综合用户画像：SQL 维度 + 关键词频率 + 可选 LLM 推断
// ⚠️ 仅 admin 自查工具。LLM 推断结果不持久化，每次调用实时算。
// 见 src/user_profile.mjs 顶部伦理边界说明 + SECURITY.md "数据敏感性"
router.get('/admin/user-profile/:account_id', requireAdmin, async (req, res) => {
  const accountId = intId(req.params.account_id);
  if (!accountId) return err(res, 'account_id 无效');
  const account = getUserAccountById(accountId);
  if (!account) return err(res, '账号不存在', 404);
  const withLlm = req.query.with_llm === '1' || req.query.with_llm === 'true';
  try {
    const { computeFullProfile } = await import('./user_profile.mjs');
    const profile = await computeFullProfile(accountId, { withLlm });
    return ok(res, {
      account: {
        id: account.id,
        username: account.username,
        email: account.email,
        created_at: account.created_at,
        is_banned: !!account.is_banned,
      },
      ...profile,
    });
  } catch (e) {
    log('error', `[Admin] user-profile failed account=${accountId}: ${e.message}`);
    return err(res, e.message || '画像生成失败', 500);
  }
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

// GET /api/admin/stats/ai-usage?days=7
router.get('/admin/stats/ai-usage', requireAdmin, (req, res) => {
  noStore(res);
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
  const db = getDb();
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT account_id, day,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(message_count) AS message_count
    FROM ai_usage_daily
    WHERE day >= ?
    GROUP BY account_id, day
    ORDER BY day DESC
    LIMIT 500
  `).all(since);

  const totals = rows.reduce((acc, r) => {
    acc.prompt_tokens     += r.prompt_tokens     || 0;
    acc.completion_tokens += r.completion_tokens || 0;
    acc.message_count     += r.message_count     || 0;
    return acc;
  }, { prompt_tokens: 0, completion_tokens: 0, message_count: 0 });

  return ok(res, {
    days,
    totals: {
      prompt_tokens:     totals.prompt_tokens,
      completion_tokens: totals.completion_tokens,
      total_tokens:      totals.prompt_tokens + totals.completion_tokens,
      message_count:     totals.message_count,
      estimated_cost:    null,
    },
    by_day: rows,
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

  if (process.env.TRUST_PROXY) {
    app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 'loopback' : process.env.TRUST_PROXY);
  }

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
