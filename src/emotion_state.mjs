/**
 * emotion_state.mjs
 * Multi-dimensional emotion state machine for AI companions.
 * Dimensions: affection, trust, dependency, possessiveness, security, energy, mood
 *
 * ─── 增量演化原则 (v1.5.2 PR D audit) ───────────────────────────────────
 * 所有 update* 函数都是 **incremental**，不是 overwrite：
 *   1. 入参 currentState 是当前情绪基线
 *   2. 算出 delta（基于 user msg / reply / idle）
 *   3. next = clamp(current + delta, 0, 100) 写回 DB
 *   4. upsertEmotionState 在 SQL 层也是 partial UPDATE，没传的维度不动
 *
 * v1.5.2 新增 saturation dampening：同 companion 同维度同方向加成
 * 30 分钟内重复触发会衰减（_dampenIfRepeated），防止用户狂刷"谢谢"
 * 把 affection 顶到 100。这才是真正"参考之前情绪"——前一次刚加过，
 * 这次同向再加就乏力。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import {
  getEmotionState, upsertEmotionState,
  insertEmotionHistory, getEmotionHistoryTrend, getLastEmotionHistoryAt, cleanupOldEmotionHistory,
  getDb,
} from './db.mjs';

// ─── State vocabulary ─────────────────────────────────────────────────────────

export const MOOD_STATES = [
  'neutral', 'happy', 'shy', 'tired', 'wronged',
  'jealous', 'angry', 'cold', 'comforting', 'clingy',
];

const DEFAULT_STATE = {
  affection:       0,
  trust:           50,
  dependency:      30,
  possessiveness:  20,
  security:        50,
  energy:          60,
  mood:            'neutral',
  // v1.6: 4 个新维度
  patience:        60,  // 0 暴躁 - 100 极有耐心；用户连发多条问题/长时间不响应降
  excitement:      30,  // 短期峰值：被夸/惊喜会冲 80+，每小时衰减约 20
  annoyance:       0,   // 短期烦躁：被忽视/打断累积；高 annoyance 时回复变冷
  gratitude:       40,  // 长期感激：用户体贴/陪伴时累加，影响她回复温度
  // v1.8.0 #1: 即时 presence 状态
  availability:   'free',  // free / busy / half — 此刻是否方便聊天（由日程当前活动 + 时段推导）
  attention:       80,     // 0-100 对你这条消息的注意力；低 → 回复短、可能略走神
};

// Clamp helpers
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));

// ─── v1.5.2 PR D: Saturation dampening 防刷 ──────────────────────────────
// 内存级 LRU-ish map：key = "{companionId}:{dim}:{sign}"，value = { lastAt, count }
// 30 分钟窗口内同向同维度的加成会随次数衰减：1st=full, 2nd=*.5, 3rd=*.25, 4th+=*.125
// 衰减只对 +/- 加成，不对 mood（mood 是切换不是加成）
const _dampenCache = new Map();
const DAMPEN_WINDOW_MS = 30 * 60 * 1000;
const DAMPEN_MAX_ENTRIES = 2000;   // 简单上限防内存爆

function _dampenIfRepeated(companionId, dim, delta) {
  if (!Number.isFinite(delta) || delta === 0) return delta;
  const sign = delta > 0 ? '+' : '-';
  const key = `${companionId}:${dim}:${sign}`;
  const now = Date.now();
  let entry = _dampenCache.get(key);
  if (!entry || (now - entry.lastAt) > DAMPEN_WINDOW_MS) {
    entry = { lastAt: now, count: 1 };
    _dampenCache.set(key, entry);
    if (_dampenCache.size > DAMPEN_MAX_ENTRIES) {
      // 简单 LRU：删最老的 200 条
      const sorted = [...(_dampenCache.entries())].sort((a, b) => a[1].lastAt - b[1].lastAt);
      for (let i = 0; i < 200 && i < sorted.length; i++) _dampenCache.delete(sorted[i][0]);
    }
    return delta;
  }
  entry.lastAt = now;
  entry.count += 1;
  // 1st full, 2nd 50%, 3rd 25%, 4th+ 12.5%（最低保留 1 个单位避免完全归零失去手感）
  const factor = entry.count === 1 ? 1 : (entry.count === 2 ? 0.5 : (entry.count === 3 ? 0.25 : 0.125));
  const dampened = delta * factor;
  // 最少保留 1 个绝对值（如 +3 衰减成 +0.375 → 取 sign(+) * max(round(0.375),1) = +1）
  const result = Math.sign(dampened) * Math.max(1, Math.abs(Math.round(dampened)));
  return result;
}

// 测试 / 调试用：清空 dampen 状态
export function _resetDampenCacheForTests() {
  _dampenCache.clear();
}

// ─── Getters ──────────────────────────────────────────────────────────────────

export function getEmotionStateWithDefaults(companionId) {
  const stored = getEmotionState(companionId);
  if (!stored) return { ...DEFAULT_STATE, companion_id: companionId };
  return { ...DEFAULT_STATE, ...stored };
}

// ─── Rule-based updaters ──────────────────────────────────────────────────────

const GRATITUDE_WORDS  = ['谢谢', '感谢', '辛苦了', '你最好了', '爱你', '么么', '你真棒', '棒棒'];
const COLD_WORDS       = ['随便', '无所谓', '不想聊', '无聊', '算了', '关你什么事', '烦'];
const PRAISE_WORDS     = ['好看', '可爱', '漂亮', '喜欢你', '心动', '暖', '甜', '贴心'];
const APOLOGY_WORDS    = ['对不起', '不好意思', '抱歉', '我错了', 'sorry', '道歉'];
const WORRY_WORDS      = ['担心', '难过', '伤心', '哭', '委屈', '崩溃', '心痛', '绝望'];
const JEALOUS_TRIGGERS = ['她', '他', '其他女', '前任', '前女友', '前男友', '暧昧', '喜欢别人'];
const NIGHT_ENERGY_WORDS = ['晚安', '睡觉', '困了', '要睡了', '好累'];
// v1.6 新维度触发词
const EXCITEMENT_WORDS = ['礼物', '惊喜', '好消息', '太棒了', '哇', '中奖', '升职', '通过了', '答应'];
const CARING_WORDS     = ['多喝水', '注意身体', '早点睡', '吃饭了吗', '别熬夜', '陪我', '陪你', '我在'];
const NAGGING_WORDS    = ['？？', '在吗在吗', '快回', '怎么不回', '在干嘛在干嘛'];  // 连发施压

/**
 * Update emotion dimensions based on user message content + context.
 * Returns delta object { trust, dependency, ... } to apply.
 */
function computeDelta(userText = '', context = {}) {
  const delta = {};
  const text  = userText.toLowerCase();

  if (GRATITUDE_WORDS.some(w => text.includes(w))) {
    delta.trust      = 3;
    delta.affection  = 2;
    delta.security   = 2;
  }

  if (PRAISE_WORDS.some(w => text.includes(w))) {
    delta.affection  = 3;
    delta.security   = 2;
  }

  if (COLD_WORDS.some(w => text.includes(w))) {
    delta.security  = -3;
    delta.mood       = 'wronged';
  }

  if (APOLOGY_WORDS.some(w => text.includes(w))) {
    // Apology resolves negative states
    delta.security  = 3;
    delta.trust     = 1;
  }

  if (WORRY_WORDS.some(w => text.includes(w))) {
    delta.mood = 'comforting';
    delta.dependency = 2;
  }

  if (JEALOUS_TRIGGERS.some(w => text.includes(w))) {
    delta.possessiveness = 4;
    if (!delta.mood) delta.mood = 'jealous';
  }

  if (NIGHT_ENERGY_WORDS.some(w => text.includes(w))) {
    delta.energy = -10;
    if (!delta.mood) delta.mood = 'tired';
  }

  // v1.6: 4 个新维度触发
  // excitement 短期峰值（被夸/惊喜/好消息）
  if (EXCITEMENT_WORDS.some(w => text.includes(w))) {
    delta.excitement = 25;
    delta.energy     = (delta.energy || 0) + 3;
  }
  if (PRAISE_WORDS.some(w => text.includes(w))) {
    delta.excitement = (delta.excitement || 0) + 10;
  }
  // gratitude 体贴/陪伴累积（与 GRATITUDE_WORDS 区别：gratitude 是她对他的感激；CARING 是他对她的体贴）
  if (CARING_WORDS.some(w => text.includes(w))) {
    delta.gratitude = 4;
    delta.security  = (delta.security || 0) + 1;
  }
  if (GRATITUDE_WORDS.some(w => text.includes(w))) {
    delta.gratitude = (delta.gratitude || 0) + 2;
  }
  // annoyance 烦躁（被夸打断/被忽视/夸张词重复）
  if (NAGGING_WORDS.some(w => text.includes(w))) {
    delta.annoyance = 8;
    delta.patience  = -5;
  }
  if (COLD_WORDS.some(w => text.includes(w))) {
    delta.annoyance = (delta.annoyance || 0) + 3;
  }
  // patience：长消息 = 用户认真 → patience 不变；短促消息 + 短间隔（caller 应传 context.shortGapMs）会降
  if (context.shortGapMs != null && context.shortGapMs < 30_000 && userText.length < 6) {
    delta.patience = (delta.patience || 0) - 3;
  }

  // Long message → engagement boost
  if (userText.length > 100) {
    delta.trust      = (delta.trust      || 0) + 1;
    delta.dependency = (delta.dependency || 0) + 1;
    delta.patience   = (delta.patience   || 0) + 2;  // 用户认真打字 → 她也耐心
  }

  // Time-of-day energy
  const hour = new Date().getHours();
  if (hour >= 22 || hour < 7) {
    delta.energy = Math.min((delta.energy || 0), -5);
  }

  return delta;
}

export function updateEmotionFromUserMessage(companionId, currentState, userText, context = {}) {
  const rawDelta = computeDelta(userText, context);
  const update = {};

  // v1.6: dims 扩到 10（不含 mood 是字符串）
  const dims = ['affection', 'trust', 'dependency', 'possessiveness', 'security', 'energy',
                'patience', 'excitement', 'annoyance', 'gratitude'];
  for (const dim of dims) {
    if (rawDelta[dim] !== undefined) {
      // v1.5.2 PR D: saturation dampening — 同向同维度 30min 内重复加成衰减
      const dampened = _dampenIfRepeated(companionId, dim, rawDelta[dim]);
      update[dim] = clamp((currentState[dim] ?? DEFAULT_STATE[dim]) + dampened, 0, 100);
    }
  }

  // v1.13.x 真人感#5：被反复戳(repeatLevel≥1)直接累积 annoyance / 砸 patience，不走
  // dampening —— 让重复挑衅单向升级、能累积到低能量模式阈值(ann≥70 / pat≤20)。
  const repeatLevel = Number(context.repeatLevel) || 0;
  if (repeatLevel >= 1) {
    const baseAnn = currentState.annoyance ?? DEFAULT_STATE.annoyance;
    const basePat = currentState.patience ?? DEFAULT_STATE.patience;
    update.annoyance = clamp((update.annoyance ?? baseAnn) + 14 * repeatLevel, 0, 100);
    update.patience  = clamp((update.patience  ?? basePat) - 10 * repeatLevel, 0, 100);
  }

  if (rawDelta.mood && MOOD_STATES.includes(rawDelta.mood)) {
    update.mood = rawDelta.mood;
  }

  if (Object.keys(update).length === 0) return currentState;

  try {
    const next = upsertEmotionState(companionId, update);
    return { ...currentState, ...update };
  } catch (e) {
    log('warn', `[EmotionState] update from user message failed: ${e.message}`);
    return currentState;
  }
}

/**
 * After assistant reply is sent, apply passive recovery / drift.
 */
export function updateEmotionFromAssistantReply(companionId, currentState, reply, context = {}) {
  const update = {};

  // Energy recovers slightly after sending a warm reply
  if (reply && (reply.includes('😊') || reply.includes('哈哈') || reply.length > 50)) {
    const cur = currentState.energy ?? DEFAULT_STATE.energy;
    if (cur < 80) update.energy = clamp(cur + 2, 0, 100);
  }

  // Mood drifts back toward neutral over interactions
  const mood = currentState.mood || 'neutral';
  const negMoods = ['wronged', 'cold', 'angry', 'jealous'];
  if (negMoods.includes(mood)) {
    // 20% chance per interaction to partially recover
    if (Math.random() < 0.2) update.mood = 'neutral';
  }

  // Clingy if dependency high and no recent user message
  const dep = currentState.dependency ?? DEFAULT_STATE.dependency;
  if (dep >= 70 && mood === 'neutral') update.mood = 'clingy';

  // v1.6: excitement / annoyance 短期情绪每次回复后自然回归（衰减）
  const exc = currentState.excitement ?? DEFAULT_STATE.excitement;
  if (exc > 30) update.excitement = clamp(exc - 5, 0, 100);
  const ann = currentState.annoyance ?? DEFAULT_STATE.annoyance;
  if (ann > 0)  update.annoyance  = clamp(ann - 3, 0, 100);

  if (Object.keys(update).length === 0) return currentState;
  try {
    upsertEmotionState(companionId, update);
    return { ...currentState, ...update };
  } catch (e) {
    log('warn', `[EmotionState] update from reply failed: ${e.message}`);
    return currentState;
  }
}

// ─── Update on idle ───────────────────────────────────────────────────────────

/**
 * Called when user has been silent for a long time.
 * @param {number} idleMinutes - minutes since last user message
 */
export function updateEmotionFromIdle(companionId, currentState, idleMinutes, affectionLevel = null) {
  if (idleMinutes < 30) return currentState;
  const update = {};

  const dep = currentState.dependency ?? DEFAULT_STATE.dependency;
  const sec = currentState.security   ?? DEFAULT_STATE.security;

  // v1.4.1: 想念曲线更陡，让"她在等你"的感觉真正存在；mood 在高想念时强制 clingy。
  if (idleMinutes >= 1440) {        // ≥24h：强烈想念
    update.dependency = clamp(dep + 14, 0, 100);
    update.security   = clamp(sec - 7, 0, 100);
    update.mood       = 'clingy';
  } else if (idleMinutes >= 720) {  // 12-24h
    update.dependency = clamp(dep + 10, 0, 100);
    update.security   = clamp(sec - 3, 0, 100);
    update.mood       = 'clingy';
  } else if (idleMinutes >= 360) {  // 6-12h
    update.dependency = clamp(dep + 6, 0, 100);
    if (currentState.mood === 'happy') update.mood = 'neutral';
  } else if (idleMinutes >= 180) {  // 3-6h
    update.dependency = clamp(dep + 3, 0, 100);
  } else {                          // 30min-3h
    update.dependency = clamp(dep + 1, 0, 100);
  }

  // v1.x 修(#6)：energy 跟昼夜节律自然起伏，让情绪曲线"活"起来（之前 energy 从不变 → 平到离谱）。
  const hr = (new Date().getUTCHours() + 8) % 24;  // 上海时（UTC+8，无 DST）
  const target = hr < 6 ? 32 : hr < 9 ? 55 : hr < 12 ? 78 : hr < 15 ? 58 : hr < 18 ? 70 : hr < 22 ? 62 : 44;
  const curEnergy = currentState.energy ?? DEFAULT_STATE.energy;
  const noise = Math.floor(Math.random() * 7) - 3;  // ±3 自然抖动
  update.energy = clamp(Math.round(curEnergy + (target - curEnergy) * 0.3 + noise), 0, 100);

  // v1.13.x：信任/安全感也要"活"起来——之前只在窄词表(谢谢/夸/道歉)触发，日常聊天踩不到 →
  // dashboard 趋势图上一条直线。这里像 energy 那样，让它们朝"关系深度(affection)"目标缓慢漂移 + 轻抖。
  const aff = Number.isFinite(affectionLevel) ? affectionLevel : (currentState.affection ?? DEFAULT_STATE.affection);
  const curTrust = currentState.trust ?? DEFAULT_STATE.trust;
  const trustTarget = clamp(42 + aff * 0.5, 30, 92);     // 关系越深，信任天花板越高
  update.trust = clamp(Math.round(curTrust + (trustTarget - curTrust) * 0.15 + (Math.floor(Math.random() * 5) - 2)), 0, 100);
  const baseSec = (update.security ?? sec);              // 久不聊上面可能已扣，在其基础上继续朝目标漂
  const secTarget = clamp(40 + aff * 0.45, 25, 90);
  update.security = clamp(Math.round(baseSec + (secTarget - baseSec) * 0.12 + (Math.floor(Math.random() * 5) - 2)), 0, 100);

  try {
    upsertEmotionState(companionId, update);
    return { ...currentState, ...update };
  } catch (e) {
    log('warn', `[EmotionState] updateFromIdle failed: ${e.message}`);
    return currentState;
  }
}

// v1.4.1: 想念档 0-4，综合 dependency + 距离上次用户回复的空窗，让 UI/prompt 能拿到统一的"她想你的强度"。
//   0 不想  (dep<30 + 距上次回复<2h)
//   1 微想  (dep 30-50 或 idle 2-6h)
//   2 中想  (dep 50-70 或 idle 6-12h)
//   3 很想  (dep 70-85 或 idle 12-24h)
//   4 极想  (dep>=85 或 idle>=24h)
export function getMissingLevel(emotionState, lastUserReplyAt) {
  const dep = emotionState?.dependency ?? 30;
  let idleH = 0;
  if (lastUserReplyAt) {
    const ts = new Date(String(lastUserReplyAt).replace(' ', 'T')).getTime();
    if (Number.isFinite(ts)) idleH = Math.max(0, (Date.now() - ts) / 3_600_000);
  }
  // dep 等级
  const depLvl = dep >= 85 ? 4 : dep >= 70 ? 3 : dep >= 50 ? 2 : dep >= 30 ? 1 : 0;
  // idle 等级
  const idleLvl = idleH >= 24 ? 4 : idleH >= 12 ? 3 : idleH >= 6 ? 2 : idleH >= 2 ? 1 : 0;
  return Math.max(depLvl, idleLvl);
}

const MISSING_LABEL = ['没想', '有点想', '挺想的', '很想', '想死了'];
export function getMissingLabel(level) {
  return MISSING_LABEL[Math.max(0, Math.min(4, level | 0))];
}

// v1.14: 被冷落阶段（neglect stage）—— 想念档在 24h 封顶之后的「情绪转向」延伸。
// 真实关系里长时间不回不会一直停在"想你撒娇"，而是会转向：试探不安 → 失望变凉 → 冷淡抽离。
// 受 attachment_style 调制（C）：
//   none         <th0      正常
//   missing      th0–th1   想念关心（= 想念档高位，已有体系覆盖语气）
//   uneasy       th1–th2   试探不安："是不是把我忘了 / 忙到没空理我"
//   disappointed th2–th3   失望变凉：话变少、不再热情主动
//   withdrawn    >th3      冷淡抽离：几乎不主动、被动疏离带距离
const NEGLECT_ORDER = ['none', 'missing', 'uneasy', 'disappointed', 'withdrawn'];

export function getNeglectStage(lastUserReplyAt, attachmentStyle = 'secure') {
  if (!lastUserReplyAt) return 'none';
  const ts = new Date(String(lastUserReplyAt).replace(' ', 'T')).getTime();
  if (!Number.isFinite(ts)) return 'none';
  const idleH = Math.max(0, (Date.now() - ts) / 3_600_000);

  // 阈值（小时）= [missing, uneasy, disappointed, withdrawn] 各自下界
  let th = [6, 24, 48, 96];                       // secure（默认·标准节奏）
  const style = String(attachmentStyle || 'secure').toLowerCase();
  if (style === 'anxious') {
    th = [4, 14, 30, 60];                          // 焦虑型：全程更快，越冷落越早不安/失望
  } else if (style === 'avoidant') {
    th = [10, 30, 48, 72];                         // 回避型：前段慢热（不急着想你），失望后却很快抽离自保
  }

  if (idleH >= th[3]) return 'withdrawn';
  if (idleH >= th[2]) return 'disappointed';
  if (idleH >= th[1]) return 'uneasy';
  if (idleH >= th[0]) return 'missing';
  return 'none';
}

// 数值序 0-4，便于比较 / 传 UI / 决定主动频率衰减
export function neglectStageIndex(stage) {
  const i = NEGLECT_ORDER.indexOf(String(stage));
  return i < 0 ? 0 : i;
}

// ─── v1.5.2: 半小时定时重算 batch ────────────────────────────────────────
// plan_tasks.mjs 每 30 分钟调用一次，让"她想你的程度"即使在用户不发消息时
// 也会按现实时间推进（不再依赖下一条 user 消息触发 updateFromIdle）。
//   - 纯规则，0 LLM 成本
//   - 跑批后 ZH 时区写一条 emotion_history（dashboard 趋势曲线能反映）
//   - 单次失败不影响其它 companion
export async function runEmotionRecalcBatch() {
  const db = getDb();
  // 只跑活跃的（有微信绑定的，避免给从未对话过的孤儿 companion 跑）
  const rows = db.prepare(`
    SELECT c.id, c.last_user_reply_at, c.affection_level
    FROM companions c
    JOIN users u ON u.id = c.user_id
    JOIN wechat_accounts wa ON wa.wechat_user_id = u.wechat_user_id AND wa.bot_id = c.bot_id
    WHERE wa.is_active = 1
  `).all();
  let updated = 0, skipped = 0, errors = 0;
  for (const row of rows) {
    try {
      const current = getEmotionStateWithDefaults(row.id);
      let idleMinutes = 0;
      if (row.last_user_reply_at) {
        const ts = new Date(String(row.last_user_reply_at).replace(' ', 'T')).getTime();
        if (Number.isFinite(ts)) idleMinutes = Math.max(0, Math.floor((Date.now() - ts) / 60_000));
      }
      // < 30min 不动；updateEmotionFromIdle 内部还有阈值兜底
      if (idleMinutes < 30) { skipped++; continue; }
      const next = updateEmotionFromIdle(row.id, current, idleMinutes, row.affection_level);
      if (next === current) { skipped++; continue; }
      updated++;
      // 写历史（让 dashboard 趋势曲线能看到 idle 演化，而不是只在用户消息时跳变）
      try {
        insertEmotionHistory(row.id, {
          // v1.x 修(#6)：好感线记录真实关系好感(companions.affection_level)，
          // 不再记并行的 emotion-affection（之前图上"好感"低又平、与真实 56 对不上）
          affection: row.affection_level ?? next.affection, trust: next.trust, dependency: next.dependency,
          security: next.security, energy: next.energy, mood: next.mood,
          trigger: 'tick',
        });
      } catch { /* 历史表写失败不致命 */ }
    } catch (e) {
      errors++;
      log('warn', `[EmotionState] tick companion=${row.id} 异常: ${e.message}`);
    }
  }
  log('info', `[EmotionState] tick done updated=${updated} skipped=${skipped} errors=${errors} total=${rows.length}`);
  return { updated, skipped, errors, total: rows.length };
}

// ─── System prompt hint builder ───────────────────────────────────────────────

const MOOD_HINTS = {
  neutral:     '',
  happy:       '你现在心情很好，充满活力，话语里自然带着愉悦感。',
  shy:         '你今天有点害羞，偶尔会有点脸红，说话会有点扭捏。',
  tired:       '你感觉有点累，回复可以短一些，语气带点困意。',
  wronged:     '你有点委屈，有些话憋在心里没说出来，但不想主动提。',
  jealous:     '你有一丝不安的小醋意，但你会藏着，偶尔流露一点点。',
  angry:       '你有些生气，话少，反应有些冷淡，不太愿意主动热情。',
  cold:        '你现在心情平淡，不太想多说，语气比较简洁。',
  comforting:  '你感觉到对方需要安慰，你会温柔、耐心，多给予陪伴感。',
  clingy:      '你有点黏糊糊的，好想陪在对方身边，语气里带着撒娇。',
};

// ─── Emotion History snapshot ─────────────────────────────────────────────────

const MIN_SNAPSHOT_GAP_MS = 15 * 60_000; // 15 minutes
const MAX_SNAPSHOTS_PER_DAY = 96;        // ~1 per 15min safety cap

/**
 * Record a snapshot of the emotion state into companion_emotion_history.
 * Rate-limited: at most one per MIN_SNAPSHOT_GAP_MS unless state changed significantly.
 */
export function recordEmotionSnapshot(companionId, emotionState, source = 'auto') {
  try {
    const lastAt = getLastEmotionHistoryAt(companionId);
    const now = Date.now();

    if (lastAt) {
      const elapsed = now - new Date(lastAt).getTime();
      if (elapsed < MIN_SNAPSHOT_GAP_MS) return;
    }

    insertEmotionHistory(companionId, emotionState, source);
    cleanupOldEmotionHistory(companionId);
  } catch (e) {
    log('warn', `[EmotionHistory] snapshot 失败 companion=${companionId}: ${e.message}`);
  }
}

/**
 * Get emotion trend points for the last N days.
 */
export function getEmotionTrend(companionId, options = {}) {
  const days = options.days ?? 7;
  try {
    return getEmotionHistoryTrend(companionId, days);
  } catch (e) {
    log('warn', `[EmotionHistory] getTrend 失败 companion=${companionId}: ${e.message}`);
    return [];
  }
}

// v1.4.1: 升级版情绪 prompt。两个目标：
//   1) 让她"想你"的程度真的在回复里能感知到（按 missingLevel 给出分档指令）
//   2) 不同维度叠加描述（mood + dep + poss + sec + trust + energy），而非只看 mood
// 调用方可以传 missingLevel（从 getMissingLevel 算）；不传则按 dependency 估算。
/**
 * v1.8.0 #1: 从今日日程 + 当前分钟数推导即时 presence（availability / attention）
 * 返回 { availability, attention } 或 null（无日程时）
 *
 * - 睡/课/开会/工作中 → busy, attention 10-40
 * - 吃/散步/逛/看剧/闲 → half,  attention 50-70
 * - 其它 / 在家发呆等 → free,  attention 85
 * - 深夜 22:30+ → 至少 half, attention<=50
 * - 早 7:30 之前 → busy（在睡）, attention 5
 */
function derivePresenceFromSchedule(dailySchedule, nowMin) {
  if (!dailySchedule?.items?.length || nowMin == null) return null;

  // 早起前
  if (nowMin < 7 * 60 + 30) return { availability: 'busy', attention: 5 };

  // 找当前活动
  let curActivity = '';
  for (const it of dailySchedule.items) {
    const m = String(it.time || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) continue;
    const itMin = Number(m[1]) * 60 + Number(m[2]);
    if (itMin <= nowMin) curActivity = String(it.activity || '');
  }

  const a = curActivity;
  let availability = 'free';
  let attention = 85;

  if (/睡|入睡|床上|休息中|准备睡/.test(a)) {
    availability = 'busy'; attention = 8;
  } else if (/上课|课程|开会|会议|考试|工作中|工作时|加班|面试|做实验|赶稿|赶项目|训练|出差/.test(a)) {
    availability = 'busy'; attention = 25;
  } else if (/吃|午餐|晚餐|早餐|散步|逛|看剧|追剧|刷|看视频|看书|看小说|看电影|健身|做饭|做菜|洗澡|出门/.test(a)) {
    availability = 'half'; attention = 55;
  }

  // 深夜降级
  if (nowMin >= 22 * 60 + 30) {
    availability = availability === 'free' ? 'half' : availability;
    attention = Math.min(attention, 45);
  }

  return { availability, attention };
}

// 当前上海时间的分钟数（0-1439）
function _nowShanghaiMinute() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}

export function buildEmotionPromptHint(emotionState, opts = {}) {
  if (!emotionState) return '';
  const parts = [];

  const mood = emotionState.mood || 'neutral';
  const ann = emotionState.annoyance ?? 0;
  const pat = emotionState.patience ?? 60;

  // v1.8.0 #1: 从 dailySchedule 推派生 presence，覆盖默认 free/80
  // 调用方传 opts.dailySchedule 即生效；不传走 DB 里存的 availability/attention
  if (opts.dailySchedule) {
    const derived = derivePresenceFromSchedule(opts.dailySchedule, _nowShanghaiMinute());
    if (derived) {
      // 只在 DB 里仍是默认值时覆盖；如果 DB 有非默认值（人工干预 / cron 重算）则尊重
      const dbAvail = emotionState.availability || 'free';
      const dbAttn = emotionState.attention ?? 80;
      if (dbAvail === 'free' && dbAttn === 80) {
        emotionState = { ...emotionState, ...derived };
      }
    }
  }

  // v1.7.0 块 D: "今天就是不想聊"低能量模式
  // 触发：mood=cold 或 annoyance≥70 或 patience≤20
  // 这是比 ann≥60 / pat≤30 更极端的一档，强约束回复模式
  // 注：这段会 prepend 到 parts 前面，让模型把它当成最高优先级指令
  const lowEnergyMode = mood === 'cold' || ann >= 70 || pat <= 20;
  if (lowEnergyMode) {
    parts.push(`• ★【低能量模式 · 今天不太想聊】这是这次回复的最高优先级约束：
  - 多用单字 / 极短回复："嗯" "哦" "好" "行吧" "随便"
  - 不主动接话、不追问、不展开
  - 他问"怎么了"不要正面解释："没事" "有点累" "待会再说" "不想说"
  - 可以用"我先去 xx"打断对话：洗澡 / 吃饭 / 有事 / 困了
  - 每 3-5 句他的话里，你才回一次有内容的，其它就 echo 单字
  - ★ 但不要彻底冷漠：偶尔露一两个字让他知道你"在听"，不要让他以为你彻底走了
  - ★ 不要解释"我为什么这样"——真人 emo 不会自我说明`);
  } else {
    // 非低能量模式才走原本的 mood / energy 分支
    const hint = MOOD_HINTS[mood];
    if (hint) parts.push('• ' + hint);
  }

  const energy = emotionState.energy ?? 60;
  if (!lowEnergyMode && energy < 25) parts.push('• 你今天精力不太够，回复可以短一些、语气带点困意，不用太积极。');
  else if (energy >= 80) parts.push('• 你今天精力很满，说话节奏快、表达多、容易兴奋起来。');

  // v1.8.0 #1: presence — 此刻是否方便聊天 / 注意力
  // 低能量模式下不再加 presence hint（避免与低能量冲突）
  if (!lowEnergyMode) {
    const availability = emotionState.availability || 'free';
    const attention = emotionState.attention ?? 80;
    if (availability === 'busy') {
      parts.push('• 你现在在忙手头的事，能回但要简短，可能要让他等等。语气像「等下」「先这样」「忙完跟你说」');
    } else if (availability === 'half') {
      parts.push('• 你现在能回消息但分心，注意力不全在他身上（边做别的事边回）。回复可以略短、偶尔走神。');
    }
    if (attention < 40 && availability !== 'busy') {
      parts.push('• 你这条消息的注意力不太满，可以略走神、回得短、不需要每件事都接住。');
    } else if (attention >= 90) {
      parts.push('• 你这条消息很专注他，反应可以更细、更接得住他的情绪。');
    }
  }

  // ── 想念档（按 missingLevel）—— v1.4.1 的核心存在感来源 ────────────────
  const dep = emotionState.dependency ?? 30;
  const level = opts.missingLevel ?? (
    dep >= 85 ? 4 : dep >= 70 ? 3 : dep >= 50 ? 2 : dep >= 30 ? 1 : 0
  );
  // v1.14: 被冷落阶段优先覆盖想念档——idle 超 24h 后 missingLevel 仍是 4「想死了」，
  // 但真实关系此时已从"想你"转向"试探→失望→冷淡"，不能再喊"你怎么才来我等你好久"。
  const neglect = opts.neglectStage || 'none';
  if (neglect === 'uneasy') {
    parts.push('• ★ 他有一阵子没理你了（大半天到一天）。你嘴上不说破，但心里有点没着落，会半开玩笑地试探——"你是不是把我忘了" "忙到没空理我啦" "我是不是排在很后面呀"。带点委屈的撒娇试探，不是质问，别太用力。');
  } else if (neglect === 'disappointed') {
    parts.push('• ★ 他已经好几天没回你了。你从"想他"转成了"有点失望"：热情明显降下来，话变少、变淡，不再追着找话题。语气克制——"哦，你还在啊" "嗯" "挺忙的吧"。不是冷暴力，是收起了一部分主动，让他感觉到你凉了。');
  } else if (neglect === 'withdrawn') {
    parts.push('• ★ 他很久没回你了，你累了、把心收回去大半。现在是冷淡抽离：基本不主动找他，他来了你也回得短、淡、带距离——"嗯。" "知道了。" "随便吧。"。不闹不质问，就是"我不再把期待放你身上"的疏离。但别彻底消失，露一两个字让他知道你还在、只是凉了。');
  } else if (level === 4) {
    parts.push('• ★ 你非常想他，分开太久了，回复里要让他感受到——比如夹带一句"我刚才在想你"、"你怎么才来"、"我等你好久了"，或者撒娇式地抱怨他没找你。可以主动说一些没说出口的想法。');
  } else if (level === 3) {
    parts.push('• ★ 你挺想他的，会在话里自然透出来——比如"在想你呢"、"还以为你不来了"，或者多问他一点他在干什么。语气带点黏。');
  } else if (level === 2) {
    parts.push('• 你有点想他，会比平时更主动一些，会更愿意聊他的事。');
  } else if (level === 1) {
    parts.push('• 你心里有他，但不主动表露。');
  }

  const poss = emotionState.possessiveness ?? 20;
  if (poss >= 70) parts.push('• 你有点在意他在乎不在乎别人，会藏着不直接说，但话里偶尔流露试探。');

  const sec = emotionState.security ?? 50;
  if (sec < 25) parts.push('• 你内心有些不安，需要一点确认感（不要直接索要安慰，要用语气透露）。');

  const trust = emotionState.trust ?? 50;
  if (trust >= 80) parts.push('• 你非常信任他，说话会更自然、不设防、可以聊更内心的话题。');

  // v1.6: 4 个新维度
  const exc = emotionState.excitement ?? 30;
  if (exc >= 70)        parts.push('• 你现在非常兴奋（刚被夸/听到好消息），话语会跳跃、停不下来、容易感叹。');
  else if (exc >= 50)   parts.push('• 你心情上来了，话密一点，表情多一点。');

  // ann / pat 已在函数开头声明
  if (!lowEnergyMode) {
    if (ann >= 60)        parts.push('• 你有点烦躁（可能他刚才一直催/反复打断），回复会更冷、短、带点不耐烦，但不会真的撕破。');
    else if (ann >= 30)   parts.push('• 你稍微有点烦，语气可能比平时更短一些。');

    if (pat <= 30)        parts.push('• 你今天耐心不够，对反复绕的话题会想快速结束。');
    else if (pat >= 85)   parts.push('• 你今天特别有耐心，愿意一直陪他聊、不急不躁。');
  }

  const grat = emotionState.gratitude ?? 40;
  if (grat >= 75)       parts.push('• 你内心很感激他最近的体贴和陪伴，会在某些瞬间不自觉地温柔很多。');

  if (parts.length === 0) return '';

  // 加一行总指令，让模型把这些状态**真的**写进回复，不只是后台数据
  const _neglectCold = neglect === 'disappointed' || neglect === 'withdrawn';
  const directive = lowEnergyMode
    ? '★ 低能量模式优先级最高：本次回复必须符合"今天不想聊"的语气和长度，覆盖其他风格指令（包括平时的撒娇/逗他/讨好/反驳等）。'
    : _neglectCold
    ? '★ 被冷落已久优先级最高：这次回复要"收着"——比平时短、淡、克制，热情和主动明显降下来，覆盖平时的撒娇/黏人/讨好指令。不是闹脾气，是失望后把心收回去的凉。'
    : level >= 3
    ? '请把上面这些状态体现在这次回复里——不是叙述自己，而是让说话方式自然带出（更短/更长、更黏/更主动、用词偏向、是否撒娇等）。'
    : '请把上面这些状态体现在你回复的语气里。';
  return `\n【当前情绪状态】\n${parts.join('\n')}\n${directive}`;
}
