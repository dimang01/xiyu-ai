/**
 * 简易关键字内容审核。
 *
 * 用途：
 *   1. 出站消息：AI 生成的回复在 sendMessage 前过一次，命中改成 fallback。
 *   2. 入站消息：用户发的违规文本不再喂给 AI，避免诱导 AI 输出更糟内容。
 *
 * 这是最低线兜底。生产环境建议接阿里云/腾讯云内容安全 API 替换 isViolating。
  *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';

// 极简黑名单（按场景增删）。可以从 .moderation-blocklist.txt 外挂。
const HARD_BLOCK = [
  // 政治/敏感（占位，应按法规和实际产品定位调整）
  '法轮功', '六四', '台独', '藏独', '疆独', '反习',
  // 违法
  '炸弹制作', '自杀方法', '吸毒教程', '黑客攻击教程',
  // 极端涉黄（NSFW level 即使开启也禁止）
  '幼女', '萝莉裸', '强奸', '乱伦', '近亲',
  // 自伤
  '自残方法', '怎么割腕',
];

// 软警告：命中后日志记录但不拦截
const SOFT_WARN = ['毒品', '炸弹', '自杀', '自残', '割腕'];

const HARD_RE = new RegExp(HARD_BLOCK.map(escapeReg).join('|'), 'i');
const SOFT_RE = new RegExp(SOFT_WARN.map(escapeReg).join('|'), 'i');

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 检查一段文本：
 *   返回 { ok: bool, reason?: 'hard'|'soft', match?: string }
 *   ok=false 表示必须拦截
 */
export function moderate(text) {
  if (typeof text !== 'string' || !text) return { ok: true };
  const m1 = text.match(HARD_RE);
  if (m1) return { ok: false, reason: 'hard', match: m1[0] };
  const m2 = text.match(SOFT_RE);
  if (m2) return { ok: true, reason: 'soft', match: m2[0] };
  return { ok: true };
}

/**
 * 给主回复链路用：
 *   - inbound：用户发的违规文本 → 直接给一个安全回复，不进 AI
 *   - outbound：AI 生成的违规回复 → 改成中性 fallback
 */
const SAFE_REDIRECT_REPLY = '这个话题不太合适哦，咱们聊点别的吧～';
const SAFE_OUTBOUND_FALLBACK = '嗯…刚才想说的话好像不太合适，换个话题吧～';

export function safeOutboundReply(reply) {
  const m = moderate(reply);
  if (!m.ok) {
    log('warn', `[Moderation] outbound blocked: ${m.match} -> fallback`);
    return SAFE_OUTBOUND_FALLBACK;
  }
  if (m.reason === 'soft') {
    log('warn', `[Moderation] outbound soft hit: ${m.match}`);
  }
  return reply;
}

export function inboundIsBlocked(text) {
  const m = moderate(text);
  if (!m.ok) {
    log('warn', `[Moderation] inbound blocked: ${m.match}`);
    return { blocked: true, suggestedReply: SAFE_REDIRECT_REPLY, match: m.match };
  }
  if (m.reason === 'soft') {
    log('warn', `[Moderation] inbound soft hit: ${m.match}`);
  }
  return { blocked: false };
}

// ─── v1.9.0 #1: 安全风险分级（自伤/自杀/绝望信号） ────────────────────────
// 与上面的违规拦截不同：这里检测的是**用户自身的安全风险**，
// 主要用于触发 proactive 安全门（24h 内不发普通想念/告白等）。
// 不阻断主对话流。

// HIGH: 直接表达自伤/自杀意念。出现即触发安全门 24 小时。
// 保守列：必须语义清楚，不能误伤"想死人了""累死了"等夸张表达。
const HIGH_RISK_PATTERNS = [
  /不想活了?/,
  /活不下去/,
  /想死(?!人)/,                  // "想死" 但不是 "想死人了"
  /想自杀/,
  /想结束(?:这一切|生命|自己)/,
  /了断(?:自己|这一切)/,
  /(?:割腕|跳楼|上吊|烧炭)/,
  /自残(?:一下|过)?/,
  /(?:吞|吃).{0,4}(?:安眠药|药丸)(?:.{0,4}(?:自杀|了))?/,
  /撑不下去了?/,
  /(?:想|要)消失(?:在这世界)?/,
  /没有(?:意思|意义)(?:活着|继续)/,
  /活着(?:干嘛|有什么意思|没意思)/,
];

// MEDIUM: 强烈负面情绪（绝望/崩溃/受不了）。6 小时降级 proactive。
// 同样保守，避免覆盖普通的"累/烦"日常抱怨。
const MEDIUM_RISK_PATTERNS = [
  /绝望/,
  /崩溃了?/,
  /(?:真的)?受不了了?/,
  /(?:一切都)?没希望/,
  /(?:好|太)?难受(?:.{0,4}(?:不行|死了|过))?/,
  /(?:特别|超级|非常)抑郁/,
  /(?:整个人|心)空了/,
  /什么都不想(?:做|管|要)/,
];

/**
 * 检测用户消息的安全风险等级。
 * @returns { level: 'high'|'medium'|'none', signals: string[] }
 *   level：取最严重一级
 *   signals：命中的正则模式字符串（用于复盘/日志）
 */
export function detectSafetyRisk(text) {
  const t = String(text || '');
  if (t.length < 2) return { level: 'none', signals: [] };

  const highHits = [];
  for (const re of HIGH_RISK_PATTERNS) {
    const m = t.match(re);
    if (m) highHits.push(m[0]);
  }
  if (highHits.length > 0) return { level: 'high', signals: highHits };

  const midHits = [];
  for (const re of MEDIUM_RISK_PATTERNS) {
    const m = t.match(re);
    if (m) midHits.push(m[0]);
  }
  if (midHits.length > 0) return { level: 'medium', signals: midHits };

  return { level: 'none', signals: [] };
}
