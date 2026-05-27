/**
 * 文本 embedding 提供商抽象
 *
 * 支持的 provider：
 *   - gemini    Google gemini-embedding-001 (默认；可截断维度)
 *   - openai    text-embedding-3-small
 *   - zhipu     embedding-3
 *   - qwen      text-embedding-v3 (DashScope)
 *
 * 切换：EMBEDDING_PROVIDER=...
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from '../logger.mjs';
import { GoogleGenerativeAI } from '@google/generative-ai';

const ACTIVE = (process.env.EMBEDDING_PROVIDER || 'gemini').toLowerCase();
const DIM = Number(process.env.EMBEDDING_DIM) || 768;

async function geminiEmbed(text) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY 未配置');
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({
    model: process.env.EMBEDDING_MODEL || 'gemini-embedding-001',
  });
  const result = await model.embedContent({
    content: { parts: [{ text }] },
    outputDimensionality: DIM,
  });
  return result?.embedding?.values || null;
}

async function openaiCompatEmbed({ baseURL, apiKey, model, text }) {
  const resp = await fetch(`${baseURL}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`embedding HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) return null;
  // 若超过期望维度则截断（OpenAI text-embedding-3 默认 1536，可比 DIM 长）
  return vec.slice(0, DIM);
}

export async function embedText(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim().slice(0, 2000);
  if (!trimmed) return null;
  try {
    switch (ACTIVE) {
      case 'gemini':
        return await geminiEmbed(trimmed);
      case 'openai':
        return await openaiCompatEmbed({
          baseURL: 'https://api.openai.com/v1',
          apiKey: process.env.OPENAI_API_KEY,
          model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
          text: trimmed,
        });
      case 'zhipu':
        return await openaiCompatEmbed({
          baseURL: 'https://open.bigmodel.cn/api/paas/v4',
          apiKey: process.env.ZHIPU_API_KEY,
          model: process.env.EMBEDDING_MODEL || 'embedding-3',
          text: trimmed,
        });
      case 'qwen':
        return await openaiCompatEmbed({
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKey: process.env.QWEN_API_KEY,
          model: process.env.EMBEDDING_MODEL || 'text-embedding-v3',
          text: trimmed,
        });
      default:
        throw new Error(`未知 EMBEDDING_PROVIDER=${ACTIVE}`);
    }
  } catch (err) {
    log('warn', `[embedding] 失败: ${err.message}`);
    return null;
  }
}

export function getActiveEmbeddingProvider() {
  return { id: ACTIVE, model: process.env.EMBEDDING_MODEL || '(默认)', dim: DIM };
}
