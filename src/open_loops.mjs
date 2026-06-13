/**
 * v1.8.0 #4: Open Loops —— 她记得"未完成的事"
 *
 * 用户提到 "明天去招聘会"、"周末搬家" 这类**有未来或未确定结果**的事，
 * AI 抽取并存表。proactive 在 due_at 临近时优先级飙升，让她主动问：
 *   "对了，你今天不是去招聘会吗？有人要你没？"
 *
 * 真人陪伴感最强的瞬间之一。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { extractStructuredInfo } from './ai.mjs';
import { saveOpenLoop, listOpenLoops, resolveOpenLoop, markStaleOpenLoops, shanghaiDateKey } from './db.mjs';
import { log } from './logger.mjs';

/**
 * #324 失忆修：把"还没了结的事/约定"拼成 reply prompt 注入串——**无条件注入**，不靠易失的
 * immediate 16 行窗口兜着（密聊下"约了一起吃晚饭"这类共同约定最容易被长对话挤出窗口而失忆）。
 * 约定/约会(appointment)置顶。纯读、bounded（≤4 条），无则返回 ''。
 */
export function buildOpenLoopsHint(companionId) {
  try {
    const loops = listOpenLoops(companionId, { status: 'open', limit: 20 });
    if (!loops.length) return '';
    // appointment（你俩的约定）置顶，其余保持 listOpenLoops 既有排序(emotional_weight/due_at)
    const sorted = [...loops].sort((a, b) =>
      (b.loop_kind === 'appointment' ? 1 : 0) - (a.loop_kind === 'appointment' ? 1 : 0));
    const lines = sorted.slice(0, 4).map(l =>
      `- ${String(l.title).slice(0, 60)}${l.loop_kind === 'appointment' ? '（你俩的约定，还没兑现）' : ''}`);
    return `\n【你还记得这些没了结的事】（别忘了；约定没兑现别当没发生过，自然时可主动提起）\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

function buildExtractSystemPrompt(todayKey) {
  return `你是 open-loop 提取助手。从他（对方）的消息中识别"未完成、有未来结果、值得后续询问"的事情。

今天是 ${todayKey}，时区 Asia/Shanghai。
他说"明天/后天/下周/周五/周末/过几天"时，必须**基于今天**换算成具体日期。
due_at 只能输出 YYYY-MM-DD 或 null，禁止输出相对说法（如"明天"）。

只提取这类事：
- 他提到的"将来要做的事"且**还没结果**："明天去面试"、"周五考试"、"周末搬家"、"等下吃完饭"（kind="todo"）
- 他提到的"等结果的事"："送出了简历"、"医院做了检查"、"投了那家公司"（kind="todo"）
- 他提到"想去做但还没做"："想买 XX"、"想去 XX 旅游"（情感权重较低，kind="todo"）
- 他提到的"短期纠结/烦恼"："最近被工作压得喘不过气"、"在纠结要不要分手"（情感权重高，kind="todo"）
- **你俩之间约定/约会还没兑现的事**（kind="date"）："约了一起吃晚饭"、"说好周末一起看电影"、"等下一起去图书馆"、"今天见面了说下次再约"——**这类是你和他共同的安排，不是他一个人的事**，title 直接写"约了一起吃晚饭"即可，不必以"他"开头。**当前这顿/这场还没发生**就算 open loop（吃了/看了/见过了就不是了）。

不要提取：
- 已经结束的事（"我昨天去过了"、"刚弄完"、"寄了"、"白去了"、"没戏了"、"刚吃完饭"、"看完了"）
- 长期事实（"我是程序员"）
- 偏好（"我喜欢猫"）

输出 JSON 数组，每条：
{
  "title": "他明天去招聘会找工作 / 约了一起吃晚饭",   // ≤80 字；todo 以"他XXX"开头，date 直接写约定
  "kind": "todo" | "date",                  // date=你俩共同约定/约会；todo=他个人的事（缺省 todo）
  "due_at": "2026-06-10" 或 null,           // YYYY-MM-DD，没有具体时间填 null
  "emotional_weight": 70,                    // 0-100，他在乎程度
  "expected_followup": "明天晚上问招聘会结果"   // ≤80 字
}

如果消息里没有 open loop，返回空数组 []。

每次最多输出 2 条。`;
}

const RESOLVE_KEYWORDS = [
  // 完成 / 结束 / 已发生
  { re: /(?:搞定|完成|结束|去过|做完|过完|拿到|没拿到|黄了|挂了|过了|没过|考完|考了|考过|面完|面过|交了|交完|提交了|搬完|搬好|搬过去|寄了|寄出去|寄到了|送出去|发出去|发了|发完|收到了|签收|已经回来|回来了|刚弄完|刚做完|刚结束|刚回|结束了|忙完|忙完了|出结果|出来了)/, action: 'check' },
  // 取消 / 没去 / 黄了
  { re: /(?:没去|没去成|不去了|取消了|改天再说|算了|放弃了|不做了|不用去了|没戏|没戏了|白去了|白跑了|白搞了|凉了|寄了|GG|没下文)/, action: 'check' },
  // 结果反馈
  { re: /(?:面试.*(?:通过|没过|挂了|凉了|过了)|工作.*(?:找到|找着|没找到|定了)|考试.*(?:过了|没过|挂了)|offer)/, action: 'check' },
  // #324：约定/约会履约或取消（"约了一起吃晚饭"→吃完就该关，别当没发生过）
  { re: /(?:吃完了?|吃过了|吃过饭|吃了饭|看完了|看过了|见过了|见完了|约会(?:结束|回来)|玩完了|逛完了|散完步)/, action: 'check' },
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
  const QUICK_GATE = /(?:明天|后天|下周|周末|过几天|今天|周一|周二|周三|周四|周五|周六|周日|要去|准备|计划|想去|打算|要做|要交|送出|投了|去了|面试|考试|面|考|医院|检查|约|订|预约|发烧|生病|去看|做|赶|搬|结果|后|之后|过完|考完|交完|做完|结束|一起|见面|约好|说好|改天|下次|吃饭|碰面|等下|待会)/;
  if (!QUICK_GATE.test(userMsg)) return 0;

  const userContent = `他说："${userMsg}"\nAI回复："${(botReply || '').slice(0, 100)}"\n\n请提取 open loops（如果有）。`;
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
          // #324：你俩共同约定/约会 → loopKind='appointment'，供 reply 无条件注入"还没兑现的约定"
          loopKind: item.kind === 'date' ? 'appointment' : 'user_said',
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
