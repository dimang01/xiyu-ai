/**
 * Image generation 提供商抽象层
 *
 * 支持的 provider（按国内常用优先）：
 *   - zhipu       智谱 CogView-4   （默认；OpenAI 兼容图像格式）
 *   - qwen        阿里通义万相      （DashScope wanx-v1，异步任务）
 *   - doubao      豆包 (火山方舟)    （OpenAI 兼容 image generation）
 *   - wenxin      百度文心一格      （AI Studio / 千帆 image API）
 *   - openai      OpenAI DALL-E/gpt-image-1
 *
 * 切换方式：.env 中 IMAGE_PROVIDER=zhipu/qwen/doubao/wenxin/openai
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from '../logger.mjs';

const ACTIVE = (process.env.IMAGE_PROVIDER || 'zhipu').toLowerCase();

// ─── 智谱 CogView ─────────────────────────────────────────────────────────
async function zhipuGenerate(prompt, size) {
  const key = process.env.ZHIPU_API_KEY;
  if (!key) throw new Error('ZHIPU_API_KEY 未配置');
  const model = process.env.IMAGE_MODEL || process.env.ZHIPU_IMAGE_MODEL || 'cogview-4';
  const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, size }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`Zhipu HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const url = data?.data?.[0]?.url;
  if (!url) throw new Error('Zhipu 响应无 URL');
  return url;
}

// ─── 通义万相（DashScope，异步任务模式） ──────────────────────────────────
async function qwenGenerate(prompt, size) {
  const key = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY;
  if (!key) throw new Error('QWEN_API_KEY 未配置');
  const model = process.env.IMAGE_MODEL || 'wanx-v1';
  // 1. 提交任务
  const create = await fetch(
    'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify({
        model,
        input: { prompt },
        parameters: { size: size.replace('x', '*'), n: 1 },
      }),
    },
  );
  if (!create.ok) throw new Error(`Qwen create HTTP ${create.status}: ${(await create.text()).slice(0, 200)}`);
  const { output } = await create.json();
  const taskId = output?.task_id;
  if (!taskId) throw new Error('Qwen 未返回 task_id');
  // 2. 轮询
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const q = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const { output: o } = await q.json();
    if (o?.task_status === 'SUCCEEDED') {
      const url = o.results?.[0]?.url;
      if (!url) throw new Error('Qwen SUCCEEDED 但无 URL');
      return url;
    }
    if (o?.task_status === 'FAILED') throw new Error(`Qwen FAILED: ${o.message || ''}`);
  }
  throw new Error('Qwen 任务超时');
}

// ─── 豆包图像（火山方舟 OpenAI 兼容） ─────────────────────────────────────
async function doubaoGenerate(prompt, size) {
  const key = process.env.DOUBAO_API_KEY;
  if (!key) throw new Error('DOUBAO_API_KEY 未配置');
  const model = process.env.IMAGE_MODEL;
  if (!model) throw new Error('豆包图像需 IMAGE_MODEL=接入点ID');
  const resp = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, size, response_format: 'url' }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`Doubao HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const url = data?.data?.[0]?.url;
  if (!url) throw new Error('Doubao 响应无 URL');
  return url;
}

// ─── 百度文心一格（千帆） ─────────────────────────────────────────────────
async function wenxinGenerate(prompt, size) {
  const key = process.env.WENXIN_API_KEY;
  if (!key) throw new Error('WENXIN_API_KEY 未配置');
  const model = process.env.IMAGE_MODEL || 'irag-1.0';
  // 千帆 v2 OpenAI 兼容图像接口
  const resp = await fetch('https://qianfan.baidubce.com/v2/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, size }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`Wenxin HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const url = data?.data?.[0]?.url;
  if (!url) throw new Error('Wenxin 响应无 URL');
  return url;
}

// ─── OpenAI DALL-E / gpt-image-1 ─────────────────────────────────────────
async function openaiGenerate(prompt, size) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY 未配置');
  const model = process.env.IMAGE_MODEL || 'gpt-image-1';
  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, size, n: 1 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  // 兼容 url 或 b64_json
  if (data?.data?.[0]?.url) return data.data[0].url;
  if (data?.data?.[0]?.b64_json) return `data:image/png;base64,${data.data[0].b64_json}`;
  throw new Error('OpenAI 响应无 URL/base64');
}

const REGISTRY = {
  zhipu: zhipuGenerate,
  qwen: qwenGenerate,
  doubao: doubaoGenerate,
  wenxin: wenxinGenerate,
  openai: openaiGenerate,
};

/**
 * 统一生图接口。返回图片 URL（或 base64 data URL）。
 */
export async function imageGenerate(prompt, { size = '1024x1024' } = {}) {
  const fn = REGISTRY[ACTIVE];
  if (!fn) throw new Error(`未知 IMAGE_PROVIDER=${ACTIVE}。可选：${Object.keys(REGISTRY).join(', ')}`);
  log('debug', `[image] provider=${ACTIVE} size=${size}`);
  return await fn(prompt, size);
}

export function getActiveImageProvider() {
  return { id: ACTIVE, model: process.env.IMAGE_MODEL || '(默认)' };
}

export function getImageProviderCapabilities(providerName = ACTIVE) {
  const id = String(providerName || ACTIVE || '').toLowerCase();
  return {
    provider: id,
    textToImage: Boolean(REGISTRY[id]),
    imageToImage: false,
    referenceImage: false,
  };
}
