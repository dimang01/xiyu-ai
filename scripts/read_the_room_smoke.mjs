/**
 * read_the_room_smoke.mjs — v1.16.x 主动消息「读空气」刹车护栏
 *
 * 校验 shouldBackoffProactive 的未回连发刹车：
 *  - 连发 < 阈值(3) → 还能发；≥3 → 闭嘴（防自说自话轰炸）
 *  - clingy 黏人模式（用户主动选）无视刹车
 *  - 各依恋风格一致
 *
 * 跑：node scripts/read_the_room_smoke.mjs
 */
import { shouldBackoffProactive } from '../src/proactive_engine.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.error('✗ FAIL:', name); } };

// 1h 前回复(不触发 idle backoff) + 没刚发过(不触发 minGap/夜间静默)，隔离出 unanswered 这一条
const c = (o = {}) => ({
  attachment_style: 'secure', proactive_intensity: 'normal',
  proactive_unanswered: 0,
  last_user_reply_at: new Date(Date.now() - 3600_000).toISOString(),
  last_proactive_reply_at: null,
  ...o,
});

check('未回 0 条 → 不刹车',           shouldBackoffProactive(c({ proactive_unanswered: 0 })) === false);
check('未回 2 条 → 还能发',           shouldBackoffProactive(c({ proactive_unanswered: 2 })) === false);
check('未回 3 条 → 刹车闭嘴',         shouldBackoffProactive(c({ proactive_unanswered: 3 })) === true);
check('未回 5 条 → 仍刹车',           shouldBackoffProactive(c({ proactive_unanswered: 5 })) === true);
check('clingy 黏人模式 → 无视刹车',   shouldBackoffProactive(c({ proactive_unanswered: 5, proactive_intensity: 'clingy' })) === false);
check('anxious 未回 3 条也刹车',      shouldBackoffProactive(c({ proactive_unanswered: 3, attachment_style: 'anxious' })) === true);
check('avoidant 未回 3 条也刹车',     shouldBackoffProactive(c({ proactive_unanswered: 3, attachment_style: 'avoidant' })) === true);

console.log(`\nread_the_room_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
