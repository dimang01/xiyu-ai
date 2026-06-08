/**
 * shaping.mjs — 共建独特性（Co-Shaped Companion）
 *
 * 让"她"成为用户一手共建、不可替代的：
 *   - detectTeaching: 从用户消息里识别"教她 / 定规矩"的意图（规则，保守，宁可漏）
 *   - buildShapingConfirmHint: 检测到时，让她当场自然答应 + 记住
 *   - buildShapingPromptHint: 把"他教过你的"作为高优先级规则注入每次回复
 *
 * 存储在 companion_shaping 表（db.mjs）。kind: nickname/style/taboo/pact/fact/lexicon。
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

// 明显不是"称呼"的词，避免 "叫我去/叫我走" 误判
const NICK_STOP = ['一下', '他', '她', '它', '你', '我', '人', '的', '了', '吗', '点', '别', '去', '来', '滚', '走', '走开', '闭嘴', '过来', '起来', '出去'];
// "叫我X"里 X 以动词开头多半不是称呼（叫我去开会 / 叫我等一下）
const VERB_HEAD = ['去', '来', '滚', '走', '帮', '陪', '看', '听', '想', '叫', '说', '做', '吃', '喝', '买', '给', '带', '找', '等', '把', '让', '闭', '过', '起', '出', '回', '滚'];

/**
 * 规则检测用户的"教学/纠正/约定"意图。返回 [{kind, content}]，可能多条；无则 []。
 * 设计原则：保守——只抓高确信模式，漏了无妨（用户会重复教），别把普通对话误判成教学。
 */
export function detectTeaching(text = '') {
  const t = String(text || '').trim();
  if (!t || t.length > 60) return [];   // 太长多半是叙述
  const out = [];
  let m;

  // 称呼：叫我X / 喊我X（排除动词开头如"叫我去开会"；称呼限 1-4 字）
  if ((m = t.match(/(?:以后)?(?:叫我|喊我|叫人家)\s*([^\s，。,.!！?？、]{1,4})/))
      && !NICK_STOP.includes(m[1]) && !VERB_HEAD.includes(m[1][0])) {
    out.push({ kind: 'nickname', content: m[1] });
  }
  // 别叫我X → 雷区
  if ((m = t.match(/别(?:再)?叫我\s*([^\s，。,.!！?？、]{1,6})/))) {
    out.push({ kind: 'taboo', content: `别叫"${m[1]}"` });
  }
  // 说话风格祈使
  if ((m = t.match(/(?:说话|语气|你)?\s*(皮|正经|凶|温柔|高冷|放飞|逗|贱|乖|骚|甜)\s*一?点/))) {
    out.push({ kind: 'style', content: `说话${m[1]}一点` });
  }
  if (/别(?:太)?正经|别老一本正经|放开点|放飞自我|别端着/.test(t)) out.push({ kind: 'style', content: '别太正经、放得开' });
  if ((m = t.match(/(少|多)发\s*(表情包|表情|语音|emoji)/))) out.push({ kind: 'style', content: `${m[1]}发${m[2]}` });

  // 雷区 / 不喜欢
  if ((m = t.match(/我(不吃|不喝|讨厌|最烦|受不了|很怕|特别怕|怕)\s*([^\s，。,.!！?？、]{1,8})/))) {
    out.push({ kind: 'taboo', content: `${m[1]}${m[2]}` });
  }

  // 约定（含"约定好/咱俩说好/说好了"等）
  if ((m = t.match(/(?:答应我|以后你要|以后你得|以后你要记得|我们说好|你要记得|(?:咱俩|咱们|我们)?约定好?|(?:咱俩|咱们)说好了?)\s*([^，。,.!！?？]{2,24})/))) {
    out.push({ kind: 'pact', content: m[1].trim() });
  }

  // 事实（身份/职业，结尾词约束避免误判）
  if ((m = t.match(/我是\s*(?:个|名|一名)?\s*([^\s，。,.!！?？的]{1,9}(?:师|员|生|手|工|家|长|总|警|程序员|医生|护士|老师|学生))/))) {
    out.push({ kind: 'fact', content: `是${m[1]}` });
  }
  // 事实（过敏 —— 重要健康事实，务必记住；要求"我/人家"开头避免误伤"你过敏吗"）
  if ((m = t.match(/(?:我|人家)(?:对)?\s*([^\s，。,.!！?？、]{1,8})过敏/))) {
    out.push({ kind: 'taboo', content: `对${m[1]}过敏（别碰）` });
  }
  // 事实（生肖/属相）
  if ((m = t.match(/我属\s*([鼠牛虎兔龙蛇马羊猴鸡狗猪])/))) {
    out.push({ kind: 'fact', content: `属${m[1]}` });
  }

  // 去重
  const seen = new Set();
  return out.filter(o => { const k = `${o.kind}:${o.content}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export const KIND_LABEL = { nickname: '称呼', style: '说话风格', taboo: '雷区', pact: '约定', fact: '关于他', lexicon: '专属梗' };

/** 当场确认：检测到教学时，让她自然答应 + 记住（注入这次 reply 的 prompt）。 */
export function buildShapingConfirmHint(taught = []) {
  if (!Array.isArray(taught) || !taught.length) return '';
  const lines = taught.map(t => {
    if (t.kind === 'nickname') return `他要你以后叫他「${t.content}」`;
    if (t.kind === 'style')    return `他要你说话变成「${t.content}」`;
    if (t.kind === 'taboo')    return `他的雷区：「${t.content}」`;
    if (t.kind === 'pact')     return `他跟你定下约定：「${t.content}」`;
    if (t.kind === 'fact')     return `他告诉你关于他：「${t.content}」`;
    return `「${t.content}」`;
  });
  return `\n【★ 他正在"调教"你 —— 本条最高优先级】\n他这条在教你 / 定规矩：\n- ${lines.join('\n- ')}\n你要**自然地答应、表示记住了**（用你的语气，别像机器人确认，可以小傲娇 / 小调皮），并从现在起真的照做。这是你们俩独有的默契。`;
}

/** 注入人设：把"他教过你的"作为高优先级规则带进每次回复。shapingList = listShaping(companionId)。 */
export function buildShapingPromptHint(shapingList = []) {
  if (!Array.isArray(shapingList) || !shapingList.length) return '';
  const byKind = {};
  for (const s of shapingList) (byKind[s.kind] ||= []).push(s.content);
  const parts = [];
  if (byKind.nickname?.length) parts.push(`- 称呼他：「${byKind.nickname[0]}」（他亲自定的，别用别的）`);
  if (byKind.style?.length)    parts.push(`- 说话风格：${byKind.style.join('；')}`);
  if (byKind.taboo?.length)    parts.push(`- 避开（他的雷区）：${byKind.taboo.join('；')}`);
  if (byKind.pact?.length)     parts.push(`- 你们的约定（要守）：${byKind.pact.join('；')}`);
  if (byKind.fact?.length)     parts.push(`- 记得关于他：${byKind.fact.join('；')}`);
  if (byKind.lexicon?.length)  parts.push(`- 你们的专属梗（可自然复用）：${byKind.lexicon.join('、')}`);
  if (!parts.length) return '';
  return `\n【★ 他亲手"调教"过你的（你们俩独有的默契，优先级高于通用人设）】\n${parts.join('\n')}`;
}
