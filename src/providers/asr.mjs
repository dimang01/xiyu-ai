/**
 * 语音识别 (ASR) 提供商抽象
 *
 * 支持的 provider（按国内常用优先）：
 *   - qwen      阿里通义 paraformer  （国内推荐；DashScope）
 *   - xunfei    讯飞星火 IAT         （IAT WebAPI）
 *   - tencent   腾讯云 ASR          （需要签名）
 *   - gemini    Google Gemini       （兼容现有实现）
 *   - openai    OpenAI Whisper      （audio/transcriptions）
 *
 * 切换：ASR_PROVIDER=...
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from '../logger.mjs';
import { GoogleGenerativeAI } from '@google/generative-ai';

const ACTIVE = (process.env.ASR_PROVIDER || 'gemini').toLowerCase();

// ─── Gemini (现有实现) ────────────────────────────────────────────────────
async function geminiASR(audioBuffer, mimeType) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY 未配置');
  const supported = ['audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/webm'];
  const useMime = supported.includes(mimeType) ? mimeType : 'audio/ogg';
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: process.env.ASR_MODEL || 'gemini-2.5-flash' });
  const result = await model.generateContent([
    { inlineData: { data: audioBuffer.toString('base64'), mimeType: useMime } },
    '请将这段语音转录为文字，只输出转录内容，用中文。',
  ]);
  return result.response.text().trim();
}

// ─── OpenAI Whisper ──────────────────────────────────────────────────────
async function openaiASR(audioBuffer, mimeType) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY 未配置');
  const fd = new FormData();
  // 文件名靠扩展名识别格式，给个稳妥的名字
  const ext = (mimeType.split('/')[1] || 'mp3').replace('mpeg', 'mp3');
  fd.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
  fd.append('model', process.env.ASR_MODEL || 'whisper-1');
  fd.append('language', 'zh');
  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`Whisper HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return (data.text || '').trim();
}

// ─── 通义 paraformer (DashScope 异步) ────────────────────────────────────
// 文件必须通过 URL 提供，所以我们用 base64 data URL 包一层。
async function qwenASR(audioBuffer, mimeType) {
  const key = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY;
  if (!key) throw new Error('QWEN_API_KEY 未配置');
  const model = process.env.ASR_MODEL || 'paraformer-v2';
  // 提交任务
  const dataUrl = `data:${mimeType};base64,${audioBuffer.toString('base64')}`;
  const create = await fetch(
    'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify({
        model,
        input: { file_urls: [dataUrl] },
        parameters: { language_hints: ['zh'] },
      }),
    },
  );
  if (!create.ok) throw new Error(`Qwen ASR HTTP ${create.status}: ${(await create.text()).slice(0, 200)}`);
  const { output } = await create.json();
  const taskId = output?.task_id;
  if (!taskId) throw new Error('paraformer 未返回 task_id');
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const q = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const { output: o } = await q.json();
    if (o?.task_status === 'SUCCEEDED') {
      // 结果是 transcription_url，需要 fetch 文本
      const url = o.results?.[0]?.transcription_url;
      if (url) {
        const tr = await fetch(url);
        const j = await tr.json();
        return (j.transcripts?.[0]?.text || '').trim();
      }
      return (o.results?.[0]?.text || '').trim();
    }
    if (o?.task_status === 'FAILED') throw new Error(`paraformer FAILED: ${o.message || ''}`);
  }
  throw new Error('paraformer 任务超时');
}

// ─── 讯飞 IAT (短语音) ────────────────────────────────────────────────────
// 注意：讯飞用 ws 协议+ HMAC 签名比较复杂。这里给一个 HTTP RESTful 占位
// （讯飞 OpenAPI v2 支持 HTTP）。生产用户建议参考讯飞官方 SDK 完善。
async function xunfeiASR(audioBuffer, mimeType) {
  const apiKey = process.env.XUNFEI_API_KEY;
  const apiSecret = process.env.XUNFEI_API_SECRET;
  const appId = process.env.XUNFEI_APP_ID;
  if (!apiKey || !apiSecret || !appId) {
    throw new Error('讯飞需 XUNFEI_APP_ID + XUNFEI_API_KEY + XUNFEI_API_SECRET');
  }
  // 简化实现：调用讯飞极速版（HTTP）。
  // 真实生产建议接入 RTASR / IAT WebSocket 服务，并校验签名。
  throw new Error('讯飞 ASR 当前仅占位，未实现 WebSocket 签名（PR welcome）');
}

// ─── 腾讯云 ASR (占位) ────────────────────────────────────────────────────
async function tencentASR(audioBuffer, mimeType) {
  throw new Error('腾讯云 ASR 当前仅占位，建议使用官方 SDK (PR welcome)');
}

const REGISTRY = {
  gemini: geminiASR,
  openai: openaiASR,
  qwen: qwenASR,
  xunfei: xunfeiASR,
  tencent: tencentASR,
};

export async function asrRecognize(audioBuffer, mimeType = 'audio/ogg') {
  const fn = REGISTRY[ACTIVE];
  if (!fn) {
    log('error', `[asr] 未知 ASR_PROVIDER=${ACTIVE}`);
    return '[语音识别失败]';
  }
  log('debug', `[asr] provider=${ACTIVE} size=${audioBuffer.length} mime=${mimeType}`);
  try {
    const text = await fn(audioBuffer, mimeType);
    log('info', `[asr] 结果: ${text.slice(0, 100)}`);
    return text || '[语音识别失败]';
  } catch (err) {
    log('error', `[asr] 失败: ${err.message}`);
    return '[语音识别失败]';
  }
}

export function getActiveAsrProvider() {
  return { id: ACTIVE, model: process.env.ASR_MODEL || '(默认)' };
}
