/**
 * Chat 提供商抽象层
 *
 * 大部分国内外大模型都已兼容 OpenAI Chat Completions 协议
 *（请求/响应字段一致，只需换 baseURL + apiKey + 模型名），
 * 因此本文件把它们统一注册成 "OpenAI-compatible" 类，
 * 单独处理 Anthropic（因为它字段不同）。
 *
 * 使用方式：在 .env 中设置
 *   CHAT_PROVIDER=deepseek | openai | anthropic | xai | zhipu | doubao | qwen | kimi | wenxin
 *   CHAT_MODEL=<模型名，留空用默认>
 *   <PROVIDER>_API_KEY=<对应 key>
 *
 * 切换 provider 完全无需改业务代码。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import OpenAI from 'openai';
import { log } from '../logger.mjs';

// ─── Provider 注册表 ───────────────────────────────────────────────────────
// 每条记录：{ baseURL, defaultModel, apiKeyEnv, label }
// 添加新 provider 时只需新增一行（仅限 OpenAI 兼容协议）。
const REGISTRY = {
  deepseek: {
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek',
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    label: 'OpenAI (ChatGPT)',
  },
  xai: {
    baseURL: 'https://api.x.ai/v1',
    defaultModel: 'grok-2-latest',
    apiKeyEnv: 'XAI_API_KEY',
    label: 'xAI Grok',
  },
  zhipu: {
    // 智谱 GLM 系列，OpenAI 兼容端点
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    apiKeyEnv: 'ZHIPU_API_KEY',
    label: '智谱 GLM',
  },
  doubao: {
    // 字节豆包 / 火山方舟，OpenAI 兼容
    // 注意：CHAT_MODEL 必须是火山方舟控制台里的"接入点 ID"（ep-xxx）
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: '',
    apiKeyEnv: 'DOUBAO_API_KEY',
    label: '豆包 (Volcengine Ark)',
  },
  qwen: {
    // 阿里通义千问 DashScope，OpenAI 兼容
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    apiKeyEnv: 'QWEN_API_KEY',
    label: '通义千问 (DashScope)',
  },
  kimi: {
    // 月之暗面 Kimi
    baseURL: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    apiKeyEnv: 'KIMI_API_KEY',
    label: 'Kimi (Moonshot)',
  },
  wenxin: {
    // 百度文心 / 千帆，OpenAI 兼容端点
    baseURL: 'https://qianfan.baidubce.com/v2',
    defaultModel: 'ernie-4.0-8k',
    apiKeyEnv: 'WENXIN_API_KEY',
    label: '文心一言 (百度千帆)',
  },
};

const ACTIVE = (process.env.CHAT_PROVIDER || 'deepseek').toLowerCase();

// ─── Anthropic 单独走原生协议（messages API） ─────────────────────────────
async function anthropicChat({ system, messages, model, temperature, max_tokens, top_p, signal }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 未配置');
  const usedModel = model || process.env.CHAT_MODEL || 'claude-sonnet-4-6';

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
  // 提取文本（content 是 block 数组）
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

// ─── 工厂：返回当前 provider 的 client ─────────────────────────────────────
let _client = null;
function getOpenAIClient() {
  if (_client) return _client;
  const entry = REGISTRY[ACTIVE];
  if (!entry) {
    throw new Error(`未知 CHAT_PROVIDER=${ACTIVE}。可选：${Object.keys(REGISTRY).join(', ')} 或 anthropic`);
  }
  const apiKey = process.env[entry.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`${entry.label} 需要 ${entry.apiKeyEnv}，请配置 .env`);
  }
  _client = new OpenAI({ apiKey, baseURL: entry.baseURL });
  log('info', `[chat] 启用 provider=${ACTIVE} (${entry.label}) baseURL=${entry.baseURL}`);
  return _client;
}

function activeModel() {
  if (ACTIVE === 'anthropic') return process.env.CHAT_MODEL || 'claude-sonnet-4-6';
  const entry = REGISTRY[ACTIVE];
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
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout_ms);
  try {
    if (ACTIVE === 'anthropic') {
      return await anthropicChat({
        system,
        messages,
        model: activeModel(),
        temperature,
        max_tokens,
        top_p,
        signal: controller.signal,
      });
    }
    const client = getOpenAIClient();
    const model = activeModel();
    if (!model) {
      throw new Error(
        `${REGISTRY[ACTIVE].label} 未指定模型。请设置 CHAT_MODEL=... ` +
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
  return { id: ACTIVE, label: ACTIVE === 'anthropic' ? 'Anthropic Claude' : REGISTRY[ACTIVE]?.label, model: activeModel() };
}
