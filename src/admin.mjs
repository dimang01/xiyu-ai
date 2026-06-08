/**
 * 管理员认证模块
 *
 * - 首次启动自动生成 20 位随机密码，写入 .admin-credentials（mode 0600）
 * - 用户名固定为 'admin'
 * - 登录后下发 30 分钟有效的 admin JWT（与普通用户 token 区分：payload.role = 'admin'）
 * - requireAdmin 中间件校验 token 并注入 req.adminUser
 *
 * 查看密码：cat ./.admin-credentials（项目根目录）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.mjs';

const CRED_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.admin-credentials',
);
const SECRET_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.admin-secret',
);
const TOKEN_TTL_MS = 30 * 60 * 1000;
const PASSWORD_LEN = 20;
const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // 去掉易混淆字符

let SECRET = null;
function getSecret() {
  if (SECRET) return SECRET;
  if (existsSync(SECRET_FILE)) {
    SECRET = readFileSync(SECRET_FILE, 'utf-8').trim();
    if (SECRET.length >= 32) return SECRET;
  }
  SECRET = crypto.randomBytes(48).toString('hex');
  try {
    writeFileSync(SECRET_FILE, SECRET, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(SECRET_FILE, 0o600);
  } catch (e) {
    log('warn', `[Admin] 写 admin secret 失败: ${e.message}`);
  }
  return SECRET;
}

function generatePassword(len = PASSWORD_LEN) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += PASSWORD_CHARS[bytes[i] % PASSWORD_CHARS.length];
  }
  return out;
}

// admin 密码 scrypt 哈希（P0：.admin-credentials 不再明文存密码）
function hashPassword(password, salt = crypto.randomBytes(16)) {
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'hex');
  return { saltHex: saltBuf.toString('hex'), hashHex: crypto.scryptSync(String(password), saltBuf, 32).toString('hex') };
}
function verifyPassword(password, saltHex, hashHex) {
  try {
    const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32);
    const want = Buffer.from(hashHex, 'hex');
    return hash.length === want.length && crypto.timingSafeEqual(hash, want);
  } catch { return false; }
}

/**
 * 读取或初始化管理员凭据。返回 { username, salt, hash }。
 * 没有凭据文件时自动生成并打印一次明文密码到日志；旧明文凭据自动升级为 scrypt 哈希（密码不变）。
 */
export function loadAdminCredentials() {
  if (existsSync(CRED_FILE)) {
    const raw = readFileSync(CRED_FILE, 'utf-8').trim();
    const parts = raw.split(':');
    // 新格式：username:scrypt:salt:hash
    if (parts.length === 4 && parts[1] === 'scrypt') {
      return { username: parts[0], salt: parts[2], hash: parts[3] };
    }
    // 旧明文格式 username:password → 自动升级为 scrypt 哈希（密码不变，用户继续用原密码登录）
    if (parts.length === 2 && parts[0] && parts[1]) {
      const { saltHex, hashHex } = hashPassword(parts[1]);
      try {
        writeFileSync(CRED_FILE, `${parts[0]}:scrypt:${saltHex}:${hashHex}`, { encoding: 'utf-8', mode: 0o600 });
        chmodSync(CRED_FILE, 0o600);
        log('info', '[Admin] 凭据已从明文升级为 scrypt 哈希（密码不变，仍用原密码登录）');
      } catch (e) { log('warn', `[Admin] 哈希升级写入失败: ${e.message}`); }
      return { username: parts[0], salt: saltHex, hash: hashHex };
    }
    log('warn', `[Admin] 凭据文件格式损坏，将重新生成`);
  }
  const username = 'admin';
  const password = generatePassword();
  const { saltHex, hashHex } = hashPassword(password);
  try {
    writeFileSync(CRED_FILE, `${username}:scrypt:${saltHex}:${hashHex}`, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(CRED_FILE, 0o600);
    log('info', '======================================================');
    log('info', '  [Admin] 已生成管理员凭据：');
    log('info', `  username: ${username}`);
    log('info', `  password: ${password}`);
    log('info', `  文件位置：${CRED_FILE}（仅存哈希）`);
    log('info', '  请妥善保存此密码，登录后无法找回（可重新生成）');
    log('info', '======================================================');
  } catch (e) {
    log('error', `[Admin] 无法写入凭据文件: ${e.message}`);
  }
  return { username, salt: saltHex, hash: hashHex };
}

/**
 * 重新生成管理员密码并写回文件。返回新密码。
 */
export function regenerateAdminPassword() {
  const current = loadAdminCredentials();
  const newPassword = generatePassword();
  const { saltHex, hashHex } = hashPassword(newPassword);
  writeFileSync(CRED_FILE, `${current.username}:scrypt:${saltHex}:${hashHex}`, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(CRED_FILE, 0o600);
  log('info', `[Admin] 管理员密码已重新生成`);
  return newPassword;
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64uDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function signAdminToken(payload = {}, ttlMs = TOKEN_TTL_MS) {
  const body = { ...payload, role: 'admin', iat: Date.now(), exp: Date.now() + ttlMs };
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = b64u(JSON.stringify(body));
  const sig = b64u(crypto.createHmac('sha256', getSecret()).update(`${head}.${data}`).digest());
  return `${head}.${data}.${sig}`;
}

export function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, data, sig] = parts;
  const expected = b64u(crypto.createHmac('sha256', getSecret()).update(`${head}.${data}`).digest());
  const got = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const payload = JSON.parse(b64uDecode(data).toString('utf-8'));
    if (payload.role !== 'admin') return null;
    if (typeof payload.exp === 'number' && payload.exp > Date.now()) return payload;
  } catch { /* fall through */ }
  return null;
}

/**
 * 校验登录凭据 — 常量时间比较，防止时序攻击
 */
export function verifyAdminCredentials(username, password) {
  const cred = loadAdminCredentials();
  if (typeof username !== 'string' || typeof password !== 'string') return false;
  const u = Buffer.from(username);
  const eu = Buffer.from(cred.username);
  if (u.length !== eu.length || !crypto.timingSafeEqual(u, eu)) return false;
  return verifyPassword(password, cred.salt, cred.hash);
}

export function requireAdmin(req, res, next) {
  const bearer = req.get('authorization') || '';
  const m = bearer.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : (req.get('x-admin-token') || '').trim();
  if (!token) return res.status(401).json({ ok: false, message: '需要管理员登录' });
  const payload = verifyAdminToken(token);
  if (!payload) return res.status(401).json({ ok: false, message: '管理员登录已过期，请重新登录' });
  req.adminUser = { username: payload.username || 'admin' };
  next();
}
