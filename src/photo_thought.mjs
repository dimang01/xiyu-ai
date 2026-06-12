/**
 * photo_thought.mjs —— 「看到这个想到你」品类的素材选择（v1.21.6 PR-B，纯函数零 IO）。
 *
 * 真实恋爱里频率不高但亲密密度第一：在街头/货架/菜单看到与他兴趣或你们的梗相关之物，
 * 拍下来发"看到这个想到你"。我们此前完全缺这一类。
 *
 * 本模块只负责"从素材源里挑一个能拍的关联物"，不碰 DB、不碰 LLM、不发图——
 * 调用方（proactive）拉数据（偏好/梗/记忆 + 雷区 + 已用素材 + 隐私判定）塞进来，
 * 选中的素材 id 交回去落 v1.21.3 指纹账本做 14 天冷却。
 *
 * 硬约束（全部在 filterThoughtPool 里确定性执行，不靠 LLM 自觉）：
 *   - 雷区(taboo)类素材：零选用
 *   - 隐私过滤命中过的内容：零选用（isSensitive 注入）
 *   - 14 天内已用过的素材 id：冷却出局（usedIds 注入）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

const MAX_LABEL = 40;

function clip(s, n = MAX_LABEL) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

/**
 * 把三类素材源拍平成统一候选池。每条带：
 *   id     —— v1.21.3 账本素材 id（pref:/joke:/mem: 前缀，跨天冷却的单位）
 *   label  —— 可拍的关联物/梗（人类可读）
 *   hint   —— 喂给 planner 的关联线索（imagePrompt 拍此物、caption 点此关联）
 *   source —— preference | lexicon | memory（仅观察）
 *   weight —— 加权采样用（亲密度/重要度）
 */
export function buildThoughtPool({ likes = [], lexicon = [], memories = [] } = {}) {
  const pool = [];
  for (const p of likes) {
    if (p?.id == null || !p.target) continue;
    pool.push({
      id: `pref:${p.id}`, label: clip(p.target),
      hint: `他喜欢/常提的「${clip(p.target)}」`,
      source: 'preference', weight: Math.max(1, Number(p.intensity) || 3),
    });
  }
  for (const s of lexicon) {
    if (s?.id == null || !s.content) continue;
    pool.push({
      id: `joke:${s.id}`, label: clip(s.content),
      hint: `你们之间的梗/约定「${clip(s.content)}」`,
      source: 'lexicon', weight: 4,   // 专属梗亲密度高
    });
  }
  for (const m of memories) {
    if (m?.id == null || !m.content) continue;
    pool.push({
      id: `mem:${m.id}`, label: clip(m.content),
      hint: `你记得他的事「${clip(m.content)}」`,
      source: 'memory', weight: Math.max(1, Math.round((Number(m.importance) || 5) / 2)),
    });
  }
  return pool;
}

/**
 * 确定性硬过滤：雷区 / 隐私命中 / 已冷却，全部出局。
 * @param {Array} pool buildThoughtPool 结果
 * @param {object} o
 *   tabooTerms  雷区词（preference.taboo.target + shaping.taboo.content），子串命中即排除
 *   usedIds     Set<string> 近 14 天已用素材 id（getRecentlyUsedMaterialIds）
 *   isSensitive (text)=>bool 隐私过滤判定（注入 filterForStorage：store=false 即敏感）
 */
export function filterThoughtPool(pool, { tabooTerms = [], usedIds = new Set(), isSensitive } = {}) {
  const taboos = (Array.isArray(tabooTerms) ? tabooTerms : [])
    .map(t => clip(t, 30)).filter(t => t.length >= 2);   // 单字雷区不做子串(误伤)
  const used = usedIds instanceof Set ? usedIds : new Set();
  const sens = typeof isSensitive === 'function' ? isSensitive : () => false;
  return (Array.isArray(pool) ? pool : []).filter(item => {
    if (!item || !item.id || !item.label) return false;
    if (used.has(item.id)) return false;                                   // 14 天冷却
    const hay = `${item.label} ${item.hint}`;
    if (taboos.some(t => hay.includes(t))) return false;                   // 雷区零选用
    if (sens(item.label) || sens(item.hint)) return false;                 // 隐私命中零选用
    return true;
  });
}

/**
 * 从过滤后的候选池加权随机选一个素材。无可用素材 → null（调用方退回普通场景照）。
 */
export function selectThoughtMaterial(opts = {}, rng = Math.random) {
  const pool = filterThoughtPool(buildThoughtPool(opts), opts);
  if (!pool.length) return null;
  const total = pool.reduce((s, p) => s + (p.weight || 1), 0);
  let r = rng() * total;
  for (const p of pool) { r -= (p.weight || 1); if (r < 0) return p; }
  return pool[pool.length - 1];
}

/**
 * 给 planner 的品类 sceneSeed：拍那个关联物（无脸 POV），caption 必须自然点出关联。
 * 场景自洽兜底 + 多模板由 LLM 生成（不写死罐头）。
 */
export function thoughtSceneSeed(material) {
  if (!material) return '';
  return `在街头/货架/菜单/路边/便利店看到一样跟${material.hint}有关的东西，POV 拍那个东西本身（无脸、不出现人），`
    + `caption 自然点出"看到这个就想到你/想起你"的关联，别生硬别像广告。`
    + `**场景自洽硬约束**：所拍之物必须能在她当日日程的场景里合理出现（便利店货架上的零食行，米其林后厨的摆盘不行）；`
    + `若此刻场景里这东西根本不可能出现，宁可 shouldSendPhoto=false 也不要硬凑。`;
}
