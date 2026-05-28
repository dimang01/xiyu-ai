/**
 * memory_v2.mjs
 * Memory v3 utilities: layer normalization, sensitivity filter,
 * decay scoring, recall ranking, and deduplication.
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { patchMemory, touchMemory } from './db.mjs';

// ─── Allowed enumerations ──────────────────────────────────────────────────────

export const MEMORY_LAYERS = [
  'core_persona', 'relationship_rule', 'user_fact',
  'preference', 'event', 'emotion', 'summary',
];

export const MEMORY_STATUSES = ['active', 'archived', 'contradicted', 'deleted'];

export const MEMORY_SOURCES = ['auto', 'user', 'system', 'summary', 'reflection', 'imported'];

// Map legacy memory_type → memory_layer for backward compat display
const LEGACY_TYPE_TO_LAYER = {
  fact:            'user_fact',
  preference:      'preference',
  event:           'event',
  emotion:         'emotion',
  image:           'event',
  daily_summary:   'summary',
  weekly_summary:  'summary',
  monthly_summary: 'summary',
};

export function normalizeMemoryLayer(layer) {
  if (MEMORY_LAYERS.includes(layer)) return layer;
  if (LEGACY_TYPE_TO_LAYER[layer]) return LEGACY_TYPE_TO_LAYER[layer];
  return 'event';
}

export function normalizeMemoryWeight(weight) {
  const n = Number(weight);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(0, Math.round(n)));
}

// ─── Sensitive content filter ─────────────────────────────────────────────────

// Patterns that should not be persisted verbatim in memory
const SENSITIVE_PATTERNS = [
  // ID numbers / bank cards
  /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[012])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/, // 身份证
  /\b[3-9]\d{15}\b/,           // 银行卡 (16位+)
  // credentials
  /(?:密码|password|pwd)\s*[:：=\s][^\s]{4,}/i,
  /(?:验证码|captcha|otp|code)\s*[:：=\s]\d{4,8}/i,
  /sk-[a-zA-Z0-9]{20,}/,       // OpenAI-style API key
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /ghp_[a-zA-Z0-9]{36}/,       // GitHub PAT
  /(?:token|secret|key)\s*[:：=\s][a-zA-Z0-9_\-]{16,}/i,
  // addresses - precise
  /(?:详细地址|住在|家住|门牌|楼号|室号)\s*[:：]?\s*.{6,30}(?:路|街|巷|弄|号|栋|单元|室)/,
  // self-harm methods
  /(?:想自杀|去死|了结生命|结束生命).*(?:方法|怎么|如何|用什么)/,
  // explicit minors
  /(?:未成年|小学生|初中生|高中生|\d{1,2}岁).*(?:性|裸|色情)/,
];

export function isSensitiveMemoryContent(text) {
  if (!text || typeof text !== 'string') return false;
  return SENSITIVE_PATTERNS.some(re => re.test(text));
}

/**
 * Returns cleaned content or null if fully blocked.
 * Replaces specific sensitive tokens with generic placeholders.
 */
export function sanitizeMemoryContent(text) {
  if (!text) return text;
  // Block outright if multiple patterns match (high confidence sensitive)
  const hits = SENSITIVE_PATTERNS.filter(re => re.test(text)).length;
  if (hits >= 2) return null;
  // Mask individual patterns
  let out = text;
  out = out.replace(/sk-[a-zA-Z0-9]{20,}/, '[API密钥已屏蔽]');
  out = out.replace(/ghp_[a-zA-Z0-9]{36}/, '[Token已屏蔽]');
  out = out.replace(/(?:密码|password|pwd)\s*[:：=\s][^\s]{4,}/gi, '[密码信息已屏蔽]');
  out = out.replace(/(?:验证码|captcha|otp)\s*[:：=\s]\d{4,8}/gi, '[验证码已屏蔽]');
  if (isSensitiveMemoryContent(out)) return null;
  return out;
}

// ─── Decay score ──────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/**
 * Compute a decay score in [0, 1] for a memory row.
 * locked=1 or pinned=1 → always 1.0
 * weight >= 4 → slow decay (half-life 90 days)
 * weight <= 1 → fast decay (half-life 14 days)
 * others → half-life 45 days
 */
export function computeMemoryDecay(memory, now = new Date()) {
  if (memory.locked || memory.pinned) return 1.0;
  if (memory.memory_status && memory.memory_status !== 'active') return 0;

  const createdAt = memory.created_at ? new Date(String(memory.created_at).replace(' ', 'T')) : now;
  const lastUsed  = memory.last_used_at ? new Date(String(memory.last_used_at).replace(' ', 'T')) : createdAt;
  const refDate   = lastUsed > createdAt ? lastUsed : createdAt;
  const ageDays   = Math.max(0, (now - refDate) / MS_PER_DAY);

  const weight = typeof memory.memory_weight === 'number' ? memory.memory_weight : 3;
  let halfLifeDays;
  if (weight >= 4)     halfLifeDays = 90;
  else if (weight <= 1) halfLifeDays = 14;
  else                  halfLifeDays = 45;

  return Math.exp(-ageDays * Math.LN2 / halfLifeDays);
}

// ─── Recall ranking ───────────────────────────────────────────────────────────

/**
 * Re-rank a list of recalled memories using weight, decay, recency, and context match.
 * Returns sorted array (highest relevance first).
 */
export function rankMemoriesForRecall(memories, context = '') {
  const ctx = (context || '').toLowerCase();

  return memories
    .filter(m => {
      if (m.memory_status && m.memory_status !== 'active') return false;
      if (m.do_not_mention) return false;
      return true;
    })
    .map(m => {
      const decay   = computeMemoryDecay(m);
      const weight  = normalizeMemoryWeight(m.memory_weight ?? 3) / 5;
      const imp     = ((m.importance ?? 5) / 10);
      const pin     = m.pinned  ? 0.15 : 0;
      const locked  = m.locked  ? 0.10 : 0;

      // context keyword boost
      let ctxBoost = 0;
      if (ctx && m.content) {
        const words = ctx.replace(/[^一-龥a-zA-Z0-9]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
        if (words.some(w => m.content.includes(w))) ctxBoost = 0.20;
      }

      const score = weight * 0.3 + imp * 0.2 + decay * 0.2 + pin + locked + ctxBoost;
      return { ...m, _recall_score: score };
    })
    .sort((a, b) => b._recall_score - a._recall_score);
}

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Simple deduplication: returns a subset where content is not "too similar".
 * For same companion_id + same memory_layer, strings sharing > 70% of tokens
 * count as duplicate. Keeps the higher-weight one.
 */
export function dedupeMemories(memories) {
  const keep = [];
  for (const m of memories) {
    const isDup = keep.some(k => {
      if (k.memory_layer !== m.memory_layer) return false;
      return tokenSimilarity(k.content || '', m.content || '') > 0.7;
    });
    if (!isDup) keep.push(m);
  }
  return keep;
}

function tokenSimilarity(a, b) {
  if (!a || !b) return 0;
  const ta = new Set(a.replace(/[^一-龥a-zA-Z0-9]/g, ' ').split(/\s+/).filter(Boolean));
  const tb = new Set(b.replace(/[^一-龥a-zA-Z0-9]/g, ' ').split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) { if (tb.has(t)) common++; }
  return common / Math.max(ta.size, tb.size);
}

/**
 * Given a list of newly extracted memories and existing memories for a companion,
 * filter out near-duplicates. If duplicate found, bumps weight of existing instead.
 */
export function filterNewMemoriesAgainstExisting(newMemories, existingMemories, db, companionId) {
  const toInsert = [];
  for (const nm of newMemories) {
    const dup = existingMemories.find(em => {
      if (em.memory_status === 'deleted') return false;
      if (em.memory_layer !== normalizeMemoryLayer(nm.memoryType || nm.memory_layer || 'event')) return false;
      return tokenSimilarity(em.content || '', nm.content || '') > 0.65;
    });
    if (dup) {
      // Bump weight and use_count of existing rather than inserting
      try {
        const newWeight = Math.min(5, (dup.memory_weight ?? 3) + 1);
        patchMemory(dup.id, companionId, { memory_weight: newWeight });
        touchMemory(dup.id, companionId);
      } catch (e) {
        log('warn', `[MemoryV2] 更新重复记忆权重失败: ${e.message}`);
      }
    } else {
      toInsert.push(nm);
    }
  }
  return toInsert;
}
