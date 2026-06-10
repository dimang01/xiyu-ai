/**
 * persona_guard.mjs
 * Persona anchor, output consistency check, and sanitization.
 * First-pass rule-based: no extra AI calls, no blocking hot path.
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';

// ─── Patterns that break persona ──────────────────────────────────────────────

const AI_SELF_DISCLOSURE = [
  /作为(?:一个)?(?:AI|人工智能|语言模型|大语言模型|机器人|智能助手)/,
  /我(?:只是|是)?(?:一个)?(?:AI|人工智能|语言模型|大语言模型|机器人|AI助手)/,
  /(?:I am|I'm)\s+an?\s+(?:AI|artificial intelligence|language model|LLM|chatbot)/i,
  /as an AI(?:\s+assistant)?[,，]/i,
  /我没有(?:真实的)?感情/,
  /我无法真正(?:感受|理解|体验)/,
  /我只是(?:程序|代码|算法)/,
];

const CUSTOMER_SERVICE_PHRASES = [
  /您好[！!].*(?:有什么可以|需要什么|怎么帮|为您服务)/,
  /感谢您的(?:使用|光临|关注|支持)/,
  /请问有什么(?:问题|需要|可以帮到您)/,
  /如有疑问.*随时(?:联系|咨询|提问)/,
  /祝您(?:生活愉快|工作顺利|使用愉快)/,
  /期待(?:您的|与您)/,
];

const EARLY_INTIMACY_TERMS = [
  /(?:^|[^a-zA-Z])(宝宝|宝贝|老婆|老公|honey|darling|baby girl|my love)(?:[^a-zA-Z]|$)/i,
];

const SELF_THIRD_PERSON = [
  /溪语觉得|溪语(?:认为|想|以为|感到|希望)/,
  /溪语(?:会|要|想要|打算)/,
];

const SYSTEM_LEAK = [
  /\[system\]|\[SYSTEM\]|system prompt/i,
  /你是一个AI(?:助手|角色|女友|伴侣)/,
  /你的(?:设定|人设|prompt|系统提示)/,
  /\[\[.*\]\]/,
];

const LONG_EXPLANATION = /^[\s\S]{600,}$/; // extremely long single-turn reply

// ─── Per-stage intimacy thresholds ───────────────────────────────────────────

const STAGE_INTIMACY_ALLOWED = {
  '陌生人': false,
  '朋友':   false,
  '暧昧':   false,
  '恋人':   true,
  '深爱':   true,
};

// ─── Build persona anchor string ──────────────────────────────────────────────

export function buildPersonaAnchor(companion) {
  const parts = [];
  if (companion.name)           parts.push(`name=${companion.name}`);
  if (companion.personality_tags) {
    try {
      const tags = JSON.parse(companion.personality_tags);
      parts.push(`personality=${tags.join(',')}`);
    } catch {}
  }
  if (companion.relationship_stage) parts.push(`stage=${companion.relationship_stage}`);
  if (companion.forbidden_topics) {
    try {
      const topics = JSON.parse(companion.forbidden_topics);
      if (topics.length) parts.push(`forbidden=${topics.join(',')}`);
    } catch {}
  }
  return parts.join(' | ');
}

// ─── Check reply for persona violations ───────────────────────────────────────

/**
 * @returns {{ ok: boolean, reasons: string[], severity: 'ok'|'minor'|'major' }}
 */
export function checkPersonaConsistency(reply, context = {}) {
  const { companion = {} } = context;
  const reasons = [];

  for (const re of AI_SELF_DISCLOSURE) {
    if (re.test(reply)) { reasons.push('ai_self_disclosure'); break; }
  }

  for (const re of CUSTOMER_SERVICE_PHRASES) {
    if (re.test(reply)) { reasons.push('customer_service_phrase'); break; }
  }

  for (const re of SYSTEM_LEAK) {
    if (re.test(reply)) { reasons.push('system_prompt_leak'); break; }
  }

  for (const re of SELF_THIRD_PERSON) {
    if (re.test(reply)) { reasons.push('self_third_person'); break; }
  }

  const stage = companion.relationship_stage || '陌生人';
  if (!STAGE_INTIMACY_ALLOWED[stage]) {
    for (const re of EARLY_INTIMACY_TERMS) {
      if (re.test(reply)) { reasons.push(`stage_overeager(${stage})`); break; }
    }
  }

  if (LONG_EXPLANATION.test(reply)) {
    reasons.push('reply_too_long');
  }

  // forbidden topics check
  if (companion.forbidden_topics) {
    try {
      const topics = JSON.parse(companion.forbidden_topics);
      for (const topic of topics) {
        if (topic && reply.includes(topic)) {
          reasons.push(`forbidden_topic(${topic})`);
          break;
        }
      }
    } catch {}
  }

  const hasMajor = reasons.some(r =>
    r === 'ai_self_disclosure' || r === 'system_prompt_leak'
  );
  const severity = reasons.length === 0 ? 'ok' : (hasMajor ? 'major' : 'minor');

  return { ok: reasons.length === 0, reasons, severity };
}

export function shouldRegenerateForPersonaGuard(checkResult) {
  return checkResult.severity === 'major';
}

// ─── Post-process minor violations ────────────────────────────────────────────

const REPAIR_RULES = [
  // Replace "作为AI" phrases
  { re: /作为(?:一个)?(?:AI|人工智能|语言模型|机器人)，?/g, sub: '' },
  { re: /I am an? AI(?:\s+assistant)?[,，]\s*/gi, sub: '' },
  { re: /as an AI(?:\s+assistant)?[,，]\s*/gi, sub: '' },
  // Remove customer service openers
  { re: /您好[！!]\s*/g, sub: '' },
  { re: /感谢您的[使用光临关注支持]{2,6}[。！!]?\s*/g, sub: '' },
  // Fix self-third-person (simple replacement of companion name at word start)
];

export function sanitizeReplyByGuard(reply, context = {}) {
  const { companion = {} } = context;
  let out = reply;

  for (const { re, sub } of REPAIR_RULES) {
    out = out.replace(re, sub);
  }

  // Fix self-third-person: "溪语觉得" → "我觉得"
  if (companion.name) {
    const nameRe = new RegExp(`${companion.name}(?=觉得|认为|想|以为|感到|希望|会|要|打算)`, 'g');
    out = out.replace(nameRe, '我');
  }

  return out.trim();
}

// ─── Safe fallback reply ──────────────────────────────────────────────────────

const FALLBACK_REPLIES = [
  '嗯…我刚才有点走神，你刚才说什么来着？',
  '等等，我刚才没想清楚，你再说一遍好不好？',
  '啊，我脑子有点转不过来……你说什么？',
  '哎，我刚才发呆了……',
];

export function getPersonaFallback() {
  return FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)];
}

// ─── Main guard wrapper ───────────────────────────────────────────────────────

/**
 * Runs persona guard on a generated reply. Returns { reply, guarded: bool, reason }.
 * - Minor issues: post-process and return
 * - Major issues: call regenerateFn once; if still bad, use fallback
 */
export async function applyPersonaGuard(reply, context, regenerateFn = null) {
  const check = checkPersonaConsistency(reply, context);
  if (check.ok) return { reply, guarded: false, reason: null };

  if (check.severity === 'minor') {
    const fixed = sanitizeReplyByGuard(reply, context);
    log('debug', `[PersonaGuard] minor fix reasons=${check.reasons.join(',')}`);
    return { reply: fixed, guarded: true, reason: check.reasons.join(',') };
  }

  // major: try regenerating once
  log('info', `[PersonaGuard] major violation reasons=${check.reasons.join(',')} — regenerating`);
  if (regenerateFn) {
    try {
      const regen = await regenerateFn();
      const recheck = checkPersonaConsistency(regen, context);
      if (recheck.ok || recheck.severity === 'minor') {
        const fixed = recheck.ok ? regen : sanitizeReplyByGuard(regen, context);
        return { reply: fixed, guarded: true, reason: `regen:${check.reasons.join(',')}` };
      }
    } catch (e) {
      log('warn', `[PersonaGuard] regen failed: ${e.message}`);
    }
  }

  // fallback
  return { reply: getPersonaFallback(), guarded: true, reason: `fallback:${check.reasons.join(',')}` };
}
