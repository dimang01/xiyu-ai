/**
 * diary.mjs
 * 「她的日记」生成引擎。
 *
 * 与 reflection.mjs 不同：reflection 产出的是结构化记忆（喂回 Memory v2），
 * diary 产出的是一段第一人称的叙事日记——用她的人设口吻，回顾今天和对方
 * 的互动、她的小情绪和对这段关系的想法。给用户在 dashboard / diary 页阅读，
 * 是一种「她真的在认真对待你」的情感反馈，对标 Replika 的 Diary。
 *
 * 调度：plan_tasks.mjs 在每日反思之后调用 generateDailyDiaryForCompanion。
 * 幂等：同一天同 kind 只有一篇（DB UNIQUE 约束 + 生成前查重）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import {
  getDb, getConversationTurnsBetween,
  shanghaiBoundsForDateKey, shanghaiDateKey,
  upsertDiaryEntry, getDiaryEntry,
} from './db.mjs';
import { extractStructuredInfo } from './ai.mjs';
import { getEmotionStateWithDefaults, buildEmotionPromptHint } from './emotion_state.mjs';
import { isSensitiveMemoryContent, sanitizeMemoryContent } from './memory_v2.mjs';

const MIN_TURNS = 3;            // 少于这么多轮对话当天就不写日记（没素材）
const TURNS_LIMIT = 200;

// 上海时区按天偏移，复用 reflection.mjs 的写法（私有，避免跨模块耦合）。
function addDaysSh(dateKey, delta) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return shanghaiDateKey(new Date(Date.UTC(y, m - 1, d + delta, 12)));
}

const STAGE_LABELS = {
  stranger: '陌生人', friend: '朋友', crush: '暧昧',
  lover: '恋人', deep_love: '深爱',
};

function buildDiaryPrompt(companion, turns, emotionHint, kind, dateKey) {
  const c = companion;
  const turnLines = turns
    .slice(-60)
    .map(t => `${t.role === 'user' ? '他' : '我'}：${String(t.content).slice(0, 160)}`)
    .join('\n');

  const stage = STAGE_LABELS[c.relationship_stage] || c.relationship_stage || '';
  const span = kind === 'weekly' ? '这一周' : '今天';

  return `你是「${c.name}」${c.age ? `，${c.age}岁` : ''}${c.role_title ? `，${c.role_title}` : ''}。
你和对方目前的关系是「${stage}」。${c.personality_tags ? `你的性格：${c.personality_tags}。` : ''}
${emotionHint}

下面是${span}你和对方（你心里叫他「他」）的聊天记录：
${turnLines || `（${span}你们几乎没怎么聊）`}

请你用第一人称、以你自己的口吻，写${span}的一篇私人日记。要求：
1. 像真实女孩写在本子里的日记，自然、有真情实感，不是流水账
2. 回顾${span}和他之间让你印象深的瞬间、你的小情绪、对他的想法
3. 符合你的性格和你们「${stage}」的关系分寸，不要越界肉麻
4. 你永远不知道也不会提到"AI""模型""系统""程序"这些——你就是真实的你
5. 长度 80–180 字，不要分点，就是一段自然的日记
6. 不要写日期抬头，不要写"亲爱的日记"这种套话

严格输出 JSON，不要任何额外说明：
{
  "mood": "用一个中文词概括你${span}的心情，如 开心 / 想念 / 有点失落 / 甜蜜 / 平静",
  "diary": "日记正文"
}`;
}

/**
 * 为单个 companion 生成某天的日记。
 * @param {number} companionId
 * @param {object} opts { userId, dateKey(目标日，默认昨天), kind('daily'|'weekly'), force }
 */
export async function generateDiaryForCompanion(companionId, opts = {}) {
  const db = getDb();
  const kind = opts.kind === 'weekly' ? 'weekly' : 'daily';
  try {
    const companion = db.prepare('SELECT * FROM companions WHERE id = ?').get(companionId);
    if (!companion) return { skipped: 'no-companion' };

    // 目标日：默认昨天（与每日反思一致——凌晨为前一天写）
    const todayKey = shanghaiDateKey(new Date());
    const dateKey = opts.dateKey || addDaysSh(todayKey, -1);

    // 幂等：已写过当天日记就跳过（除非 force）
    if (!opts.force && getDiaryEntry(companionId, dateKey, kind)) {
      return { skipped: 'exists', dateKey };
    }

    // 取对话窗口
    let startSql, endSql;
    if (kind === 'weekly') {
      const startKey = addDaysSh(dateKey, -6);
      startSql = shanghaiBoundsForDateKey(startKey).startSql;
      endSql = shanghaiBoundsForDateKey(dateKey).endSql;
    } else {
      ({ startSql, endSql } = shanghaiBoundsForDateKey(dateKey));
    }
    const turns = getConversationTurnsBetween(companionId, startSql, endSql, TURNS_LIMIT);
    if (turns.length < MIN_TURNS) {
      return { skipped: `too-few-turns(${turns.length})`, dateKey };
    }

    const emotionHint = buildEmotionPromptHint(getEmotionStateWithDefaults(companionId));
    const prompt = buildDiaryPrompt(companion, turns, emotionHint, kind, dateKey);

    const raw = await extractStructuredInfo(
      '你在以第一人称写私人日记，只输出 JSON，无其他内容。',
      prompt,
      { maxTokens: 700, temperature: 0.85, accountId: opts.accountId ?? null },
    );

    let parsed;
    try {
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
      parsed = JSON.parse(cleaned);
    } catch {
      log('warn', `[Diary] ${kind} companion=${companionId} JSON 解析失败`);
      return { skipped: 'parse-fail', dateKey };
    }

    let content = sanitizeMemoryContent(String(parsed?.diary || '')).trim();
    const mood = String(parsed?.mood || '').slice(0, 20) || null;
    if (!content || content.length < 10) return { skipped: 'empty', dateKey };
    if (isSensitiveMemoryContent(content)) {
      log('warn', `[Diary] ${kind} companion=${companionId} 命中敏感过滤，丢弃`);
      return { skipped: 'sensitive', dateKey };
    }

    const entry = upsertDiaryEntry({
      companionId, userId: opts.userId ?? companion.user_id ?? null,
      dateKey, kind, mood, content: content.slice(0, 1200),
    });
    log('info', `[Diary] ${kind} companion=${companionId} date=${dateKey} mood=${mood} len=${content.length}`);
    return { ok: true, dateKey, entry };
  } catch (e) {
    log('error', `[Diary] ${kind} companion=${companionId} 异常: ${e.message}`);
    return { error: e.message };
  }
}

export function generateDailyDiaryForCompanion(companionId, opts = {}) {
  return generateDiaryForCompanion(companionId, { ...opts, kind: 'daily' });
}

export function generateWeeklyDiaryForCompanion(companionId, opts = {}) {
  return generateDiaryForCompanion(companionId, { ...opts, kind: 'weekly' });
}
