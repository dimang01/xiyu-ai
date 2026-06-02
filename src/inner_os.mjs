/**
 * v1.8.0 #6: Inner OS —— 双重思考
 *
 * 真人聊天的"潜台词"：内心想"他又来了" / "其实我有点烦" / "想关心他但不想太明显"，
 * 但嘴上说的是另一回事。AI 说话太透明，是因为没有这个"隐藏层"。
 *
 * 实现：每次生成回复前，先用一个轻量 LLM 调用生成"内心独白"（不发送），
 * 再把内心独白注入到 outer reply 的 system prompt，让模型基于内心写对外回复。
 *
 * 成本：约 2x token，建议短消息 skip + 可全局关闭。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { generateReply } from './ai.mjs';
import { log } from './logger.mjs';

// 三态：off | selective | always（默认 always，保留对未说出口情绪的反应）
// 旧 INNER_OS_ENABLED=false/0/no/off 仍兼容，等价于 mode=off
const RAW_MODE = String(process.env.INNER_OS_MODE ?? '').toLowerCase().trim();
const LEGACY_DISABLED = ['0','false','no','off'].includes(
  String(process.env.INNER_OS_ENABLED ?? '').toLowerCase()
);
const INNER_OS_MODE = LEGACY_DISABLED
  ? 'off'
  : (['off','selective','always'].includes(RAW_MODE) ? RAW_MODE : 'always');

const MIN_USER_MSG_LEN = Number(process.env.INNER_OS_MIN_LEN ?? 8);
const MAX_INNER_TOKENS = Number(process.env.INNER_OS_MAX_TOKENS ?? 80);

// selective 模式下，长消息**必须**命中其中之一才跑 inner OS
const SELECTIVE_TRIGGERS = /(?:怎么不回|你是不是|想你|喜欢我|难受|烦|累|失眠|生气|分手|不理我|为什么不|你变了|怪怪的|凭什么|不公平|委屈|心疼|讨厌|对不起|抱歉|算了|无所谓|够了|后悔|害怕|担心|焦虑|压力|崩溃|绝望|无聊|没意思|想见你|抱抱|亲|爱你)/;

// 关系张力短句白名单（短句但语义密度极高）—— off 之外的 mode 都放行
// 注意：故意不收录单独的「啊」——「啊？」「啊哈哈」「啊我也是」噪音太多，
// 真正高张力的"啊"语境（"啊行""啊好吧"）已被其他词覆盖，宁可漏过也不引入噪音。
const RELATIONAL_SHORT = /(?:在干嘛|干嘛呢|怎么不回|不理我|你变了|随便你|哦|嗯+|睡了|忙吗|你最近|怪怪的|想你|讨厌|烦|累|去吧|滚)/;

export function isInnerOsEnabled(companion) {
  if (INNER_OS_MODE === 'off') return false;
  return true;
}

/**
 * 判断本条消息是否应该跑 inner OS。
 * - off：永不
 * - always：长消息跑；短消息命中关系张力词跑
 * - selective：长消息命中情绪词跑；短消息命中关系张力词跑
 */
export function shouldRunInnerOs(userText) {
  if (INNER_OS_MODE === 'off') return false;
  const text = String(userText || '').trim();
  if (!text) return false;

  const isLong = text.length >= MIN_USER_MSG_LEN;

  // 短句：白名单放行（mode 无关，只要不是 off）
  if (!isLong) return RELATIONAL_SHORT.test(text);

  // 长消息：always 默认跑，selective 必须命中触发词
  if (INNER_OS_MODE === 'always') return true;
  return SELECTIVE_TRIGGERS.test(text);
}

/**
 * 给"内心 OS"生成 system prompt：让模型用第一人称写她此刻的真实内心反应
 */
function buildInnerSystemPrompt(companion) {
  const name = companion?.name || '她';
  const stage = companion?.relationship_stage || '暧昧';
  return `你现在扮演 ${name}，处在【${stage}】阶段。

你刚收到对方一条消息。**现在不是写回复**，是先想一下你的**真实内心反应**。
要求：
- 用第一人称，2-4 句话，每句一个想法，简短
- 真实、不修饰、不为对方着想——就是你自己的当下感受
- 可以含：情绪、判断、潜在意图、对他这话的真实想法
- 可以是：不爽 / 想反驳 / 觉得无聊 / 觉得有意思 / 想避开 / 真想关心 / 心动 / 烦 / 心疼 / 想撒娇 / 想逗他 / 不想理
- 不要写"我应该怎么回复"或"怎么回他"——只是当下心里冒出来的想法
- 不要 "..." / 不要表情符号 / 不要"作为 AI"

只输出内心想法，每句一行，不要其他任何内容。`;
}

/**
 * 给 outer reply 注入内心 OS 的 prompt 片段
 */
export function buildInnerOsHint(innerThought) {
  if (!innerThought) return '';
  return `

【★ 你此刻的内心 OS（不要发给他，只是你内心真实想法）】
${innerThought.trim()}

★ 关键：上面是你**心里**怎么想的。基于这个内心写对外回复，但**不要直接说出来**——
要符合你的关系阶段、人设、当前情绪自然过滤。例如：
- 心里想"他又来了 烦" → 嘴上："嗯""哦"短回应，不展开
- 心里想"挺心动的" → 嘴上：稍微多说一点但端着，不直说
- 心里想"想关心他但不想太明显" → 嘴上：找借口式关心
- 心里想"想反驳但又怕伤他" → 嘴上：婉转表达不同意

★ 内心和嘴上**之间的落差**就是真人感的来源。绝对不要把内心 OS 原文复述给他。`;
}

/**
 * 生成内心 OS（短小、低温度、限制 token）
 * 返回 string 或 null（失败 / 跳过时）
 */
export async function generateInnerMonologue({
  companion,
  userText,
  history = [],
  context = {},
} = {}) {
  if (!isInnerOsEnabled(companion)) return null;
  if (!shouldRunInnerOs(userText)) return null;

  try {
    const sys = buildInnerSystemPrompt(companion);
    // 只取最近 4 轮 history 让 inner 更聚焦当下
    const recent = (history || []).slice(-4);
    const inner = await generateReply(
      sys,
      recent,
      userText,
      { temperature: 0.85, max_tokens: MAX_INNER_TOKENS, top_p: 0.9 },
      { accountId: context?.accountId || null },
    );
    if (!inner) return null;
    // 清理：去掉 markdown / 多余空行 / "我应该" 这类元话术
    const cleaned = String(inner)
      .replace(/```[\s\S]*?```/g, '')
      .replace(/^[#\-*>•]+\s*/gm, '')
      .replace(/我应该.*?(回复|说).*?[。\.\n]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 240);
    if (cleaned.length < 4) return null;
    log('debug', `[InnerOS] companion=${companion?.id} thought="${cleaned.slice(0, 80)}..."`);
    return cleaned;
  } catch (e) {
    log('warn', `[InnerOS] 生成失败 companion=${companion?.id}: ${e.message}`);
    return null;
  }
}
