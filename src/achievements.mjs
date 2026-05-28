/**
 * Achievements / Milestones
 *
 * Lightweight relationship milestones — no pay-gating, no manipulation,
 * just a quiet record of time spent together.
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { getDb } from './db.mjs';

const ACHIEVEMENT_DEFINITIONS = [
  {
    key: 'first_chat',
    title: '初次相遇',
    description: '与她进行了第一次对话',
  },
  {
    key: 'first_memory_saved',
    title: '留下印记',
    description: '第一条记忆被保存下来',
  },
  {
    key: 'first_proactive_message',
    title: '她主动了',
    description: '她第一次主动发来消息',
  },
  {
    key: 'first_scene_photo',
    title: '共同记录',
    description: '第一次分享了照片',
  },
  {
    key: 'seven_days_together',
    title: '一周之约',
    description: '相识已满七天',
  },
  {
    key: 'thirty_days_together',
    title: '一月相伴',
    description: '相识已满三十天',
  },
  {
    key: 'relationship_stage_friend',
    title: '成为朋友',
    description: '关系进展到了朋友阶段',
  },
  {
    key: 'relationship_stage_flirting',
    title: '暧昧开始',
    description: '关系进展到了暧昧阶段',
  },
  {
    key: 'relationship_stage_lover',
    title: '心意相通',
    description: '关系进展到了恋人阶段',
  },
  {
    key: 'first_pinned_memory',
    title: '珍贵记忆',
    description: '第一次固定了一条记忆',
  },
];

const DEFINITION_MAP = new Map(ACHIEVEMENT_DEFINITIONS.map(d => [d.key, d]));

export function listAchievementDefinitions() {
  return ACHIEVEMENT_DEFINITIONS;
}

/**
 * Check event and unlock matching achievements.
 * @param {number} companionId
 * @param {string} event - one of the achievement keys
 * @param {object} context - optional metadata
 * @returns {object|null} unlocked achievement row or null
 */
export function checkAndUnlockAchievements(companionId, event, context = {}) {
  const def = DEFINITION_MAP.get(event);
  if (!def) return null;

  const db = getDb();
  const existing = db.prepare(
    `SELECT id FROM companion_achievements WHERE companion_id = ? AND achievement_key = ?`
  ).get(companionId, event);
  if (existing) return null;

  const metadata = Object.keys(context).length ? JSON.stringify(context) : null;
  try {
    db.prepare(`
      INSERT INTO companion_achievements (companion_id, achievement_key, title, description, metadata_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(companionId, def.key, def.title, def.description, metadata);
  } catch {
    // UNIQUE constraint race — already unlocked
    return null;
  }

  return db.prepare(
    `SELECT * FROM companion_achievements WHERE companion_id = ? AND achievement_key = ?`
  ).get(companionId, event);
}

/**
 * Return all achievements for a companion, newest first.
 */
export function getCompanionAchievements(companionId) {
  const db = getDb();
  return db.prepare(
    `SELECT id, achievement_key, title, description, unlocked_at, metadata_json
     FROM companion_achievements
     WHERE companion_id = ?
     ORDER BY unlocked_at DESC`
  ).all(companionId);
}
