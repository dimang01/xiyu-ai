/**
 * 语音合成 (Text-to-Speech) 提供商抽象 — v1.4.0 Sprint 1 / v1.4.3 Sprint 3
 *
 * 当前支持：
 *   - minimax  MiniMax speech-2.x（注册即送 500 字符，新式 sk-api- key 无需 GroupId）
 *   - openai   OpenAI tts-1 / tts-1-hd（6 个内置音色 alloy/echo/fable/onyx/nova/shimmer）
 *   - azure    Azure Cognitive Speech（zh-CN-XiaoxiaoNeural 等 SSML，需 region）
 *   - doubao   字节 火山引擎 TTS（需 appid + access_token + cluster）
 *   - qwen     阿里通义 CosyVoice / Qwen-TTS（OpenAI 兼容模式，需 DashScope key）
 *
 * 配置优先级（同 vision/asr）：
 *   1. process.env.TTS_PROVIDER / TTS_MODEL / TTS_VOICE_ID / <PROVIDER>_API_KEY
 *   2. app_settings 同名 key（由 /app/setup.html 写入）
 *   3. 默认值或抛错
 *
 * 各 provider 额外字段（按需读取）：
 *   - MiniMax:   MINIMAX_GROUP_ID（可选，新 key 不需要）
 *   - Doubao:    TTS_DOUBAO_APPID + TTS_DOUBAO_CLUSTER（cluster 一般填 volcano_tts）
 *   - Azure:     TTS_AZURE_REGION（如 eastasia / westus）
 *
 * 返回格式：所有 provider 统一返回 { audio: Buffer, format: 'mp3' }
 * （后端调用方 voice_pipeline.mjs 负责再转 SILK）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from '../logger.mjs';
import { getAppSetting } from '../db.mjs';
import { randomUUID } from 'node:crypto';

// ─── Provider 注册表 ───────────────────────────────────────────────────────
export const REGISTRY = {
  minimax: {
    baseURL: 'https://api.minimax.chat/v1',
    defaultModel: 'speech-02-turbo',  // 性价比版；speech-02-hd 更清晰但贵
    apiKeyEnv: 'MINIMAX_API_KEY',
    groupIdEnv: 'MINIMAX_GROUP_ID',   // 可选：老式 JWT key 才需要
    defaultVoiceId: 'female-tianmei',
    label: 'MiniMax speech-02',
    kind: 'minimax-native',
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'tts-1',            // tts-1-hd 更清晰但贵 2x
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultVoiceId: 'nova',           // 6 选：alloy/echo/fable/onyx/nova/shimmer
    label: 'OpenAI tts-1',
    kind: 'openai-compatible',
  },
  azure: {
    // baseURL 由 region 动态拼出，这里只占位
    defaultModel: '',                 // Azure 无 model 概念，model 字段忽略
    apiKeyEnv: 'AZURE_SPEECH_KEY',
    regionEnv: 'TTS_AZURE_REGION',    // 如 'eastasia' / 'westus'
    defaultVoiceId: 'zh-CN-XiaoxiaoNeural',
    label: 'Azure Speech',
    kind: 'azure-ssml',
  },
  doubao: {
    baseURL: 'https://openspeech.bytedance.com/api/v1/tts',
    defaultModel: '',                 // 豆包 TTS 无 model 概念
    apiKeyEnv: 'DOUBAO_TTS_ACCESS_TOKEN',
    appidEnv: 'TTS_DOUBAO_APPID',
    clusterEnv: 'TTS_DOUBAO_CLUSTER', // 一般填 volcano_tts
    defaultVoiceId: 'BV700_streaming',
    label: '豆包 TTS（火山引擎）',
    kind: 'doubao-native',
  },
  qwen: {
    // 阿里百炼 OpenAI 兼容端点（支持 cosyvoice-v2 / qwen3-tts-flash）
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'cosyvoice-v2',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    defaultVoiceId: 'longxiaochun',
    label: '通义 CosyVoice / Qwen-TTS',
    kind: 'openai-compatible',
  },
};

// ─── 动态读取：env 优先，其次 app_settings ────────────────────────────────
function readSetting(key) {
  if (process.env[key]) return process.env[key];
  try {
    const v = getAppSetting(key);
    if (v) return v;
  } catch { /* 表不存在时静默 */ }
  return '';
}

export function getActiveProviderName() {
  return (readSetting('TTS_PROVIDER') || '').toLowerCase();
}

function getEntry(name) {
  return REGISTRY[name] || null;
}

function getApiKey(entry) {
  return entry ? readSetting(entry.apiKeyEnv) || null : null;
}

function getModelFor(entry) {
  return readSetting('TTS_MODEL') || entry?.defaultModel || '';
}

function getVoiceId(entry, overrideId) {
  if (overrideId) return overrideId;
  return readSetting('TTS_VOICE_ID') || entry?.defaultVoiceId || '';
}

/**
 * 把 MiniMax T2A v2 API 返回的 hex 音频字符串 → Buffer
 * MiniMax /v1/t2a_v2 返回 { data: { audio: 'hex string', subtitle_file: '...' }, ... }
 */
function hexToBuffer(hexStr) {
  if (!hexStr || typeof hexStr !== 'string') return null;
  // 防御：MiniMax 偶尔返回带 0x 前缀
  const clean = hexStr.replace(/^0x/, '');
  if (clean.length % 2 !== 0) return null;
  return Buffer.from(clean, 'hex');
}

// ─── MiniMax T2A v2 调用 ──────────────────────────────────────────────────
// GROUP_ID 是可选的：
//   - 老式 JWT key（eyJhbG...）需要 GroupId 路由租户
//   - 新式 prefix-only key（"sk-api-" 开头）已经把 group 信息嵌在 key 里，调用时无需传
async function minimaxSynthesize({ apiKey, groupId, model, voice_id, speed = 1.0, text, signal }) {
  const url = groupId
    ? `https://api.minimax.chat/v1/t2a_v2?GroupId=${encodeURIComponent(groupId)}`
    : 'https://api.minimax.chat/v1/t2a_v2';
  const body = {
    model,
    text,
    stream: false,
    voice_setting: {
      voice_id,
      speed: Math.max(0.5, Math.min(2.0, Number(speed) || 1.0)),
      vol: 1.0,
      pitch: 0,
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const errText = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`[tts:minimax] HTTP ${resp.status}: ${errText}`);
  }
  const json = await resp.json();
  // MiniMax 标准错误结构：{ base_resp: { status_code, status_msg } }
  if (json?.base_resp && Number(json.base_resp.status_code) !== 0) {
    throw new Error(`[tts:minimax] ${json.base_resp.status_code}: ${json.base_resp.status_msg}`);
  }
  const hex = json?.data?.audio;
  const buf = hexToBuffer(hex);
  if (!buf || buf.length < 32) throw new Error('[tts:minimax] 返回 audio 为空或损坏');
  return buf;
}

// ─── OpenAI / 兼容（Qwen 百炼兼容模式） ──────────────────────────────────
async function openaiCompatSynthesize({ baseURL, apiKey, model, voice_id, speed, text, signal }) {
  const resp = await fetch(`${baseURL}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: text,
      voice: voice_id,
      response_format: 'mp3',
      speed: Math.max(0.25, Math.min(4.0, Number(speed) || 1.0)),
    }),
    signal,
  });
  if (!resp.ok) {
    const errText = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`[tts:openai-compat] HTTP ${resp.status}: ${errText}`);
  }
  const arr = await resp.arrayBuffer();
  const buf = Buffer.from(arr);
  if (buf.length < 32) throw new Error('[tts:openai-compat] 返回 audio 过短');
  return buf;
}

// ─── Azure Speech（SSML） ────────────────────────────────────────────────
function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}
async function azureSynthesize({ region, apiKey, voice_id, speed, text, signal }) {
  if (!region) throw new Error('[tts:azure] TTS_AZURE_REGION 未配置（如 eastasia / westus）');
  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  // Azure prosody rate 用百分比偏移：1.0 = +0%，1.5 = +50%，0.5 = -50%
  const ratePct = `${Math.round(((Number(speed) || 1.0) - 1.0) * 100)}%`;
  const lang = (voice_id && voice_id.includes('-')) ? voice_id.split('-').slice(0, 2).join('-') : 'zh-CN';
  const ssml =
    `<speak version="1.0" xml:lang="${lang}">` +
      `<voice name="${escapeXml(voice_id)}">` +
        `<prosody rate="${ratePct}">${escapeXml(text)}</prosody>` +
      `</voice>` +
    `</speak>`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'xiyu-ai',
    },
    body: ssml,
    signal,
  });
  if (!resp.ok) {
    const errText = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`[tts:azure] HTTP ${resp.status}: ${errText}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 32) throw new Error('[tts:azure] 返回 audio 过短');
  return buf;
}

// ─── 豆包（火山引擎） TTS ────────────────────────────────────────────────
async function doubaoSynthesize({ apiKey, appid, cluster, voice_id, speed, text, signal }) {
  if (!appid) throw new Error('[tts:doubao] TTS_DOUBAO_APPID 未配置');
  if (!cluster) throw new Error('[tts:doubao] TTS_DOUBAO_CLUSTER 未配置（一般填 volcano_tts）');
  const body = {
    app: { appid, token: apiKey, cluster },
    user: { uid: 'xiyu-ai' },
    audio: {
      voice_type: voice_id,
      encoding: 'mp3',
      speed_ratio: Math.max(0.2, Math.min(3.0, Number(speed) || 1.0)),
      volume_ratio: 1.0,
      pitch_ratio: 1.0,
    },
    request: {
      reqid: randomUUID(),
      text,
      operation: 'query',
    },
  };
  const resp = await fetch('https://openspeech.bytedance.com/api/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer;${apiKey}`,  // 豆包格式：'Bearer;<token>'（分号不是空格）
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const errText = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`[tts:doubao] HTTP ${resp.status}: ${errText}`);
  }
  const json = await resp.json();
  // 豆包返回：{ code, message, data: '<base64-mp3>', ... }，code=3000 表示成功
  if (Number(json?.code) !== 3000) {
    throw new Error(`[tts:doubao] code=${json?.code} msg=${json?.message || ''}`);
  }
  const b64 = json?.data;
  if (!b64 || typeof b64 !== 'string') throw new Error('[tts:doubao] 返回 data 为空');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 32) throw new Error('[tts:doubao] 解码后 audio 过短');
  return buf;
}

// ─── 公共入口 ────────────────────────────────────────────────────────────
/**
 * 合成文本为音频（mp3）字节。
 * @param {string} text - 中文文本，长度 ≤ 1000 由 caller 自行控制；这里不裁剪。
 * @param {object} opts - { voice_id?, speed?, model?, timeoutMs? }
 * @returns {Promise<{ audio: Buffer, format: 'mp3', provider: string, model: string, voice_id: string }>}
 */
export async function ttsSynthesize(text, opts = {}) {
  if (!text || typeof text !== 'string') throw new Error('[tts] text 必填');
  const name = getActiveProviderName();
  if (!name) throw new Error('[tts] 未配置 TTS_PROVIDER（在 /app/setup.html 设置或在 .env 配）');

  const entry = getEntry(name);
  if (!entry) throw new Error(`[tts] 未知 provider: ${name}`);

  const apiKey = getApiKey(entry);
  if (!apiKey) throw new Error(`[tts] ${entry.apiKeyEnv} 未配置`);

  const model = opts.model || getModelFor(entry);
  const voice_id = getVoiceId(entry, opts.voice_id);
  const speed = opts.speed ?? 1.0;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || 30_000);

  try {
    let audio;
    if (entry.kind === 'minimax-native') {
      const groupId = entry.groupIdEnv ? readSetting(entry.groupIdEnv) : null;
      audio = await minimaxSynthesize({
        apiKey, groupId, model, voice_id, speed,
        text, signal: controller.signal,
      });
    } else if (entry.kind === 'openai-compatible') {
      audio = await openaiCompatSynthesize({
        baseURL: entry.baseURL, apiKey, model, voice_id, speed,
        text, signal: controller.signal,
      });
    } else if (entry.kind === 'azure-ssml') {
      const region = entry.regionEnv ? readSetting(entry.regionEnv) : '';
      audio = await azureSynthesize({
        region, apiKey, voice_id, speed,
        text, signal: controller.signal,
      });
    } else if (entry.kind === 'doubao-native') {
      const appid = entry.appidEnv ? readSetting(entry.appidEnv) : '';
      const cluster = entry.clusterEnv ? readSetting(entry.clusterEnv) : '';
      audio = await doubaoSynthesize({
        apiKey, appid, cluster, voice_id, speed,
        text, signal: controller.signal,
      });
    } else {
      throw new Error(`[tts] kind=${entry.kind} 未实现`);
    }
    log('debug', `[tts] ${name} ok model=${model || '-'} voice=${voice_id} chars=${text.length} bytes=${audio.length}`);
    return { audio, format: 'mp3', provider: name, model, voice_id };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 给 setup wizard 用：查询当前 TTS provider 是否可用（不真发请求）。
 */
export function getTtsStatus() {
  const name = getActiveProviderName();
  if (!name) return { active: null, configured: false, providers: Object.keys(REGISTRY) };
  const entry = getEntry(name);
  if (!entry) return { active: name, configured: false, error: 'unknown-provider', providers: Object.keys(REGISTRY) };
  const apiKey = getApiKey(entry);
  // 额外必填字段：azure 需 region、doubao 需 appid+cluster；其余 provider 仅 key
  let extraOk = true;
  const extras = {};
  if (entry.kind === 'azure-ssml') {
    const region = readSetting(entry.regionEnv);
    extras.region = region || null;
    if (!region) extraOk = false;
  } else if (entry.kind === 'doubao-native') {
    const appid = readSetting(entry.appidEnv);
    const cluster = readSetting(entry.clusterEnv);
    extras.appid = appid || null;
    extras.cluster = cluster || null;
    if (!appid || !cluster) extraOk = false;
  }
  return {
    active: name,
    label: entry.label,
    model: getModelFor(entry),
    voice_id: getVoiceId(entry),
    configured: !!apiKey && extraOk,
    extras,
    providers: Object.keys(REGISTRY),
  };
}
