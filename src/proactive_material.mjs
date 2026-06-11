/**
 * proactive_material.mjs — 主动消息素材级去重（v1.21.3 PR-E，纯函数零 IO）
 *
 * 解决的事故形态：「橘猫像小汤圆」同一个梗 3 天出场 3 次。措辞次次不同，
 * trigram 撞车检测（比近 5 条原文）抓不到；但"小汤圆"三个字次次在场——
 * 专有名词正是高权重记忆的锚。
 *
 * 两层职责：
 *   - filterRecentlyUsed: 召回候选按素材 ID 冷却过滤（硬约束，看不到就说不出）
 *   - extractMaterialRefs: 发送成功后归因——reply 实际引用了哪些候选记忆
 *     （锚匹配：≥4 字公共子串直接命中；3 字子串要求不是泛词碎片）
 *
 * 冷却判定按单条素材 ID（不是"素材×场景"组合）：用户感知的重复单位是
 * 梗本身，换个街角小汤圆也不该复活。scene/kind 只落账观察，不参与判定。
 *
 * ⚠ 本模块只许被 proactive 链路 import。对话召回（bot.mjs / playground.mjs）
 * 绝不挂这个过滤——她主动不提是克制，他聊起来接不住是失忆。
 * （静态断言在 scripts/proactive_material_smoke.mjs）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { normalizeForSim } from './text_similarity.mjs';

/** 默认冷却天数（env PROACTIVE_MATERIAL_DEDUP_DAYS 覆盖） */
export const DEFAULT_DEDUP_DAYS = 14;

export function materialDedupDays(env = process.env) {
  const n = Number(env.PROACTIVE_MATERIAL_DEDUP_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DEDUP_DAYS;
}

/** 素材 ID 规范：记忆 mem:<id>，open loop loop:<id> */
export function memMaterialId(memoryId) { return `mem:${memoryId}`; }
export function loopMaterialId(loopId) { return `loop:${loopId}`; }

/**
 * 召回候选冷却过滤：usedIds（Set）里出现过的记忆出局。
 * fail-safe：usedIds 异常时原样放行（宁可重复不可断供）。
 */
export function filterRecentlyUsed(memories, usedIds) {
  if (!Array.isArray(memories) || !memories.length) return memories || [];
  if (!(usedIds instanceof Set) || !usedIds.size) return memories;
  return memories.filter(m => !usedIds.has(memMaterialId(m?.id)));
}

// 泛字集：公共子串若大半由这些高频字构成，不算"梗的锚"（避免"今天的""了一下"
// 这类碎片误判引用）。注意"小汤圆""多肉""室友"等真锚不受影响。
const GENERIC_CHARS = new Set(
  '的了在是我你他她它们都很就还又也和跟与这那哪个啊呀吧呢吗嘛不没有要会能可以什么怎么时候今天明天昨天现在然后觉得知道说想看好一二三上下'.split('')
);

// 常见双字白名单：2 字锚的额外门槛——这些词在任何对话里都高频出现，
// 与具体记忆无关（"下周"撞上"下周出差"不等于在用这条记忆）。
const GENERIC_BIGRAMS = new Set([
  '下周', '这周', '上周', '周末', '今晚', '昨晚', '明早', '早上', '晚上', '中午', '下午',
  '工作', '上班', '下班', '加班', '吃饭', '睡觉', '起床', '出门', '回家', '回来', '过来',
  '消息', '电话', '视频', '东西', '时间', '事情', '感觉', '喜欢', '开心', '难过', '突然',
  '刚刚', '刚才', '最近', '已经', '一起', '自己', '别人', '朋友', '记得', '忘记',
]);

function isGenericFragment(s) {
  // 2 字锚：两字必须全非泛字，且不在常见双字白名单
  // （阈值偏松是有意的——误报代价是某条记忆多冷却 14 天（克制方向），
  //   漏报代价是同梗复读（事故）。生产案例里 LLM 把"小汤圆"缩称"汤圆"，
  //   3 字阈值就咬不住了——红色验证沙箱抓出来的。）
  if (s.length === 2) {
    return GENERIC_BIGRAMS.has(s) || [...s].some(ch => GENERIC_CHARS.has(ch));
  }
  let generic = 0;
  for (const ch of s) if (GENERIC_CHARS.has(ch)) generic++;
  return generic >= Math.ceil(s.length / 2);   // 一半以上泛字 = 碎片
}

/** 找 a、b 的全部公共子串里"最强的锚"：返回 { len, text }（归一化后比较） */
function strongestCommonAnchor(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return { len: 0, text: '' };
  let prev = new Uint16Array(n + 1);
  let curr = new Uint16Array(n + 1);
  let best = { len: 0, text: '' };
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
      if (curr[j] >= 2) {
        const text = a.slice(i - curr[j], i);
        // 锚资格：≥4 字直接够格；2-3 字过泛词碎片关（见 isGenericFragment）
        if (!isGenericFragment(text) && curr[j] > best.len) best = { len: curr[j], text };
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return best;
}

/**
 * 归因：reply 实际引用了候选里的哪几条素材。
 * @param {string} reply 已发出的主动消息全文
 * @param {Array<{id: string, content: string}>} candidates 进过 prompt 的素材
 *        （id 已是 mem:/loop: 规范形式）
 * @returns {string[]} 命中的素材 ID
 */
export function extractMaterialRefs(reply, candidates) {
  const r = normalizeForSim(reply || '');
  if (r.length < 4 || !Array.isArray(candidates)) return [];
  const refs = [];
  for (const c of candidates) {
    const content = normalizeForSim(c?.content || '');
    if (content.length < 3) continue;
    const anchor = strongestCommonAnchor(content, r);
    // ≥2 字公共锚即命中（"汤圆""橘猫"这类缩称正是 2 字）——泛词碎片
    // 与常见双字已在 strongestCommonAnchor 里过滤
    if (anchor.len >= 2) refs.push(String(c.id));
  }
  return refs;
}

/** 软约束注入段：近 N 天已发主动消息摘要，明示近期已用素材禁止再用相近内容 */
export function buildRecentProactiveHint(texts, { perItem = 40, maxItems = 8 } = {}) {
  const items = (Array.isArray(texts) ? texts : [])
    .map(t => String(t || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, maxItems);
  if (!items.length) return '';
  return `\n\n【★ 近 7 天你主动发过这些】\n${items.map(t => `- ${t.slice(0, perItem)}`).join('\n')}\n上面提过的具体事物、梗、回忆（某只宠物、某件小事、某个比喻），这次**严格禁止**再提——换个说法重提也不行。聊点全新的。`;
}
