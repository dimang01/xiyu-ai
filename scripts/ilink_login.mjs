#!/usr/bin/env node
/**
 * 溪语 AI · 腾讯 iLink (ClawBot) 终端二维码登录辅助脚本
 *
 * Usage:
 *   npm run ilink:login                # 启动扫码登录流程
 *   npm run ilink:login -- --help      # 显示帮助，不联网
 *
 * 流程：
 *   1. 调 ilink/bot/get_bot_qrcode?bot_type=3 拿二维码
 *   2. 在终端打印二维码，用微信扫码
 *   3. 每 2 秒轮询 get_qrcode_status
 *   4. confirmed 后写入 ./.weixin-credentials.json
 *
 * 安全：
 *   - 微信扫码 + 手机点击确认必须由用户本人完成
 *   - 不打印 bot_token / 完整响应
 *   - .weixin-credentials.json 已在 .gitignore，请勿提交
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import 'dotenv/config';
import { existsSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fetch from 'node-fetch';
import qrcode from 'qrcode-terminal';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CREDENTIALS_FILE = resolve(ROOT, '.weixin-credentials.json');

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟二维码有效期上限

function usage() {
  const lines = [
    '溪语 AI · iLink QR 登录',
    '',
    'Usage:',
    '  npm run ilink:login                启动扫码登录',
    '  npm run ilink:login -- --help      显示本帮助',
    '',
    'Environment:',
    '  ILINK_BASE_URL    iLink 接入域名（默认 ' + DEFAULT_BASE_URL + '）',
    '',
    'Output:',
    '  成功后写入 ./.weixin-credentials.json （不会打印 token 内容）',
    '',
    'Notes:',
    '  - 微信扫码 + 手机端"允许登录"必须由账号持有人完成',
    '  - 仅适用于已获得腾讯 iLink/ClawBot 准入的开发者账号',
    '  - 二维码 5 分钟内未确认会过期，请重新运行此脚本',
  ];
  console.log(lines.join('\n'));
}

function pickField(obj, paths) {
  for (const p of paths) {
    const segs = p.split('.');
    let cur = obj;
    let ok = true;
    for (const s of segs) {
      if (cur && typeof cur === 'object' && s in cur) cur = cur[s];
      else { ok = false; break; }
    }
    if (ok && cur !== null && cur !== undefined && cur !== '') return cur;
  }
  return null;
}

function normalizeStatus(data) {
  const raw = String(data?.status ?? data?.data?.status ?? '').toLowerCase().trim();
  if (!raw) return 'wait';
  // 兼容服务端不同拼写
  if (raw === 'scanned' || raw === 'scaned') return 'scaned';
  return raw;
}

function maskShort(s) {
  if (!s) return null;
  const v = String(s);
  if (v.length <= 8) return v.slice(0, 2) + '***';
  return v.slice(0, 4) + '***' + v.slice(-2);
}

async function httpGet(url, label) {
  const r = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'iLink-App-Id': 'bot',
    },
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`${label} HTTP ${r.status}`);
  }
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} returned non-JSON response`); }
}

async function httpPostJson(url, body, label) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'iLink-App-Id': 'bot',
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} returned non-JSON response`); }
}

async function requestQrcode(baseUrl) {
  const url = `${baseUrl.replace(/\/$/, '')}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  let data;
  try {
    // 接口实际为 POST（与开源版 ilink.mjs 行为一致）
    data = await httpPostJson(url, { local_token_list: [] }, 'get_bot_qrcode');
  } catch (firstErr) {
    // 兼容部分签名的 GET 端点
    try {
      data = await httpGet(url, 'get_bot_qrcode');
    } catch {
      throw firstErr;
    }
  }
  const qrcodeKey = pickField(data, ['qrcode', 'data.qrcode']);
  const qrcodeImgContent = pickField(data, ['qrcode_img_content', 'data.qrcode_img_content']);
  if (!qrcodeKey && !qrcodeImgContent) {
    throw new Error('get_bot_qrcode response missing qrcode/qrcode_img_content (协议可能已变更)');
  }
  return { qrcodeKey, qrcodeImgContent };
}

async function pollStatus(baseUrl, qrcodeKey) {
  const url = `${baseUrl.replace(/\/$/, '')}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeKey)}`;
  const data = await httpGet(url, 'get_qrcode_status');
  const status = normalizeStatus(data);
  return { status, data };
}

function extractCredentials(data, baseUrl) {
  return {
    bot_token: pickField(data, ['bot_token', 'data.bot_token']),
    ilink_bot_id: pickField(data, ['ilink_bot_id', 'data.ilink_bot_id']),
    ilink_user_id: pickField(data, ['ilink_user_id', 'data.ilink_user_id']),
    baseurl: (pickField(data, ['baseurl', 'data.baseurl']) || baseUrl).replace(/\/$/, ''),
  };
}

function saveCredentials(creds) {
  const payload = {
    baseurl: creds.baseurl,
    ilink_bot_id: creds.ilink_bot_id,
    ilink_user_id: creds.ilink_user_id,
    bot_token: creds.bot_token,
    created_at: new Date().toISOString(),
  };
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf-8' });
  try { chmodSync(CREDENTIALS_FILE, 0o600); } catch { /* best-effort */ }
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const baseUrl = (process.env.ILINK_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  console.log(`[WeChat iLink] Base URL: ${baseUrl}`);
  console.log('[WeChat iLink] 正在申请二维码...');

  let qrResp;
  try {
    qrResp = await requestQrcode(baseUrl);
  } catch (err) {
    console.error(`[WeChat iLink] 申请二维码失败: ${err.message}`);
    console.error('  · 请确认网络可达，并且该账号已获得腾讯 iLink/ClawBot 准入');
    process.exitCode = 1;
    return;
  }

  const { qrcodeKey, qrcodeImgContent } = qrResp;
  if (qrcodeImgContent && /^https?:\/\//.test(String(qrcodeImgContent))) {
    console.log('[WeChat iLink] 服务端二维码图链接（仅显示前缀）：' + String(qrcodeImgContent).slice(0, 32) + '…');
  }
  if (qrcodeKey) {
    console.log('[WeChat iLink] 用微信扫描下方二维码：');
    console.log('');
    qrcode.generate(String(qrcodeKey), { small: true });
    console.log('');
  } else if (qrcodeImgContent) {
    console.log('[WeChat iLink] 此服务端只返回二维码图，请打开链接扫描后回到本终端。');
  } else {
    console.error('[WeChat iLink] 服务端未提供可识别的二维码字段。');
    process.exitCode = 1;
    return;
  }

  console.log('[WeChat iLink] 等待扫码与手机端确认...');
  const startedAt = Date.now();
  let lastStatus = '';
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    let resp;
    try {
      resp = await pollStatus(baseUrl, qrcodeKey);
    } catch (err) {
      console.error(`[WeChat iLink] 轮询失败: ${err.message}（将重试）`);
      continue;
    }
    const { status, data } = resp;
    if (status !== lastStatus) {
      const human = ({
        wait: '等待扫码…',
        scaned: '已扫码，请在手机微信点击"允许"',
        need_verifycode: '需要验证码（此脚本暂不支持，请改用网页端）',
        scaned_but_redirect: '需要在主端口重定向后再试',
        binded_redirect: '账号已绑定其他实例，需重定向',
        verify_code_blocked: '验证码被风控拦截，请稍后重试',
        expired: '二维码已过期',
        cancelled: '用户已取消',
        confirmed: '已确认',
      })[status] || `状态: ${status}`;
      console.log(`[WeChat iLink] ${human}`);
      lastStatus = status;
    }
    if (status === 'expired') {
      console.error('[WeChat iLink] 二维码已过期，请重新运行 npm run ilink:login');
      process.exitCode = 1;
      return;
    }
    if (status === 'cancelled') {
      console.error('[WeChat iLink] 用户已取消登录');
      process.exitCode = 1;
      return;
    }
    if (status === 'need_verifycode' || status === 'verify_code_blocked') {
      console.error('[WeChat iLink] 当前流程需要额外验证码，本脚本不处理。请改用 dashboard 网页端扫码绑定。');
      process.exitCode = 1;
      return;
    }
    if (status === 'confirmed') {
      const creds = extractCredentials(data, baseUrl);
      if (!creds.bot_token || !creds.ilink_bot_id) {
        console.error('[WeChat iLink] 登录响应缺少 bot_token / ilink_bot_id 字段（协议可能已变更）');
        process.exitCode = 1;
        return;
      }
      saveCredentials(creds);
      console.log('[WeChat iLink] Login successful. Credentials saved to .weixin-credentials.json');
      console.log(`[WeChat iLink] bot_id=${maskShort(creds.ilink_bot_id)}  user_id=${maskShort(creds.ilink_user_id)}`);
      return;
    }
    // 其它状态继续等待
  }

  console.error('[WeChat iLink] 超时未完成登录（5 分钟），请重新运行 npm run ilink:login');
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch(err => {
  // 不要 dump 完整 stack 暴露细节
  console.error(`[WeChat iLink] 脚本异常: ${err.message}`);
  process.exitCode = 1;
});
