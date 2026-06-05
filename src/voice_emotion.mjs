/**
 * voice_emotion.mjs — 喂 mp3 给千问 qwen-audio，识别语气 / 情绪 / 转写。
 *
 * DashScope multimodal generation endpoint：
 *   POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
 *   Authorization: Bearer <QWEN_API_KEY>
 *   model: qwen-audio-turbo-latest
 *
 * 输入 messages 里 content 数组接受 { audio: "data:audio/mp3;base64,..." } + { text: prompt }。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { getAppSetting } from './db.mjs';

const QWEN_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const DEFAULT_MODEL = 'qwen-audio-turbo-latest';
const REQ_TIMEOUT_MS = 25_000;

async function readQwenKey() {
  return process.env.QWEN_AUDIO_API_KEY
    || process.env.QWEN_API_KEY
    || (await getAppSetting('QWEN_API_KEY'))
    || (await getAppSetting('QWEN_AUDIO_API_KEY'));
}

const TONE_PROMPT = '请识别这段语音并输出严格 JSON：'
  + '{"transcript":"逐字内容","tone":"语气一句话不超过15字","emotion":"主要情绪一个词，如 开心/低落/疲惫/激动/温柔/撒娇/严肃/中性","energy":"高|中|低"}。'
  + '硬性要求：所有字符串和键名必须用双引号 "，不要用单引号 \'。不要 markdown / 代码块 / 多余解释，只输出一行 JSON。';

function tryParseJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  // 兜底剥 markdown code fence
  s = s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  // 也兜底找首个 { ... } 子串（模型偶尔加前后引导文字）
  if (!s.startsWith('{')) {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) s = m[0];
  }
  try { return JSON.parse(s); } catch {}

  // v1.10.18 兜底：qwen-audio 经常返 Python dict 风格 {'k': 'v', ...}（单引号）。
  // 转双引号再试。仅对外层换；如果值里有 ASCII 单引号会被误换 — 但中文/普通转写
  // 几乎不会出现 ASCII '，先这么挡着，看实际故障再加 escape 状态机。
  const swapped = s.replace(/'/g, '"');
  try { return JSON.parse(swapped); } catch {}

  return null;
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.map(c => (typeof c === 'string' ? c : c?.text || '')).filter(Boolean);
    return parts.join('');
  }
  if (content && typeof content === 'object' && content.text) return content.text;
  return '';
}

/**
 * 喂 mp3 给千问 qwen-audio，返回 { transcript, tone, emotion, energy }。
 * 任意失败抛错，让调用方 fallback。
 */
export async function analyzeVoiceWithQwen(mp3Buf, opts = {}) {
  if (!Buffer.isBuffer(mp3Buf) || mp3Buf.length < 64) throw new Error('mp3 buffer too small or invalid');

  const apiKey = await readQwenKey();
  if (!apiKey) throw new Error('QWEN_API_KEY 未配置');

  const model = opts.model || DEFAULT_MODEL;
  const audioDataUrl = `data:audio/mp3;base64,${mp3Buf.toString('base64')}`;
  const body = {
    model,
    input: {
      messages: [{
        role: 'user',
        content: [
          { audio: audioDataUrl },
          { text: TONE_PROMPT },
        ],
      }],
    },
    parameters: { result_format: 'message' },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQ_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(QWEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  if (!resp.ok) throw new Error(`qwen-audio HTTP ${resp.status}: ${text.slice(0, 200)}`);

  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`qwen-audio response not JSON: ${text.slice(0, 200)}`); }

  const choice = json?.output?.choices?.[0];
  const raw = extractTextFromContent(choice?.message?.content) || json?.output?.text || '';
  const parsed = tryParseJson(raw);
  if (!parsed) throw new Error(`qwen-audio output not JSON-parseable: ${raw.slice(0, 200)}`);

  // 字段归一化
  return {
    transcript: String(parsed.transcript || '').trim(),
    tone: String(parsed.tone || '').trim(),
    emotion: String(parsed.emotion || '').trim(),
    energy: String(parsed.energy || '').trim(),
    model,
  };
}
