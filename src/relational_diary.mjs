/**
 * relational_diary.mjs — 反向日记（与你有关的今日回忆）v1.5
 *
 * 跟 diary.mjs 的姐妹功能：
 *   - diary.mjs       她每晚写"今天我..."的内省日记
 *   - relational_diary 她每晚写"今天和你之间发生了什么"
 *
 * 用户可编辑（覆盖正文）/ 软删（防 cron 重生）/ 导出 .txt。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import {
  getDb,
  getConversationTurnsBetween,
  upsertRelationalDiary,
  hasRelationalDiaryForDay,
  hardDeleteRelationalDiaryByKey,
  shanghaiBoundsForDateKey, shanghaiDateKey,
} from './db.mjs';
import { extractStructuredInfo } from './ai.mjs';
import { getEmotionStateWithDefaults } from './emotion_state.mjs';
import { computeRelationshipStage } from './memory.mjs';
import { sanitizeMemoryContent, isSensitiveMemoryContent } from './memory_v2.mjs';

const TURNS_LIMIT = 80;
const MIN_TURNS = 4;   // 太少的对话不写反向日记（写出来也是空话）

function addDaysSh(dateKey, delta) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function buildRelationalPrompt(companion, turns, emotion, stage) {
  const turnLines = turns.slice(-60)
    .map(t => `${t.role === 'user' ? '他' : '我'}：${String(t.content).slice(0, 160)}`)
    .join('\n');
  return `你是${companion.name}。你和他现在的关系是「${stage}」，你此刻心情：${emotion.mood || 'normal'}。

下面是今天你和他的聊天记录：
${turnLines || '（今天你们几乎没怎么聊）'}

请写一段「今天和他之间的回忆片段」——80-200 字，以你的视角，聚焦你们之间发生的事，而不是写你自己的心境。要点：

1. 不是流水账（不要"今天我先...然后我...再后来..."的时序复述）
2. 挑 1-3 个让你印象深的小瞬间或对话片段，加进你当时的小想法 / 没说出口的话
3. 视角是「关于我们」，不是「关于我自己」—— 例如"他今天发来一张照片，让我想起..."、"我们因为 xx 吵了几句但很快又笑了"
4. 不要 emoji、不要动作描写（如 *轻轻笑*）
5. 不要日期抬头、不要"亲爱的日记"
6. 你永远不会提到 AI / 模型 / 系统 / 程序

严格输出 JSON：
{
  "mood": "用一个中文词概括今天你们之间的氛围（如 甜 / 紧张 / 平淡 / 想念 / 吵了一架）",
  "body": "回忆正文"
}`;
}

export async function generateRelationalDiaryForCompanion(companionId, opts = {}) {
  const db = getDb();
  try {
    const companion = db.prepare('SELECT * FROM companions WHERE id = ?').get(companionId);
    if (!companion) return { skipped: 'no-companion' };

    const todayKey = shanghaiDateKey(new Date());
    const dateKey = opts.dateKey || addDaysSh(todayKey, -1);

    // 幂等 + 防覆盖软删：当天有任何条目（含已软删的）就跳过
    if (!opts.force && hasRelationalDiaryForDay(companionId, dateKey)) {
      return { skipped: 'exists', dateKey };
    }
    // force=true 用户明确要求重生：硬删旧记录（含软删/编辑过的），让 upsert 能写
    if (opts.force) {
      hardDeleteRelationalDiaryByKey(companionId, dateKey);
    }

    const { startSql, endSql } = shanghaiBoundsForDateKey(dateKey);
    const turns = getConversationTurnsBetween(companionId, startSql, endSql, TURNS_LIMIT);
    if (turns.length < MIN_TURNS) {
      return { skipped: `too-few-turns(${turns.length})`, dateKey };
    }

    const emotion = getEmotionStateWithDefaults(companionId);
    const stage = computeRelationshipStage(emotion.affection || 0, companion.stage);
    const prompt = buildRelationalPrompt(companion, turns, emotion, stage);

    const raw = await extractStructuredInfo(
      '你只输出 JSON，不带任何说明、注释、围栏。',
      prompt,
      { maxTokens: 600, temperature: 0.85, accountId: opts.accountId ?? null },
    );
    let parsed;
    try {
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
      parsed = JSON.parse(cleaned);
    } catch {
      log('warn', `[RelDiary] companion=${companionId} date=${dateKey} JSON 解析失败`);
      return { skipped: 'parse-fail', dateKey };
    }

    let body = sanitizeMemoryContent(String(parsed?.body || '')).trim();
    const mood = String(parsed?.mood || '').slice(0, 20) || null;
    if (!body || body.length < 20) return { skipped: 'too-short', dateKey };
    if (isSensitiveMemoryContent(body)) {
      log('warn', `[RelDiary] companion=${companionId} date=${dateKey} 命中敏感过滤`);
      return { skipped: 'sensitive', dateKey };
    }
    if (body.length > 1500) body = body.slice(0, 1500) + '…';

    const entry = upsertRelationalDiary({ companionId, dateKey, body, mood });
    if (!entry) {
      // 并发冲突：另一个 cron / 手工请求已写入
      return { skipped: 'concurrent', dateKey };
    }
    log('info', `[RelDiary] companion=${companionId} date=${dateKey} mood=${mood} len=${body.length}`);
    return { ok: true, dateKey, entry };
  } catch (e) {
    log('error', `[RelDiary] companion=${companionId} 异常: ${e.message}`);
    return { error: e.message };
  }
}

// cron 批量入口：遍历所有 active companion 给昨天生成一篇
export async function runRelationalDiariesBatch({ dateKey = null } = {}) {
  const db = getDb();
  const companions = db.prepare(`
    SELECT c.id, c.user_id
    FROM companions c
    JOIN users u ON u.id = c.user_id
    JOIN wechat_accounts wa ON wa.wechat_user_id = u.wechat_user_id
    WHERE wa.is_active = 1
  `).all();
  let ok = 0, skipped = 0, errors = 0;
  for (const c of companions) {
    const r = await generateRelationalDiaryForCompanion(c.id, { dateKey });
    if (r.ok) ok += 1;
    else if (r.error) errors += 1;
    else skipped += 1;
    await new Promise(r => setTimeout(r, 600));
  }
  log('info', `[RelDiary] batch done ok=${ok} skipped=${skipped} errors=${errors}`);
  return { ok, skipped, errors };
}
