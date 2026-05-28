/**
 * Persona JSON Import / Export
 *
 * Exports companion persona data to a portable JSON format.
 * Never exports account_id, user_id, email, bot_token, or API keys.
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { getDb } from './db.mjs';

const EXPORT_SCHEMA = 'xiyu_companion_export_v1';
const MAX_IMPORT_BYTES = 512 * 1024; // 512 KB

const PERSONA_FIELDS = [
  'name', 'age', 'role_title',
  'hair_color', 'hair_style', 'eye_color', 'body_type', 'height', 'clothing_style',
  'personality_tags', 'mbti', 'introvert_level',
  'intimacy_level',
  'speech_styles', 'use_emoji_level', 'use_kaomoji', 'reply_length',
  'can_joke', 'avoid_cheesy', 'no_pressure', 'occasional_tantrum', 'encouraging', 'nsfw_level',
  'hobbies', 'favorite_food', 'favorite_music', 'pet_preference',
  'how_met', 'relationship_status', 'shared_memory',
  'memory_priorities',
  'proactive_enabled', 'proactive_frequency', 'proactive_time_window',
  'voice_reply_enabled', 'sticker_reply_enabled',
  'call_user_as', 'user_call_her_as',
  'persona_prompt', 'forbidden_topics',
  'memory_enabled',
  'relationship_stage',
  'current_scene',
  'backstory', 'family_background', 'education',
  'voice_style', 'voice_speed',
  'chat_modes', 'chat_mode_active',
  'temperature', 'max_tokens', 'top_p',
];

// Fields intentionally excluded from export (security / privacy)
// account_id, user_id, bot_id, email, bot_token, secrets, avatar_url
const IMPORT_STRING_FIELDS = new Set([
  'name', 'role_title', 'hair_color', 'hair_style', 'eye_color', 'body_type',
  'clothing_style', 'intimacy_level', 'mbti', 'reply_length', 'favorite_food',
  'favorite_music', 'pet_preference', 'how_met', 'relationship_status', 'shared_memory',
  'call_user_as', 'user_call_her_as', 'persona_prompt', 'relationship_stage',
  'current_scene', 'backstory', 'family_background', 'education',
  'voice_style', 'chat_mode_active', 'proactive_frequency', 'proactive_time_window',
]);
const IMPORT_INT_FIELDS = new Set([
  'age', 'height', 'introvert_level', 'use_emoji_level', 'use_kaomoji',
  'can_joke', 'avoid_cheesy', 'no_pressure', 'occasional_tantrum', 'encouraging',
  'nsfw_level', 'memory_enabled', 'proactive_enabled', 'voice_reply_enabled',
  'sticker_reply_enabled', 'max_tokens',
]);
const IMPORT_FLOAT_FIELDS = new Set(['temperature', 'top_p', 'voice_speed']);
const IMPORT_JSON_FIELDS = new Set([
  'personality_tags', 'speech_styles', 'hobbies', 'memory_priorities',
  'forbidden_topics', 'chat_modes',
]);

// Patterns that suggest injected credentials / prompts
const SENSITIVE_PATTERN = /api[_-]?key|secret|token|password|bearer\s+[a-z0-9]/i;

/**
 * Build an exportable JSON payload for a companion.
 * @param {number} companionId
 * @param {{ includeMemories?: boolean }} options
 */
export function buildCompanionExport(companionId, options = {}) {
  const db = getDb();
  const c = db.prepare(`SELECT ${PERSONA_FIELDS.join(', ')} FROM companions WHERE id = ?`).get(companionId);
  if (!c) throw Object.assign(new Error('Companion not found'), { status: 404 });

  const facts = db.prepare(
    `SELECT category, content, sort_order FROM companion_persona_facts WHERE companion_id = ? ORDER BY sort_order`
  ).all(companionId);

  const payload = {
    schema: EXPORT_SCHEMA,
    exported_at: new Date().toISOString(),
    companion: c,
    persona_facts: facts,
    core_memories: [],
    settings: {},
  };

  if (options.includeMemories) {
    const memories = db.prepare(
      `SELECT memory_layer, content, importance, memory_weight, memory_status, pinned, created_at
       FROM companion_memories
       WHERE companion_id = ? AND memory_status = 'active'
       ORDER BY importance DESC, created_at DESC
       LIMIT 200`
    ).all(companionId);
    payload.core_memories = memories;
  }

  return payload;
}

/**
 * Validate a raw parsed import payload.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function validateCompanionImport(payload) {
  if (!payload || typeof payload !== 'object') return { valid: false, error: 'payload must be an object' };
  if (payload.schema !== EXPORT_SCHEMA) return { valid: false, error: `unsupported schema: ${payload.schema}` };
  if (!payload.companion || typeof payload.companion !== 'object') return { valid: false, error: 'missing companion object' };
  if (typeof payload.companion.name !== 'string' || !payload.companion.name.trim()) {
    return { valid: false, error: 'companion.name is required' };
  }
  if (payload.persona_facts !== undefined && !Array.isArray(payload.persona_facts)) {
    return { valid: false, error: 'persona_facts must be an array' };
  }
  if (payload.core_memories !== undefined && !Array.isArray(payload.core_memories)) {
    return { valid: false, error: 'core_memories must be an array' };
  }
  return { valid: true };
}

/**
 * Strip sensitive patterns and unknown fields from a raw import payload.
 * Returns a sanitized { companionFields, personaFacts, coreMemories }.
 */
export function sanitizeImportedCompanion(payload) {
  const raw = payload.companion || {};
  const companionFields = {};

  for (const [key, val] of Object.entries(raw)) {
    if (IMPORT_STRING_FIELDS.has(key)) {
      const s = String(val ?? '').slice(0, 4000);
      companionFields[key] = SENSITIVE_PATTERN.test(s) ? '' : s;
    } else if (IMPORT_INT_FIELDS.has(key)) {
      const n = parseInt(val, 10);
      companionFields[key] = Number.isFinite(n) ? n : undefined;
    } else if (IMPORT_FLOAT_FIELDS.has(key)) {
      const f = parseFloat(val);
      companionFields[key] = Number.isFinite(f) ? f : undefined;
    } else if (IMPORT_JSON_FIELDS.has(key)) {
      try {
        const arr = Array.isArray(val) ? val : JSON.parse(String(val));
        if (Array.isArray(arr)) {
          companionFields[key] = JSON.stringify(arr.map(v => String(v).slice(0, 200)));
        }
      } catch {
        // skip malformed JSON
      }
    }
    // All other fields (account_id, user_id, bot_id, secrets…) are silently dropped
  }

  const personaFacts = (Array.isArray(payload.persona_facts) ? payload.persona_facts : [])
    .slice(0, 500)
    .map(f => ({
      category: String(f.category ?? 'general').slice(0, 100),
      content: String(f.content ?? '').slice(0, 1000),
      sort_order: parseInt(f.sort_order, 10) || 0,
    }))
    .filter(f => f.content && !SENSITIVE_PATTERN.test(f.content));

  const coreMemories = (Array.isArray(payload.core_memories) ? payload.core_memories : [])
    .slice(0, 200)
    .map(m => ({
      memory_layer: String(m.memory_layer ?? 'core').slice(0, 50),
      content: String(m.content ?? '').slice(0, 2000),
      importance: Math.min(10, Math.max(1, parseInt(m.importance, 10) || 5)),
      memory_weight: Math.min(5, Math.max(1, parseInt(m.memory_weight, 10) || 3)),
    }))
    .filter(m => m.content && !SENSITIVE_PATTERN.test(m.content));

  return { companionFields, personaFacts, coreMemories };
}

/**
 * Import a companion payload for a given user.
 * Creates a new companion owned by userId.
 * @param {number} userId
 * @param {number} accountId
 * @param {string} botId
 * @param {object} payload  parsed + validated import JSON
 * @param {{ importMemories?: boolean }} options
 */
export async function importCompanionForUser(userId, accountId, botId, payload, options = {}) {
  const db = getDb();
  const { companionFields, personaFacts, coreMemories } = sanitizeImportedCompanion(payload);

  const now = new Date().toISOString();
  const insertCompanion = db.prepare(`
    INSERT INTO companions (
      user_id, bot_id,
      name, age, role_title,
      hair_color, hair_style, eye_color, body_type, height, clothing_style,
      personality_tags, mbti, introvert_level,
      intimacy_level,
      speech_styles, use_emoji_level, use_kaomoji, reply_length,
      can_joke, avoid_cheesy, no_pressure, occasional_tantrum, encouraging, nsfw_level,
      hobbies, favorite_food, favorite_music, pet_preference,
      how_met, relationship_status, shared_memory,
      memory_priorities,
      proactive_enabled, proactive_frequency, proactive_time_window,
      voice_reply_enabled, sticker_reply_enabled,
      call_user_as, user_call_her_as,
      persona_prompt, forbidden_topics,
      memory_enabled,
      relationship_stage, current_scene,
      backstory, family_background, education,
      voice_style, voice_speed,
      chat_modes, chat_mode_active,
      temperature, max_tokens, top_p,
      created_at, updated_at
    ) VALUES (
      @user_id, @bot_id,
      @name, @age, @role_title,
      @hair_color, @hair_style, @eye_color, @body_type, @height, @clothing_style,
      @personality_tags, @mbti, @introvert_level,
      @intimacy_level,
      @speech_styles, @use_emoji_level, @use_kaomoji, @reply_length,
      @can_joke, @avoid_cheesy, @no_pressure, @occasional_tantrum, @encouraging, @nsfw_level,
      @hobbies, @favorite_food, @favorite_music, @pet_preference,
      @how_met, @relationship_status, @shared_memory,
      @memory_priorities,
      @proactive_enabled, @proactive_frequency, @proactive_time_window,
      @voice_reply_enabled, @sticker_reply_enabled,
      @call_user_as, @user_call_her_as,
      @persona_prompt, @forbidden_topics,
      @memory_enabled,
      @relationship_stage, @current_scene,
      @backstory, @family_background, @education,
      @voice_style, @voice_speed,
      @chat_modes, @chat_mode_active,
      @temperature, @max_tokens, @top_p,
      @created_at, @updated_at
    )
  `);

  const defaults = {
    age: 20, role_title: '邻家女孩',
    hair_color: '黑色', hair_style: '长发', eye_color: '棕色', body_type: '匀称',
    height: 165, clothing_style: '甜美',
    personality_tags: '["温柔","体贴"]', mbti: null, introvert_level: 5,
    intimacy_level: '慢慢熟悉',
    speech_styles: '["自然口语"]', use_emoji_level: 5, use_kaomoji: 0, reply_length: '适中(3-4句)',
    can_joke: 1, avoid_cheesy: 0, no_pressure: 0, occasional_tantrum: 0, encouraging: 1, nsfw_level: 0,
    hobbies: '[]', favorite_food: null, favorite_music: null, pet_preference: null,
    how_met: null, relationship_status: '普通朋友', shared_memory: null,
    memory_priorities: '["我的喜好","情绪变化"]',
    proactive_enabled: 1, proactive_frequency: '适中', proactive_time_window: '07:30-24:00',
    voice_reply_enabled: 0, sticker_reply_enabled: 0,
    call_user_as: '你', user_call_her_as: null,
    persona_prompt: '', forbidden_topics: '[]',
    memory_enabled: 1,
    relationship_stage: '陌生人', current_scene: '在家',
    backstory: null, family_background: null, education: null,
    voice_style: '温柔', voice_speed: 1.0,
    chat_modes: '["日常聊天"]', chat_mode_active: '日常聊天',
    temperature: 0.7, max_tokens: 2000, top_p: 0.9,
  };

  const row = { ...defaults, ...companionFields, user_id: userId, bot_id: botId, created_at: now, updated_at: now };
  const result = insertCompanion.run(row);
  const companionId = result.lastInsertRowid;

  if (personaFacts.length) {
    const insertFact = db.prepare(
      `INSERT INTO companion_persona_facts (companion_id, category, content, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    for (const f of personaFacts) {
      insertFact.run(companionId, f.category, f.content, f.sort_order, now);
    }
  }

  if (options.importMemories && coreMemories.length) {
    const insertMem = db.prepare(`
      INSERT INTO companion_memories
        (companion_id, user_id, memory_type, memory_layer, content, importance, memory_weight, memory_status, created_at)
      VALUES (?, ?, 'fact', ?, ?, ?, ?, 'active', ?)
    `);
    for (const m of coreMemories) {
      insertMem.run(companionId, userId, m.memory_layer, m.content, m.importance, m.memory_weight, now);
    }
  }

  return { companionId };
}

export { EXPORT_SCHEMA, MAX_IMPORT_BYTES };
