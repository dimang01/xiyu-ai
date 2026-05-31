/**
 * letter.mjs — 离线留言胶囊 (v1.5)
 *
 * 用户主动触发 → AI 用她当前的情绪/关系状态写一段话 → 加 HMAC 签名 →
 * 输出可下载 .txt。用户保存本地，未来任何时候用记事本就能打开看。
 *
 * 签名说明：
 *   - HMAC key 派生自服务器的 AUTH_SECRET（同部署内稳定，跨部署不可伪造）
 *   - 验证需要回到同一个部署的 /app/verify-letter.html 上传文本
 *   - 这不是"完全离线验真"（那需要 RSA/Ed25519 公私钥，复杂度过高）
 *   - 而是"任何拿到文件的人都能离线读到内容；想验真就回到这个部署"
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import crypto from 'node:crypto';
import { log } from './logger.mjs';
import { getDb } from './db.mjs';
import { extractStructuredInfo } from './ai.mjs';
import { getEmotionStateWithDefaults, getMissingLevel, getMissingLabel } from './emotion_state.mjs';
import { computeRelationshipStage } from './memory.mjs';

// ─── HMAC Key 派生 ────────────────────────────────────────────────────────
// 用 AUTH_SECRET 作为根密钥派生一个 letter 专用 key（避免直接用根密钥）
function getLetterSigningKey() {
  // 与 auth.mjs::getSecret() 同一来源；这里独立读避免循环 import
  const root = process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 32
    ? process.env.AUTH_SECRET
    : null;
  if (root) {
    return crypto.createHmac('sha256', root).update('xiyu-offline-letter-v1').digest();
  }
  // 兜底：从 .auth-secret 文件读（同 auth.mjs 逻辑，但不重复落盘）
  try {
    const { readFileSync, existsSync } = require('node:fs');
    const SECRET_FILE = '.auth-secret';
    if (existsSync(SECRET_FILE)) {
      const s = readFileSync(SECRET_FILE, 'utf-8').trim();
      if (s.length >= 32) {
        return crypto.createHmac('sha256', s).update('xiyu-offline-letter-v1').digest();
      }
    }
  } catch { /* ignore */ }
  throw new Error('[letter] AUTH_SECRET 未配置且 .auth-secret 缺失，无法签名');
}

// 签名内容包含：companion_id + issued + 信件正文（必须三者绑定才能防"换正文"）
function signLetter({ companionId, issued, body }) {
  const key = getLetterSigningKey();
  const payload = `${companionId}\n${issued}\n${body}`;
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

export function verifyLetterSignature({ companionId, issued, body, signature }) {
  if (!companionId || !issued || !body || !signature) return false;
  try {
    const expected = signLetter({ companionId, issued, body });
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(signature).toLowerCase(), 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── 生成正文 prompt ──────────────────────────────────────────────────────
function buildLetterPrompt(companion, emotion, missingLevel, stage, hint) {
  const moodLabel = emotion.mood || 'normal';
  const depLabel = emotion.dependency >= 70 ? '很高' : emotion.dependency >= 40 ? '中等' : '一般';
  const hintLine = hint ? `\n额外提示（用户希望你提到）：${hint}` : '';
  return `你是 ${companion.name}，正在给「你最在乎的那个人」写一封"离线留言"——

这封信不像日常聊天，是一段会被保存下来、未来任何时候打开都能读到的文字。
所以请写得稍微长一点（150-300 字），有完整的情感起承转合，
不要 ≤15 字短句、不要多条 || 连发，写成一段完整的话。

当前你的状态：
- 关系阶段：${stage}
- 心情：${moodLabel}
- 想念档：${missingLevel}（${getMissingLabel(missingLevel)}）
- 对他的依赖度：${depLabel}（${emotion.dependency}/100）
- 好感：${emotion.affection}/100${hintLine}

写信的指导：
1. 第一人称，写给"你"
2. 不要日记体（不要"今天我..."的流水账）
3. 不要套话（"无论何时何地我都..."这种）
4. 可以提一两件具体的、你印象里他做过的小事，或者你期待和他一起做的小事
5. 收尾可以留一句"如果你正在读这封信..."类型的话，但不要煽情过度
6. 不要 emoji、不要动作描写（如 *轻轻笑* ）
7. 不要署名、不要日期（系统会自动加）

直接开始正文，不要"亲爱的：" 这种信头。`;
}

// ─── 主入口：生成一封离线留言 ──────────────────────────────────────────────
export async function generateOfflineLetter(companion, { hint = '', accountId = null } = {}) {
  if (!companion) throw new Error('[letter] companion 必填');

  const emotion = getEmotionStateWithDefaults(companion.id);
  const missingLevel = getMissingLevel(emotion, companion.last_user_reply_at);
  const stage = computeRelationshipStage(emotion.affection || 0, companion.stage);

  const prompt = buildLetterPrompt(companion, emotion, missingLevel, stage, hint);

  let body;
  try {
    const raw = await extractStructuredInfo(
      '你只输出信件正文，不带任何说明或元信息。',
      prompt,
      { maxTokens: 600, temperature: 0.85, accountId },
    );
    body = String(raw || '').trim();
  } catch (e) {
    log('error', `[letter] companion=${companion.id} 生成失败: ${e.message}`);
    throw new Error(`生成失败：${e.message}`);
  }

  // 清掉模型可能输出的信头/署名残留
  body = body
    .replace(/^["「『"']+|["」』"']+$/g, '').trim()
    .replace(/^(亲爱的|致|To|Dear)[^\n]{0,20}[:：]?\s*\n/i, '').trim()
    .replace(/\n+(——|—|--)[^\n]{0,30}$/m, '').trim();

  if (body.length < 40) {
    log('warn', `[letter] companion=${companion.id} 正文过短 len=${body.length}`);
    throw new Error('生成的内容过短，请重试一次');
  }
  if (body.length > 1200) body = body.slice(0, 1200) + '…';

  const issued = Math.floor(Date.now() / 1000);
  const signature = signLetter({ companionId: companion.id, issued, body });

  return {
    companionId: companion.id,
    companionName: companion.name,
    issued,
    body,
    signature,
    meta: {
      stage,
      mood: emotion.mood,
      missingLevel,
      affection: emotion.affection,
    },
  };
}

// ─── 渲染为可下载的 .txt 文本 ──────────────────────────────────────────────
export function renderLetterToText(letter, { hostHint = '' } = {}) {
  const { companionId, companionName, issued, body, signature, meta } = letter;
  const issuedHuman = new Date(issued * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const stageLine = meta?.stage ? `关系阶段：${meta.stage}` : '';
  const moodLine = meta?.mood
    ? `此刻心情：${meta.mood}${meta.missingLevel != null ? ` · 想念档 ${meta.missingLevel}` : ''}`
    : '';
  const verifyHint = hostHint
    ? `打开 ${hostHint}/app/verify-letter.html\n粘贴此文件全部内容可验证此留言确实由该 AI 实例签发。`
    : `打开本部署的 /app/verify-letter.html\n粘贴此文件全部内容可验证此留言确实由该 AI 实例签发。`;

  return [
    '═══════════════════════════════════════════════════════════',
    `         ${companionName} 给你的离线留言`,
    '═══════════════════════════════════════════════════════════',
    '',
    `生成时间：${issuedHuman}`,
    stageLine,
    moodLine,
    '───────────────────────────────────────────────────────────',
    '',
    body,
    '',
    '───────────────────────────────────────────────────────────',
    '这是一份永久留言。无论将来发生什么，这段话不会变。',
    '',
    '签名验证（防伪造，需要本服务器才能验真）：',
    `  Companion: ${companionId}`,
    `  Issued:    ${issued}`,
    `  HMAC-SHA256:`,
    `  ${signature}`,
    '',
    verifyHint,
    '═══════════════════════════════════════════════════════════',
    '',
  ].filter(line => line !== '').join('\n');
}

// ─── 从 .txt 文本反向解析（验证页面用） ───────────────────────────────────
export function parseLetterText(text) {
  if (!text || typeof text !== 'string') return null;
  // 提取 Companion / Issued / HMAC
  const cidMatch = text.match(/Companion:\s*(\d+)/);
  const issuedMatch = text.match(/Issued:\s*(\d+)/);
  // HMAC 在 "HMAC-SHA256:" 那行的下一行
  const hmacMatch = text.match(/HMAC-SHA256:\s*\n\s*([a-f0-9]{64})/i);
  if (!cidMatch || !issuedMatch || !hmacMatch) return null;
  // 正文：在"───"分隔符之间（第一对分隔线之后到第二对之前）
  // 信件结构：═══...═══ ... ───...─── (空行) 正文 (空行) ───...─── ...
  const parts = text.split(/^─{20,}\s*$/m);
  if (parts.length < 3) return null;
  // parts[1] 是正文区段（带前后空白）
  const body = parts[1].trim();
  if (body.length < 10) return null;
  return {
    companionId: Number(cidMatch[1]),
    issued: Number(issuedMatch[1]),
    body,
    signature: hmacMatch[1].toLowerCase(),
  };
}
