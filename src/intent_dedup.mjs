/**
 * intent_dedup.mjs —— 语义/intent 级复读止血（PR-1，2026-06-14）。
 *
 * 背景（PR-0 retention_board 实测）：4 个"第二天回来"的真实用户对话里**全部**检出 hard break，
 * 复读为主——最该留住的人最容易撞复读。现有 anti-repeat（proactive 3-gram Jaccard）只拦**文本**，
 * 挡不住"语义功能相同、文本不同"的复读（u48 一晚 remind_安全 + ask_plan 出 3-4 次）。
 * 本模块给 bot 主动重复加 **intent 级冷却**：把每条 bot 消息打个粗 intent 标签，同 intent(+同 topic)
 * 在冷却窗内不再重复触发。
 *
 * ── 红线（别矫枉过正）──
 * · 轻量规则·**禁 LLM**（intent 分类纯关键词，不起第二个 pass）。
 * · **morning/goodnight 冷却宽松**：窗口 < 24h，**cross-day 早安永远放行**——PR-0 实测早安是
 *   唯一续命器（5 次跨天回来全靠它），绝不能误杀。同日重复另有 morning_dedup 兜。
 * · 只管 **bot 主动重复**：用户自己驱动的回答不冷却（用户连问两次"你吃了吗"都该正常答）——
 *   故 reply 侧的确定性裁剪**只在用户当前消息是 ack（好/知道了/嗯…）时**才触发。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

export const INTENTS = ['miss_you', 'morning', 'goodnight', 'remind', 'ask_plan', 'food', 'photo', 'comfort', 'tease', 'other'];

// 每个 intent 的冷却小时数。高频类(miss_you/remind/ask_plan/goodnight/morning)更长；
// morning/goodnight 刻意 < 24h → cross-day 必放行（红线：绝不误杀早安）。other=0=不冷却(别压正常闲聊)。
export const INTENT_COOLDOWN_H = {
  miss_you: 8, remind: 6, ask_plan: 6, goodnight: 12, morning: 12,
  food: 6, photo: 6, comfort: 6, tease: 4, other: 0,
};

// 分类顺序 = 优先级（先具体后泛化）。命中第一条即返回。
const INTENT_RULES = [
  ['goodnight', /晚安|睡了|睡啦|去睡|早点睡|早些睡|梦里见|good ?night|快睡|该睡了|睡个好觉/i],
  ['morning', /早安|早呀|早上好|早啊|刚醒|醒了吗|起床|good ?morning|睡醒/i],
  ['miss_you', /想你|好想你|想见你|惦记你|想你了|挂念你|miss ?you/i],
  ['remind', /记得|别忘|注意点?|小心|多喝水|早点(睡|休息)|带齐|带好|别熬夜|别(感冒|着凉|累着)|带(把)?伞|注意安全|早点回/i],
  ['ask_plan', /还(要|是)?(去|来).{0,6}(吗|嘛|不)|明天.{0,8}(吗|嘛|安排|打算)|打算(干|做|去).{0,4}(什么|啥|哪)|有(什么|啥)?安排|准备好了?吗|带(齐|好)东西了?吗|几点(出发|走|到|去)/i],
  ['food', /吃(了|过)(吗|没|饭)|吃的(什么|啥)|喝(奶茶|咖啡|了杯|点)|饿(了|不饿)|外卖|火锅|晚饭|早饭|午饭|吃饭(了)?(没|吗)/i],
  ['photo', /\[photo\]|发了一张照片|自拍|拍(给你|一张|张)|看看(我|你的)|给你看(看|一)/i],
  ['comfort', /别(难过|担心|生气|往心里去|太累)|没事(的|啦)?|抱抱|乖乖?|摸摸头|辛苦了|歇会儿|歇歇|别(太)?累着|心疼/i],
  ['tease', /笨蛋|傻(瓜|乎乎|啦)|油嘴滑舌|想得美|贫嘴|滑头|讨厌啦|坏蛋|得意什么|臭美/],
];

// 粗 topic 词表：用于"同 intent + 同 topic"判定。命中返回 topic token，否则 ''（=按 intent-only 冷却）。
const TOPIC_LEX = [
  ['露营', /露营|帐篷|睡袋|野营/], ['旅行', /旅行|旅游|出去玩|出门玩/],
  ['考试', /考试|期末|复习|考研|背单词/], ['作业', /作业|功课|题|卷子|论文/],
  ['工作', /工作|上班|加班|方案|代码|实习|项目|开会/], ['吃饭', /吃饭|外卖|火锅|奶茶|咖啡|晚饭|早饭|午饭/],
  ['睡觉', /睡觉|睡了|熬夜|失眠|早睡/], ['天气', /下雨|雨|雪|降温|天气|伞/],
  ['游戏', /游戏|打游戏|王者|原神/], ['影视', /电影|追剧|看剧|番|综艺/],
  ['书', /看书|读书|小说|书/], ['宠物', /猫|狗|仓鼠|宠物/], ['生日', /生日|过生日/],
];

const normIntentText = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

// turn 时间戳 → ms：兼容 {ts}(已是 ms) 与 {created_at}('YYYY-MM-DD HH:MM:SS' UTC，getConversationContext 给的)。
function turnMs(t, fallbackMs) {
  if (typeof t.ts === 'number') return t.ts;
  if (t.created_at) { const m = Date.parse(String(t.created_at).replace(' ', 'T') + (String(t.created_at).includes('Z') ? '' : 'Z')); if (Number.isFinite(m)) return m; }
  return fallbackMs;
}

/** 粗 intent 分类（纯关键词，禁 LLM）。 */
export function classifyIntent(content) {
  const s = String(content || '');
  if (!s.trim()) return 'other';
  for (const [intent, re] of INTENT_RULES) if (re.test(s)) return intent;
  return 'other';
}

/** 粗 topic（同 intent + 同 topic 判定用）；无命中返回 ''。 */
export function topicKey(content) {
  const s = String(content || '');
  for (const [topic, re] of TOPIC_LEX) if (re.test(s)) return topic;
  return '';
}

/**
 * 用户当前消息是否只是低内容 ack（好/知道了/嗯/去呀/知道了宝贝…）——reply 侧裁剪的前置闸。
 * 红线：只管 bot 主动重复，不碰 user 驱动的回答——故**含疑问的消息一律非 ack**（用户在问=该答）。
 */
export function isAck(content) {
  const raw = String(content || '').trim();
  if (!raw) return true;
  if (/[?？]|吗|嘛|呢\s*$|什么|啥|怎么|哪|几点|为什么|多少|是不是|可不可以/.test(raw)) return false;  // 疑问=用户在问=非 ack
  const s = normIntentText(raw).replace(/[~～!！。.、,，啦呀哦噢呐宝贝亲爱的的]/g, '');
  if (!s) return true;                                   // 纯标点/语气/称呼 = ack
  if (s.length > 6) return false;
  return /^(好|行|知道|知道了|晓得|懂了?|收到|ok|okay|嗯+|恩|哦|噢|是|对|可以|没事|明白|了解|去|来|走|拜拜|88|晚安|安|metoo)+$/i.test(s);
}

/** 从近期 turn（含两端 role）抽 assistant intent 事件环：[{intent, topic, ts}]，仅窗口内。 */
export function recentIntentEvents(recentTurns, nowMs, windowH = 24) {
  const since = nowMs - windowH * 3600e3;
  return (recentTurns || [])
    .filter((t) => t.role === 'assistant' && t.content)
    .map((t) => ({ intent: classifyIntent(t.content), topic: topicKey(t.content), ts: turnMs(t, nowMs) }))
    .filter((e) => e.ts >= since);
}

/** 末尾连续 user ack 数（rule3：连续两次短回后不再追同 topic）。 */
export function trailingAckStreak(recentTurns) {
  let streak = 0;
  for (let i = recentTurns.length - 1; i >= 0; i--) {
    const t = recentTurns[i];
    if (t.role === 'assistant') continue;               // 跳过 bot 自己的消息
    if (t.role !== 'user') break;
    if (isAck(t.content)) streak++; else break;
  }
  return streak;
}

/**
 * 这条 bot 消息的 intent 是否在冷却中（=该被止血）。
 * @returns { cooled, reason }
 */
export function isIntentCooled({ intent, topic = '', events = [], nowMs = Date.now(), ackStreak = 0 }) {
  if (intent === 'other') return { cooled: false };
  const winH = INTENT_COOLDOWN_H[intent] ?? 6;
  const sameIntent = events.filter((e) => e.intent === intent && nowMs - e.ts <= winH * 3600e3);
  // rule3：连续 ≥2 次 user ack 后，不再追同一"追问/提醒"类 intent。
  if (ackStreak >= 2 && (intent === 'remind' || intent === 'ask_plan') && sameIntent.length) {
    return { cooled: true, reason: `ack连击${ackStreak}·停追同${intent}` };
  }
  if (!sameIntent.length) return { cooled: false };
  // 同 topic 细化：双方都有 topic 且不同 → 放行（真不同话题）；否则按同 intent 冷却。
  if (topic) {
    const hit = sameIntent.some((e) => !e.topic || e.topic === topic);
    return hit ? { cooled: true, reason: `${winH}h内同 ${intent}/${topic} 已说` } : { cooled: false };
  }
  return { cooled: true, reason: `${winH}h内同 ${intent} 已说` };
}

/** reply 侧 prompt 注入：列最近已说过的 intent/topic，叫她别原样复读（intent 级·非纯字符串）。 */
export function buildIntentDedupHint(events, nowMs = Date.now()) {
  const recent = events.filter((e) => e.intent !== 'other' && nowMs - e.ts <= 6 * 3600e3);
  if (!recent.length) return '';
  const seen = new Set();
  const tags = [];
  for (const e of recent) { const k = e.topic ? `${e.intent}:${e.topic}` : e.intent; if (!seen.has(k)) { seen.add(k); tags.push(k); } }
  if (!tags.length) return '';
  return `\n\n【★ 别复读】你最近几小时已经主动说过这些（intent:topic）：${tags.slice(-6).join('、')}。`
    + `用户只是简短回应时，**别再原样重复同一种话**（如反复叮嘱"带齐东西"、反复说"想你"、反复问"还去吗"）——换个角度、或更简短地接一句就好。`;
}

// reply 侧确定性兜底：复读-after-ack 命中后的极简变化应答（小集合·避开最近用过的·非罐头堆词）。
const MICRO_ACK = {
  remind: ['嗯嗯，记着啦', '知道啦~', '好，你也是'],
  ask_plan: ['嗯，那你忙', '好呀~', '行，听你的'],
  miss_you: ['嘿嘿', '想我就多找我呀', '油嘴滑舌'],
  goodnight: ['嗯，晚安~', '快睡吧'],
  morning: ['嗯，早呀~'],
  comfort: ['嗯，有我在呢', '别多想啦'],
  default: ['嗯嗯', '好~', '在的'],
};
/** 取一条不与最近 assistant 文本撞的极简应答；全撞则返回第一条（仍比整段复读短得多）。 */
export function pickMicroAck(intent, recentTexts = []) {
  const pool = MICRO_ACK[intent] || MICRO_ACK.default;
  const used = new Set((recentTexts || []).map(normIntentText));
  return pool.find((c) => !used.has(normIntentText(c))) || pool[0];
}
