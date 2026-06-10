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

/**
 * Email 工作模式：
 *   - "resend"     ：通过 Resend HTTP API 发送（需要 RESEND_API_KEY + RESEND_FROM）
 *   - "dev_stdout" ：不发邮件，把验证码醒目地打到服务日志（开发 / 自托管首次启动用）
 *
 * 解析优先级（最高 → 最低）：
 *   1. 环境变量 EMAIL_MODE 显式指定（resend / dev_stdout）
 *   2. EMAIL_DEV_MODE=1 → dev_stdout
 *   3. RESEND_API_KEY 与 RESEND_FROM 都已配置 → resend
 *   4. 否则 → dev_stdout（fallback，不阻塞首次部署）
 */
export function getEmailMode() {
  const explicit = String(process.env.EMAIL_MODE || '').toLowerCase().trim();
  if (explicit === 'resend' || explicit === 'dev_stdout') return explicit;
  if (String(process.env.EMAIL_DEV_MODE || '').trim() === '1') return 'dev_stdout';
  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM) return 'resend';
  return 'dev_stdout';
}

function logDevCode(email, code) {
  const banner = '═'.repeat(60);
  // 直接 console.log 而不是 log()，确保即便日志级别被调高也能看见
  console.log(`\n${banner}`);
  console.log(`📬  [EMAIL_DEV_MODE] 验证码（未真发邮件，请勿用于生产）`);
  console.log(`    收件人：${email}`);
  console.log(`    验证码：    ${code}`);
  console.log(`    5 分钟内有效。`);
  console.log(`    若要改为真实发邮件，请在 .env 配置 RESEND_API_KEY + RESEND_FROM`);
  console.log(`${banner}\n`);
}

/**
 * v1.21.2 (#263 后续)：运维告警邮件——proactive 死人开关等系统级 CRITICAL 用。
 * 复用注册验证码同一 Resend 通道，**不依赖 bot 自身回复链路**；
 * dev_stdout 模式直接打印（测试/红色验证靠它断言）。失败抛错由调用方 fail-open。
 */
export async function sendOpsAlertEmail(to, subject, text) {
  const mode = getEmailMode();
  if (mode === 'dev_stdout') {
    console.log(`\n${'═'.repeat(60)}\n🚨  [EMAIL_DEV_MODE] 运维告警（未真发邮件）\n    收件人：${to}\n    主题：${subject}\n    ${String(text).split('\n').join('\n    ')}\n${'═'.repeat(60)}\n`);
    log('warn', `[Email] dev_stdout 运维告警：${subject}`);
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !process.env.RESEND_FROM) throw new Error('RESEND_API_KEY / RESEND_FROM 未配置');
  const res = await fetch(RESEND_EMAILS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: normalizeFrom(process.env.RESEND_FROM),
      to: [to],
      subject: `[溪语运维告警] ${subject}`,
      text: String(text),
    }),
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}`);
}

export async function sendVerificationEmail(email, code) {
  const mode = getEmailMode();

  if (mode === 'dev_stdout') {
    logDevCode(email, code);
    log('info', `[Email] dev_stdout 模式：验证码已打印到服务日志（recipient=${email}）`);
    return;
  }

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
