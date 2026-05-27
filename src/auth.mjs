/**
 * 简易 JWT-like session token：HMAC-SHA256 签名的紧凑 payload。
 *
 * 设计点：
 *  - 不引入 jsonwebtoken npm 依赖，纯 crypto 自己实现，足够够用
 *  - secret 从环境变量 AUTH_SECRET 读，未设置则用 .auth-secret 自动生成并持久化
 *  - 30 天过期；exp 在 payload 里
 *  - 中间件 requireAuth 把 user_id 注入 req.authUser，并要求 query 里的 user_id（若有）必须一致
  *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.mjs';
import { isAccountBanned } from './db.mjs';

const SECRET_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.auth-secret',
);
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let SECRET = null;
function getSecret() {
  if (SECRET) return SECRET;
  if (process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 32) {
    SECRET = process.env.AUTH_SECRET;
    return SECRET;
  }
  if (existsSync(SECRET_FILE)) {
    SECRET = readFileSync(SECRET_FILE, 'utf-8').trim();
    if (SECRET.length >= 32) return SECRET;
  }
  // 第一次启动时生成
  SECRET = crypto.randomBytes(48).toString('hex');
  try {
    writeFileSync(SECRET_FILE, SECRET, { encoding: 'utf-8', mode: 0o600 });
    log('info', `[Auth] generated new auth secret at ${SECRET_FILE}`);
  } catch (err) {
    log('warn', `[Auth] failed to persist secret: ${err.message}`);
  }
  return SECRET;
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64uDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function signToken(payload, ttlMs = TOKEN_TTL_MS) {
  const body = {
    ...payload,
    iat: Date.now(),
    exp: Date.now() + ttlMs,
  };
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = b64u(JSON.stringify(body));
  const sig = b64u(
    crypto.createHmac('sha256', getSecret()).update(`${head}.${data}`).digest(),
  );
  return `${head}.${data}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, data, sig] = parts;
  const expected = b64u(
    crypto.createHmac('sha256', getSecret()).update(`${head}.${data}`).digest(),
  );
  const got = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const payload = JSON.parse(b64uDecode(data).toString('utf-8'));
    if (typeof payload.exp === 'number' && payload.exp > Date.now()) return payload;
  } catch { /* fall through */ }
  return null;
}

/**
 * Express middleware. 优先从 Authorization: Bearer 取 token，
 * 也兼容 x-auth-token header（方便测试）。
 * 校验通过后挂 req.authUser = { id, ... }；
 * 校验失败 401。
 * 如果 query/body 里的 user_id 与 token 中的 id 不一致，403。
 */
export function requireAuth(req, res, next) {
  const bearer = req.get('authorization') || '';
  const m = bearer.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : (req.get('x-auth-token') || '').trim();
  if (!token) return res.status(401).json({ ok: false, success: false, message: '未登录' });

  const payload = verifyToken(token);
  if (!payload?.id) return res.status(401).json({ ok: false, success: false, message: '登录已过期' });

  req.authUser = { id: Number(payload.id), username: payload.username || null };

  if (isAccountBanned(req.authUser.id)) {
    return res.status(403).json({ ok: false, success: false, message: '账号已被封禁' });
  }

  const claimed = Number(
    req.query?.user_id ?? req.query?.account_id ?? req.body?.user_id ?? req.body?.account_id ?? req.get('x-user-id') ?? 0
  ) || null;
  if (claimed && claimed !== req.authUser.id) {
    return res.status(403).json({ ok: false, success: false, message: '不可访问他人数据' });
  }

  // 强制 query/body 里的 user_id 用 token 的（覆盖前端可能伪造的）
  if (req.query) req.query.user_id = String(req.authUser.id);
  if (req.body && typeof req.body === 'object') req.body.user_id = req.authUser.id;
  next();
}

/**
 * 可选鉴权：有 token 就解，没就 next()，给那些既支持登录又支持游客的接口用。
 */
export function softAuth(req, _res, next) {
  const bearer = req.get('authorization') || '';
  const m = bearer.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : (req.get('x-auth-token') || '').trim();
  if (token) {
    const payload = verifyToken(token);
    if (payload?.id) req.authUser = { id: Number(payload.id), username: payload.username || null };
  }
  next();
}
