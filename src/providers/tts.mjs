/**
 * 语音合成 (Text-to-Speech) 提供商抽象 — v1.4.0 Sprint 1
 *
 * 当前支持：
 *   - minimax  MiniMax speech-2.x（推荐入门：注册即送 500 字符，按字符计费）
 *
 * 后续 Sprint 3 会加入：豆包 / Azure / OpenAI。
 *
 * 配置优先级（同 vision/asr）：
 *   1. process.env.TTS_PROVIDER / TTS_MODEL / TTS_VOICE_ID / <PROVIDER>_API_KEY
 *   2. app_settings 同名 key（由 /app/setup.html 写入）
 *   3. 默认值或抛错
 *
 * 返回格式：所有 provider 统一返回 { audio: Buffer, format: 'mp3' }
 * （后端调用方 voice_pipeline.mjs 负责再转 SILK）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from '../logger.mjs';
import { getAppSetting } from '../db.mjs';

// ─── Provider 注册表 ───────────────────────────────────────────────────────
export const REGISTRY = {
  minimax: {
    // MiniMax 海外/中国大陆主域名以 GroupId 为路由的差异由 baseURL + group_id 处理
    baseURL: 'https://api.minimax.chat/v1',
    defaultModel: 'speech-02-turbo',  // 性价比版；speech-02-hd 更清晰但贵
    apiKeyEnv: 'MINIMAX_API_KEY',
    groupIdEnv: 'MINIMAX_GROUP_ID',   // MiniMax 必填，控制台拿
    defaultVoiceId: 'female-tianmei', // 甜美女声；可在 setup 里改成 male-* 或克隆音色
    label: 'MiniMax speech-02',
    kind: 'minimax-native',
  },
  // Sprint 3 占位（先不实现，setup wizard 里也不要让用户选）
  // doubao: { ... },
  // azure:  { ... },
  // openai: { ... },
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
      // GroupId 现在可选（参见 minimaxSynthesize 的注释）
      const groupId = entry.groupIdEnv ? readSetting(entry.groupIdEnv) : null;
      audio = await minimaxSynthesize({
        apiKey, groupId, model, voice_id, speed,
        text, signal: controller.signal,
      });
    } else {
      throw new Error(`[tts] kind=${entry.kind} 未实现`);
    }
    log('debug', `[tts] ${name} ok model=${model} voice=${voice_id} chars=${text.length} bytes=${audio.length}`);
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
  return {
    active: name,
    label: entry.label,
    model: getModelFor(entry),
    voice_id: getVoiceId(entry),
    configured: !!apiKey,  // GROUP_ID 现在可选，仅 apiKey 必填
    providers: Object.keys(REGISTRY),
  };
}
