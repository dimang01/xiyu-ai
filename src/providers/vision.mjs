/**
 * 图片识别 (Vision/multimodal) 提供商抽象
 *
 * 支持的 provider：
 *   - zhipu     智谱 GLM-4V (默认；国内速度好)
 *   - openai    OpenAI gpt-4o
 *   - qwen      通义千问 qwen-vl
 *   - doubao    豆包视觉
 *   - anthropic Claude (有视觉能力)
 *
 * 配置优先级：
 *   1. process.env.VISION_PROVIDER / VISION_MODEL / <PROVIDER>_API_KEY
 *   2. app_settings 同名 key（由 /app/setup.html 写入）
 *   3. 默认值或抛错
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from '../logger.mjs';
import { getAppSetting } from '../db.mjs';

// ─── Provider 注册表 ───────────────────────────────────────────────────────
// custom=true 表示需要用户提供 model（如豆包接入点）；否则有默认值。
export const REGISTRY = {
  zhipu: {
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4v-flash',
    apiKeyEnv: 'ZHIPU_API_KEY',
    label: '智谱 GLM-4V',
    kind: 'openai-compat',
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    label: 'OpenAI Vision (gpt-4o-mini)',
    kind: 'openai-compat',
  },
  qwen: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-vl-plus',
    apiKeyEnv: 'QWEN_API_KEY',
    label: '通义千问 VL',
    kind: 'openai-compat',
  },
  doubao: {
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: '', // 必填接入点
    apiKeyEnv: 'DOUBAO_API_KEY',
    label: '豆包视觉 (Volcengine Ark)',
    kind: 'openai-compat',
    note: '需在 VISION_MODEL 填火山方舟接入点 ID（ep-xxx）',
  },
  anthropic: {
    baseURL: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-6',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    label: 'Anthropic Claude (vision)',
    kind: 'anthropic-native',
  },
};

const PROMPT = '请详细描述这张图片：主体、场景、颜色、氛围、情绪等。用中文，控制在 100 字以内。';

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
  return (readSetting('VISION_PROVIDER') || 'zhipu').toLowerCase();
}
function getApiKeyForEntry(entry) {
  return entry ? readSetting(entry.apiKeyEnv) || null : null;
}
function getModelFor(entry) {
  return readSetting('VISION_MODEL') || entry?.defaultModel || '';
}

// 通用 OpenAI-Compatible vision call —— 国内大模型几乎都遵循这套格式
async function openaiCompatVision({ baseURL, apiKey, model, dataUrl, signal }) {
  const resp = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
      temperature: 0.3,
    }),
    signal: signal || AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`Vision HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function anthropicVision({ apiKey, model, base64, mimeType, signal }) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    }),
    signal: signal || AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`Anthropic vision HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

export async function visionRecognize(imageBuffer, mimeType = 'image/jpeg') {
  const name = getActiveProviderName();
  const entry = REGISTRY[name];
  if (!entry) {
    log('error', `[vision] 未知 VISION_PROVIDER=${name}`);
    return '[图片识别失败]';
  }
  const apiKey = getApiKeyForEntry(entry);
  if (!apiKey) {
    log('error', `[vision] ${entry.apiKeyEnv} 未配置`);
    return '[图片识别失败]';
  }
  const model = getModelFor(entry);
  if (!model) {
    log('error', `[vision] ${entry.label} 未指定模型`);
    return '[图片识别失败]';
  }

  const base64 = imageBuffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;
  log('debug', `[vision] provider=${name} model=${model} size=${imageBuffer.length}`);
  try {
    if (entry.kind === 'anthropic-native') {
      return await anthropicVision({ apiKey, model, base64, mimeType });
    }
    return await openaiCompatVision({ baseURL: entry.baseURL, apiKey, model, dataUrl });
  } catch (err) {
    log('error', `[vision] 失败: ${err.message}`);
    return '[图片识别失败]';
  }
}

export function getActiveVisionProvider() {
  const name = getActiveProviderName();
  const entry = REGISTRY[name];
  return {
    id: name,
    label: entry?.label,
    model: getModelFor(entry),
    configured: Boolean(entry && getApiKeyForEntry(entry) && getModelFor(entry)),
  };
}

/**
 * 测试 vision provider 连通性。发一张 1×1 像素 PNG，要求一个词的描述。
 * 超时 15 秒。
 */
export async function testVisionProvider(name) {
  const entry = REGISTRY[name];
  if (!entry) throw new Error(`未知 vision provider: ${name}`);
  const apiKey = getApiKeyForEntry(entry);
  if (!apiKey) throw new Error(`${entry.label} 的 ${entry.apiKeyEnv} 未配置`);
  const model = getModelFor(entry);
  if (!model) throw new Error(`${entry.label} 未指定模型`);

  // 透明 1×1 PNG (67 bytes base64)
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const dataUrl = `data:image/png;base64,${pngBase64}`;
  const t0 = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    if (entry.kind === 'anthropic-native') {
      await anthropicVision({
        apiKey,
        model,
        base64: pngBase64,
        mimeType: 'image/png',
        signal: controller.signal,
      });
    } else {
      await openaiCompatVision({
        baseURL: entry.baseURL,
        apiKey,
        model,
        dataUrl,
        signal: controller.signal,
      });
    }
    return { ok: true, provider: name, label: entry.label, latency_ms: Date.now() - t0 };
  } finally {
    clearTimeout(timeout);
  }
}
