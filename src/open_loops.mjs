/**
 * v1.8.0 #4: Open Loops —— 她记得"未完成的事"
 *
 * 用户提到 "明天去招聘会"、"周末搬家" 这类**有未来或未确定结果**的事，
 * AI 抽取并存表。proactive 在 due_at 临近时优先级飙升，让她主动问：
 *   "对了，你今天不是去招聘会吗？有人要你没？"
 *
 * 真人陪伴感最强的瞬间之一。
 *
 * v1.20: 反向也接上 —— **她自己**口头承诺的事（owner='companion'）。
 * "明天提醒你带伞""周末给你讲那个故事"以前是 LLM 顺着人设说的空话，没有任何
 * 系统接住（photo promise v1.19.5 只接住了发图）。说了不做比不说更伤信任。
 * 链路：bot.mjs 出口异步抽取 → 存表 → 到期 proactive 升格 promise_keep 主动兑现。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { extractStructuredInfo } from './ai.mjs';
import { saveOpenLoop, listOpenLoops, resolveOpenLoop, markStaleOpenLoops, shanghaiDateKey } from './db.mjs';
import { log } from './logger.mjs';

function buildExtractSystemPrompt(todayKey) {
  return `你是 open-loop 提取助手。从用户消息中识别"未完成、有未来结果、值得后续询问"的事情。

今天是 ${todayKey}，时区 Asia/Shanghai。
用户说"明天/后天/下周/周五/周末/过几天"时，必须**基于今天**换算成具体日期。
due_at 只能输出 YYYY-MM-DD 或 null，禁止输出相对说法（如"明天"）。

只提取这类事：
- 用户提到的"将来要做的事"且**还没结果**："明天去面试"、"周五考试"、"周末搬家"、"等下吃完饭"
- 用户提到的"等结果的事"："送出了简历"、"医院做了检查"、"投了那家公司"
- 用户提到"想去做但还没做"："想买 XX"、"想去 XX 旅游"（情感权重较低）
- 用户提到的"短期纠结/烦恼"："最近被工作压得喘不过气"、"在纠结要不要分手"（情感权重高）

不要提取：
- 已经结束的事（"我昨天去过了"、"刚弄完"、"寄了"、"白去了"、"没戏了"）
- 长期事实（"我是程序员"）
- 偏好（"我喜欢猫"）

输出 JSON 数组，每条：
{
  "title": "他明天去招聘会找工作",          // ≤80 字，以"他XXX"开头描述
  "due_at": "2026-06-10" 或 null,         // YYYY-MM-DD，没有具体时间填 null
  "emotional_weight": 70,                  // 0-100，他在乎程度
  "expected_followup": "明天晚上问招聘会结果"  // ≤80 字
}

如果用户消息里没有 open loop，返回空数组 []。

每次最多输出 2 条。`;
}

const RESOLVE_KEYWORDS = [
  // 完成 / 结束 / 已发生
  { re: /(?:搞定|完成|结束|去过|做完|过完|拿到|没拿到|黄了|挂了|过了|没过|考完|考了|考过|面完|面过|交了|交完|提交了|搬完|搬好|搬过去|寄了|寄出去|寄到了|送出去|发出去|发了|发完|收到了|签收|已经回来|回来了|刚弄完|刚做完|刚结束|刚回|结束了|忙完|忙完了|出结果|出来了)/, action: 'check' },
  // 取消 / 没去 / 黄了
  { re: /(?:没去|没去成|不去了|取消了|改天再说|算了|放弃了|不做了|不用去了|没戏|没戏了|白去了|白跑了|白搞了|凉了|寄了|GG|没下文)/, action: 'check' },
  // 结果反馈
  { re: /(?:面试.*(?:通过|没过|挂了|凉了|过了)|工作.*(?:找到|找着|没找到|定了)|考试.*(?:过了|没过|挂了)|offer)/, action: 'check' },
];

function safeParseArray(raw) {
  if (!raw) return [];
  try {
    if (typeof raw === 'object' && Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      const m = raw.match(/\[[\s\S]*\]/);
      if (!m) return [];
      const arr = JSON.parse(m[0]);
      return Array.isArray(arr) ? arr : [];
    }
  } catch {}
  return [];
}

/**
 * 从用户消息 + bot 回复抽取 open loops，存表。
 * 静默失败，不阻塞主流程。
 */
export async function extractOpenLoops(companionId, userMsg, botReply, sourceMessageId = null) {
  if (!userMsg || userMsg.length < 8) return 0;

  // 启发式快速筛：消息里没有时间/事件相关词时直接 skip，省 LLM 调用
  const QUICK_GATE = /(?:明天|后天|下周|周末|过几天|今天|周一|周二|周三|周四|周五|周六|周日|要去|准备|计划|想去|打算|要做|要交|送出|投了|去了|面试|考试|面|考|医院|检查|约|订|预约|发烧|生病|去看|做|赶|搬|结果|后|之后|过完|考完|交完|做完|结束)/;
  if (!QUICK_GATE.test(userMsg)) return 0;

  const userContent = `用户说："${userMsg}"\nAI回复："${(botReply || '').slice(0, 100)}"\n\n请提取 open loops（如果有）。`;
  const systemPrompt = buildExtractSystemPrompt(shanghaiDateKey(new Date()));

  try {
    const raw = await extractStructuredInfo(systemPrompt, userContent);
    const list = safeParseArray(raw);
    if (list.length === 0) return 0;

    let saved = 0;
    for (const item of list.slice(0, 2)) {
      if (!item.title || String(item.title).length < 4) continue;
      try {
        saveOpenLoop({
          companionId,
          title: String(item.title).slice(0, 200),
          dueAt: item.due_at && /^\d{4}-\d{2}-\d{2}/.test(String(item.due_at))
            ? String(item.due_at).slice(0, 19)
            : null,
          emotionalWeight: Math.max(0, Math.min(100, Number(item.emotional_weight) || 5)),
          expectedFollowup: item.expected_followup ? String(item.expected_followup).slice(0, 200) : null,
          sourceMessageId,
        });
        saved++;
      } catch (e) {
        log('debug', `[OpenLoop] save skipped: ${e.message}`);
      }
    }
    if (saved > 0) log('info', `[OpenLoop] +${saved} companion=${companionId}`);
    return saved;
  } catch (e) {
    log('warn', `[OpenLoop] extract 失败: ${e.message}`);
    return 0;
  }
}

/**
 * 检测用户消息是否 resolve 了任何 open loop。
 * 用启发式（关键词 + 时间距离），不调 LLM 控成本。
 * 命中后调 resolveOpenLoop()。
 */
export function detectAndResolveOpenLoops(companionId, userMsg) {
  if (!userMsg || userMsg.length < 4) return 0;

  // 触发关键字检测：用户在表达"已发生 / 已结束 / 没去成"
  const hasResolveSignal = RESOLVE_KEYWORDS.some(rk => rk.re.test(userMsg));
  if (!hasResolveSignal) return 0;

  let resolved = 0;
  try {
    const open = listOpenLoops(companionId, { status: 'open', limit: 20 });
    if (!open.length) return 0;

    // 简单匹配：用户消息里有 open loop title 的核心词 → 视为 resolve 该 loop
    const userTextLower = userMsg.toLowerCase();
    for (const loop of open) {
      // 从 title 提取关键名词（粗暴：去掉"他"/"明天"等高频词）
      const kw = String(loop.title)
        .replace(/^他/g, '')
        .replace(/(明天|后天|今天|周末|去|要|做|的|了|过|完|找|准备|打算|计划)/g, '')
        .slice(0, 10);
      if (kw.length >= 2 && userTextLower.includes(kw.toLowerCase())) {
        resolveOpenLoop(loop.id, userMsg.slice(0, 200));
        resolved++;
      }
    }
    if (resolved > 0) log('info', `[OpenLoop] resolved ${resolved} loops companion=${companionId}`);
  } catch (e) {
    log('warn', `[OpenLoop] auto-resolve 失败: ${e.message}`);
  }
  return resolved;
}

/**
 * 定时清理过期 stale loops。给 plan_tasks.mjs 调。
 */
export function cleanupStaleOpenLoops() {
  try {
    const n = markStaleOpenLoops();
    if (n > 0) log('info', `[OpenLoop] cleanup: ${n} loops → stale`);
    return n;
  } catch (e) {
    log('warn', `[OpenLoop] cleanup 失败: ${e.message}`);
    return 0;
  }
}

// ─── v1.20: 她的承诺（owner='companion'）────────────────────────────────────
// 同 photo promise 的教训：纯 prompt 拦不住，要配确定性兜底。这里三层防滥用：
//   1) gate 正则粗筛（多数回复不含承诺信号，0 LLM 调用）
//   2) LLM 只抽"明确承诺"，prompt 写死排除模糊客套/照片/条件假设
//   3) normalizeCompanionPromise 确定性清洗（VAGUE/照片/坏日期一律丢，可 smoke 回归）

// gate：她的回复里出现这些才值得调 LLM。故意不收"等下/一会儿"短时口头禅
// （兑现窗口太短 proactive 赶不上，误报还高），也不收裸"我会"（"我会想你的"
// 是情感宣言不是待办）。
const COMPANION_PROMISE_GATE_RE = /提醒你|叫你起|喊你起|我答应|我保证|说好了|说到做到|一言为定|拉钩|(?:明天|后天|今晚|晚上|晚点|周末|下周|周[一二三四五六日天]|到时候?|回头|下次)[^。！？!?\n]{0,10}(?:给你讲|讲给你|找你|陪你|给你做|带你去|发给你|教你|给你唱|给你看)|(?:给你讲|讲给你|陪你看|带你去|教你)[^。！？!?\n]{0,8}(?:明天|后天|今晚|周末|下周|到时候|下次)/;

// 模糊客套黑名单：命中即丢，不管 LLM 怎么说（"改天聊"不是承诺，是礼貌性收尾）
const PROMISE_VAGUE_RE = /改天|有空再|回头再说|下次一定|有机会再?|再约|看情况|到时候再说/;

// 照片承诺另有链路（v1.19.5 detectPhotoPromise → 确定性入队），这里抽到必丢，
// 防两套系统对同一句"等下拍给你"各兑现一次
const PROMISE_PHOTO_RE = /拍|照片|自拍|发图|相片|合照/;

/** 纯函数 gate：她的回复是否含承诺信号（可 smoke 确定性回归） */
export function hasCompanionPromiseSignal(assistantText) {
  const t = String(assistantText || '');
  if (t.length < 6) return false;
  return COMPANION_PROMISE_GATE_RE.test(t);
}

/**
 * 纯函数：LLM 输出的一条承诺 → 入库参数。不合格返回 null。
 * 全部防滥用规则都收敛在这（可 smoke）：
 * - title 太短 / 命中模糊客套 / 涉照片 → 丢
 * - due_at 必须 YYYY-MM-DD 且在 [今天, 今天+30天]，否则置 null（LLM 换算错防护）
 * - remind 没有有效 due_at → 丢（没期限的提醒没法兑现，等于又一张空头支票）
 * - do 没有 due_at → 默认后天（"下次我先找你"两天后她真来找，才叫说到做到；
 *   挂着无限期不如给个近期兑现点）
 * - emotional_weight 代码定死（remind=80 / do=60），不收 LLM 的值，少一个可注入面
 */
export function normalizeCompanionPromise(item, todayKey) {
  if (!item || typeof item !== 'object') return null;
  const title = String(item.title || '').trim();
  if (title.length < 4) return null;
  if (PROMISE_VAGUE_RE.test(title)) return null;
  const followup = String(item.expected_followup || '').trim();
  if (PROMISE_PHOTO_RE.test(title) || PROMISE_PHOTO_RE.test(followup)) return null;

  const promiseKind = item.kind === 'remind' ? 'remind' : 'do';

  let dueAt = null;
  const rawDue = String(item.due_at || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawDue)) {
    // 字符串比较对 YYYY-MM-DD 即日期序；上界今天+30 天防"下个月"类垃圾长期挂表
    const maxDue = shiftDateKey(todayKey, 30);
    if (rawDue >= todayKey && rawDue <= maxDue) dueAt = rawDue;
  }
  if (promiseKind === 'remind' && !dueAt) return null;
  if (promiseKind === 'do' && !dueAt) dueAt = shiftDateKey(todayKey, 2);

  return {
    title: title.startsWith('她') ? title.slice(0, 200) : `她答应${title}`.slice(0, 200),
    dueAt,
    promiseKind,
    expectedFollowup: followup ? followup.slice(0, 200) : null,
    emotionalWeight: promiseKind === 'remind' ? 80 : 60,
  };
}

/** YYYY-MM-DD + n 天 → YYYY-MM-DD（naive，不涉时区：dateKey 本身已是上海日期） */
function shiftDateKey(dateKey, days) {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildPromiseExtractPrompt(todayKey) {
  return `你是承诺提取助手。从 AI 伴侣（她）的回复中识别**她明确承诺要为用户做的事**。

今天是 ${todayKey}，时区 Asia/Shanghai。
她说"明天/后天/周末/下周X"时，必须**基于今天**换算成具体日期。
due_at 只能输出 YYYY-MM-DD 或 null，禁止输出相对说法。

只提取**明确承诺**（她清楚地说了"我会做X"）：
- 提醒承诺："明天提醒你带伞""到时候我叫你起床" → kind=remind（必须能定出日期）
- 陪伴承诺："周末给你讲那个故事""下次我先找你""明天教你做饭" → kind=do

绝不提取：
- 模糊客套："改天聊""有空一起""下次一定""回头再说"（没有具体事项的礼貌话）
- 发照片/自拍承诺（"等下拍给你"）——另有系统处理
- 条件假设："如果你需要我就……""你要是想听的话……"
- 用户要做的事（只看**她**承诺的）
- 她已经做完或正在做的事
- 纯情感宣言："我会一直陪着你""我永远在"（是状态不是待办）

输出 JSON 数组（最多 1 条，宁缺毋滥）：
{
  "title": "明天提醒他带伞",                  // ≤60字，描述她承诺的事
  "kind": "remind" 或 "do",
  "due_at": "2026-06-11" 或 null,            // remind 必须有日期
  "expected_followup": "主动发消息提醒他出门记得带伞"  // 到期她该主动做什么，≤60字
}

没有明确承诺就返回空数组 []。`;
}

/**
 * 从她的回复抽取她的承诺，存表（owner='companion'）。
 * bot.mjs postProcess 异步调，静默失败不阻塞主流程。
 */
export async function extractCompanionPromises(companionId, userMsg, botReply, sourceMessageId = null) {
  if (!hasCompanionPromiseSignal(botReply)) return 0;

  const todayKey = shanghaiDateKey(new Date());
  const userContent = `用户说："${String(userMsg || '').slice(0, 150)}"\n她回复："${String(botReply).slice(0, 300)}"\n\n请提取她做出的明确承诺（如果有）。`;

  try {
    const raw = await extractStructuredInfo(buildPromiseExtractPrompt(todayKey), userContent);
    const list = safeParseArray(raw);
    if (list.length === 0) return 0;

    const norm = normalizeCompanionPromise(list[0], todayKey);
    if (!norm) return 0;

    saveOpenLoop({
      companionId,
      title: norm.title,
      dueAt: norm.dueAt,
      emotionalWeight: norm.emotionalWeight,
      expectedFollowup: norm.expectedFollowup,
      sourceMessageId,
      owner: 'companion',
      promiseKind: norm.promiseKind,
    });
    log('info', `[OpenLoop] ★ 她的承诺入账 companion=${companionId} kind=${norm.promiseKind} due=${norm.dueAt} "${norm.title.slice(0, 30)}"`);
    return 1;
  } catch (e) {
    log('warn', `[OpenLoop] promise extract 失败: ${e.message}`);
    return 0;
  }
}
