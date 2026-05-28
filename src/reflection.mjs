/**
 * reflection.mjs
 * Daily / weekly reflection engine: generates structured memory updates
 * by reflecting on recent conversation turns.
 *
 * This is NOT a summary (that's plan_tasks.mjs). Reflection produces
 * structured new/updated memories that go into the Memory v2 system.
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { getDb, getConversationTurnsBetween, shanghaiBoundsForDateKey, shanghaiDateKey } from './db.mjs';
import { extractStructuredInfo } from './ai.mjs';
import {
  normalizeMemoryLayer, normalizeMemoryWeight,
  isSensitiveMemoryContent, sanitizeMemoryContent,
  addOrMergeMemory,
} from './memory_v2.mjs';
import { saveMemory, getMemoriesV2 } from './db.mjs';
import { processMemoryForGraph } from './event_graph.mjs';

const CONFIDENCE_MIN = 0.7;
const RECENT_TURNS_LIMIT = 300;

// ─── Prompt builder ───────────────────────────────────────────────────────────

export function buildReflectionPrompt(companion, recentTurns, existingMemories) {
  const c = companion;
  const turnLines = recentTurns
    .slice(-80)
    .map(t => {
      const role = t.role === 'user' ? '用户' : '她';
      return `${role}：${String(t.content).slice(0, 200)}`;
    })
    .join('\n');

  const existingSnippet = (existingMemories || [])
    .slice(0, 20)
    .map(m => `[${m.memory_layer}] ${String(m.content).slice(0, 80)}`)
    .join('\n');

  return `你是一个 AI 陪伴系统的记忆提炼引擎，专门分析对话并更新结构化记忆。

你要分析「${c.name}」和用户的最近对话，对照已有记忆，提炼出真正值得长期记录的新知识。

【已有记忆摘要（前 20 条）】
${existingSnippet || '（暂无）'}

【最近对话（最多 80 轮）】
${turnLines || '（无对话）'}

【要求】
1. 提炼对"用户这个人"的新认识：偏好变化、情绪模式、最近状态、关系进展
2. 不要重复已有记忆中已明确记录的内容（除非有重要更新）
3. 每条新记忆必须有 confidence（0-1），只保留 >= ${CONFIDENCE_MIN} 的
4. updated_memories 只更新真正有新信息的旧记忆
5. 不要提取：API 密钥、密码、验证码、身份证号、银行卡、明确的家庭住址
6. 不要在对话内容中识别任何性暗示、自伤、未成年相关敏感内容

严格输出 JSON，不要任何额外说明：
{
  "new_memories": [
    {
      "memory_layer": "preference|user_fact|emotion|event|relationship_rule",
      "memory_weight": 3,
      "content": "一句话描述，不超过 60 字",
      "confidence": 0.85
    }
  ],
  "updated_memories": [
    {
      "memory_id": 0,
      "new_content": "更新后的内容",
      "reason": "最近对话中发现的变化"
    }
  ],
  "do_not_store": [
    { "reason": "说明为什么这些内容不应存储" }
  ]
}`;
}

// ─── Result normalizer ────────────────────────────────────────────────────────

export function normalizeReflectionResult(raw) {
  if (!raw || typeof raw !== 'object') return { new_memories: [], updated_memories: [], do_not_store: [] };

  const newMems = Array.isArray(raw.new_memories)
    ? raw.new_memories.filter(m =>
        m && typeof m.content === 'string' &&
        typeof m.confidence === 'number' &&
        m.confidence >= CONFIDENCE_MIN &&
        !isSensitiveMemoryContent(m.content)
      ).map(m => ({
        memory_layer:  normalizeMemoryLayer(m.memory_layer || 'event'),
        memory_weight: normalizeMemoryWeight(m.memory_weight ?? 3),
        content:       (sanitizeMemoryContent(m.content) || '').slice(0, 120),
        confidence:    Number(m.confidence),
      })).filter(m => m.content)
    : [];

  const updatedMems = Array.isArray(raw.updated_memories)
    ? raw.updated_memories.filter(m =>
        m && typeof m.memory_id === 'number' && m.memory_id > 0 &&
        typeof m.new_content === 'string' &&
        !isSensitiveMemoryContent(m.new_content)
      ).map(m => ({
        memory_id:   m.memory_id,
        new_content: (sanitizeMemoryContent(m.new_content) || '').slice(0, 120),
        reason:      String(m.reason || '').slice(0, 80),
      })).filter(m => m.new_content)
    : [];

  return {
    new_memories:     newMems,
    updated_memories: updatedMems,
    do_not_store:     Array.isArray(raw.do_not_store) ? raw.do_not_store : [],
  };
}

// ─── Apply reflection updates ─────────────────────────────────────────────────

export async function applyReflectionMemoryUpdates(companionId, updates, options = {}) {
  const db = options.db ?? getDb();
  const userId = options.userId;
  let inserted = 0, merged = 0, updated = 0;

  // Insert or merge new memories
  for (const m of (updates.new_memories || [])) {
    try {
      const result = await addOrMergeMemory(companionId, {
        ...m,
        memory_source: 'reflection',
      }, { db });

      if (result.action === 'insert') {
        saveMemory({
          companionId,
          userId,
          memoryType: m.memory_layer,
          content:    m.content,
          importance: m.memory_weight ?? 3,
          memoryLayer: m.memory_layer,
          memoryWeight: m.memory_weight,
          memorySource: 'reflection',
        });
        // 轻量事件图谱（静默，不阻塞）
        // 传入 memory_layer 让守卫函数跳过 emotion 层
        try {
          processMemoryForGraph(companionId, m.content, null, { memory_layer: m.memory_layer });
        } catch { /* 非阻塞 */ }
        inserted++;
      } else if (result.action === 'merged') {
        merged++;
      }
    } catch (e) {
      log('warn', `[Reflection] insert 失败 companion=${companionId}: ${e.message}`);
    }
  }

  // Update existing memories — never touch locked or pinned
  for (const u of (updates.updated_memories || [])) {
    try {
      const existing = db.prepare(`
        SELECT id, locked, pinned FROM companion_memories
        WHERE id = ? AND companion_id = ?
      `).get(u.memory_id, companionId);

      if (!existing) continue;
      if (existing.locked || existing.pinned) continue;

      db.prepare(`
        UPDATE companion_memories
        SET content = ?, updated_at = ?, memory_source = 'reflection'
        WHERE id = ? AND companion_id = ?
      `).run(u.new_content, new Date().toISOString(), u.memory_id, companionId);
      updated++;
    } catch (e) {
      log('warn', `[Reflection] update 失败 id=${u.memory_id}: ${e.message}`);
    }
  }

  log('info', `[Reflection] companion=${companionId} inserted=${inserted} merged=${merged} updated=${updated}`);
  return { inserted, merged, updated };
}

// ─── Per-companion reflection runners ────────────────────────────────────────

async function runReflectionForCompanion(companionId, userId, turnsRange, kind, options = {}) {
  const db = getDb();
  try {
    const companion = db.prepare('SELECT * FROM companions WHERE id = ?').get(companionId);
    if (!companion) return;

    const { startSql, endSql } = turnsRange;
    const turns = getConversationTurnsBetween(companionId, startSql, endSql, RECENT_TURNS_LIMIT);
    if (turns.length < 3) {
      log('info', `[Reflection] companion=${companionId} ${kind} 跳过（对话轮次 ${turns.length} < 3）`);
      return;
    }

    const existingMemories = getMemoriesV2(companionId, {
      status: 'active', layer: null, limit: 30,
    });

    const prompt = buildReflectionPrompt(companion, turns, existingMemories);
    const raw = await extractStructuredInfo(
      '你是结构化记忆提炼引擎，只输出 JSON，无其他内容。',
      prompt,
      { maxTokens: 1500 },
    );

    let parsed;
    try {
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
      parsed = JSON.parse(cleaned);
    } catch {
      log('warn', `[Reflection] ${kind} companion=${companionId} JSON 解析失败`);
      return;
    }

    const updates = normalizeReflectionResult(parsed);
    await applyReflectionMemoryUpdates(companionId, updates, { userId });

    log('info', `[Reflection] ${kind} companion=${companionId} new=${updates.new_memories.length} updated=${updates.updated_memories.length}`);
  } catch (e) {
    log('error', `[Reflection] ${kind} companion=${companionId} 异常: ${e.message}`);
  }
}

function addDaysSh(dateKey, delta) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return shanghaiDateKey(new Date(Date.UTC(y, m - 1, d + delta, 12)));
}

export async function runDailyReflectionForCompanion(companionId, options = {}) {
  const now = new Date();
  const todayKey = shanghaiDateKey(now);
  const yesterdayKey = addDaysSh(todayKey, -1);
  const { startSql, endSql } = shanghaiBoundsForDateKey(yesterdayKey);
  const userId = options.userId;
  await runReflectionForCompanion(companionId, userId, { startSql, endSql }, 'daily', options);
}

export async function runWeeklyReflectionForCompanion(companionId, options = {}) {
  const now = new Date();
  const todayKey = shanghaiDateKey(now);
  const endKey = addDaysSh(todayKey, -1);
  const startKey = addDaysSh(endKey, -6);
  const { startSql: startSql0 } = shanghaiBoundsForDateKey(startKey);
  const { endSql: endSql0 } = shanghaiBoundsForDateKey(endKey);
  const userId = options.userId;
  await runReflectionForCompanion(companionId, userId, { startSql: startSql0, endSql: endSql0 }, 'weekly', options);
}
