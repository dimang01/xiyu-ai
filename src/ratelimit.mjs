/**
 * 极简 IP 速率限制中间件（内存 token bucket，单机用）。
 * 不引入额外依赖，重启时计数器清零。
  *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

const buckets = new Map(); // key -> { tokens, lastRefill }

function refill(b, maxTokens, refillPerMs) {
  const now = Date.now();
  const elapsed = now - b.lastRefill;
  if (elapsed > 0) {
    b.tokens = Math.min(maxTokens, b.tokens + elapsed * refillPerMs);
    b.lastRefill = now;
  }
}

function clientKey(req, scope) {
  // 不直接读取 X-Forwarded-For：该 header 可由客户端伪造。
  // 反代场景应在 Express 层显式配置 TRUST_PROXY，让 req.ip 由可信代理链计算。
  const ip = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
  return `${scope}|${ip}`;
}

/**
 * @param {{ scope: string, maxPerWindow: number, windowMs: number, message?: string }} opts
 */
export function rateLimit(opts) {
  const { scope, maxPerWindow, windowMs, message = '请求太频繁，请稍后再试' } = opts;
  const refillPerMs = maxPerWindow / windowMs;
  return function rateLimitMiddleware(req, res, next) {
    const key = clientKey(req, scope);
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: maxPerWindow, lastRefill: Date.now() };
      buckets.set(key, b);
    }
    refill(b, maxPerWindow, refillPerMs);
    if (b.tokens < 1) {
      const retryAfter = Math.ceil((1 - b.tokens) / refillPerMs / 1000);
      res.set('Retry-After', String(Math.max(1, retryAfter)));
      return res.status(429).json({ ok: false, success: false, message, retryAfter });
    }
    b.tokens -= 1;
    next();
  };
}

// 内存清理：每 10 分钟扫一遍清空闲过 1 小时的桶
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets.entries()) {
    if (now - b.lastRefill > 60 * 60 * 1000) buckets.delete(k);
  }
}, 10 * 60 * 1000).unref?.();
