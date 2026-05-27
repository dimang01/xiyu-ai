/**
 * 图片识别 (Vision/multimodal) 提供商抽象
 *
 * 支持的 provider：
 *   - zhipu    智谱 GLM-4V (默认；国内速度好)
 *   - openai   OpenAI gpt-4o
 *   - qwen     通义千问 qwen-vl
 *   - doubao   豆包视觉
 *   - anthropic Claude (有视觉能力)
 *
 * 切换：VISION_PROVIDER=...
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from '../logger.mjs';

const ACTIVE = (process.env.VISION_PROVIDER || 'zhipu').toLowerCase();
const PROMPT = '请详细描述这张图片：主体、场景、颜色、氛围、情绪等。用中文，控制在 100 字以内。';

// 通用 OpenAI-Compatible vision call —— 国内大模型几乎都遵循这套格式
async function openaiCompatVision({ baseURL, apiKey, model, dataUrl }) {
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
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`Vision HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function anthropicVision({ apiKey, model, base64, mimeType }) {
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
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`Anthropic vision HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

export async function visionRecognize(imageBuffer, mimeType = 'image/jpeg') {
  const base64 = imageBuffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;
  log('debug', `[vision] provider=${ACTIVE} size=${imageBuffer.length}`);
  try {
    switch (ACTIVE) {
      case 'zhipu': {
        const key = process.env.ZHIPU_API_KEY;
        if (!key) throw new Error('ZHIPU_API_KEY 未配置');
        return await openaiCompatVision({
          baseURL: 'https://open.bigmodel.cn/api/paas/v4',
          apiKey: key,
          model: process.env.VISION_MODEL || process.env.ZHIPU_VISION_MODEL || 'glm-4v-flash',
          dataUrl,
        });
      }
      case 'openai': {
        const key = process.env.OPENAI_API_KEY;
        if (!key) throw new Error('OPENAI_API_KEY 未配置');
        return await openaiCompatVision({
          baseURL: 'https://api.openai.com/v1',
          apiKey: key,
          model: process.env.VISION_MODEL || 'gpt-4o-mini',
          dataUrl,
        });
      }
      case 'qwen': {
        const key = process.env.QWEN_API_KEY;
        if (!key) throw new Error('QWEN_API_KEY 未配置');
        return await openaiCompatVision({
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKey: key,
          model: process.env.VISION_MODEL || 'qwen-vl-plus',
          dataUrl,
        });
      }
      case 'doubao': {
        const key = process.env.DOUBAO_API_KEY;
        const model = process.env.VISION_MODEL;
        if (!key || !model) throw new Error('豆包视觉需 DOUBAO_API_KEY + VISION_MODEL=接入点ID');
        return await openaiCompatVision({
          baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
          apiKey: key,
          model,
          dataUrl,
        });
      }
      case 'anthropic': {
        const key = process.env.ANTHROPIC_API_KEY;
        if (!key) throw new Error('ANTHROPIC_API_KEY 未配置');
        return await anthropicVision({
          apiKey: key,
          model: process.env.VISION_MODEL || 'claude-sonnet-4-6',
          base64,
          mimeType,
        });
      }
      default:
        throw new Error(`未知 VISION_PROVIDER=${ACTIVE}`);
    }
  } catch (err) {
    log('error', `[vision] 失败: ${err.message}`);
    return '[图片识别失败]';
  }
}

export function getActiveVisionProvider() {
  return { id: ACTIVE, model: process.env.VISION_MODEL || '(默认)' };
}
