/**
 * Chat 提供商抽象层
 *
 * 大部分国内外大模型都已兼容 OpenAI Chat Completions 协议
 *（请求/响应字段一致，只需换 baseURL + apiKey + 模型名），
 * 因此本文件把它们统一注册成 "OpenAI-compatible" 类，
 * 单独处理 Anthropic（因为它字段不同）。
 *
 * 使用方式：
 *   1. 优先读取 process.env（.env 文件或环境变量）
 *   2. 其次读取 SQLite app_settings（通过 /app/setup.html 写入）
 *   3. 两者都没有时 provider disabled，聊天时返回友好错误
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import OpenAI from 'openai';
import { log } from '../logger.mjs';
import { getAppSetting } from '../db.mjs';

// ─── Provider 注册表 ───────────────────────────────────────────────────────
// 每条记录：{ baseURL, defaultModel, apiKeyEnv, label }
// 添加新 provider 时只需新增一行（仅限 OpenAI 兼容协议）。
export const REGISTRY = {
  deepseek: {
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek',
    link: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    recommended: true,
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    label: 'OpenAI (ChatGPT)',
    link: 'https://platform.openai.com/api-keys',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4-turbo', 'o4-mini'],
  },
  anthropic: {
    // Anthropic 走原生协议（非 OpenAI 兼容），baseURL 仅作展示
    baseURL: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-6',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    label: 'Anthropic Claude',
    link: 'https://console.anthropic.com/',
    models: ['claude-sonnet-4-6', 'claude-opus-4', 'claude-haiku-4-5'],
    native: true,
  },
  gemini: {
    // Gemini 走 generateContent 原生协议（非 OpenAI 兼容）
    baseURL: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.5-flash',
    apiKeyEnv: 'GEMINI_API_KEY',
    label: 'Google Gemini',
    link: 'https://aistudio.google.com/apikey',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro'],
    native: true,
  },
  xai: {
    baseURL: 'https://api.x.ai/v1',
    defaultModel: 'grok-2-latest',
    apiKeyEnv: 'XAI_API_KEY',
    label: 'xAI Grok',
    link: 'https://console.x.ai/',
    models: ['grok-2-latest', 'grok-2-vision-latest', 'grok-beta'],
  },
  zhipu: {
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    apiKeyEnv: 'ZHIPU_API_KEY',
    label: '智谱 GLM',
    link: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: ['glm-4-flash', 'glm-4.5', 'glm-4.5-air', 'glm-4-plus', 'glm-4-air'],
  },
  doubao: {
    // 注意：CHAT_MODEL 必须是火山方舟控制台里的"接入点 ID"（ep-xxx）
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: '',
    apiKeyEnv: 'DOUBAO_API_KEY',
    label: '豆包 (Volcengine Ark)',
    link: 'https://console.volcengine.com/ark',
    note: 'CHAT_MODEL 必须填火山方舟接入点 ID（ep-xxx）',
    models: [],  // 必须自定义接入点 ID
  },
  qwen: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    apiKeyEnv: 'QWEN_API_KEY',
    label: '通义千问 (DashScope)',
    link: 'https://dashscope.console.aliyun.com/apiKey',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen2.5-72b-instruct', 'qwen2.5-7b-instruct'],
  },
  kimi: {
    baseURL: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    apiKeyEnv: 'KIMI_API_KEY',
    label: 'Kimi (Moonshot)',
    link: 'https://platform.moonshot.cn/console/api-keys',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2-0905-preview'],
  },
  wenxin: {
    baseURL: 'https://qianfan.baidubce.com/v2',
    defaultModel: 'ernie-4.0-8k',
    apiKeyEnv: 'WENXIN_API_KEY',
    label: '文心一言 (百度千帆)',
    link: 'https://qianfan.cloud.baidu.com/',
    models: ['ernie-4.0-8k', 'ernie-4.0-turbo-8k', 'ernie-speed-128k', 'ernie-tiny-8k'],
  },
  minimax: {
    baseURL: 'https://api.minimax.chat/v1',
    defaultModel: 'MiniMax-Text-01',
    apiKeyEnv: 'MINIMAX_API_KEY',
    label: 'MiniMax 海螺',
    link: 'https://platform.minimaxi.com/',
    models: ['MiniMax-Text-01', 'abab6.5s-chat', 'abab6.5-chat', 'abab5.5-chat'],
  },
  stepfun: {
    baseURL: 'https://api.stepfun.com/v1',
    defaultModel: 'step-2-16k',
    apiKeyEnv: 'STEPFUN_API_KEY',
    label: '阶跃星辰 StepFun',
    link: 'https://platform.stepfun.com/',
    models: ['step-2-16k', 'step-1-8k', 'step-1-32k', 'step-1v-8k'],
  },
  // 通用 OpenAI 兼容网关：用户自定义 Base URL + Model + API Key。
  // 适用于 OpenRouter / SiliconFlow / One API / New API / LiteLLM /
  // LM Studio / Ollama OpenAI 兼容端点等。不保证所有平台都完全兼容。
  'openai-compatible': {
    baseURL: '',           // 动态：env OPENAI_COMPATIBLE_BASE_URL > app_settings
    defaultModel: '',      // 动态：env OPENAI_COMPATIBLE_MODEL > app_settings
    apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
    label: 'OpenAI Compatible (自定义)',
    link: '',
    custom: true,
    baseURLEnv: 'OPENAI_COMPATIBLE_BASE_URL',
    modelEnv: 'OPENAI_COMPATIBLE_MODEL',
    note: '可用于 OpenRouter / SiliconFlow / One API / LiteLLM 等 OpenAI 兼容网关',
  },
};

// ─── 动态读取：env 优先，其次 app_settings ─────────────────────────────────

// 通用：env > app_settings > '' 优先级
function readSetting(key) {
  if (process.env[key]) return process.env[key];
  try {
    const v = getAppSetting(key);
    if (v) return v;
  } catch {}
  return '';
}

function getActiveProviderName() {
  const v = readSetting('CHAT_PROVIDER');
  return v ? v.toLowerCase() : 'deepseek';
}

function getApiKeyForEntry(entry) {
  if (!entry) return null;
  if (process.env[entry.apiKeyEnv]) return process.env[entry.apiKeyEnv];
  try {
    const stored = getAppSetting(entry.apiKeyEnv);
    if (stored) return stored;
  } catch {}
  return null;
}

// 仅对自定义兼容 provider 用：动态读取 base URL 与 model。
function getDynamicBaseURL(entry) {
  if (!entry?.baseURLEnv) return entry?.baseURL || '';
  if (process.env[entry.baseURLEnv]) return process.env[entry.baseURLEnv];
  try {
    const stored = getAppSetting(entry.baseURLEnv);
    if (stored) return stored;
  } catch {}
  return '';
}
function getDynamicModel(entry) {
  if (!entry?.modelEnv) return entry?.defaultModel || '';
  if (process.env[entry.modelEnv]) return process.env[entry.modelEnv];
  try {
    const stored = getAppSetting(entry.modelEnv);
    if (stored) return stored;
  } catch {}
  return '';
}

// ─── Anthropic 单独走原生协议（messages API） ─────────────────────────────
async function anthropicChat({ system, messages, model, temperature, max_tokens, top_p, signal }) {
  const entry = REGISTRY.anthropic;
  const apiKey = getApiKeyForEntry(entry);
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 未配置，请在 /app/setup.html 中填写');
  const usedModel = model || process.env.CHAT_MODEL || entry.defaultModel;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: usedModel,
      max_tokens: max_tokens || 2000,
      temperature,
      top_p,
      system,
      messages,
    }),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return {
    text,
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
    },
  };
}

// ─── Gemini 单独走原生协议（generateContent） ─────────────────────────────
// 把 OpenAI 风格的 {system, messages:[{role, content}]} 转成 Gemini 的
// {systemInstruction, contents:[{role:'user'|'model', parts:[{text}]}]}
async function geminiChat({ system, messages, model, temperature, max_tokens, top_p, signal }) {
  const entry = REGISTRY.gemini;
  const apiKey = getApiKeyForEntry(entry);
  if (!apiKey) throw new Error('GEMINI_API_KEY 未配置，请在 /app/setup.html 中填写');
  const usedModel = model || process.env.CHAT_MODEL || entry.defaultModel;

  const contents = (messages || []).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content ?? '') }],
  }));
  const body = {
    contents,
    generationConfig: {
      temperature,
      topP: top_p,
      maxOutputTokens: max_tokens || 2000,
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(usedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();
  return {
    text,
    usage: {
      prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}

// ─── 工厂：按 provider 名返回 OpenAI-compatible client ────────────────────
// 缓存 key = providerName（每次调用时若 apiKey 变了会重建 client）
const _clientCache = new Map(); // name -> { key, client }

function getOpenAIClientFor(name) {
  const entry = REGISTRY[name];
  if (!entry) {
    throw new Error(`未知 CHAT_PROVIDER=${name}。可选：${Object.keys(REGISTRY).join(', ')}`);
  }
  const apiKey = getApiKeyForEntry(entry);
  if (!apiKey) {
    throw new Error(`${entry.label} 需要 ${entry.apiKeyEnv}，请在 .env 或 /app/setup.html 中配置`);
  }
  const baseURL = entry.custom ? getDynamicBaseURL(entry) : entry.baseURL;
  if (entry.custom && !baseURL) {
    throw new Error(`${entry.label} 需要 ${entry.baseURLEnv}，请在 /app/setup.html 中配置 Base URL`);
  }
  // 自定义兼容 provider 的缓存 key 需包含 baseURL（key 或 baseURL 变化都要重建）
  const cacheKey = entry.custom ? `${apiKey}::${baseURL}` : apiKey;
  const cached = _clientCache.get(name);
  if (cached && cached.key === cacheKey) return cached.client;
  const client = new OpenAI({ apiKey, baseURL });
  _clientCache.set(name, { key: cacheKey, client });
  log('info', `[chat] provider=${name} (${entry.label}) client 已创建`);
  return client;
}

function activeModel(name) {
  if (!name) name = getActiveProviderName();
  const entry = REGISTRY[name];
  const overrideModel = readSetting('CHAT_MODEL');
  if (overrideModel) return overrideModel;
  if (entry?.custom) return getDynamicModel(entry) || '';
  return entry?.defaultModel || '';
}

// ─── 统一对外接口 ──────────────────────────────────────────────────────────

/**
 * 通用 chat 调用。
 * @param {Object} opts
 * @param {string} opts.system    system prompt
 * @param {Array}  opts.messages  [{role:'user'|'assistant', content:string}]
 * @param {number} opts.temperature
 * @param {number} opts.max_tokens
 * @param {number} opts.top_p
 * @param {number} opts.timeout_ms
 * @returns {Promise<{text:string, usage:{prompt_tokens,completion_tokens}}>}
 */
export async function chatComplete({
  system,
  messages,
  temperature = 0.7,
  max_tokens = 2000,
  top_p = 0.9,
  timeout_ms = 30_000,
} = {}) {
  const name = getActiveProviderName();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout_ms);
  try {
    if (name === 'anthropic') {
      return await anthropicChat({
        system,
        messages,
        model: activeModel(name),
        temperature,
        max_tokens,
        top_p,
        signal: controller.signal,
      });
    }
    if (name === 'gemini') {
      return await geminiChat({
        system,
        messages,
        model: activeModel(name),
        temperature,
        max_tokens,
        top_p,
        signal: controller.signal,
      });
    }
    const client = getOpenAIClientFor(name);
    const model = activeModel(name);
    if (!model) {
      throw new Error(
        `${REGISTRY[name]?.label || name} 未指定模型。请设置 CHAT_MODEL=... ` +
          `(豆包必须填火山方舟接入点 ID)`,
      );
    }
    const allMessages = [{ role: 'system', content: system }, ...messages];
    const resp = await client.chat.completions.create(
      { model, messages: allMessages, temperature, max_tokens, top_p },
      { signal: controller.signal },
    );
    return {
      text: (resp.choices?.[0]?.message?.content || '').trim(),
      usage: {
        prompt_tokens: resp.usage?.prompt_tokens || 0,
        completion_tokens: resp.usage?.completion_tokens || 0,
      },
    };
  } finally {
    clearTimeout(t);
  }
}

export function getActiveChatProvider() {
  const name = getActiveProviderName();
  return {
    id: name,
    label: REGISTRY[name]?.label,
    model: activeModel(name),
  };
}

/**
 * 测试指定 provider 的连通性（给 /api/setup/test-provider 用）。
 * 不改变 active provider；超时 15 秒；max_tokens 极小。
 */
export async function testChatProvider(name) {
  const entry = REGISTRY[name];
  if (!entry) throw new Error(`未知 provider: ${name}`);
  const apiKey = getApiKeyForEntry(entry);
  if (!apiKey) throw new Error(`${entry.label} 的 ${entry.apiKeyEnv} 未配置，请在 /app/setup.html 填写`);
  if (entry.custom && !getDynamicBaseURL(entry)) {
    throw new Error(`${entry.label} 的 ${entry.baseURLEnv} 未配置，请填写 Base URL`);
  }

  const t0 = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    if (name === 'anthropic') {
      await anthropicChat({
        system: 'Reply with exactly one word.',
        messages: [{ role: 'user', content: 'Say: ok' }],
        temperature: 0,
        max_tokens: 5,
        signal: controller.signal,
      });
    } else if (name === 'gemini') {
      await geminiChat({
        system: 'Reply with exactly one word.',
        messages: [{ role: 'user', content: 'Say: ok' }],
        temperature: 0,
        max_tokens: 5,
        signal: controller.signal,
      });
    } else {
      const client = getOpenAIClientFor(name);
      const model = activeModel(name) || entry.defaultModel || '';
      if (!model) {
        throw new Error(`${entry.label} 未指定模型，请在 /app/setup.html 填写 Model`);
      }
      await client.chat.completions.create(
        {
          model,
          messages: [
            { role: 'system', content: 'Reply with exactly one word.' },
            { role: 'user', content: 'Say: ok' },
          ],
          temperature: 0,
          max_tokens: 5,
        },
        { signal: controller.signal },
      );
    }
    return { ok: true, provider: name, label: entry.label, latency_ms: Date.now() - t0 };
  } finally {
    clearTimeout(timeout);
  }
}
