/**
 * v1.9.1: AI 味检测（纯函数模块，不集成主流程）
 *
 * 现状：persona_guard.mjs 已覆盖语义层（AI 自称 / 客服腔 / system leak / 第三人称 /
 * 阶段越界 / forbidden topics / 过长）。但 AI 味更多藏在**词法和句式**：
 *   - 书面连接词："首先 / 其次 / 综上 / 因此 / 与此同时"
 *   - 助手式收尾："希望对你有帮助 / 我建议你 / 你可以尝试"
 *   - 分点报告体：1. 2. 3. / 一、二、三、
 *   - 过度共情模板："我能理解你的感受 / 这听起来真的很不容易"
 *   - 语气词过量：呢/哦/呀/啦/嘛 高密度堆叠（刻意可爱）
 *   - 单条过长（陪伴语境普通回复 ≥ 180 字就开始像 AI）
 *
 * 本模块只提供检测函数，**不做 rewrite pass**（2x token 成本+效果不确定）。
 * 配套 scripts/ai_taste_scan.mjs 离线扫描历史对话，本模块不进入实时主流程。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

// ─── 检测项定义 ──────────────────────────────────────────────────────────────

// 1. 书面连接词（口语里很少这么完整地用）
const FORMAL_CONNECTORS = [
  '首先', '其次', '最后', '总之', '综上', '综上所述', '因此',
  '与此同时', '不仅如此', '从这个角度来看', '换句话说',
  '值得注意的是', '需要指出的是', '一方面', '另一方面',
];

// 2. 助手 / 客服式收尾
const ASSISTANT_CLOSINGS = [
  '希望对你有帮助', '希望能帮到你', '希望这能帮到你',
  '如果你需要我可以', '如果还有问题', '如有需要', '如有其他问题',
  '我建议你', '我建议是', '建议你可以', '你可以尝试',
  '以下是几个方向', '以下是几点', '以下几点',
  '我来帮你分析一下', '让我们一起来看看',
  '希望这些建议', '希望这些信息',
];

// 3. 过度共情模板（在女友陪伴语境里高频 = AI 客服感）
const EMPATHY_TEMPLATES = [
  '我能理解你的感受', '我完全理解', '我非常理解',
  '这听起来真的很不容易', '这听起来真的不容易', '听起来真的很不容易',
  '你的感受是合理的', '你的感受很正常', '有这样的感受是正常的',
  '我会一直陪着你', '我永远都会陪着你', '我会陪着你的',
  '请记住你不是一个人', '你并不孤单',
];

// 4. 分点报告体（行首数字/字母/项目符号）
//    用整行匹配，避免误伤句中的"1点钟方向"等
const LIST_LINE = /^(?:\s*)(?:[1-9]\d?[.、]\s*|[一二三四五六七八九十][、.]\s*|[\-•▪‣◦*]\s+|（[1-9]\d?）)/m;

// 5. 语气词过量（按比例，不是出现就扣）
const PARTICLE_CHARS = ['呢', '哦', '呀', '啦', '嘛', '咯', '哒'];
// 阈值：粒子数 / 总字符数 ≥ 0.18 视为刻意（每 5 个字就有 1 个语气词）
const PARTICLE_DENSITY_THRESHOLD = 0.18;
// 但消息必须有一定长度才算（短消息一个"呢"就 100% 密度，不算 AI 味）
const PARTICLE_MIN_LEN = 12;

// 6. 过长（中文字符数）
const TOO_LONG_SOFT = 180;  // 轻扣
const TOO_LONG_HARD = 350;  // 重扣

// ─── 权重（合计 0-100 范围，但允许多条命中累加超过 100） ───────────────────
const WEIGHTS = {
  formal_connector: 8,       // 每条连接词
  assistant_closing: 14,     // 每条收尾（最显眼的 AI 味）
  empathy_template: 12,      // 每条共情模板
  list_format: 18,           // 分点格式一次性扣（命中 = 整段报告体）
  particle_overuse: 16,      // 语气词过量
  too_long_soft: 6,
  too_long_hard: 16,
};

/**
 * 检测一段文本的 AI 味。
 *
 * @param {string} text - assistant 输出文本
 * @returns {{score: number, hits: Array<{type: string, text: string, weight: number}>}}
 *   score   — 累加权重，越高越像 AI
 *   hits    — 每条命中详情（type / 命中片段 / 该项权重）
 *
 * 调用方应自行判断阈值。**纯函数，无副作用**。
 */
export function detectAiTaste(text) {
  const t = String(text || '');
  const hits = [];
  if (t.length < 2) return { score: 0, hits };

  // 1. formal connectors
  for (const word of FORMAL_CONNECTORS) {
    if (t.includes(word)) {
      hits.push({ type: 'formal_connector', text: word, weight: WEIGHTS.formal_connector });
    }
  }

  // 2. assistant closings
  for (const phrase of ASSISTANT_CLOSINGS) {
    if (t.includes(phrase)) {
      hits.push({ type: 'assistant_closing', text: phrase, weight: WEIGHTS.assistant_closing });
    }
  }

  // 3. empathy templates
  for (const phrase of EMPATHY_TEMPLATES) {
    if (t.includes(phrase)) {
      hits.push({ type: 'empathy_template', text: phrase, weight: WEIGHTS.empathy_template });
    }
  }

  // 4. list format（行首正则）
  if (LIST_LINE.test(t)) {
    const m = t.match(LIST_LINE);
    hits.push({ type: 'list_format', text: (m?.[0] || '').trim().slice(0, 20), weight: WEIGHTS.list_format });
  }

  // 5. particle density
  if (t.length >= PARTICLE_MIN_LEN) {
    let particleCount = 0;
    for (const ch of t) {
      if (PARTICLE_CHARS.includes(ch)) particleCount++;
    }
    const density = particleCount / t.length;
    if (density >= PARTICLE_DENSITY_THRESHOLD) {
      hits.push({
        type: 'particle_overuse',
        text: `${particleCount}/${t.length} (${(density * 100).toFixed(0)}%)`,
        weight: WEIGHTS.particle_overuse,
      });
    }
  }

  // 6. length（按中文字符数粗算 = t.length，因为大多场景纯中文）
  if (t.length >= TOO_LONG_HARD) {
    hits.push({ type: 'too_long_hard', text: `${t.length} chars`, weight: WEIGHTS.too_long_hard });
  } else if (t.length >= TOO_LONG_SOFT) {
    hits.push({ type: 'too_long_soft', text: `${t.length} chars`, weight: WEIGHTS.too_long_soft });
  }

  const score = hits.reduce((s, h) => s + h.weight, 0);
  return { score, hits };
}

/**
 * 便利函数：判断是否"像 AI"。默认 score >= 30 视为可疑。
 * 调用方可传自定义阈值。
 */
export function isLikelyAiTaste(text, threshold = 30) {
  return detectAiTaste(text).score >= threshold;
}
