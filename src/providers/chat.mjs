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
    recommended: true,
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    label: 'OpenAI (ChatGPT)',
    link: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    // Anthropic 走原生协议（非 OpenAI 兼容），baseURL 仅作展示
    baseURL: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-6',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    label: 'Anthropic Claude',
    link: 'https://console.anthropic.com/',
    native: true,
  },
  xai: {
    baseURL: 'https://api.x.ai/v1',
    defaultModel: 'grok-2-latest',
    apiKeyEnv: 'XAI_API_KEY',
    label: 'xAI Grok',
    link: 'https://console.x.ai/',
  },
  zhipu: {
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    apiKeyEnv: 'ZHIPU_API_KEY',
    label: '智谱 GLM',
    link: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  doubao: {
    // 注意：CHAT_MODEL 必须是火山方舟控制台里的"接入点 ID"（ep-xxx）
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: '',
    apiKeyEnv: 'DOUBAO_API_KEY',
    label: '豆包 (Volcengine Ark)',
    link: 'https://console.volcengine.com/ark',
    note: 'CHAT_MODEL 必须填火山方舟接入点 ID（ep-xxx）',
  },
  qwen: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    apiKeyEnv: 'QWEN_API_KEY',
    label: '通义千问 (DashScope)',
    link: 'https://dashscope.console.aliyun.com/apiKey',
  },
  kimi: {
    baseURL: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    apiKeyEnv: 'KIMI_API_KEY',
    label: 'Kimi (Moonshot)',
    link: 'https://platform.moonshot.cn/console/api-keys',
  },
  wenxin: {
    baseURL: 'https://qianfan.baidubce.com/v2',
    defaultModel: 'ernie-4.0-8k',
    apiKeyEnv: 'WENXIN_API_KEY',
    label: '文心一言 (百度千帆)',
    link: 'https://qianfan.cloud.baidu.com/',
  },
};

// ─── 动态读取：env 优先，其次 app_settings ─────────────────────────────────

function getActiveProviderName() {
  if (process.env.CHAT_PROVIDER) return process.env.CHAT_PROVIDER.toLowerCase();
  try {
    const stored = getAppSetting('CHAT_PROVIDER');
    if (stored) return stored.toLowerCase();
  } catch {}
  return 'deepseek';
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
  const cached = _clientCache.get(name);
  if (cached && cached.key === apiKey) return cached.client;
  const client = new OpenAI({ apiKey, baseURL: entry.baseURL });
  _clientCache.set(name, { key: apiKey, client });
  log('info', `[chat] provider=${name} (${entry.label}) client 已创建`);
  return client;
}

function activeModel(name) {
  if (!name) name = getActiveProviderName();
  if (name === 'anthropic') return process.env.CHAT_MODEL || REGISTRY.anthropic.defaultModel;
  const entry = REGISTRY[name];
  return process.env.CHAT_MODEL || entry?.defaultModel || '';
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
    } else {
      const client = getOpenAIClientFor(name);
      const model = activeModel(name) || entry.defaultModel || 'gpt-4o-mini';
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
