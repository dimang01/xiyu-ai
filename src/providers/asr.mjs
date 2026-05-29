/**
 * 语音识别 (ASR) 提供商抽象
 *
 * 支持的 provider（按国内常用优先）：
 *   - gemini    Google Gemini       （默认；有免费额度）
 *   - openai    OpenAI Whisper      （audio/transcriptions）
 *   - qwen      阿里通义 paraformer  （DashScope 异步）
 *   - xunfei    讯飞星火 IAT        （占位 — WebSocket+HMAC 协议，需 PR）
 *   - tencent   腾讯云 ASR          （占位 — TC3-HMAC 签名，需 PR）
 *
 * 配置优先级：
 *   1. process.env.ASR_PROVIDER / ASR_MODEL / <PROVIDER>_API_KEY
 *   2. app_settings 同名 key（由 /app/setup.html 写入）
 *   3. 默认值或抛错
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from '../logger.mjs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getAppSetting } from '../db.mjs';

// ─── Provider 注册表 ───────────────────────────────────────────────────────
export const REGISTRY = {
  gemini: {
    apiKeyEnv: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-flash',
    label: 'Google Gemini',
  },
  openai: {
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultModel: 'whisper-1',
    label: 'OpenAI Whisper',
  },
  qwen: {
    apiKeyEnv: 'QWEN_API_KEY',
    defaultModel: 'paraformer-v2',
    label: '通义千问 paraformer',
  },
  xunfei: {
    apiKeyEnv: 'XUNFEI_API_KEY',
    defaultModel: '',
    label: '讯飞 ASR (占位)',
    stub: true,
  },
  tencent: {
    apiKeyEnv: 'TENCENT_SECRET_ID',
    defaultModel: '',
    label: '腾讯云 ASR (占位)',
    stub: true,
  },
};

// ─── 动态读取：env 优先，其次 app_settings ─────────────────────────────────
function readSetting(key) {
  if (process.env[key]) return process.env[key];
  try {
    const v = getAppSetting(key);
    if (v) return v;
  } catch {}
  return '';
}
function getActiveProviderName() {
  return (readSetting('ASR_PROVIDER') || 'gemini').toLowerCase();
}
function getApiKeyForEntry(entry) {
  return entry ? readSetting(entry.apiKeyEnv) || null : null;
}
function getModelFor(entry) {
  return readSetting('ASR_MODEL') || entry?.defaultModel || '';
}

// ─── Gemini ───────────────────────────────────────────────────────────────
async function geminiASR(audioBuffer, mimeType) {
  const key = readSetting('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY 未配置');
  const supported = ['audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/webm'];
  const useMime = supported.includes(mimeType) ? mimeType : 'audio/ogg';
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: getModelFor(REGISTRY.gemini) });
  const result = await model.generateContent([
    { inlineData: { data: audioBuffer.toString('base64'), mimeType: useMime } },
    '请将这段语音转录为文字，只输出转录内容，用中文。',
  ]);
  return result.response.text().trim();
}

// ─── OpenAI Whisper ──────────────────────────────────────────────────────
async function openaiASR(audioBuffer, mimeType) {
  const key = readSetting('OPENAI_API_KEY');
  if (!key) throw new Error('OPENAI_API_KEY 未配置');
  const fd = new FormData();
  const ext = (mimeType.split('/')[1] || 'mp3').replace('mpeg', 'mp3');
  fd.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
  fd.append('model', getModelFor(REGISTRY.openai));
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
async function qwenASR(audioBuffer, mimeType) {
  const key = readSetting('QWEN_API_KEY') || readSetting('DASHSCOPE_API_KEY');
  if (!key) throw new Error('QWEN_API_KEY 未配置');
  const model = getModelFor(REGISTRY.qwen);
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

// ─── 讯飞 IAT (占位) ──────────────────────────────────────────────────────
async function xunfeiASR(/* audioBuffer, mimeType */) {
  throw new Error(
    '讯飞 ASR 仅占位（需 WebSocket + HMAC 签名，且企业实名）。' +
    '建议改用 ASR_PROVIDER=gemini 或 openai（Whisper）。' +
    '参考文档：https://www.xfyun.cn/doc/asr/voicedictation/API.html',
  );
}

// ─── 腾讯云 ASR (占位) ────────────────────────────────────────────────────
async function tencentASR(/* audioBuffer, mimeType */) {
  throw new Error(
    '腾讯云 ASR 仅占位（需 TC3-HMAC 签名，且个人实名）。' +
    '建议改用 ASR_PROVIDER=gemini 或 openai（Whisper）。' +
    '参考文档：https://cloud.tencent.com/document/product/1093/35646',
  );
}

const HANDLERS = {
  gemini: geminiASR,
  openai: openaiASR,
  qwen: qwenASR,
  xunfei: xunfeiASR,
  tencent: tencentASR,
};

export async function asrRecognize(audioBuffer, mimeType = 'audio/ogg') {
  const name = getActiveProviderName();
  const fn = HANDLERS[name];
  if (!fn) {
    log('error', `[asr] 未知 ASR_PROVIDER=${name}`);
    return '[语音识别失败]';
  }
  log('debug', `[asr] provider=${name} size=${audioBuffer.length} mime=${mimeType}`);
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
  const name = getActiveProviderName();
  const entry = REGISTRY[name];
  return {
    id: name,
    label: entry?.label,
    model: getModelFor(entry),
    configured: Boolean(entry && !entry.stub && getApiKeyForEntry(entry)),
  };
}

/**
 * 测试 ASR provider 连通性。
 * 使用一段极短的静音 ogg/wav 测试请求是否通；超时 15 秒。
 * 占位 provider 直接抛错，不发请求。
 */
export async function testAsrProvider(name) {
  const entry = REGISTRY[name];
  if (!entry) throw new Error(`未知 ASR provider: ${name}`);
  if (entry.stub) {
    throw new Error(`${entry.label} 当前仅为占位实现，建议改用 gemini 或 openai`);
  }
  const apiKey = getApiKeyForEntry(entry);
  if (!apiKey) throw new Error(`${entry.label} 的 ${entry.apiKeyEnv} 未配置`);

  // 极短静音 WAV（44-byte header + 256 samples of silence，约 88 字节）。
  // 多数 ASR 接口对空白音频会返回空文本而非报错——只要没 4xx/5xx 就算"连通"。
  const samples = 256;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples * 2, 40);
  const buf = Buffer.concat([header, Buffer.alloc(samples * 2)]);

  const t0 = Date.now();
  // 只对 openai / gemini / qwen 做真实 ping；它们的处理函数自带超时
  try {
    await HANDLERS[name](buf, 'audio/wav');
    return { ok: true, provider: name, label: entry.label, latency_ms: Date.now() - t0 };
  } catch (err) {
    // 静音可能被某些服务返回 "空转录" 而当成 400，这里把"接收到 4xx 错误"也视为
    // "鉴权通过 / 协议通"——但只接受非鉴权类错误。鉴权失败 (401/403) 仍是失败。
    const msg = err.message || '';
    if (/401|403/.test(msg) || /API_KEY/.test(msg)) throw err;
    if (/HTTP 4\d\d/.test(msg)) {
      return {
        ok: true, provider: name, label: entry.label, latency_ms: Date.now() - t0,
        warn: '连通成功，但静音测试音被 provider 拒绝（属于正常情况）',
      };
    }
    throw err;
  }
}
