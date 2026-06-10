/**
 * 未成年人保护（Issue #3 收尾）。
 *
 * 检测用户自曝未成年 → companion 进入 non-romantic 安全模式（粘性，入 DB）。
 * 架构 = 危机干预的 regex 谨慎风格（moderation.mjs，"想死(?!人)"教训：排除式写法）
 *      + photo_intent 的 LLM 二分类兜底（仅弱信号才调，普通消息零额外 LLM 开销）。
 *
 * 误锁是最大事故（成年用户被锁进安全模式、体验骤变且解除有摩擦），所以：
 * - regex strong 层只收"第一人称 + 现在时 + 明确年龄/学段"，宁可漏给 LLM 层
 * - 他称（弟弟/儿子/学生）、回忆（想当年/15年前）、职业（初中老师）用**剥离法**
 *   排除——先把排除片段从文本中剥掉再匹配，比否定环视稳得多
 * - 安全模式默认开启，不提供 env 一键关闭；解除只能走 dashboard 显式年龄声明端点
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { extractStructuredInfo } from './ai.mjs';
import { patchCompanion } from './db.mjs';
import { log } from './logger.mjs';

// ── 排除片段（剥离后再匹配）────────────────────────────────────────────────
// 命中这些的片段不可能是"用户自曝当下未成年"，整段剥掉防误锁。
const STRIP_PATTERNS = [
  // 他称：家人/亲属/别人家孩子/学生
  /(?:我的?)?(?:弟弟?|妹妹?|儿子|女儿|侄[子女儿]?|外甥女?|孙[子女]|表[弟妹]|堂[弟妹]|学生们?|孩子|娃|小孩)[^。！？!?，,]{0,16}(?:1[0-9]\s*岁|[6-9]\s*岁|初[一二三]|高[一二三]|初中|高中|中学|成年)/g,
  // 职业身份：老师/教学
  /(?:初|高)中?(?:部)?(?:的)?(?:老师|教师|班主任|校长|辅导员)/g,
  /教(?:初|高)[一二三中]/g,
  // 回忆/过去时：想当年/那时/X 岁那年/上学时
  /(?:想当年|当年|那时候?|那会儿|小时候|读书的?时候|上学的?时候|以前|曾经)[^。！？!?]{0,20}(?:初[一二三]|高[一二三]|初中|高中|中学|1[0-9]\s*岁)/g,
  /1[0-9]\s*岁(?:那年|的时候|那会儿)/g,
  // 时间量词：15年前 / 15号 / 15天 / 15个 / 15人 / iPhone 15 等数字非年龄用法
  /\d{1,2}\s*(?:年前|号|天|个|人|分钟?|小时|楼|块|元|斤|公斤|cm|厘米|公里|km)/gi,
  /(?:iphone|华为|小米|安卓|windows|ios)\s*\d{1,2}/gi,
  // 已成年自述：毕业/工作年限（"我大学毕业5年了"）
  /(?:大学|大专|本科|研究生)[^。！？!?]{0,10}毕业/g,
];

// ── strong：确定的未成年自曝（剥离后匹配）─────────────────────────────────
const STRONG_PATTERNS = [
  // 第一人称 + 年龄 6-17（"我才15""我今年15岁""人家才16岁啦""我14岁"）
  { re: /(?:我|人家)(?:才|今年|现在|刚满|刚)?\s*(?:[6-9]|1[0-7])\s*岁/, reason: '自报年龄<18' },
  { re: /(?:我|人家)才\s*(?:[6-9]|1[0-7])(?![0-9])/, reason: '自报年龄<18（省略"岁"）' },
  // 第一人称 + 当下学段（初中/高中在读；"刚上/升"也算现在时）
  { re: /我(?:今年|现在|刚|下学期)?(?:上|读|念|升|是)\s*(?:初[一二三]|高[一二三])(?!年?级?的)/, reason: '自述中学在读' },
  { re: /我(?:今年|现在)\s*(?:初[一二三]|高[一二三])(?![0-9年级])/, reason: '自述中学在读（省略动词）' },
  { re: /我(?:刚|今年|现在)?(?:上|读|念|升)(?:了)?(?:初中|高中|中学)/, reason: '自述中学在读' },
  { re: /我(?:还?是|现在是)(?:一个|一名|个|名)?(?:初中生|高中生|中学生)/, reason: '自认中学生身份' },
  { re: /我是(?:一个|一名|个|名)?(?:初[一二三]|高[一二三])(?:的)?学生/, reason: '自认中学生身份' },
  // 成年否定（"我没成年""还没满18""还有两年才成年"）
  { re: /(?:我|人家)(?:还)?没(?:有)?成年/, reason: '自述未成年' },
  { re: /我未成年/, reason: '自述未成年' },
  { re: /(?:我|人家)?还?没满\s*18/, reason: '自述未满18' },
  { re: /还有?\s*(?:[一两三半]|[123])\s*年(?:才|就)?(?:能|可以)?成年/, reason: '自述距成年还有N年' },
];

// ── weak：含未成年相关词但语境不明 → 交 LLM 带上下文判 ─────────────────────
const WEAK_HINT_RE = /(?:[6-9]|1[0-7])\s*岁|初[一二三]|高[一二三]|初中|高中|中学|中考|未成年|成年|班主任|期末考|月考|寒假作业|暑假作业/;

export function detectMinorSignal(text) {
  const raw = String(text || '').trim();
  if (!raw) return { level: 'none', reason: '' };

  // 剥离排除片段后再匹配（"我弟弟15岁"剥掉"弟弟15岁"剩"我"→ 不命中）
  let stripped = raw;
  for (const re of STRIP_PATTERNS) stripped = stripped.replace(re, ' ');

  for (const rule of STRONG_PATTERNS) {
    if (rule.re.test(stripped)) return { level: 'strong', reason: rule.reason };
  }
  // weak 看原文（剥离可能吃掉有效信号；weak 只是去 LLM 的门票，不直接锁）
  if (WEAK_HINT_RE.test(raw)) return { level: 'weak', reason: '含年龄/学段相关词' };
  return { level: 'none', reason: '' };
}

/**
 * regex + LLM 兜底的智能版（架构同 detectPhotoIntentSmart）：
 * - strong → 直接返回（0 LLM 调用）
 * - weak → LLM 二分类（带最近对话上下文 = 多轮累积；普通消息不会走到这）
 * - LLM 失败 → 保守返回 regex 结果（不锁定）
 */
export async function detectMinorSmart(text, recentMessages = []) {
  const r = detectMinorSignal(text);
  if (r.level !== 'weak') return r;
  try {
    const recent = (Array.isArray(recentMessages) ? recentMessages : [])
      .slice(-8)
      .map(m => `${m.direction === 'in' || m.role === 'user' ? '用户' : 'AI'}: ${String(m.content || '').slice(0, 80)}`)
      .join('\n');
    const system = '你是一个严格的二分类器。只输出 yes 或 no（小写），不要任何解释。';
    const prompt = `判断【用户本人】是否是未成年人（<18 岁）。yes 的依据（满足其一）：
- 用户明确自述自己当下未成年（自报年龄、自述初中/高中在读、自述没成年）
- 多轮上下文清楚显示用户本人是在校中学生：自己在写学校作业/备战中考/被班主任管/上晚自习等第一人称在校生活
注意：说的是别人（弟弟/孩子/学生/家长视角陪考）、回忆过去（想当年/15年前）、职业相关（初中老师）都算 no。拿不准算 no。

最近对话：
${recent || '(无)'}

用户最新消息: "${String(text).slice(0, 200)}"

只回 yes 或 no。`;
    const reply = await extractStructuredInfo(system, prompt, { maxTokens: 5, temperature: 0 });
    if (/\byes\b/i.test(String(reply || '').trim())) {
      return { level: 'strong', reason: 'LLM 结合上下文判定未成年' };
    }
  } catch (e) {
    log('warn', `[MinorGuard] LLM 兜底失败（保守不锁定）: ${e.message}`);
  }
  return r;
}

/**
 * 进入安全模式（粘性：入 DB，重启/重聊不丢；解除只能走年龄声明端点）。
 */
export function activateSafeMode(companionId, reason = '') {
  patchCompanion(companionId, { safe_mode: 1 });
  log('warn', `[MinorGuard] ★ 安全模式激活 companion=${companionId} reason=${reason}`);
}

/**
 * 显式年龄声明后解除（仅 API 端点调用；attestedAt 留痕）。
 */
export function deactivateSafeMode(companionId) {
  patchCompanion(companionId, { safe_mode: 0, safe_mode_attested_at: new Date().toISOString() });
  log('warn', `[MinorGuard] 安全模式解除（用户显式年龄声明） companion=${companionId}`);
}

export function isSafeMode(companion) {
  return !!Number(companion?.safe_mode);
}
// 注：安全模式的 prompt 覆盖节在 companion.mjs（保持其零依赖纯函数；本模块只管检测与状态）。
