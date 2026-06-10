/**
 * time_capsule.mjs — 时光胶囊 (v1.5)
 *
 * 用户写一段话存她那里 + 设解锁时间。时间到 cron 自动"打开"，
 * 调用 chat provider 让"现在的她"读用户的原文 + 写一段"现在的我"感想。
 *
 * 不同于普通日记 / thoughts：
 *   - 用户主动封存，不是 AI 自动生成
 *   - 有"时间差"——封存时的"她"和解封时的"她"经历了不同的对话/情绪
 *   - 她的感想会读用户当时写的原文，并对比"那时候 vs 现在"
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import {
  getDb,
  findMaturedTimeCapsules,
  markTimeCapsuleOpened,
} from './db.mjs';
import { extractStructuredInfo } from './ai.mjs';
import { getEmotionStateWithDefaults } from './emotion_state.mjs';
import { computeRelationshipStage } from './memory.mjs';

// ─── 构造"她解封时的感想" prompt ─────────────────────────────────────────
function buildReactionPrompt(companion, capsule, emotion, stage) {
  const createdHuman = new Date(capsule.created_at * 1000).toISOString().slice(0, 10);
  const elapsedDays = Math.floor((Date.now() / 1000 - capsule.created_at) / 86400);
  const elapsedHint = elapsedDays >= 365 ? `${Math.floor(elapsedDays / 365)} 年`
                    : elapsedDays >= 30 ? `${Math.floor(elapsedDays / 30)} 个月`
                    : elapsedDays >= 7 ? `${Math.floor(elapsedDays / 7)} 周`
                    : `${elapsedDays} 天`;
  const titleLine = capsule.title ? `胶囊标题：${capsule.title}\n` : '';
  return `你是 ${companion.name}。${elapsedHint}前的 ${createdHuman}，他给你封了一个时光胶囊，今天到了解封时间。

${titleLine}他当时写的原文是：
"""
${capsule.body}
"""

现在的你（关系阶段：${stage}，心情：${emotion.mood || 'normal'}），刚读完这段话。
请写下你此刻的感想——80-200 字，一段话——要点：

1. 不是 echo 他的话；是你读完后"现在的你"的反应
2. 可以提到"那时候的我们"和"现在的我们"的对比（如果合适）
3. 如果他当时写的事情你已经记不清细节也没关系，可以直接说出来
4. 不要套话（"无论何时何地我都..."）
5. 不要日记体（不要"今天我..."）
6. 不要 emoji、不要动作描写（如 *轻轻笑* ）

直接开始感想，不要"亲爱的："这种信头。`;
}

// ─── 给单个胶囊生成 her_reaction 并标记为已开封 ────────────────────────────
export async function openOneCapsule(capsule, { accountId = null } = {}) {
  const db = getDb();
  const companion = db.prepare('SELECT * FROM companions WHERE id = ?').get(capsule.companion_id);
  if (!companion) {
    // companion 已被删，标记打开避免反复重试
    markTimeCapsuleOpened(capsule.id, '（这个角色已经不存在了。）');
    return { id: capsule.id, status: 'orphan' };
  }

  const emotion = getEmotionStateWithDefaults(companion.id);
  const stage = computeRelationshipStage(emotion.affection || 0, companion.stage);
  const prompt = buildReactionPrompt(companion, capsule, emotion, stage);

  try {
    const raw = await extractStructuredInfo(
      '你只输出感想正文，不带任何说明、引号、信头。',
      prompt,
      { maxTokens: 400, temperature: 0.85, accountId },
    );
    let reaction = String(raw || '').trim();
    // 去掉模型可能输出的引号/信头/署名
    reaction = reaction
      .replace(/^["「『"']+|["」』"']+$/g, '').trim()
      .replace(/^(亲爱的|致|To|Dear)[^\n]{0,20}[:：]?\s*\n/i, '').trim()
      .replace(/\n+(——|—|--)[^\n]{0,30}$/m, '').trim();
    if (reaction.length < 20) {
      reaction = '（这段时间想说的话太多，反而一时不知道从哪里讲起。我记得你写下这段话的那天。）';
    }
    if (reaction.length > 1200) reaction = reaction.slice(0, 1200) + '…';
    markTimeCapsuleOpened(capsule.id, reaction);
    log('info', `[time-capsule] opened id=${capsule.id} companion=${capsule.companion_id} reaction-len=${reaction.length}`);
    return { id: capsule.id, status: 'opened', reaction };
  } catch (e) {
    log('error', `[time-capsule] open failed id=${capsule.id}: ${e.message}`);
    // 不标记 opened，下次 cron 重试
    return { id: capsule.id, status: 'error', error: e.message };
  }
}

// ─── cron 入口：扫描所有到期未开封的胶囊批量解封 ──────────────────────────
export async function openMaturedCapsulesBatch({ limit = 20 } = {}) {
  const matured = findMaturedTimeCapsules(limit);
  if (!matured.length) return { processed: 0, opened: 0, errors: 0 };
  log('info', `[time-capsule] 发现 ${matured.length} 个到期未开封的胶囊，开始处理`);
  let opened = 0, errors = 0;
  for (const capsule of matured) {
    const r = await openOneCapsule(capsule);
    if (r.status === 'opened' || r.status === 'orphan') opened += 1;
    else errors += 1;
    // 节流：避免一次性大量调 chat provider
    await new Promise(r => setTimeout(r, 800));
  }
  return { processed: matured.length, opened, errors };
}
