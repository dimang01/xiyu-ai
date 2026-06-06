/**
 * 照片请求意图检测。
 *
 * v1.10.38 起：regex 是 fast path（命中即返回 strong），不命中再用 LLM 二分类
 * 兜底。终结"每个新口语 → 加 regex → 发版"循环。
 */

import { extractStructuredInfo } from './ai.mjs';
import { log } from './logger.mjs';

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？!?、,.~～…"'“”‘’：:；;（）()【】[\]{}<>《》]/g, '');
}

const STRONG_PATTERNS = [
  { re: /发(?:张|个|一张)?照片/, reason: '要求发送照片' },
  { re: /发(?:张|个|一张)?自拍/, reason: '要求发送自拍' },
  { re: /自拍(?:看看|看一下|给我|一张)?/, reason: '要求自拍' },
  { re: /拍(?:一张|张)(?:给我|看看|看一下)?/, reason: '要求拍一张' },
  { re: /让我看(?:看|一下)你/, reason: '要求看你' },
  { re: /想看(?:看|一下)?你/, reason: '表达想看你' },
  { re: /看(?:看|一下)你在干嘛/, reason: '要求看当前状态' },
  { re: /你在干嘛给我看看/, reason: '要求看当前状态' },
  { re: /给我看(?:一下|下|看)?你/, reason: '要求看你' },
  { re: /爆照/, reason: '要求爆照' },
  { re: /发图(?:看看|看一下)?/, reason: '要求发图' },
  { re: /来(?:张|个)图/, reason: '要求发图' },
  { re: /再(?:发|来)(?:张|一张|个)/, reason: '要求再发一张' },
  { re: /再拍(?:张|一张|个)/, reason: '要求再拍一张' },
  { re: /照片再发(?:张|一张)?/, reason: '要求再发照片' },
  { re: /秀(?:一下|下)?(?:你|自己)/, reason: '要求秀一下' },
  // v1.10.35: "再给我看看 / 再看一张 / 再来一张看看" 类隐式 follow-up
  // 用户上一条已收到 photo，自然延续上下文要再来一张。原 STRONG L23 要求
  // 结尾必带"你"，但口语对话很少完整说"你"。
  { re: /再(?:给我)?看(?:看|一下|一张)/, reason: '要求再看一张' },
  { re: /再来一张/, reason: '要求再来一张' },
  { re: /多发(?:张|一张|几张|两张)/, reason: '要求多发几张' },
  { re: /换(?:个角度|个姿势)?(?:拍|再拍|发)/, reason: '要求换姿势再拍' },
  // 也补 "给我看看" 不带"你"的常见口语写法
  { re: /^(?:再)?给我看(?:看|一下|一张)?[嘛吧呀啊呢]?$/, reason: '要求再看一张（短口语）' },
  // v1.10.37: "看看你 / 看一下你 / 看你..." 无前缀的看你请求
  // （原 STRONG 都要求 "再/给我/让我/想" 等前缀，遗漏了赤裸 "看你"）
  { re: /^看(?:看|一下|一眼|一张)?你/, reason: '要求看你（无前缀短口语）' },
  { re: /看(?:看|一下)你(?:呀|嘛|呢|啊|吧|呗|好不|长什么|漂不|美不|帅不)/, reason: '要求看你（含语气词或追问）' },
  // "你长什么样" / "你什么样子" 类问外貌
  { re: /你长什么(?:样|模样)/, reason: '问外貌' },
  { re: /你(?:是)?什么样(?:子)?/, reason: '问外貌' },
];

const WEAK_PATTERNS = [
  { re: /^(你)?在干嘛(呢|呀|啊)?$/, reason: '询问当前状态' },
  { re: /睡了吗/, reason: '夜间关心' },
  { re: /到家了吗/, reason: '到家关心' },
  { re: /今天好累/, reason: '情绪分享' },
  { re: /想你了/, reason: '想念表达' },
];

const UNSAFE_PHOTO_RE = /(裸|露点|色情|黄片|做爱|性爱|床照|内衣|胸|屁股|性|血腥|自残|杀人|未成年|萝莉|正太)/;

export function detectPhotoIntent(text) {
  const normalized = normalizeText(text);
  if (!normalized) return { type: 'none', reason: '' };

  for (const rule of STRONG_PATTERNS) {
    if (rule.re.test(normalized)) {
      return { type: 'strong_photo_request', reason: rule.reason };
    }
  }

  for (const rule of WEAK_PATTERNS) {
    if (rule.re.test(normalized)) {
      return { type: 'weak_photo_context', reason: rule.reason };
    }
  }

  return { type: 'none', reason: '' };
}

export function hasUnsafePhotoContent(text) {
  return UNSAFE_PHOTO_RE.test(normalizeText(text));
}

/**
 * v1.10.38: regex fast path + LLM 兜底的智能版本。
 * - regex 命中 strong → 直接返回 strong（0 LLM 调用）
 * - regex 不命中 → 调 extractStructuredInfo 让 LLM 判 yes/no（最多 +1 次轻 LLM 调用）
 * - LLM 抛错 → 退回 regex 结果（保守不打扰主流程）
 *
 * @param {string} text
 * @param {Array<{role?:string, direction?:string, content?:string}>} recentMessages 可选最近对话
 * @returns {Promise<{type: 'strong_photo_request'|'weak_photo_context'|'none', reason: string}>}
 */
export async function detectPhotoIntentSmart(text, recentMessages = []) {
  const r = detectPhotoIntent(text);
  if (r.type === 'strong_photo_request') return r;

  // 不命中 strong（regex 漏识别 / weak / none）→ LLM 兜底
  try {
    const yes = await classifyPhotoIntentWithLLM(text, recentMessages);
    if (yes) {
      log('info', `[photo_intent] LLM 兜底命中 text="${String(text).slice(0, 40)}"`);
      return { type: 'strong_photo_request', reason: 'LLM 判定为请求照片' };
    }
  } catch (e) {
    log('warn', `[photo_intent] LLM 兜底失败: ${e.message}`);
  }
  return r; // 退回 regex 结果（weak 或 none）
}

async function classifyPhotoIntentWithLLM(text, recentMessages) {
  const recent = (Array.isArray(recentMessages) ? recentMessages : [])
    .slice(-6)
    .map(m => `${m.direction === 'in' || m.role === 'user' ? '用户' : 'AI'}: ${String(m.content || '').slice(0, 80)}`)
    .filter(Boolean)
    .join('\n');

  const system = '你是一个简单的二分类器。只输出 yes 或 no（小写），不要任何解释或额外文字。';
  const userPrompt = `判断用户最新一条消息是否在请求看 AI 女友（虚拟陪伴对象）的照片 / 自拍 / 外貌。

最近对话上下文：
${recent || '(无)'}

用户最新消息: "${String(text).slice(0, 200)}"

判断标准：
- yes：用户请求看照片 / 自拍 / 当前样子 / 外貌 / 换个姿势再拍 / 再来一张 / 长什么样
- no：普通对话、问候、情绪表达、问其它话题

只回 yes 或 no（小写）。`;

  const reply = await extractStructuredInfo(system, userPrompt, { maxTokens: 5, temperature: 0 });
  return /\byes\b/i.test(String(reply || '').trim());
}
