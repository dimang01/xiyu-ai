/**
 * Lightweight Event Graph Foundation
 *
 * SQLite-backed entity/relation graph for companion memory.
 * No Neo4j. Pure SQLite. First-pass rule-based extraction — no LLM needed.
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { getDb } from './db.mjs';

const VALID_ENTITY_TYPES = new Set(['person', 'place', 'thing', 'event', 'preference', 'reminder', 'other']);
const VALID_RELATION_TYPES = new Set([
  'likes', 'dislikes', 'visited', 'mentioned', 'promised_reminder', 'owns', 'knows', 'related_to',
]);

export function normalizeEntityType(type) {
  const t = String(type ?? '').toLowerCase().trim();
  return VALID_ENTITY_TYPES.has(t) ? t : 'other';
}

// Simple rule-based extraction — no LLM required
const EXTRACTION_RULES = [
  { pattern: /(?:我|用户)喜欢\s*([^\s，,。！!？?]{2,20})/g,    relation: 'likes',            entityType: 'thing' },
  { pattern: /(?:我|用户)不喜欢\s*([^\s，,。！!？?]{2,20})/g,  relation: 'dislikes',         entityType: 'thing' },
  { pattern: /(?:我|用户)去(?:过|了)\s*([^\s，,。！!？?]{2,20})/g, relation: 'visited',      entityType: 'place' },
  { pattern: /(?:我|用户)提到\s*([^\s，,。！!？?]{2,20})/g,    relation: 'mentioned',        entityType: 'thing' },
  { pattern: /提醒(?:我|用户)(?:要|去)?\s*([^\s，,。！!？?]{2,20})/g, relation: 'promised_reminder', entityType: 'reminder' },
  { pattern: /(?:我|用户)有个?(?:朋友|同事|家人)\s*([^\s，,。！!？?]{2,10})/g, relation: 'knows', entityType: 'person' },
];

/**
 * Extract (relation, entityName, entityType) triples from a memory text string.
 * Returns array of { relation, entityName, entityType }.
 */
export function extractSimpleEntitiesFromMemory(memoryText) {
  const text = String(memoryText ?? '');
  const results = [];
  const seen = new Set();

  for (const rule of EXTRACTION_RULES) {
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(text)) !== null) {
      const name = m[1].trim();
      const key = `${rule.relation}:${name}`;
      if (name && !seen.has(key)) {
        seen.add(key);
        results.push({ relation: rule.relation, entityName: name, entityType: rule.entityType });
      }
    }
  }

  return results;
}

/**
 * Insert or return an entity. Matches on (companion_id, entity_type, name).
 */
export function upsertMemoryEntity(companionId, entity) {
  const db = getDb();
  const type = normalizeEntityType(entity.entityType ?? entity.entity_type);
  const name = String(entity.name ?? entity.entityName ?? '').trim().slice(0, 200);
  if (!name) throw new Error('entity name is required');

  const now = new Date().toISOString();
  const existing = db.prepare(
    `SELECT id FROM memory_entities WHERE companion_id = ? AND entity_type = ? AND name = ?`
  ).get(companionId, type, name);

  if (existing) {
    db.prepare(`UPDATE memory_entities SET updated_at = ? WHERE id = ?`).run(now, existing.id);
    return existing.id;
  }

  const aliases = entity.aliases ? JSON.stringify(entity.aliases) : null;
  const result = db.prepare(
    `INSERT INTO memory_entities (companion_id, entity_type, name, aliases_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(companionId, type, name, aliases, now, now);
  return result.lastInsertRowid;
}

/**
 * Add a relation between two entities.
 * @param {number} companionId
 * @param {{ sourceEntityId, relationType, targetEntityId, evidenceMemoryId?, confidence? }} relation
 */
export function addMemoryRelation(companionId, relation) {
  const db = getDb();
  const relType = String(relation.relationType ?? relation.relation_type ?? '').toLowerCase();
  if (!VALID_RELATION_TYPES.has(relType)) {
    throw new Error(`unknown relation type: ${relType}`);
  }

  const now = new Date().toISOString();
  const confidence = Math.min(1, Math.max(0, parseFloat(relation.confidence ?? 0.5)));
  try {
    db.prepare(`
      INSERT INTO memory_relations
        (companion_id, source_entity_id, relation_type, target_entity_id, evidence_memory_id, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      companionId,
      relation.sourceEntityId,
      relType,
      relation.targetEntityId,
      relation.evidenceMemoryId ?? null,
      confidence,
      now,
    );
  } catch {
    // Duplicate edges are acceptable — skip silently
  }
  return true;
}

/**
 * Return entities and their relations for a companion.
 * @param {number} companionId
 * @param {{ limit?: number, entityType?: string }} options
 */
export function getCompanionEventGraph(companionId, options = {}) {
  const db = getDb();
  const limit = Math.min(500, parseInt(options.limit, 10) || 100);

  let entityQuery = `SELECT id, entity_type, name, aliases_json, created_at FROM memory_entities WHERE companion_id = ?`;
  const entityArgs = [companionId];
  if (options.entityType) {
    entityQuery += ` AND entity_type = ?`;
    entityArgs.push(normalizeEntityType(options.entityType));
  }
  entityQuery += ` ORDER BY updated_at DESC LIMIT ?`;
  entityArgs.push(limit);

  const entities = db.prepare(entityQuery).all(...entityArgs);

  const entityIds = entities.map(e => e.id);
  let relations = [];
  if (entityIds.length) {
    const placeholders = entityIds.map(() => '?').join(',');
    relations = db.prepare(`
      SELECT r.id, r.source_entity_id, r.relation_type, r.target_entity_id,
             r.evidence_memory_id, r.confidence, r.created_at
      FROM memory_relations r
      WHERE r.companion_id = ?
        AND (r.source_entity_id IN (${placeholders}) OR r.target_entity_id IN (${placeholders}))
      ORDER BY r.created_at DESC
      LIMIT ?
    `).all(companionId, ...entityIds, ...entityIds, limit);
  }

  return { entities, relations };
}

/**
 * Process a newly saved memory: extract entities and relations, store them.
 * @param {number} companionId
 * @param {string} memoryText
 * @param {number|null} memoryId
 */
export function processMemoryForGraph(companionId, memoryText, memoryId = null) {
  const extractions = extractSimpleEntitiesFromMemory(memoryText);
  if (!extractions.length) return;

  const db = getDb();

  // Use a single "user" entity as source for all relations
  let userId;
  try {
    userId = upsertMemoryEntity(companionId, { entityType: 'person', name: '用户' });
  } catch {
    return;
  }

  for (const { relation, entityName, entityType } of extractions) {
    try {
      const targetId = upsertMemoryEntity(companionId, { entityType, name: entityName });
      addMemoryRelation(companionId, {
        sourceEntityId: userId,
        relationType: relation,
        targetEntityId: targetId,
        evidenceMemoryId: memoryId,
        confidence: 0.7,
      });
    } catch {
      // Non-fatal — continue
    }
  }
}
