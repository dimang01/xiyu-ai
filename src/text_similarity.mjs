/**
 * text_similarity.mjs — 文本相似度工具（v1.5.2）
 *
 * 用于检测主动消息 / 回复多段之间的重复：
 *   - normalizeForSim: 标准化（去 || / 去 emoji / 去空格 / 转小写）
 *   - ngramSet:       生成 N-gram set
 *   - jaccard:        两个 set 的 Jaccard 相似度
 *   - findCollision:  与一组历史文本比，返回相似度最高一条
 *   - dedupSegments:  对一组段过滤掉与前面段相似度 ≥ threshold 的
 *
 * 拆出来是为了避免 bot.mjs ↔ proactive.mjs 互相 import，复用同一套阈值。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

export function normalizeForSim(s) {
  return String(s)
    .replace(/\|\||｜｜/g, ' ')
    .replace(/\[[^\]]*\]/g, '')          // 去 [图片] / [系统标签]
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')  // 去 emoji
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function ngramSet(s, n = 3) {
  const set = new Set();
  if (!s || s.length < n) return set;
  for (let i = 0; i <= s.length - n; i++) set.add(s.slice(i, i + n));
  return set;
}

export function jaccard(a, b) {
  if (!a?.size || !b?.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 找一条 reply 在 recentTexts 里相似度最高的撞车（≥ threshold）
 * @returns {{ text: string, sim: number } | null}
 */
export function findCollision(reply, recentTexts, threshold = 0.55) {
  if (!reply || !recentTexts?.length) return null;
  const a = normalizeForSim(reply);
  if (a.length < 6) return null;
  const aGrams = ngramSet(a, 3);
  let best = null;
  for (const t of recentTexts) {
    const b = normalizeForSim(t);
    if (b.length < 6) continue;
    const bGrams = ngramSet(b, 3);
    const sim = jaccard(aGrams, bGrams);
    if (sim >= threshold && (!best || sim > best.sim)) best = { text: t, sim };
  }
  return best;
}

/**
 * 最长公共子串（在归一化后的字符串上）长度。O(M*N) 但段长一般 <100 字，可接受。
 * 用作 Jaccard 之外的"强语义信号"——中文 LLM 改个说法时关键短语往往原样保留。
 *   例："刚和室友给多肉换了盆" 和 "刚才跟室友一起给多肉重新装了一下盆"
 *        最长公共子串 = "室友" + "多肉" 之间会断；但 "刚醒没多久" 这类高频片段易抓到。
 */
export function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  // 滚动数组
  let prev = new Uint16Array(n + 1);
  let curr = new Uint16Array(n + 1);
  let best = 0;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i-1] === b[j-1] ? prev[j-1] + 1 : 0;
      if (curr[j] > best) best = curr[j];
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return best;
}

/**
 * 综合判定两段中文文本是否"语义重复"
 *   - bigram Jaccard ≥ jaccardTh，或
 *   - 最长公共子串 ≥ lcsTh 字符（短句强信号）
 *
 * 中文 trigram Jaccard 在 LLM 改写场景区分度太低；bigram + LCS 组合更可靠。
 */
export function isSemanticallySimilar(a, b, { jaccardTh = 0.25, lcsTh = 4, bigram = true } = {}) {
  const na = normalizeForSim(a);
  const nb = normalizeForSim(b);
  if (na.length < 4 || nb.length < 4) return { hit: false, reason: 'too-short' };
  const n = bigram ? 2 : 3;
  const sim = jaccard(ngramSet(na, n), ngramSet(nb, n));
  const lcs = longestCommonSubstring(na, nb);
  if (sim >= jaccardTh) return { hit: true, reason: 'jaccard', sim, lcs };
  if (lcs >= lcsTh)     return { hit: true, reason: 'lcs',     sim, lcs };
  return { hit: false, sim, lcs };
}

/**
 * 段内去重：对一组分段消息，从前往后扫，把与前面已保留段语义重复的剪掉。
 * 修复"LLM 一次生成的多段 || 内部出现语义重复"的 bug
 *   例：['早上好呀～刚醒没多久', '早呀～我刚醒没多久还在赖床'] → 只保留第一段
 *
 * 阈值用 isSemanticallySimilar 的组合：bigram Jaccard ≥ 0.30 或公共子串 ≥ 5 字。
 *
 * @returns {{ kept: string[], dropped: Array<{idx:number, text:string, similar_to:string, sim:number, lcs:number, reason:string}> }}
 */
export function dedupSegments(segments, options = {}) {
  const opts = typeof options === 'number'
    ? { jaccardTh: options, lcsTh: 4 }   // 向后兼容：第二参数曾是 threshold
    : { jaccardTh: 0.25, lcsTh: 4, ...options };
  if (!Array.isArray(segments) || segments.length <= 1) {
    return { kept: segments || [], dropped: [] };
  }
  const kept = [];
  const dropped = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = String(segments[i] || '').trim();
    if (!seg) continue;
    let bestHit = null;
    for (let j = 0; j < kept.length; j++) {
      const r = isSemanticallySimilar(seg, kept[j], opts);
      if (r.hit && (!bestHit || (r.sim || 0) > (bestHit.sim || 0))) {
        bestHit = { idx: j, ...r };
      }
    }
    if (bestHit) {
      dropped.push({ idx: i, text: seg, similar_to: kept[bestHit.idx], sim: bestHit.sim, lcs: bestHit.lcs, reason: bestHit.reason });
    } else {
      kept.push(seg);
    }
  }
  return { kept, dropped };
}
