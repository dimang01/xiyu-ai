import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

function httpError(message, statusCode = 400) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.expose = true;
  return e;
}

function stripIpv6Brackets(host) {
  return String(host || '').replace(/^\[|\]$/g, '');
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts.reduce((acc, n) => ((acc << 8) | n) >>> 0, 0) >>> 0;
}

function ipv4InCidr(ip, base, bits) {
  const value = ipv4ToInt(ip);
  const baseValue = ipv4ToInt(base);
  if (value === null || baseValue === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function ipv4FromMappedIpv6(ip) {
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice(7);
    if (net.isIP(tail) === 4) return tail;
  }
  return null;
}

function expandIpv6(ip) {
  const [headRaw, tailRaw] = ip.toLowerCase().split('::');
  const parseSide = side => side ? side.split(':').filter(Boolean).map(part => parseInt(part, 16)) : [];
  const head = parseSide(headRaw);
  const tail = parseSide(tailRaw);
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || head.some(Number.isNaN) || tail.some(Number.isNaN)) return null;
  return [...head, ...Array(missing).fill(0), ...tail];
}

function ipv4FromIpv6MappedHex(ip) {
  const parts = expandIpv6(ip);
  if (!parts || parts.length !== 8) return null;
  const mappedPrefix = parts.slice(0, 5).every(n => n === 0) && parts[5] === 0xffff;
  if (!mappedPrefix) return null;
  return [
    parts[6] >> 8,
    parts[6] & 0xff,
    parts[7] >> 8,
    parts[7] & 0xff,
  ].join('.');
}

function isBlockedIp(ip) {
  const mapped = ipv4FromMappedIpv6(ip) || ipv4FromIpv6MappedHex(ip);
  if (mapped) return isBlockedIp(mapped);

  if (net.isIP(ip) === 4) {
    return [
      ['127.0.0.0', 8],
      ['10.0.0.0', 8],
      ['172.16.0.0', 12],
      ['192.168.0.0', 16],
      ['169.254.0.0', 16],
      ['100.64.0.0', 10],
      ['0.0.0.0', 8],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, bits]) => ipv4InCidr(ip, base, bits));
  }

  if (net.isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    const first = parseInt(lower.split(':')[0] || '0', 16);
    return lower === '::1'
      || lower === '::'
      || (first & 0xfe00) === 0xfc00
      || (first & 0xffc0) === 0xfe80
      || (first & 0xff00) === 0xff00;
  }

  return true;
}

async function resolveAndValidateHost(hostname) {
  const host = stripIpv6Brackets(hostname).toLowerCase();
  if (!host || host === 'localhost') throw httpError('url host 不允许访问本机地址', 400);

  const literalKind = net.isIP(host);
  const addresses = literalKind ? [{ address: host, family: literalKind }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw httpError('url host 无法解析', 400);

  for (const item of addresses) {
    if (isBlockedIp(item.address)) {
      throw httpError('url 指向内网或保留地址，已拒绝下载', 400);
    }
  }
  return addresses[0];
}

async function validateUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw httpError('url 无效', 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw httpError('url 仅支持 http/https', 400);
  }
  const address = await resolveAndValidateHost(url.hostname);
  url._netguardAddress = address;
  return url;
}

function requestValidatedUrl(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const address = url._netguardAddress;
    const client = url.protocol === 'https:' ? https : http;
    const hostname = stripIpv6Brackets(url.hostname);
    const req = client.request({
      protocol: url.protocol,
      hostname,
      servername: hostname,
      port: url.port || undefined,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: {
        Host: url.host,
        'User-Agent': 'xiyu-avatar-fetch',
        Accept: 'image/*',
      },
      lookup: (_hostname, _options, cb) => cb(null, address.address, address.family),
      timeout: timeoutMs,
    }, resolve);
    req.on('timeout', () => req.destroy(httpError('下载超时', 504)));
    req.on('error', reject);
    req.end();
  });
}

async function readLimited(response, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response) {
    total += chunk.length;
    if (total > maxBytes) throw httpError('图片过大（>5MB）', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export async function downloadImageWithGuards(rawUrl, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? 3;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  let url = await validateUrl(rawUrl);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await requestValidatedUrl(url, timeoutMs);
    const status = response.statusCode || 0;

    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      // 排空当前响应避免 socket 长时间占用
      response.resume();
      if (!location) throw httpError('下载重定向缺少 Location', 502);
      if (redirectCount >= maxRedirects) throw httpError('下载重定向次数过多', 502);
      url = await validateUrl(new URL(location, url).toString());
      continue;
    }

    if (status < 200 || status >= 300) throw httpError(`下载失败 HTTP ${status}`, 502);

    const contentLength = Number(response.headers['content-length'] || 0);
    if (contentLength > maxBytes) throw httpError('图片过大（>5MB）', 413);

    const contentType = response.headers['content-type'] || '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw httpError('响应不是图片', 400);
    }

    const buffer = await readLimited(response, maxBytes);
    return { buffer, contentType, finalUrl: url.toString() };
  }

  throw httpError('下载重定向次数过多', 502);
}
