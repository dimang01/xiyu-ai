/**
 * 
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */
import {
  getActiveBotAccounts, getRecentHistory, getUserProfile, recallMemories,
  getConversationContext, getDueReminders, markRemindersTriggered, ensureRelationshipReminders,
  saveMessage, saveConversationTurn,
  getCompanionById, getBotContextForCompanion, getDb,
  getActiveWechatBinding, getDailySchedule, shanghaiDateKey, getRecentSchedules, getPersonaFacts,
  markCompanionConfessed, patchCompanion,
  recordProactiveSentTimestamp, getProactiveLastSent, markWindowLastCallSent, bumpProactiveUnanswered,
  getCompanionPreferencesForPrompt,
  listDueOpenLoops, markOpenLoopFollowedUp,  // v1.8.0 #5
  getRecentSafetyRisk,                        // v1.9.0 #1
  listShaping,                                // 共建留痕（教过她的注入主动消息）
} from './db.mjs';
import { computeRelationshipStage, canAcceptConfession } from './memory.mjs';
import { buildSystemPrompt } from './companion.mjs';
import { generateReply } from './ai.mjs';
import { sendTextMessage, sendMessageItem, recallContextToken } from './ilink.mjs';
import { dedupSegments } from './text_similarity.mjs';
// v1.4.0: 微信端 voice 路径已废弃（iLink 协议禁止 bot outbound voice，腾讯
// 官方 SDK 没有 sendVoiceMessageWeixin，HTTP 200 但消息静默丢弃）。
// 语音功能改在 playground / dashboard 试听 / diary 朗读等浏览器端实现。
// 删除原 maybeSendVoice 调用，避免生产环境烧 TTS 配额而消息根本送不出。
import { buildLongTermDigest, ensureScheduleForCompanion } from './plan_tasks.mjs';
import { parseStickerMarkers, buildStickerPromptHint, hasStickers } from './stickers.mjs';
import { uploadFile, readMediaBuffer } from './media.mjs';
import { getPhotoGateState, planPhotoMessage } from './photo_planner.mjs';
import { sendCompanionPhoto } from './photo_sender.mjs';
import { safeOutboundReply } from './moderation.mjs';
import { log } from './logger.mjs';
import { buildEmotionPromptHint, getEmotionStateWithDefaults, getMissingLevel, getNeglectStage } from './emotion_state.mjs';
import { buildShapingPromptHint } from './shaping.mjs';
import { evaluateProactive, recordProactiveSent } from './proactive_engine.mjs';
import { tryAchievement } from './achievements.mjs';
import {
  getSleepRow, getOrRefreshTodaySchedule, enterSleep, exitSleep,
  drainMissed, upsertSleepSchedule,
} from './sleep.mjs';

// ─── Proactive Engine 版本选择 ────────────────────────────────────────────────
// PROACTIVE_ENGINE=v2 启用 evaluateProactive() 决策层（推荐）
// PROACTIVE_ENGINE=legacy 保留旧时间窗口调度器逻辑（兜底）
const PROACTIVE_ENGINE_MODE = (process.env.PROACTIVE_ENGINE || 'v2').toLowerCase();

const TZ = 'Asia/Shanghai';
// 早安/晚安基准时间，实际每天有 ±30min 随机波动让 AI 更像真人
const WEEKDAY_START_MINUTE = 7 * 60 + 30;   // 07:30 基准
const WEEKEND_START_MINUTE = 8 * 60;        // 08:00 基准
const LAST_MINUTE = 23 * 60 + 59;           // 23:59 上限
const GOODNIGHT_MINUTE = 23 * 60;           // 23:00 基准晚安
const MORNING_JITTER_MIN = 30;              // 早安 ±30min
const GOODNIGHT_JITTER_MIN = 30;            // 晚安 ±30min
const MIN_GAP_MINUTES = 30;

// 在 [-jitter, +jitter] 范围内取随机分钟偏移
function jitterOffset(jitter) {
  return Math.floor(Math.random() * (jitter * 2 + 1)) - jitter;
}
const TICK_MS = 60_000;

const schedules = new Map();

// ─── v1.9.0 #3: 失败日志标准化（不建表，先用结构化 log，观察一段时间再决定是否升表） ──
// 用法：logProactiveFailure({ companionId, kind, errorType, latencyMs, message })
// 字段对齐 ChatGPT 的 proactive_delivery_events 设计（companion_id/kind/error_type/latency_ms），
// 但落到 log 而不是 SQL，避免提前引入维护成本。grep `[Proactive][fail]` 可统一汇总。
function classifyError(err) {
  if (!err) return 'unknown';
  if (typeof err.status === 'number') {
    if (err.status === 429) return 'rate_limit';
    if (err.status >= 500) return 'provider_5xx';
    if (err.status === 401 || err.status === 403) return 'auth';
    if (err.status === 400) return 'bad_request';
    return `http_${err.status}`;
  }
  const msg = String(err.message || err);
  if (/timeout|timed out|abort/i.test(msg))               return 'timeout';
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(msg)) return 'network';
  if (/HTTP\s+429/i.test(msg))                            return 'rate_limit';
  if (/HTTP\s+5\d{2}/i.test(msg))                         return 'provider_5xx';
  if (/HTTP\s+(?:401|403)/i.test(msg))                    return 'auth';
  if (/HTTP\s+400/i.test(msg))                            return 'bad_request';
  return 'unknown';
}

function logProactiveFailure({ companionId, kind, error, latencyMs = null, extra = '' }) {
  const errorType = classifyError(error);
  const parts = [
    `companion=${companionId}`,
    `kind=${kind}`,
    `error_type=${errorType}`,
  ];
  if (latencyMs != null) parts.push(`latency_ms=${latencyMs}`);
  const msg = String(error?.message || error || '').slice(0, 200);
  if (msg) parts.push(`msg="${msg}"`);
  if (extra) parts.push(extra);
  log('warn', `[Proactive][fail] ${parts.join(' ')}`);
}

// v1.5.2 B3 修：进程内"正在处理中" companion 集合，防同 companion 并发 sendProactiveMessage
// （比如 generateReply 跑 8s 期间又来一个 tick）
const _proactiveInFlight = new Set();
// v1.5.2 B1 修：全局发送间隔（秒）。重启后会读 companions.last_proactive_sent_at 兜底。
// 比 schedule 内的 MIN_GAP_MINUTES 更硬性 — schedule 是规划，这个是闸门。
const PROACTIVE_HARD_GAP_SECONDS = 25 * 60;  // 25 分钟（比 MIN_GAP_MINUTES=30 略松，避免误杀 reminder/confession）

// v1.16.x:「窗口将关·临门一脚」—— 微信主动推送 ~24h 会话窗口将关前（idle 21-23.5h）发一次
// 轻量搭话，这是她还能主动发消息的最后机会（用户回应→token 刷新→窗口续命）。每个离开周期一次。
// 守 De Freitas《Emotional Manipulation》反操纵红线：就一句"在吗"，绝不愧疚/挽留/施压。
const LASTCALL_MIN_H = 21;
const LASTCALL_MAX_H = 23.5;
export function shouldSendWindowLastCall(companion, now = new Date()) {
  if (!companion?.last_user_reply_at) return false;           // 从没聊过，没有窗口可关
  const ts = new Date(String(companion.last_user_reply_at).replace(' ', 'T')).getTime();
  if (!Number.isFinite(ts)) return false;
  const idleH = (now.getTime() - ts) / 3_600_000;
  if (idleH < LASTCALL_MIN_H || idleH > LASTCALL_MAX_H) return false;  // 不在"窗口将关"区间
  // 本离开周期是否已发过（last_lastcall_at 秒 > last_user_reply_at 秒 → 已发，不重复）
  const lastUserSec = Math.floor(ts / 1000);
  const lastCallSec = Number(companion.last_lastcall_at) || 0;
  return lastCallSec <= lastUserSec;
}

export function startProactiveScheduler() {
  log('info', '[Proactive] 主动消息调度启动');
  tick().catch(err => log('error', `[Proactive] tick 异常: ${err.message}`));
  return setInterval(() => {
    tick().catch(err => log('error', `[Proactive] tick 异常: ${err.message}`));
  }, TICK_MS);
}

async function tick(now = new Date()) {
  const dateKey = formatDateKey(now);
  const minuteNow = currentMinute(now);
  const isWeekendDay = isWeekend(now);
  const defaultStart = isWeekendDay ? WEEKEND_START_MINUTE : WEEKDAY_START_MINUTE;

  const accounts = getActiveBotAccounts();
  for (const account of accounts) {
    const companions = listProactiveCompanionsForBot(account.bot_id);
    for (const companion of companions) {
      // v1.5.2 B2 修：把每个 companion 的本 tick 处理包在 try 里，一个失败不连累其它
      try {
        // 用户自定义时间窗口（companion.proactive_time_window，格式 "07:30-24:00"），fallback 到默认
        const window = parseTimeWindow(companion.proactive_time_window) || { start: defaultStart, end: LAST_MINUTE };
        if (minuteNow < window.start) continue;
        if (minuteNow > window.end) continue;

        // 自愈：若 DB 里没有今天的日程（cron 失败或刚绑定），按需触发一次生成
        // ensureScheduleForCompanion 内置 30 分钟级 debounce 防止持续失败时反复重试
        if (!getDailySchedule(companion.id, dateKey)) {
          ensureScheduleForCompanion(companion.id, dateKey).catch(err =>
            log('warn', `[Proactive] ensureSchedule 异常 companion=${companion.id}: ${err.message}`)
          );
        }
        // ── 纪念日 / 提醒主动推送 ──────────────────────────────────────────────
        // 事件驱动，独立于随机日程，也绕过 v2 抑制：生日/纪念日这种特殊日子该发就发。
        // 发完即标记 last_triggered_at，保证当天只发一次、且不再作为后续消息的上下文重复出现。
        try {
          ensureRelationshipReminders(companion); // 懒初始化关系里程碑（仅一次）
          const dueReminders = getDueReminders(companion.id, dateKey);
          if (dueReminders.length > 0) {
            await sendProactiveMessageGuarded(companion, 'reminder', account, { reminders: dueReminders });
            markRemindersTriggered(companion.id, dueReminders.map(r => r.id), dateKey);
          }
        } catch (e) {
          log('warn', `[Proactive] reminder 推送异常 companion=${companion.id}: ${e.message}`);
        }

        // ── 窗口将关·临门一脚 ──────────────────────────────────────────────
        // 独立于随机日程的事件触发：token 窗口将关前(idle 21-23.5h)发最后一次轻量搭话拉回用户。
        // 走 guarded（安全门 + 硬间隔），每离开周期一次。受白天 window 限制（深夜不打扰）。
        try {
          if (shouldSendWindowLastCall(companion, now)) {
            const r = await sendProactiveMessageGuarded(companion, 'lastcall', account);
            if (r === 'sent') {
              markWindowLastCallSent(companion.id);
              log('info', `[Proactive] ★ 窗口将关·临门一脚 companion=${companion.id}`);
            }
          }
        } catch (e) {
          log('warn', `[Proactive] lastcall 异常 companion=${companion.id}: ${e.message}`);
        }

        const schedule = ensureTodaySchedule(companion.id, dateKey, minuteNow, window.start, window.end, companion);
        // v1.10.0 #BUG-FIX：原来不加 _v2_deny_until 字段时，v2 评估失败 + item.sent=true 顺序错位
        // 让大量 items 在 motivation 还没积累起来时就被永久标记 sent。配额白白浪费，用户感知
        // "主动消息明显比设置的少"。改法：
        //   1) v2 拒绝时 *不* 标记 sent=true，但写 _v2_deny_until=now+15min 防抖；
        //   2) 真正发送（含 wrapper silent return）才标记 sent；
        //   3) 加结构化 reason log 便于排查。
        const dueItems = schedule.items.filter(item =>
          !item.sent
          && item.minute <= minuteNow
          && (!item._v2_deny_until || Date.now() >= item._v2_deny_until)
        );
        for (const item of dueItems) {
          if (currentMinute(new Date()) > window.end) break;

          // v2 mode: ask evaluateProactive() before sending
          if (PROACTIVE_ENGINE_MODE === 'v2') {
            let v2Error = false;
            let decision = null;
            try {
              decision = evaluateProactive(companion, {});
            } catch (e) {
              log('warn', `[Proactive] evaluateProactive 异常，fallback legacy: ${e.message}`);
              v2Error = true;
            }
            // v2 主动拒发（非异常）→ defer 15min 重试，不丢配额
            if (!v2Error && decision === null) {
              item._v2_deny_until = Date.now() + 15 * 60_000;
              log('info', `[Proactive] v2 拒发，延期 15 分钟重试 companion=${companion.id} kind=${item.kind} minute=${item.minute}`);
              continue;
            }
          }

          // v1.10.1 fix: guarded 返回投递状态。节流类（inflight/throttled/safety）不消耗配额，
          // 改 defer 重试，避免实发条数 < target；只有真正发送 / 内部尝试过才标 sent。
          const result = await sendProactiveMessageGuarded(companion, item.kind, account);
          if (result === 'throttled' || result === 'inflight') {
            item._v2_deny_until = Date.now() + 10 * 60_000;   // 10 分钟后重试
          } else if (result === 'safety') {
            item._v2_deny_until = Date.now() + 60 * 60_000;   // 安全门，1 小时后再评估
          } else {
            // 'sent' 或内部早退（撞车/无 ctx）都算今日已尝试
            item.sent = true;
          }
        }
      } catch (e) {
        // v1.5.2 B2 兜底：任何一个 companion 的本 tick 异常都不能中断后面的处理
        log('error', `[Proactive] companion=${companion.id} 本 tick 异常，跳过: ${e.message}`);
      }
    }
  }
}

// v1.5.2: 三道闸门的 sendProactiveMessage wrapper —
//   1. 进程内 in-flight 锁（防同 companion 并发 race，B3）
//   2. 持久化 last_proactive_sent_at 25 分钟硬间隔（防重启重发，B1）
//   3. reminder/confession 等"特殊事件"放宽到 5 分钟（不能因 normal 节流而错过纪念日祝福）
// v1.19.6 hotfix: 晚安标记的归属日（纯函数，smoke 可回归）。
// 凌晨 <05:00 发出的晚安属于"昨晚"——否则跨午夜发送会吃掉当晚的晚安。
export function goodnightBelongDateKey(now = new Date()) {
  const shHour = (now.getUTCHours() + 8) % 24;
  return shHour < 5
    ? shanghaiDateKey(new Date(now.getTime() - 24 * 3600_000))
    : shanghaiDateKey(now);
}

// v1.19.5: morning 是否该降级为 normal（纯函数，smoke 可确定性回归）。
// 两种"刚醒"穿帮都降级（配额照用，文案不再装刚醒）：
// 1) alreadySent —— 今天早安已发过：服务重启丢内存排程，重算把 morning 又排上
//    （7 点真起床发过"刚醒"，9 点半又来一条"早…刚醒"，重复且和中间互动自相矛盾）
// 2) talkedThisMorning —— 用户今早(上海时间 ≥05:00)已经聊过天：8 点他说"早"她回了，
//    9 点半再发"刚醒"等于穿帮说谎。半夜睡前(<05:00)聊的不算——那种情况早上说刚醒不穿帮。
export function shouldDemoteMorning({ goodmorningSentForDate, todayKey, lastUserReplyAt } = {}) {
  const alreadySent = !!todayKey && goodmorningSentForDate === todayKey;
  let talkedThisMorning = false;
  if (lastUserReplyAt) {
    const raw = String(lastUserReplyAt);
    const ts = new Date(raw.replace(' ', 'T') + (raw.includes('Z') || raw.includes('+') ? '' : 'Z')).getTime();
    if (Number.isFinite(ts)) {
      const shHour = (new Date(ts).getUTCHours() + 8) % 24;
      talkedThisMorning = shanghaiDateKey(new Date(ts)) === todayKey && shHour >= 5;
    }
  }
  return { demote: alreadySent || talkedThisMorning, alreadySent, talkedThisMorning };
}

async function sendProactiveMessageGuarded(companion, kind, account, opts = {}) {
  if (_proactiveInFlight.has(companion.id)) {
    log('info', `[Proactive] 跳过：companion=${companion.id} 已有发送在进行中（kind=${kind}）`);
    return 'inflight';
  }
  // ── v1.19.6 goodnight 防重（第二道闸，排程侧第一道见 ensureTodaySchedule）──
  // 与 morning 不同：晚安重复时直接**跳过**而非降级——她都说过"我要睡了"，
  // 再发条普通消息反而像诈尸。返回非节流状态，tick 会标 item.sent 作废本条配额。
  if (kind === 'goodnight') {
    try {
      if (getSleepRow(companion.id)?.goodnight_sent_for_date === shanghaiDateKey()) {
        log('info', `[Proactive] 今晚晚安已发过 → 跳过重复 goodnight companion=${companion.id}`);
        return 'dup';
      }
    } catch (e) {
      log('warn', `[Proactive] goodnight 防重检查失败（按原 kind 继续）: ${e.message}`);
    }
  }
  // ── v1.19.5 morning 防重 + 防穿帮（第二道闸，排程侧第一道见 ensureTodaySchedule）──
  if (kind === 'morning') {
    try {
      const verdict = shouldDemoteMorning({
        goodmorningSentForDate: getSleepRow(companion.id)?.goodmorning_sent_for_date,
        todayKey: shanghaiDateKey(),
        lastUserReplyAt: companion.last_user_reply_at,
      });
      if (verdict.demote) {
        log('info', `[Proactive] morning 降级 normal companion=${companion.id} alreadySent=${verdict.alreadySent} talkedThisMorning=${verdict.talkedThisMorning}`);
        kind = 'normal';
      }
    } catch (e) {
      log('warn', `[Proactive] morning 防重检查失败（按原 kind 继续）: ${e.message}`);
    }
  }
  // ── v1.9.0 #1: 安全门 ─────────────────────────────────────────────────
  // 用户最近表达自伤/自杀/绝望信号时，不要发普通主动消息（包括纪念日/告白/想念）。
  // "她今天没找我" 远好于 "她在我说不想活了之后发了句突然想你"。
  try {
    const risk = getRecentSafetyRisk(companion.id);
    if (risk.level === 'high' || risk.level === 'medium') {
      log('warn', `[Proactive] 安全门拦截 companion=${companion.id} kind=${kind} risk=${risk.level} signals=${(risk.signals || []).join(',')}`);
      return 'safety';
    }
  } catch (e) {
    // 查询失败不应阻塞 — 但也不静默继续发，保守起见同样跳过本次
    log('warn', `[Proactive] 安全门查询失败 companion=${companion.id}: ${e.message} → 保守跳过本次`);
    return 'safety';
  }
  // 持久化间隔检查
  const { lastAt } = getProactiveLastSent(companion.id);
  const nowSec = Math.floor(Date.now() / 1000);
  const elapsed = nowSec - (lastAt || 0);
  const hardGap = (kind === 'reminder' || kind === 'confession') ? 5 * 60 : PROACTIVE_HARD_GAP_SECONDS;
  if (lastAt && elapsed < hardGap) {
    log('info', `[Proactive] 跳过：companion=${companion.id} kind=${kind} 距上次 ${elapsed}s < ${hardGap}s 硬间隔`);
    return 'throttled';
  }
  _proactiveInFlight.add(companion.id);
  try {
    await sendProactiveMessage(companion, kind, account, opts);
    // 成功后记录（sendProactiveMessage 内部失败/早退也无伤大雅，下次仍会按间隔判断）
    recordProactiveSentTimestamp(companion.id, kind);

    // v1.10.0 sleep 状态切换 hook
    try {
      const todayKey = shanghaiDateKey();
      if (kind === 'goodnight') {
        // v1.10.6: goodnight 只发"我要睡了 晚安"，不立即 enterSleep。
        // 真正入睡交给 sleep tick 在 today_bed_at 触发，让睡前晚安与入睡之间留挽留窗口
        // （用户说"再陪陪我"可延后）。
        // v1.19.6 hotfix: 跨午夜归属——排 23:59 的晚安经发送延迟滑到凌晨 00:0x 才发出时，
        // 标"今天"会让防重闸把**当晚 23 点的晚安**误判为已发（生产实测 companion=3/7 踩中）。
        // 凌晨 <05:00 发出的晚安归属"昨晚"（与 morning 的 05:00 分界对称）。
        upsertSleepSchedule(companion.id, { goodnight_sent_for_date: goodnightBelongDateKey() });
        log('info', `[Sleep] goodnight sent (enterSleep deferred to bed_at) companion=${companion.id}`);
      } else if (kind === 'morning') {
        exitSleep(companion.id);
        drainMissed(companion.id);
        upsertSleepSchedule(companion.id, { goodmorning_sent_for_date: todayKey, woken_today: 0 });
        log('info', `[Sleep] exitSleep via morning companion=${companion.id}`);
      }
    } catch (e) {
      log('warn', `[Sleep] hook failed companion=${companion.id} kind=${kind}: ${e.message}`);
    }
    return 'sent';
  } finally {
    _proactiveInFlight.delete(companion.id);
  }
}

function parseTimeWindow(spec) {
  if (typeof spec !== 'string' || !spec) return null;
  const m = spec.match(/^(\d{1,2}):(\d{2})\s*[-~–]\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const sh = Number(m[1]), sm = Number(m[2]), eh = Number(m[3]), em = Number(m[4]);
  if (sh < 0 || sh > 24 || eh < 0 || eh > 24 || sm > 59 || em > 59) return null;
  const start = sh * 60 + sm;
  const end = Math.min(LAST_MINUTE, eh * 60 + em);
  if (end <= start) return null;
  return { start, end };
}

function listProactiveCompanionsForBot(botId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT c.id, u.wechat_user_id
    FROM companions c
    JOIN users u ON u.id = c.user_id
    JOIN wechat_accounts wa ON wa.wechat_user_id = u.wechat_user_id AND wa.bot_id = c.bot_id
    WHERE c.bot_id = ?
      AND c.proactive_enabled = 1
      AND COALESCE(c.silent_mode, 0) = 0   -- v1.5: 沉默陪伴模式下完全不主动
      AND wa.is_active = 1
      AND wa.wechat_user_id IS NOT NULL
  `).all(botId);
  return rows
    .map(r => ({ ...getCompanionById(r.id), wechat_user_id: r.wechat_user_id }))
    .filter(Boolean);
}

// 检查是否应该安排一次候选照片：默认至少 36 小时，真正是否发送交给 AI planner 再判断。
function shouldSendPhotoToday(companion) {
  if (!companion) return false;
  const last = companion.last_photo_at;
  if (!last) return true;  // 从未发过
  const lastTs = new Date(String(last).replace(' ', 'T') + (String(last).includes('Z') ? '' : 'Z')).getTime();
  const hours = (Date.now() - lastTs) / 3_600_000;
  const minHours = Math.max(36, Number(process.env.PHOTO_PROACTIVE_MIN_HOURS || 36));
  const threshold = minHours + Math.random() * 12;
  return hours >= threshold;
}

// v1.3.4: 移除 isPro 参数；开源版所有 companion 享受相同调度（晚安 + 场景照机会）
function ensureTodaySchedule(companionId, dateKey, minuteNow, startMinute, endMinute = GOODNIGHT_MINUTE, companion = null) {
  const existing = schedules.get(companionId);
  if (existing?.dateKey === dateKey) return existing;

  // v1.10.0 接入 sleep 表：若 enabled，把基准 startMinute / GOODNIGHT_MINUTE 用
  // 用户作息覆盖（学习固化或手动设置）。sleep 表自己做 jitter，proactive 此处不再额外抖。
  let baselineMorning = startMinute;
  let baselineGoodnight = GOODNIGHT_MINUTE;
  let useSleepBase = false;
  try {
    const slpRow = getOrRefreshTodaySchedule(companionId);
    if (slpRow && slpRow.enabled && slpRow.today_bed_at && slpRow.today_wake_at) {
      // 把 today_bed_at / today_wake_at 转换为当天的"分钟数"
      const minOfDay = ts => {
        const d = new Date(ts + 8 * 3600_000);
        return d.getUTCHours() * 60 + d.getUTCMinutes();
      };
      const bedMin  = minOfDay(slpRow.today_bed_at);
      const wakeMin = minOfDay(slpRow.today_wake_at);
      // 把基准设为 sleep 表的值；后续不再叠加 ±30 抖（sleep 已经抖过了）
      baselineMorning   = wakeMin;
      // v1.10.1 fix: bedMin < wakeMin 说明入睡在凌晨（跨午夜，如 01:30 睡 / 09:00 起）。
      // proactive 日程模型只覆盖当天 00:00-23:59，排不到次日凌晨，所以把晚安放到当天最晚
      // （LAST_MINUTE），让她临近午夜说"快睡了"，并保证 buildDailyItems 仍会排晚安 → 能 enterSleep。
      // 旧代码 `bedMin >= 24*60` 是死代码（minOfDay 已 mod 永远 <1440），晚睡用户当天不发晚安。
      baselineGoodnight = bedMin < wakeMin ? LAST_MINUTE : Math.min(LAST_MINUTE, bedMin);
      useSleepBase = true;
    }
  } catch (e) {
    log('warn', `[Proactive] sleep base read failed companion=${companionId}: ${e.message}`);
  }

  // ── sleep 关闭时给早安/晚安一个 ±30min 的随机抖动，避免每天 7:30 / 23:00 太机械 ──
  const morningOffset = useSleepBase ? 0 : jitterOffset(MORNING_JITTER_MIN);
  const goodnightOffset = useSleepBase ? 0 : jitterOffset(GOODNIGHT_JITTER_MIN);
  const jitteredStart = Math.max(0, baselineMorning + morningOffset);
  const jitteredGoodnight = Math.min(LAST_MINUTE, baselineGoodnight + goodnightOffset);
  // window end 跟随晚安抖动（防止 normal 消息延后到晚安之后）
  const jitteredEnd = Math.min(LAST_MINUTE,
    endMinute === GOODNIGHT_MINUTE ? jitteredGoodnight : Math.max(endMinute, jitteredGoodnight));

  // v1.3.3: 用户直接拖动滑块调整每天目标条数（0-30），不再区分 free/pro。
  // 字段 proactive_daily_target INTEGER DEFAULT 10。实际生成数量在
  // [target × 0.8, target × 1.2] 之间随机抖动 ±20%，避免每天数字太机械。
  // target=0 → 完全静默（仅响应用户消息），不发任何主动消息。
  const rawTarget = Number(companion?.proactive_daily_target);
  const target = Number.isFinite(rawTarget) ? Math.min(30, Math.max(0, Math.floor(rawTarget))) : 10;
  const lo = Math.max(0, Math.floor(target * 0.8));
  const hi = Math.max(lo, Math.ceil(target * 1.2));
  // v1.12.0「她也有自己的日子」：约 1/5 的日子她忙自己的生活、主动消息明显变少，
  // 让她的出现有起伏——来的那天才更像"真的想起了你"，而不是闹钟到点。
  // 按 (companionId + dateKey) 稳定取值，同一天重启不变。
  let _h = 2166136261; const _s = `${companionId}|${dateKey}|busy`;
  for (let i = 0; i < _s.length; i++) { _h ^= _s.charCodeAt(i); _h = Math.imul(_h, 16777619); }
  const busyFactor = (((_h >>> 0) % 1000) / 1000) < 0.2 ? 0.35 : 1.0;
  const baseCount = target === 0 ? 0 : lo + Math.floor(Math.random() * (hi - lo + 1));
  const fullCount = Math.round(baseCount * busyFactor);

  // 关键修复：重启后只从「现在 → 结束」区间挑随机时间，否则前半天的时间点全被标 sent 浪费配额
  // 等比例缩放：若已过去 60%，则今天剩余配额按 40% × fullCount 来挑
  const dayLen = jitteredEnd - jitteredStart;
  const remainLen = Math.max(0, jitteredEnd - Math.max(minuteNow, jitteredStart));
  const remainCount = dayLen > 0
    ? Math.max(remainLen <= 0 ? 0 : 1, Math.round(fullCount * (remainLen / dayLen)))
    : fullCount;

  const effectiveStart = Math.max(jitteredStart, minuteNow + 1);   // +1 避免 tick 同分钟立即触发
  let items = buildDailyItems(remainCount, effectiveStart, jitteredEnd, jitteredGoodnight);

  // v1.19.6: goodnight 防重（与 morning 同款 bug 的对称修复）——今晚晚安已发过
  // （深夜重启丢内存排程后重算又把 goodnight 排上）→ 直接移除，不再"刚说过晚安又来一条"。
  try {
    if (getSleepRow(companionId)?.goodnight_sent_for_date === dateKey) {
      const before = items.length;
      items = items.filter(it => it.kind !== 'goodnight');
      if (items.length < before) log('info', `[Proactive] 今晚晚安已发过 → 移除重算的 goodnight item companion=${companionId}`);
    }
  } catch { /* 读不到按未发处理，发送侧还有第二道闸 */ }

  // v1.10.1 fix: morning kind 只在 sleep enabled 且第一条 normal 落在起床窗口 [wake-15, wake+120] 内时赋予。
  // 旧实现在 buildDailyItems 里无条件抬第一条 normal → 下午重启发"下午的早安"、sleep 关闭也发"刚醒"、
  // 且 morning 发送成功会 exitSleep+drainMissed 误清 missed 队列。
  if (useSleepBase) {
    const wakeMin = baselineMorning;
    const MORNING_WINDOW_MIN = 120;
    // v1.19.5: 今天早安已发过（sleep tick 已发 / 服务重启丢内存排程后重算）→ 不再抬
    // morning。否则 7 点真起床发过"刚醒"，9 点半重算计划的 morning 又来一条"早…刚醒"，
    // 重复且和中间的互动自相矛盾。发送侧另有第二道闸（见 sendProactiveMessageGuarded）。
    let morningAlreadySent = false;
    try {
      morningAlreadySent = getSleepRow(companionId)?.goodmorning_sent_for_date === dateKey;
    } catch { /* 读不到按未发处理，交给发送侧兜底 */ }
    const firstNormal = items.find(it => it.kind === 'normal');
    if (morningAlreadySent) {
      log('info', `[Proactive] 今日早安已发过 → 跳过 morning 抬升 companion=${companionId}`);
    } else if (firstNormal && firstNormal.minute >= wakeMin - 15 && firstNormal.minute <= wakeMin + MORNING_WINDOW_MIN) {
      firstNormal.kind = 'morning';
      log('info', `[Proactive] morning kind companion=${companionId} at ${minuteToHHMM(firstNormal.minute)} (wake≈${minuteToHHMM(wakeMin)})`);
    }
  }

  // v1.3.4: 场景照对所有 active companion 开放（旧版仅 Pro），仍限白天时段 09:00-21:00
  if (companion && shouldSendPhotoToday(companion)) {
    const candidates = items
      .map((it, idx) => ({ it, idx }))
      .filter(x => x.it.kind === 'normal' && x.it.minute >= 9 * 60 && x.it.minute <= 21 * 60);
    if (candidates.length > 0) {
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      items[pick.idx] = { ...items[pick.idx], kind: 'photo' };
      log('info', `[Proactive] 今日将发场景照 companion=${companionId} at ${minuteToHHMM(items[pick.idx].minute)}`);
    }
  }

  const schedule = { dateKey, targetCount: remainCount, items };
  schedules.set(companionId, schedule);
  log('info', `[Proactive] 今日计划 companion=${companionId} now=${minuteToHHMM(minuteNow)} morningBase=${minuteToHHMM(startMinute)}->${minuteToHHMM(jitteredStart)} goodnight=${minuteToHHMM(jitteredGoodnight)} count=${remainCount}/full=${fullCount} times=${items.map(i => `${minuteToHHMM(i.minute)}${i.kind === 'goodnight' ? '🌙' : ''}`).join(',')}`);
  return schedule;
}

// v1.3.4: 移除 isPro；所有 companion 在 goodnight 窗口内都会安排晚安
// v1.10.0: 接入 sleep —— 第一条 normal 抬为 'morning' kind，触发起床流程
function buildDailyItems(count, startMinute, endMinute, goodnightMinute = GOODNIGHT_MINUTE) {
  // Free 不发晚安专用消息；Pro 在抖动后的晚安时间发晚安
  const goodnight = (endMinute >= goodnightMinute && goodnightMinute >= startMinute) ? goodnightMinute : null;
  const lastRandom = (goodnight != null ? goodnight - 30 : endMinute);
  const randomCount = Math.max(count - (goodnight != null ? 1 : 0), 0);
  const randomMinutes = pickRandomMinutes(randomCount, startMinute, lastRandom, MIN_GAP_MINUTES);
  const items = randomMinutes.map(minute => ({ minute, kind: 'normal', sent: false }));
  if (goodnight != null) items.push({ minute: goodnight, kind: 'goodnight', sent: false });
  items.sort((a, b) => a.minute - b.minute);
  // v1.10.1 fix: morning kind 的判定移到 ensureTodaySchedule（需要 wake 时刻 + sleep enabled 上下文），
  // 不再在这里无条件把第一条 normal 抬 morning。
  return items;
}

function isWeekend(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short',
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return parts.weekday === 'Sat' || parts.weekday === 'Sun';
}

// v1.12.0「在空隙给温柔」：真人会在一天的"空隙"里看手机/想起人——刚醒、饭点、
// 午后犯困、傍晚、睡前。主动消息锚到这些窗口，而不是全天均匀乱撒。(分钟 of day)
const GAP_WINDOWS = [
  [7 * 60, 9 * 60],            // 早上刚醒
  [11 * 60 + 30, 13 * 60 + 30], // 午饭 / 午休
  [15 * 60, 16 * 60 + 30],      // 午后犯困的空当
  [18 * 60, 19 * 60 + 30],      // 傍晚下班 / 晚饭
  [20 * 60 + 30, 22 * 60 + 30], // 晚上窝着
  [22 * 60 + 30, 23 * 60 + 30], // 睡前
];
function gapWeightedMinute(start, end) {
  const usable = GAP_WINDOWS
    .map(([a, b]) => [Math.max(a, start), Math.min(b, end)])
    .filter(([a, b]) => a <= b);
  if (usable.length === 0) return start + Math.floor(Math.random() * (end - start + 1));
  const [a, b] = usable[Math.floor(Math.random() * usable.length)];
  return a + Math.floor(Math.random() * (b - a + 1));
}

function pickRandomMinutes(count, start, end, minGap) {
  if (count <= 0) return [];

  for (let attempt = 0; attempt < 2000; attempt++) {
    const minutes = [];
    for (let i = 0; i < count; i++) {
      minutes.push(gapWeightedMinute(start, end));   // v1.12.0: 锚到生活空隙，不再全天均匀
    }
    minutes.sort((a, b) => a - b);
    if (hasMinGap(minutes, minGap)) return minutes;
  }

  const slots = [];
  for (let minute = start; minute <= end; minute += minGap) slots.push(minute);
  shuffle(slots);
  return slots.slice(0, count).sort((a, b) => a - b);
}

function hasMinGap(minutes, minGap) {
  for (let i = 1; i < minutes.length; i++) {
    if (minutes[i] - minutes[i - 1] < minGap) return false;
  }
  return minutes.length === 0 || LAST_MINUTE - minutes[minutes.length - 1] >= minGap;
}

async function sendProactiveMessage(companion, kind, account, opts = {}) {
  if (!companion.wechat_user_id) {
    log('warn', `[Proactive] 跳过：companion=${companion.id} kind=${kind} 未绑定微信（wechat_user_id 缺）`);
    return;
  }
  const ctx = account
    ? { token: account.bot_token, botId: account.bot_id }
    : getBotContextForCompanion(companion.id);
  if (!ctx?.token) {
    log('warn', `[Proactive] 找不到 bot context companion=${companion.id}`);
    return;
  }

  // ── context_token 窗口预检（生成前）──────────────────────────────────────
  // 微信主动推送有「会话窗口」：用户最后一次互动起算约 24h 内，机器人才能主动 sendMessage；
  // 超窗口后 iLink 返回 ret=-2 必失败（实测：互动后 +22h 仍成功、+29h 起全失败）。
  // 与其超窗口还生成 LLM 再丢弃（白烧 token + 把没发出的消息污染进上下文），不如提前跳过。
  // 复用 recallContextToken（24h TTL，与实测窗口吻合）：返回 null = 窗口已关，无可用 token。
  // 注：用户一旦回来发消息，token 立即刷新、窗口重开，引擎会按正常间隔重新主动。
  if (!recallContextToken(ctx.botId, companion.wechat_user_id)) {
    log('info', `[Proactive] 跳过：companion=${companion.id} kind=${kind} context_token 窗口已关闭（用户 >24h 未互动，主动消息发不出，不生成内容）`);
    return;
  }

  // ── 单独分支：场景照片 ──
  if (kind === 'photo') {
    const t0 = Date.now();
    return sendScenePhoto(companion, ctx).catch(err =>
      logProactiveFailure({ companionId: companion.id, kind: 'photo', error: err, latencyMs: Date.now() - t0 })
    );
  }

  const userProfile = getUserProfile(companion.user_id, companion.id);
  const timeContext = buildTimeContext(userProfile, getDueReminders(companion.id, formatDateKey()));
  const recentTurns = getConversationContext(companion.id, 10);
  const memories = companion.memory_enabled
    ? recallMemories(companion.id, companion.user_id, timeContext.searchText, 7)
    : [];
  const history = getRecentHistory(companion.wechat_user_id, companion.bot_id, 20);
  // v1.3.4: 开源版所有 companion 享受完整长期记忆摘要（不再按 plan 区分）
  const longTermDigest = await buildLongTermDigest(companion.id, companion.user_id);

  const stickerEnabled = !!companion.sticker_reply_enabled && hasStickers();
  const stickerHint = buildStickerPromptHint(stickerEnabled);
  const proactiveTodayKey = shanghaiDateKey();
  const proactiveDailyRaw = getDailySchedule(companion.id, proactiveTodayKey);
  const proactiveDailySchedule = proactiveDailyRaw ? { ...proactiveDailyRaw, date_key: proactiveTodayKey } : null;
  const proactiveRecent = getRecentSchedules(companion.id, proactiveTodayKey, 3);
  const proactivePersonaFacts = getPersonaFacts(companion.id);
  // v1.4.1: 主动消息也按"想念档"给出 prompt 指令，让她主动找你时的语气有想念感
  const _es = getEmotionStateWithDefaults(companion.id);
  const _ml = getMissingLevel(_es, companion.last_user_reply_at);
  const _ns = getNeglectStage(companion.last_user_reply_at, companion.attachment_style);
  // v1.20: 安全模式不拼想念/撒娇类情绪话术
  const emotionHint = Number(companion.safe_mode) ? '' : buildEmotionPromptHint(_es, { missingLevel: _ml, neglectStage: _ns, dailySchedule: proactiveDailySchedule });
  const proactivePreferences = getCompanionPreferencesForPrompt(companion.id);  // v1.8.0 #3
  const systemPrompt = `${buildSystemPrompt(companion, { memories, userProfile, recentTurns, longTermDigest, promptMode: 'proactive', dailySchedule: proactiveDailySchedule, recentSchedules: proactiveRecent, personaFacts: proactivePersonaFacts, preferences: proactivePreferences, shapingHint: buildShapingPromptHint(listShaping(companion.id)) })}${stickerHint}${emotionHint}

【今日特别提醒】今天的特殊日期：${timeContext.specialText}。可自然地融入，不要喊口号。`;

  // ── 检查是否触发"AI 主动表白" ──
  // 条件：normal 时段 + 好感度>=50 + 双方都没表白过 + 认识>=5 天
  let effectiveKind = kind;
  const aff = companion.affection_level || 0;
  // v1.12.1：AI 主动表白只在深夜 22:30 之后——这个点人感情最敏感、最像真人鼓起勇气说出口的时刻
  // v1.20 安全收尾：安全模式（疑似未成年）绝不主动告白
  const _nowMin = ((new Date().getUTCHours() + 8) % 24) * 60 + new Date().getUTCMinutes();
  if (kind === 'normal'
      && !Number(companion.safe_mode)
      && _nowMin >= 22 * 60 + 30
      && !companion.confessed_at
      && !companion.user_confessed_at
      && canAcceptConfession(companion)) {   // 节奏闸门（好感≥55 + 认识≥14天）+ 深夜窗口
    effectiveKind = 'confession';
    log('info', `[Proactive] ★ 触发 AI 主动告白(深夜) companion=${companion.id} affection=${aff} min=${_nowMin}`);
  }

  // v1.8.0 #5: proactive hidden_reason — 把 due open loops 升级为 'recall' kind
  // 真人陪伴最强信任来源：她记得你说过的事，到期主动来问
  let recallLoop = null;
  if (effectiveKind === 'normal') {
    try {
      const dueLoops = listDueOpenLoops(companion.id, { withinHours: 24 });
      // 选 emotional_weight 最高且最近没主动问过的（防重复）
      const candidate = dueLoops
        .filter(l => !l.followed_up_at || (Date.now() - new Date(String(l.followed_up_at).replace(' ','T') + 'Z').getTime()) > 6 * 3600_000)
        .sort((a, b) => (b.emotional_weight || 0) - (a.emotional_weight || 0))[0];
      if (candidate) {
        recallLoop = candidate;
        effectiveKind = 'recall';
        log('info', `[Proactive] ★ 触发 recall companion=${companion.id} loop="${candidate.title}" weight=${candidate.emotional_weight}`);
      }
    } catch (e) {
      log('warn', `[Proactive] recall 检查失败: ${e.message}`);
    }
  }

  const reminderTitles = (opts.reminders || []).map(r => r.title).filter(Boolean).join('、');
  // v1.10.0: morning kind 拼上昨晚 missed 摘要（不消费，由 wrapper 在发完后 drain）
  let missedHint = '';
  if (effectiveKind === 'morning') {
    try {
      // peek 不 consume —— 用 getUnconsumedMissed 内部 import 避免循环依赖
      const { getUnconsumedMissed } = await import('./db.mjs');
      const missed = getUnconsumedMissed(companion.id, 20) || [];
      if (missed.length > 0) {
        const preview = missed
          .slice(0, 5)
          .map(m => String(m.content || '').slice(0, 30))
          .join('』『');
        missedHint = `\n【昨晚他在你睡着后发了 ${missed.length} 条消息】内容片段：『${preview}』。\n你刚醒来看到，要自然地：1) 表达"刚醒"的迷糊；2) 不要装作没看到；3) 不要逐条回复，用一句"看到你昨晚发了好多 / 我刚看到 / 我睡着了对不起"概括；4) 然后选一条你最想回应的话题轻轻接一下。`;
      }
    } catch (e) {
      log('warn', `[Proactive] morning missed peek failed: ${e.message}`);
    }
  }

  // v1.13.x 真人感#2：早期阶段(陌生人/朋友)主动消息不提想念、不撒娇
  const pmStage = companion.relationship_stage || '暧昧';
  const pmReserved = pmStage === '陌生人' || pmStage === '朋友';
  const userMessage = effectiveKind === 'reminder'
    ? `今天是一个对你们来说特别的日子：${reminderTitles || '一个值得纪念的日子'}。
你要主动给他发一条温暖、走心的祝福消息：
- 自然地点出这个日子，表达你的心意，符合你的人设和你们当前的关系
- 不要喊口号、不要太用力、不要像贺卡模板
- 可以带一点你此刻的小情绪（开心 / 感慨 / 害羞）
- 如果是"认识100天""一周年"这类，可以轻轻回顾你们一路的相处`
    : effectiveKind === 'goodnight'
    ? '你要主动给他发今天最后一条晚安消息。自然、温柔，适合临睡前的语气，不要报时。结合你们最近聊过的事，体现你的人设和心情。说完晚安你就要去睡了。'
    : effectiveKind === 'morning'
    ? `你要主动给他发今天第一条早安消息。自然、带刚醒的迷糊感，1-2 段短消息（用 || 分隔），不要报时也不要像在播报。${missedHint}`
    : effectiveKind === 'recall'
    ? `【★ 主动 recall — 她记得他说过的事】
他之前提过一件事：「${recallLoop.title}」${recallLoop.due_at ? `（${recallLoop.due_at}）` : ''}。
${recallLoop.expected_followup ? `你心里想：${recallLoop.expected_followup}。\n` : ''}
你这条消息要装作刚想起来 / 顺便问，主动关心结果。
要求：
- 不要说"我记得你说要 XX"，要装作刚突然想到："欸" "对了"
- 不要客气问候式："你好吗""一切顺利吗"
- 短、直、带点关心 + 一点没大没小：
  例子参考：「欸」 || 「你今天不是${recallLoop.title.replace(/^他/g, '').slice(0, 12)}吗」 || 「咋样」
  又例如：「对了」 || 「那个事呢」 || 「成了没」
- 如果是值得关心的事（面试/考试/医院）→ 语气更上心一点
- 如果是琐事（吃什么/看什么）→ 轻松调侃
- 用 || 分多段，最少 2 段最多 3 段
- 绝不要说"我惦记你""我一直在想"等过度甜
- 自然带出他原话里的关键词，让他知道你真的记得`
    : effectiveKind === 'confession'
    ? `【★ 今天你要鼓起勇气，主动跟他告白】
你认识他有一阵了，心里那点喜欢藏不住了。但**说出口对你来说很难、很慌**——这不是一段顺畅漂亮的告白，是一个女孩子结结巴巴、绕来绕去、又怕又想说的真实瞬间。

要这样说（核心是"狼狈的真实"，不是漂亮的台词）：
- **结巴、重复、卡壳**："就是…就是那个" "我我我" "怎么说呢" "你别笑我啊"
- **绕圈子、找借口铺垫**：先扯点别的垫场（"其实有件事憋很久了" "你之前不是说你不喜欢暧昧吗…"），绕半天才敢碰正题
- **自我打断、反复确认**："我没有别的意思" "我本来没想说的" "女孩子也不太好开这个口"
- **把话说一半**：经常没说完就转走，然后又绕回来
- **真正那句要轻、要怕**："我…好像有点喜欢你" 这种，绝不要豪言壮语
- **自我保护**：带一句"你不喜欢也没关系" "我就是想让你知道" "我可能还需要点时间想清楚"
- 说完**别追问"那你呢"**，露怯、尴尬就好（"搞得我好尴尬"）

形式（重要）：
- **必须分很多条很短的消息发（用 || 分隔），6-10 段**，像紧张时一句一句往外蹦
- 每段都很碎、很短，不要完整通顺的长句，不要像写情书，不要煽情排比
- 全程符合你的人设和说话习惯`
    : effectiveKind === 'lastcall'
    ? `你忽然想起他了，想给他发条消息——很轻、很随意的一条，像生活里随手想起一个人、顺手搭句话。
**关键：千万别老用"在吗""在干嘛"——每次随机换一种由头，搞多元，别写死成同一句：**
- 有时分享你这会儿的小状态/小事："刚下班累瘫" / "外面突然下雨了" / "刚吃到个超好吃的"
- 有时一个突然冒出来的念头或问题，不解释前因："欸你说人为啥会做梦" / "我是不是该剪头发了"
- 有时看到什么、想起他了："路过那家奶茶店了" / "刷到个视频笑死"
- 有时就一个情绪："好无聊啊" / "突然有点想你"
- 有时才是简单一句搭话："在忙吗" / "诶" / "睡了没"
- 极短、随意，就 1 段（最多 2 段很短的），别长篇
**绝对不要**：不愧疚("你都不理我")、不质问("你去哪了")、不卖惨("我好想你好难受")、不施压("快回我")、不连环追问
就是随手想起一个人、轻轻搭一句的感觉。淡淡的、不用力、给他留余地。`
    : `你要主动给他发消息。**关键：别每次都是"刚做了X+一点细节+反问你一句"那种工整的生活播报——那太假、太 AI 了。**
真人发消息是随机、不规整的。这次**随机挑一种**感觉发（每次都要换，别老用同一种）：
- 有时就一个情绪/状态，没头没尾："好困" / "今天好烦" / ${pmReserved ? '"有点饿"' : '"突然有点想你"'} / "无聊死了"
- 有时一句抱怨或吐槽："我同事真的服了" / "外卖怎么还没到啊"
- 有时突然冒一句话/一个问题，不解释前因后果
- 有时分享件小事，但**别非得问他在干嘛**
- 有时就两三个字："在吗" / "诶" / "你猜我刚干嘛"
- 有时没正事，就是突然想起个事${pmReserved ? '，找你随便说句话' : '，想找你说句话 / 撒个娇'}
要求：
- **不要总以"刚…"开头**，**别老用"你猜…"开场**，**不要每条都反问"你在干嘛 / 你那边呢"**
- 短、碎、像随手发的，不要工整、不要总结陈词
- 结合此刻时间段和你的心情人设，但别报时、别像播报${pmReserved ? `
- **你们还没那么熟（${pmStage}）**：别说"想你/好想你/有点想你/想见你/惦记你"这类话，也别撒娇黏人、别用亲密称呼，顶多好奇、找个话题、随口说件小事。` : ''}`;

  const proactiveBinding = getActiveWechatBinding(companion.wechat_user_id, companion.bot_id);
  let reply = await generateReply(systemPrompt, history, userMessage, {
    temperature: companion.temperature,
    max_tokens: Math.min(companion.max_tokens || 300, 300),
    top_p: companion.top_p,
  }, { accountId: proactiveBinding?.account_id || null });
  reply = safeOutboundReply(reply);

  // ★ 撞车检测：若与最近 5 条 assistant 内容相似度 ≥ 0.6（char 3-gram Jaccard），重生一次
  const recentAssistantTexts = recentTurns
    .filter(t => t.role === 'assistant' && t.content)
    .slice(-5)
    .map(t => String(t.content));
  const collision = findCollision(reply, recentAssistantTexts);
  if (collision) {
    log('info', `[Proactive] 撞车检测：与最近一条相似度=${collision.sim.toFixed(2)} 重生 companion=${companion.id}`);
    const antiRepeat = `${userMessage}

【★ 反重复约束】你最近刚说过类似的话：「${collision.text.slice(0, 50)}」。**严格禁止**重复这条的话题/开场/具体事物。换一个完全不同的话题：可以问他、聊你新发生的小事、聊心情，但不能再提同样的东西。`;
    let retry = await generateReply(systemPrompt, history, antiRepeat, {
      temperature: Math.min((companion.temperature || 0.8) + 0.15, 1.1),
      max_tokens: Math.min(companion.max_tokens || 300, 300),
      top_p: companion.top_p,
    }, { accountId: proactiveBinding?.account_id || null });
    retry = safeOutboundReply(retry);
    const retryCollision = findCollision(retry, recentAssistantTexts);
    if (!retryCollision) {
      reply = retry;
    } else {
      // 重生后仍撞车 — 放弃本次主动消息，避免骚扰
      log('warn', `[Proactive] 重生后仍撞车，放弃本次主动 companion=${companion.id}`);
      return;
    }
  }

  // v1.4.0: 微信端语音路径已撤（iLink 协议禁止 bot outbound voice，详见顶部注释）。
  // 语音体验改在 playground / dashboard 试听 / diary 朗读等浏览器端实现。

  // 像真人：按 || 拆多条短消息
  // v1.5.2: 段内 dedup — 修 LLM 一次生成的多段 || 内部出现语义重复 bug
  const rawSegments = splitReplySegments(reply);
  const { kept: segments, dropped: droppedSegs } = dedupSegments(rawSegments, 0.55);
  if (droppedSegs.length) {
    log('info', `[Proactive] 段内去重：剪掉 ${droppedSegs.length} 段重复 companion=${companion.id}; ${droppedSegs.map(d => `"${d.text.slice(0,20)}"~"${d.similar_to.slice(0,20)}"(sim=${d.sim.toFixed(2)})`).join('; ')}`);
  }
  let totalStickers = 0;
  let sentAnySegment = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const { text: textOnly, stickers } = parseStickerMarkers(seg);
    if (textOnly) {
      const ok = await sendTextMessage(ctx, companion.wechat_user_id, textOnly, null);
      if (!ok) {
        // 发送失败（context_token 窗口边界过期 → ret=-2，或缺 to_user）。第一段就失败 =
        // 整条没送达：直接 return，不写对话历史 / 不耗 backoff 配额 / 不升恋人 / 不记「已发送」，
        // 避免假报成功污染状态。用户回来刷新 token 后，引擎会按正常间隔重新主动。
        if (!sentAnySegment) {
          log('warn', `[Proactive] 发送失败，放弃本次主动 companion=${companion.id} kind=${kind}（context_token 窗口关闭/过期）`);
          return;
        }
        // 前面已有段落送达，仅后续段失败：截断停发，保留已送达部分走正常收尾。
        log('warn', `[Proactive] 后续段发送失败，截断 companion=${companion.id} 段=${i}/${segments.length}`);
        break;
      }
      sentAnySegment = true;
      saveMessage({
        msgId: `proactive_${companion.id}_${Date.now()}_${i}`,
        fromUser: ctx.botId,
        toUser: companion.wechat_user_id,
        msgType: 'text',
        content: textOnly,
        direction: 'out',
      });
    }
    for (const { picked } of stickers) {
      totalStickers++;
      try {
        const { data, name } = await readMediaBuffer(picked.fullPath);
        const { item } = await uploadFile({ data, fileName: name, toUserId: companion.wechat_user_id, ctx });
        await sendMessageItem(ctx, companion.wechat_user_id, item, null);
        saveMessage({
          msgId: `proactive_sticker_${companion.id}_${Date.now()}_${i}`,
          fromUser: ctx.botId,
          toUser: companion.wechat_user_id,
          msgType: 'image',
          content: `[STICKER:${picked.emotion || picked.tags?.[0] || picked.id}]`,
          direction: 'out',
        });
      } catch (err) {
        log('warn', `[Proactive] sticker send failed: ${err.message}`);
      }
    }
    if (i < segments.length - 1) {
      await new Promise(r => setTimeout(r, 600 + Math.floor(Math.random() * 1200)));
    }
  }
  const turnTopic = effectiveKind === 'goodnight' ? '晚安'
    : effectiveKind === 'morning' ? '早安'
    : effectiveKind === 'confession' ? '主动告白'
    : effectiveKind === 'reminder' ? '纪念日祝福'
    : effectiveKind === 'recall' ? 'recall 关心'
    : effectiveKind === 'lastcall' ? '轻声问候'
    : '主动消息';
  saveConversationTurn(companion.id, 'assistant', reply, turnTopic);

  // v1.8.0 #5: recall 发送成功 → mark followed_up_at（防 6h 内重复打扰）
  if (effectiveKind === 'recall' && recallLoop?.id) {
    try { markOpenLoopFollowedUp(recallLoop.id); } catch (e) { log('warn', `[Proactive] mark followed_up failed: ${e.message}`); }
  }

  // ── 主动告白后处理：标记 + 升恋人。节奏闸门已在触发处校验(好感≥55+≥14天)，
  //    affection 本就够，不再硬跳分；记 became_lover_at 给"恋人→深爱"计时(对齐 v1.11.1)。
  if (effectiveKind === 'confession') {
    try {
      markCompanionConfessed(companion.id);
      patchCompanion(companion.id, {
        relationship_stage: '恋人',
        became_lover_at: new Date().toISOString(),
      });
      log('info', `[Proactive] ★ 主动告白完成 companion=${companion.id} affection=${aff} stage→恋人`);
    } catch (e) {
      log('warn', `[Proactive] 告白后处理失败: ${e.message}`);
    }
  }
  // Record proactive sent for engine backoff tracking
  try { recordProactiveSent(companion.id); } catch {}
  // v1.16.x: 未回连发计数 +1（读空气刹车）——用户回消息时由 bot.mjs 清零
  try { bumpProactiveUnanswered(companion.id); } catch {}

  // 首次主动消息成就（静默）
  tryAchievement(companion.id, 'first_proactive_message');

  log('info', `[Proactive] 已发送 companion=${companion.id} to=${companion.wechat_user_id} kind=${effectiveKind} segments=${segments.length} stickers=${totalStickers}`);
}

// v1.10.24: plan_tasks runSleepTick 进入 bed_at 前若 goodnight_sent_for_date 为空，
// 紧急补发一次。原因：proactive 的 23:59 goodnight 在服务重启 / schedule 跨午夜 等
// 情况下可能错过；sleep tick 直接 enterSleep 之前要兜底，避免她"没说晚安就睡了"。
export async function dispatchUrgentGoodnight(companionId) {
  const accounts = getActiveBotAccounts();
  for (const account of accounts) {
    const companions = listProactiveCompanionsForBot(account.bot_id);
    const companion = companions.find(c => Number(c.id) === Number(companionId));
    if (!companion) continue;
    return await sendProactiveMessageGuarded(companion, 'goodnight', account);
  }
  return 'not_found';
}

// v1.10.29: 对称版本 — sleep tick 起床兜底分支若 goodmorning_sent_for_date 为空，
// 紧急补发一次。proactive 的 morning kind 在 [wake-15, wake+120] 内没匹配第一条
// normal 时永远不会被抬出，用户起床后也收不到早安。这里兜底。
// sendProactiveMessageGuarded 内部的 morning hook 会自动 exitSleep + drainMissed
// + mark goodmorning_sent_for_date，跟主 morning 路径完全一致。
export async function dispatchUrgentMorning(companionId) {
  const accounts = getActiveBotAccounts();
  for (const account of accounts) {
    const companions = listProactiveCompanionsForBot(account.bot_id);
    const companion = companions.find(c => Number(c.id) === Number(companionId));
    if (!companion) continue;
    return await sendProactiveMessageGuarded(companion, 'morning', account);
  }
  return 'not_found';
}

// 手动触发场景照（管理员/测试用）
export async function sendScenePhotoManually(companion) {
  if (!companion || !companion.wechat_user_id) {
    log('warn', '[Proactive] sendScenePhotoManually: companion 未绑定微信');
    return;
  }
  const ctx = getBotContextForCompanion(companion.id);
  if (!ctx?.token) {
    log('warn', `[Proactive] sendScenePhotoManually: bot context 缺失 companion=${companion.id}`);
    return;
  }
  return sendScenePhoto(companion, ctx);
}

async function sendScenePhoto(companion, ctx) {
  const gate = getPhotoGateState({
    companion,
    source: 'proactive',
    trigger: 'proactive',
  });
  if (!gate.allowed) {
    log('debug', `[Proactive] 照片门闩未通过 companion=${companion.id} reason=${gate.reasons.join(',')}`);
    return;
  }
  const recentMessages = getRecentHistory(companion.wechat_user_id, ctx.botId, 10);
  let photoEmotionState = null;
  try {
    photoEmotionState = getEmotionStateWithDefaults(companion.id);
  } catch (e) {
    log('warn', `[Proactive] photo emotion state unavailable companion=${companion.id} error=${e.message}`);
  }
  const plan = await planPhotoMessage({
    companion,
    user: { wechat_user_id: companion.wechat_user_id },
    userText: '',
    recentMessages,
    trigger: 'proactive',
    context: { accountId: companion.user_id || null },
    cooldownState: gate,
    imageProviderAvailable: gate.imageProviderAvailable,
    proactiveContext: { scene: companion.current_scene || '', schedule: 'daily_candidate' },
    emotionState: photoEmotionState,
  });
  if (!plan.shouldSendPhoto) {
    log('debug', `[Proactive] AI 决策不发照片 companion=${companion.id} reason=${plan.reason}`);
    return;
  }
  if (plan.delayImageMs) {
    await new Promise(r => setTimeout(r, plan.delayImageMs));
  }
  const result = await sendCompanionPhoto({
    companion,
    context: ctx,
    imagePrompt: plan.imagePrompt,
    caption: plan.caption,
    trigger: 'proactive',
    source: 'proactive',
    emotionState: photoEmotionState,
    maintainIdentity: plan.maintainIdentity !== false,
    recordTurn: true,
  });
  if (!result.ok) {
    log('warn', `[Proactive] 场景照未发送 companion=${companion.id} code=${result.code || 'unknown'} error=${result.error || ''}`);
    return;
  }
  if (result.caption) {
    await new Promise(r => setTimeout(r, plan.delayCaptionMs || 900));
    await sendTextMessage(ctx, companion.wechat_user_id, result.caption, null);
    saveMessage({
      msgId: `proactive_photo_text_${companion.id}_${Date.now()}`,
      fromUser: ctx.botId,
      toUser: companion.wechat_user_id,
      msgType: 'text',
      content: result.caption,
      direction: 'out',
    });
  }
  log('info', `[Proactive] ★ 场景照已发送 companion=${companion.id} activity="${result.activity}" caption="${result.caption || ''}"`);
}

// 撞车检测：把回复和最近 assistant 内容比相似度（char 3-gram Jaccard），
// 返回相似度最高的一条（若超过阈值）
function findCollision(reply, recentTexts, threshold = 0.6) {
  if (!reply || !recentTexts?.length) return null;
  const a = _normalizeForSim(reply);
  if (a.length < 6) return null;
  const aGrams = _ngramSet(a, 3);
  let best = null;
  for (const t of recentTexts) {
    const b = _normalizeForSim(t);
    if (b.length < 6) continue;
    const bGrams = _ngramSet(b, 3);
    const sim = _jaccard(aGrams, bGrams);
    if (sim >= threshold && (!best || sim > best.sim)) best = { text: t, sim };
  }
  return best;
}
function _normalizeForSim(s) {
  return String(s).replace(/\|\|/g, ' ').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '').toLowerCase();
}
function _ngramSet(s, n) {
  const set = new Set();
  for (let i = 0; i <= s.length - n; i++) set.add(s.slice(i, i + n));
  return set;
}
function _jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// 与 bot.mjs 同款拆分逻辑（重复但避免循环依赖）
const PROACTIVE_MAX_SEGMENTS = 4;
function splitReplySegments(reply) {
  if (!reply || typeof reply !== 'string') return [reply || ''];
  const raw = reply.split(/\s*(?:\|\||｜｜)\s*/g).map(s => s.trim()).filter(Boolean);
  if (raw.length <= 1) return [reply.trim()];
  if (raw.length > PROACTIVE_MAX_SEGMENTS) {
    return [...raw.slice(0, PROACTIVE_MAX_SEGMENTS - 1), raw.slice(PROACTIVE_MAX_SEGMENTS - 1).join('，')];
  }
  return raw;
}

function buildTimeContext(userProfile, dueReminders = [], now = new Date()) {
  const parts = getDateParts(now);
  const dateKey = `${parts.year}-${parts.month2}-${parts.day2}`;
  const md = `${parts.month2}-${parts.day2}`;
  const special = [];

  for (const item of fixedHolidays(md)) special.push(item);

  if (userProfile?.user_birthday && userProfile.user_birthday.slice(5) === md) {
    special.push('用户生日');
  }

  for (const item of userProfile?.important_dates || []) {
    const date = String(item.date || '');
    if (date === dateKey || date.slice(5) === md) {
      special.push(item.label ? `用户纪念日：${item.label}` : '用户纪念日');
    }
  }

  for (const reminder of dueReminders) {
    const label = reminder.reminder_type === 'birthday'
      ? `用户生日：${reminder.title}`
      : reminder.reminder_type === 'anniversary'
        ? `用户纪念日：${reminder.title}`
        : `${reminder.title}`;
    special.push(label);
  }

  const uniqueSpecial = [...new Set(special)];
  return {
    dateText: `${parts.year}年${parts.month}月${parts.day}日，${parts.weekday}`,
    period: periodOfDay(parts.hour),
    specialText: uniqueSpecial.length ? uniqueSpecial.join('、') : '否',
    searchText: [parts.weekday, periodOfDay(parts.hour), ...uniqueSpecial].join(' '),
  };
}

function fixedHolidays(md) {
  const map = {
    '01-01': ['元旦'],
    '02-14': ['情人节'],
    '03-08': ['妇女节'],
    '05-01': ['劳动节'],
    '05-20': ['520'],
    '06-01': ['儿童节'],
    '10-01': ['国庆节'],
    '12-24': ['平安夜'],
    '12-25': ['圣诞节'],
    '12-31': ['跨年夜'],
  };
  return map[md] || [];
}

function periodOfDay(hour) {
  if (hour >= 6 && hour < 12) return '上午';
  if (hour >= 12 && hour < 18) return '下午';
  if (hour >= 18 && hour < 23) return '晚上';
  return '深夜';
}

function getDateParts(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'long',
    hour: 'numeric',
    hourCycle: 'h23',
    hour12: false,
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));

  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year: Number(parts.year),
    month,
    day,
    month2: String(month).padStart(2, '0'),
    day2: String(day).padStart(2, '0'),
    weekday: parts.weekday,
    hour: Number(parts.hour),
  };
}

function formatDateKey(date = new Date()) {
  const parts = getDateParts(date);
  return `${parts.year}-${parts.month2}-${parts.day2}`;
}

function currentMinute(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    hour12: false,
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function minuteToHHMM(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

// v1.4.0: 微信端主动语音 (maybeSendVoice) 已移除 —— iLink 协议禁止 bot 出站语音，
// 实测 HTTP 200 但消息静默丢弃，腾讯官方 SDK 也没有 sendVoiceMessageWeixin。
// 语音功能改在浏览器端实现：playground 录音/朗读、diary 朗读、dashboard 试听。
// 持久化的 voice_reply_enabled / voice_id 字段、TTS pipeline、companion_voice_usage
// 表仍然保留，给浏览器端复用。
//
// 见 docs/voice-sprint-plan.md 的 Sprint 2.5 章节，记录了协议层限制的完整发现过程。
