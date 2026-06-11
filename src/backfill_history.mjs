/**
 * backfill_history.mjs — 3 个月模拟时间线 (v1.6 PR I)
 *
 * 用户创角后或 dashboard 按钮触发：让 LLM 一次性生成 30-50 个"虚拟互动事件"
 * 分布在过去 90 天里，写入 conversation_turns（带 synthetic=1）+
 * 关键事件提取到 companion_memories。
 *
 * 效果：用户首次打开聊天时她已经"认识他 3 个月"，而不是从零开始。
 *
 * 设计：
 *   - 不生成 90 天每天的完整对话（太重），而是 ~40 个时间锚点
 *   - 每个锚点 1-3 段对话（短，模拟真人微信记忆片段）
 *   - 关系演化曲线：affection 5 → 30，期间几个起伏（吵架/和好等）
 *   - 关键事件（首次见面/第一次吵架/特别开心的事）入 memories
 *   - 全过程一次 LLM 调用（max_tokens 大）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import {
  bulkInsertSyntheticTurns, markCompanionBackfilled,
  getCompanionBackfillStatus, saveMemory, upsertEmotionState,
  countRealUserTurns,
} from './db.mjs';
import { extractStructuredInfo, embedText } from './ai.mjs';

const DEFAULT_DAYS_BACK = 90;
const DEFAULT_EVENT_COUNT = 35;   // 90 天 / ~2.5 天一个事件
const THIN_DAYS_BACK = 7;         // v1.21.3: 创建时薄版（快、便宜，一周打底）
const THIN_EVENT_COUNT = 6;
const FULL_MIN_DAYS_AGO = 8;      // 全量只向更早追加：8~90 天，绝不碰薄版已覆盖的最近 7 天
const FULL_WATERMARK_TURNS = 10;  // 累计 10 条真实用户消息 → 触发全量（成本闸门）

function buildBackfillPrompt(companion, opts) {
  const c = companion;
  const days = opts.daysBack;
  const eventCount = opts.eventCount;
  let personality = '';
  try { personality = JSON.parse(c.personality_tags || '[]').join('、'); } catch {}
  let hobbies = '';
  try { hobbies = JSON.parse(c.hobbies || '[]').join('、'); } catch {}

  return `你帮一个虚拟角色补全"和他认识以来的过去 ${days} 天"——
要像真实存在过的关系记忆：有起伏、有具体小事、不是流水账。

【角色信息】
- 姓名：${c.name}
- 年龄：${c.age || 22}
- 身份：${c.role_title || '邻家女孩'}
- 性格：${personality || '温柔'}
- 爱好：${hobbies || '看剧、听音乐'}
- 你们怎么认识的：${c.how_met || '在某个不经意的瞬间认识'}

【生成要求】

生成 ${eventCount} 个时间锚点，分布在过去 ${days} 天里（最远 ${days} 天前，最近 ${opts.minDaysAgo || 3} 天前）。${(opts.minDaysAgo || 3) > 3 ? `
注意：你们最近 ${opts.minDaysAgo - 1} 天的互动记录已经存在，你生成的是**更早**的部分——
days_ago 必须 ≥ ${opts.minDaysAgo}，绝不生成最近 ${opts.minDaysAgo - 1} 天内的事件。` : ''}
每个锚点：
- 一个具体小事件（不是"我们聊得很开心"，而是"她跟他说她加班晚了，他点了奶茶给她"）
- 1-3 段聊天片段（user / assistant 各 0-2 条，模拟微信记忆）
- 一句"事件后果"标签（如"她第一次主动找他"、"她有点失落"）

关系演化曲线：
- 第 1-15 天：刚认识，礼貌客气
- 第 16-40 天：开始熟悉，有小话题，偶尔互相关心
- 第 41-70 天：信任度上升，开始吐槽、抱怨、分享私事；中间穿插 1-2 次小别扭
- 第 71-${days} 天：暧昧渐起，她开始下意识等他消息

要点：
1. 至少 2 个事件是"小冲突 / 别扭 / 误会"（非全部正面）
2. 至少 3 个事件涉及具体物品（奶茶、雨伞、电影、生日礼物等）
3. 至少 1 个事件是他主动关心（他来问候/记得她的事）
4. 至少 1 个事件涉及她生活背景（人生记忆里提到的朋友/家人/宠物名字可复用）
5. 他的消息（user）用"他"视角；她的消息（assistant）用她自己的口吻
6. 不要 emoji、不要动作描写（*笑了笑*）
7. 时间分布要不均匀（不是每 2.5 天准时一条，而是偶尔密集偶尔稀疏）

【严格 JSON 输出】

{
  "events": [
    {
      "days_ago": 87,           // 距今天数（整数 3-${days}）
      "hour": 21,               // 当天小时 0-23
      "topic": "雨天送伞",      // 一句话事件标签
      "turns": [
        { "role": "user", "content": "在哪呢" },
        { "role": "assistant", "content": "刚下班还在等车 || 下大雨没带伞" },
        { "role": "user", "content": "我过来接你" }
      ],
      "memorable": true,        // 是否值得入长期记忆（true 的会写到 companion_memories）
      "affection_delta": 3      // 这个事件让她对他好感变化 -5 ~ +5
    }
    // ... ${eventCount} 个事件
  ],
  "starting_affection": 5,      // 90 天前刚认识时的初始好感
  "ending_affection": 30        // 今天（认识 90 天后）当前好感
}

注意 affection_delta 累加 + starting_affection 应该接近 ending_affection（不严格相等）。
days_ago 数字必须严格在 ${opts.minDaysAgo || 3}-${days} 之间且**不重复**。
事件按 days_ago 倒序排（最久远的在前）。

严格只输出 JSON。`;
}

/**
 * 给单个 companion 生成 backfill 时间线并入库。
 */
export async function backfillTimelineForCompanion(companion, opts = {}) {
  if (!companion) throw new Error('companion 必填');
  const tier = opts.tier === 'thin' ? 'thin' : 'full';
  const status = getCompanionBackfillStatus(companion.id);
  // 防重：full 后不再回填；thin 后允许 full（向更早追加）；同 tier 重复跳过
  if (status?.backfilledAt && !opts.force) {
    if (status.tier === 'full' || status.tier === tier) {
      return { skipped: 'already-backfilled', backfilledAt: status.backfilledAt, tier: status.tier };
    }
  }

  const daysBack = tier === 'thin'
    ? THIN_DAYS_BACK
    : Math.max(30, Math.min(180, opts.daysBack || DEFAULT_DAYS_BACK));
  const eventCount = tier === 'thin'
    ? THIN_EVENT_COUNT
    : Math.max(20, Math.min(60, opts.eventCount || DEFAULT_EVENT_COUNT));
  // 一致性硬约束：full 在 thin 之上时只向更早追加（8~90 天），薄版条目原文不动
  const minDaysAgo = tier === 'full' && status?.tier === 'thin' ? FULL_MIN_DAYS_AGO : (tier === 'thin' ? 1 : 3);
  const prompt = buildBackfillPrompt(companion, { daysBack, eventCount, minDaysAgo });

  let parsed;
  try {
    const raw = await extractStructuredInfo(
      '你只输出 JSON，不带任何说明、围栏、注释。',
      prompt,
      { maxTokens: 6000, temperature: 0.85, accountId: opts.accountId ?? null },
    );
    const cleaned = String(raw || '').trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    parsed = JSON.parse(cleaned);
  } catch (e) {
    log('error', `[Backfill] companion=${companion.id} JSON parse failed: ${e.message}`);
    return { error: e.message };
  }

  if (!parsed?.events || !Array.isArray(parsed.events)) {
    return { error: 'no events in response' };
  }

  // 转 events → turns rows + memories
  const now = Date.now();
  const turns = [];
  const memoryEvents = [];
  let memCount = 0;

  for (const ev of parsed.events) {
    const dAgo = Math.max(minDaysAgo, Math.min(daysBack, Math.floor(Number(ev.days_ago) || 0)));
    const hour = Math.max(0, Math.min(23, Math.floor(Number(ev.hour) || 12)));
    const eventTs = new Date(now - dAgo * 86400_000);
    eventTs.setHours(hour, Math.floor(Math.random() * 60), 0, 0);
    const baseTs = eventTs.getTime();
    const turnList = Array.isArray(ev.turns) ? ev.turns : [];
    for (let i = 0; i < turnList.length; i++) {
      const t = turnList[i];
      if (!t || !t.content) continue;
      turns.push({
        created_at: new Date(baseTs + i * 30_000).toISOString().replace('T', ' ').slice(0, 19),
        role: t.role === 'assistant' ? 'assistant' : 'user',
        content: String(t.content).slice(0, 400),
        topic: ev.topic ? String(ev.topic).slice(0, 100) : null,
      });
    }
    if (ev.memorable && ev.topic) {
      memoryEvents.push({
        content: `${ev.topic}（${dAgo} 天前发生）`,
        importance: Math.max(5, Math.min(8, 5 + Math.abs(Number(ev.affection_delta) || 0))),
      });
    }
  }

  if (!turns.length) {
    return { error: 'no valid turns parsed' };
  }

  // 按 created_at 升序入库（保 conversation_turns 时间顺序）
  turns.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

  try {
    bulkInsertSyntheticTurns(companion.id, turns);
  } catch (e) {
    log('error', `[Backfill] companion=${companion.id} bulk insert failed: ${e.message}`);
    return { error: 'db insert failed: ' + e.message };
  }

  // 关键事件入 memories
  for (const m of memoryEvents) {
    try {
      const emb = await embedText(m.content).catch(() => null);
      saveMemory({
        companionId: companion.id,
        userId: companion.user_id,
        memoryType: 'event',
        content: m.content,
        importance: m.importance,
        embedding: emb,
      });
      memCount++;
    } catch { /* 单条失败不致命 */ }
  }

  // 更新 emotion_state.affection 到 ending_affection
  const finalAff = Math.max(0, Math.min(100, Math.floor(Number(parsed.ending_affection) || 30)));
  try {
    upsertEmotionState(companion.id, { affection: finalAff });
  } catch (e) {
    log('warn', `[Backfill] companion=${companion.id} affection 更新失败: ${e.message}`);
  }

  markCompanionBackfilled(companion.id, tier);
  log('info', `[Backfill] companion=${companion.id} ok tier=${tier} turns=${turns.length} memories=${memCount} ending_aff=${finalAff}`);
  return {
    ok: true,
    turnCount: turns.length,
    memoryCount: memCount,
    endingAffection: finalAff,
    daysBack,
    eventCount: parsed.events.length,
  };
}

// ─── v1.21.3 PR-D: 回填自动化（去按钮）────────────────────────────────────
// 创建时触发 thin；full 由先到者触发：绑定微信 / 累计 10 条真实用户消息。
// 水位做成"每条消息时检查"而不是一次性事件：天然覆盖存量老 companion
// （绑了微信、消息早过 10 条、但按钮时代从没点过的，下一条消息就补上）。

/** 决策纯函数（smoke 可测）：返回 'thin' | 'full' | null */
export function decideBackfillAction({ tier, userTurns = 0, justBound = false }) {
  if (tier === 'full') return null;                      // 全量已就位
  if (tier === 'thin') {
    return (justBound || userTurns >= FULL_WATERMARK_TURNS) ? 'full' : null;
  }
  // 从未回填（含按钮时代漏网的存量）：先补薄版打底；水位已过的下一轮再升 full
  return 'thin';
}

const _backfillInflight = new Set();          // 防同 companion 并发触发
const _backfillFailedAt = new Map();          // 失败冷却：30 分钟内不重试（#263：失败必须响，但别打爆 LLM）
const FAIL_COOLDOWN_MS = 30 * 60_000;

/**
 * 水位检查 + 异步触发（fire-and-forget，绝不阻塞调用方）。
 * 挂点：companion 创建后 / 微信绑定成功 / bot 每条用户消息。
 */
export function maybeAutoBackfill(companion, { justBound = false, reason = '' } = {}) {
  try {
    if (!companion?.id) return;
    if (_backfillInflight.has(companion.id)) return;
    const failedAt = _backfillFailedAt.get(companion.id);
    if (failedAt && Date.now() - failedAt < FAIL_COOLDOWN_MS) return;

    const status = getCompanionBackfillStatus(companion.id);
    const action = decideBackfillAction({
      tier: status?.tier || null,
      userTurns: status?.tier === 'thin' || !status?.tier ? countRealUserTurns(companion.id) : 0,
      justBound,
    });
    if (!action) return;

    _backfillInflight.add(companion.id);
    log('info', `[Backfill] 自动触发 tier=${action} companion=${companion.id} reason=${reason || (justBound ? 'bind' : 'watermark')}`);
    backfillTimelineForCompanion(companion, { tier: action })
      .then(r => {
        if (r?.error) {
          // #263 纪律：后台批任务失败必须响——error 级日志进 digest 错误签名段
          _backfillFailedAt.set(companion.id, Date.now());
          log('error', `[Backfill] 自动回填失败 tier=${action} companion=${companion.id}: ${r.error}（${FAIL_COOLDOWN_MS / 60000} 分钟后随水位自动重试）`);
        } else {
          _backfillFailedAt.delete(companion.id);
        }
      })
      .catch(e => {
        _backfillFailedAt.set(companion.id, Date.now());
        log('error', `[Backfill] 自动回填异常 tier=${action} companion=${companion.id}: ${e.message}`);
      })
      .finally(() => _backfillInflight.delete(companion.id));
  } catch (e) {
    log('warn', `[Backfill] 水位检查失败（不影响主链路）: ${e.message}`);
  }
}
