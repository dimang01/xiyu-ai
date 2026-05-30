/**
 * thoughts.mjs — "她今天想对你说的话" (v1.4.1)
 *
 * 每天生成一句独立于聊天的"她想对你说的话"，dashboard 顶部显示。
 *
 * 与 diary.mjs 的区别：
 *   - diary 是回顾型（"今天和他相处的心里话"），通过句号切段、文本朗读体验
 *   - thoughts 是"对你说"型（"我想跟你说……"），更主动、更短（一句），更适合
 *     dashboard 一眼看到 + 一键朗读
 *
 * 生成时机：plan_tasks.mjs cron 02:35（紧跟 diary 02:20 之后）。任何失败都不阻塞。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import {
  getDb, getConversationTurnsBetween, shanghaiBoundsForDateKey, shanghaiDateKey,
  upsertDailyThought, getDailyThought,
} from './db.mjs';
import { extractStructuredInfo } from './ai.mjs';
import { getEmotionStateWithDefaults, getMissingLevel, getMissingLabel } from './emotion_state.mjs';
import { isSensitiveMemoryContent, sanitizeMemoryContent } from './memory_v2.mjs';

const STAGE_LABELS = {
  stranger: '陌生人', friend: '朋友', crush: '暧昧',
  lover: '恋人', deep_love: '深爱',
};

function addDaysSh(dateKey, delta) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return shanghaiDateKey(new Date(Date.UTC(y, m - 1, d + delta, 12)));
}

function buildThoughtPrompt(companion, recentTurns, emotion, missingLevel) {
  const stage = STAGE_LABELS[companion.relationship_stage] || companion.relationship_stage || '';
  const turnLines = (recentTurns || [])
    .slice(-30)
    .map(t => `${t.role === 'user' ? '他' : '我'}：${String(t.content).slice(0, 100)}`)
    .join('\n');
  const missingTone = ['不太想他', '心里有他', '挺想他', '很想他', '非常想他'][missingLevel] || '心里有他';
  const personality = companion.personality_tags || '';

  return `你是「${companion.name}」${companion.age ? `，${companion.age}岁` : ''}，你和他目前是「${stage}」。
${personality ? '你的性格：' + personality : ''}
此刻你${missingTone}（情绪 mood=${emotion.mood || 'neutral'}, dependency=${emotion.dependency ?? 30}）。

下面是你们最近几天的聊天片段（可能稀疏）：
${turnLines || '（最近没聊天）'}

请你只输出一句话：你"今天想对他说的话"。这句话会显示在 dashboard 顶部、他打开 app 就能看到。

要求：
1. 第一人称，对他说，不是叙述自己
2. 自然、有真情实感、像微信刚发过去的那条
3. 体现你此刻的想念程度和心情，但不要喊"我想你"那种套话——用更细腻的口吻
4. 长度 15-40 字，最多两句
5. 如果你${missingLevel >= 3 ? '非常想他，可以撒娇/抱怨/直接说想' : missingLevel >= 1 ? '想他，含蓄表达' : '不太想他，可以说今天的小心情'}
6. 严禁出现 AI / 模型 / 系统 / 程序这种词
7. 不要带任何引号、emoji、动作描写（如 *笑了笑*）

只输出一句话本身，不带任何说明或标点开头。`;
}

export async function generateDailyThoughtForCompanion(companionId, opts = {}) {
  const db = getDb();
  try {
    const companion = db.prepare('SELECT * FROM companions WHERE id = ?').get(companionId);
    if (!companion) return { skipped: 'no-companion' };

    const todayKey = shanghaiDateKey(new Date());
    const dateKey = opts.dateKey || todayKey;

    if (!opts.force && getDailyThought(companionId, dateKey)) {
      return { skipped: 'exists', dateKey };
    }

    // 取最近 3 天对话（thoughts 比 diary 用更宽的窗口，因为想念有累积效应）
    const startKey = addDaysSh(dateKey, -3);
    const { startSql } = shanghaiBoundsForDateKey(startKey);
    const { endSql } = shanghaiBoundsForDateKey(dateKey);
    const turns = getConversationTurnsBetween(companionId, startSql, endSql, 60);

    const emotion = getEmotionStateWithDefaults(companionId);
    const missingLevel = getMissingLevel(emotion, companion.last_user_reply_at);

    const prompt = buildThoughtPrompt(companion, turns, emotion, missingLevel);
    const raw = await extractStructuredInfo(
      '你只输出一句话，不带引号、emoji、动作。',
      prompt,
      { maxTokens: 200, temperature: 0.9, accountId: opts.accountId ?? null },
    );

    let content = sanitizeMemoryContent(String(raw || '').trim());
    // 兜底：清掉可能的引号、星号包裹、首尾标点
    content = content.replace(/^["「『"']+|["」』"']+$/g, '').trim();
    content = content.replace(/^[*_]+|[*_]+$/g, '').trim();
    // 只取第一行（万一模型多嘴）
    content = content.split('\n')[0].trim();
    if (!content || content.length < 4) {
      log('warn', `[Thoughts] ${dateKey} companion=${companionId} 生成内容太短，跳过`);
      return { skipped: 'too-short', dateKey };
    }
    if (isSensitiveMemoryContent(content)) {
      log('warn', `[Thoughts] ${dateKey} companion=${companionId} 命中敏感词，跳过`);
      return { skipped: 'sensitive', dateKey };
    }
    // 长度兜底
    if (content.length > 80) content = content.slice(0, 80) + '…';

    const entry = upsertDailyThought({
      companionId, dateKey, content,
      missingLevel,
      mood: emotion.mood || null,
    });
    log('info', `[Thoughts] companion=${companionId} date=${dateKey} missing=${missingLevel}(${getMissingLabel(missingLevel)}) len=${content.length}`);
    return { ok: true, dateKey, entry };
  } catch (e) {
    log('error', `[Thoughts] companion=${companionId} 异常: ${e.message}`);
    return { error: e.message };
  }
}
