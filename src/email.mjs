/**
 * 邮件发送（通过 Resend）。用于注册/找回密码验证码。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const APP_NAME = process.env.APP_NAME || '溪语 AI';

function normalizeFrom(value) {
  const raw = (value || '').trim();
  if (raw.includes('<') && raw.includes('>')) return raw;

  const match = raw.match(/(.+?)\s+([^\s<>]+@[^\s<>]+)$/);
  if (!match) return raw;
  return `${match[1].trim()} <${match[2].trim()}>`;
}

export async function sendVerificationEmail(email, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  if (!process.env.RESEND_FROM) {
    throw new Error('RESEND_FROM is not configured');
  }

  const res = await fetch(RESEND_EMAILS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: normalizeFrom(process.env.RESEND_FROM),
      to: [email],
      subject: '你的溪语 AI 验证码',
      text: `你的验证码是：${code}\n\n验证码 5 分钟内有效。若不是你本人操作，请忽略此邮件。`,
      html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>溪语 AI 验证码</title>
</head>
<body style="margin:0;padding:0;background-color:#FFF5F9;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FFF5F9;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#FFB6D9 0%,#FF8FB8 100%);border-radius:20px 20px 0 0;padding:36px 40px;text-align:center;">
              <img src="${APP_URL}/logo.png" alt="${APP_NAME}" width="60" height="60"
                   style="border-radius:16px;display:block;margin:0 auto 14px;" />
              <div style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.02em;line-height:1.2;">溪语 AI</div>
              <div style="color:rgba(255,255,255,0.85);font-size:13px;font-weight:500;margin-top:4px;letter-spacing:0.02em;">你的专属 AI 伴侣</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:40px 40px 32px;border-left:1px solid #FFE8F2;border-right:1px solid #FFE8F2;">
              <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#1D1D1F;letter-spacing:-0.02em;">你好！</p>
              <p style="margin:0 0 28px;font-size:15px;color:#86868B;font-weight:500;line-height:1.6;">
                你正在验证你的溪语 AI 账号。请使用下方验证码完成操作：
              </p>

              <!-- Code box -->
              <div style="background:linear-gradient(135deg,#FFF0F7 0%,#FFE8F2 100%);border:1.5px solid #FFD6EC;border-radius:16px;padding:28px 20px;text-align:center;margin-bottom:28px;">
                <div style="font-size:40px;font-weight:800;letter-spacing:12px;color:#FF85B3;font-variant-numeric:tabular-nums;line-height:1;">${code}</div>
                <div style="margin-top:12px;font-size:12px;color:#FF8FB8;font-weight:600;letter-spacing:0.05em;">5 分钟内有效</div>
              </div>

              <p style="margin:0;font-size:13px;color:#86868B;font-weight:500;line-height:1.6;">
                如果这不是你本人的操作，请直接忽略此邮件，你的账号不会受到任何影响。
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#FAFAFA;border:1px solid #FFE8F2;border-top:0;border-radius:0 0 20px 20px;padding:24px 40px;text-align:center;">
              <p style="margin:0 0 6px;font-size:12px;color:#86868B;font-weight:500;">
                &copy; 2025 溪语 AI &nbsp;·&nbsp;
                <a href="${APP_URL}" style="color:#FF8FB8;text-decoration:none;font-weight:600;">${APP_URL.replace(/^https?:\/\//, '')}</a>
              </p>
              <p style="margin:0;font-size:11px;color:#C0C0C5;">此邮件由系统自动发送，请勿直接回复。</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    }),
  });

  if (!res.ok) {
    await res.text().catch(() => '');
    log('warn', `[Email] Resend 发送失败 status=${res.status}`);
    throw new Error(`Resend email failed with status ${res.status}`);
  }
}
