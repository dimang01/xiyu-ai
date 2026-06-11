/**
 * 作息与睡眠系统（v1.10.0）
 *
 * 设计：
 *  - 每个 companion 有一份 companion_sleep_schedule。bed_time/wake_time 是 HH:MM
 *    上海时区。every day 的真实 today_bed_at/today_wake_at = base ± jitter_min。
 *  - 入睡时段内：bot 入口直接静默拦截，把消息塞进 companion_missed_messages。
 *    不发"正在输入"、不回复，从用户视角像真的睡了。
 *  - plan_tasks cron 每分钟 tick：检测每个 enabled companion，到 bed_at±2min
 *    推一条"晚安"主动消息；到 wake_at±2min 自动唤醒 + 起床早安（若有未读消息附上
 *    一句"你昨晚发了好多 || 我刚醒看到"）。
 *  - 用户在 dashboard 可以「📞 打电话叫醒她」：立刻 is_sleeping=0、emotion
 *    annoyance/anger+，AI 用 "被吵醒" prompt 生成一条短消息回执。
 *
 * 学习期（observing）：
 *  - 默认 bed=00:30 wake=07:30 jitter=30（v1.10.5: 23:00→00:30），但 user_set=0
 *    且 learn_state='observing'
 *    时每天记录用户的 first_msg / last_msg 上海时区时刻到 observed_samples_json。
 *  - 满 7 天样本后第 8 天 cron 自动固化：取最后消息时刻中位数为 bed_time，
 *    取首条消息时刻中位数为 wake_time（夹在合理区间内）。learn_state='locked'。
 *  - 用户手动改作息会立即 user_set=1 learn_state='locked'，停止学习。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import {
  ensureSleepRow, getSleepRow as _dbGetSleepRow, upsertSleepSchedule as _dbUpsertSleepSchedule,
  queueMissedMessage, getUnconsumedMissed, markMissedConsumed,
  shanghaiDateKey, listSleepRowsEnabled,
} from './db.mjs';

// 包一层导出，避免直接暴露 db 层 API
export const getSleepRow = _dbGetSleepRow;
export const upsertSleepSchedule = _dbUpsertSleepSchedule;
import { log } from './logger.mjs';

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // 上海固定 +08:00

// HH:MM → 当天上海时区的 ts(ms)，可跨日：bed 23:00 + wake 07:30 → 7:30 在 bed 之后的次日
function shanghaiTodayTsForHHMM(hhmm, baseDateKey) {
  // baseDateKey 形如 "2026-06-04"
  const [h, m] = String(hhmm || '0:0').split(':').map(n => parseInt(n, 10) || 0);
  // 构造 UTC 时刻 = 上海当天 0:00 - 8h，再加 hh:mm 偏移
  const [Y, M, D] = baseDateKey.split('-').map(n => parseInt(n, 10));
  const shanghaiMidnightMs = Date.UTC(Y, M - 1, D, 0, 0, 0) - TZ_OFFSET_MS;
  return shanghaiMidnightMs + h * 3600_000 + m * 60_000;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function pad2(n) { return String(n).padStart(2, '0'); }

function shanghaiHHMM(ts) {
  const d = new Date(ts + TZ_OFFSET_MS);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

// 解析 observed_samples_json 安全
function parseSamples(row) {
  try {
    const v = JSON.parse(row?.observed_samples_json || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

/**
 * 取/重算今天的 bed_at / wake_at（含 jitter）。如果 today_date != 今天就重算。
 * 返回 row（已刷新后）。
 */
export function getOrRefreshTodaySchedule(companionId, now = Date.now()) {
  const row = ensureSleepRow(companionId);
  const todayKey = shanghaiDateKey(new Date(now));
  if (row.today_date === todayKey && row.today_bed_at && row.today_wake_at) {
    return row;
  }
  // v1.10.6: 不对称抖动 —— 入睡偏晚（基准时间向前 15 / 向后 45 分钟），起床对称 ±10 分钟。
  // 用户在 dashboard 设的 bed/wake 是基准，每天在此基础上波动，模拟真人作息不机械。
  const randMin = (lo, hi) => (Math.floor(Math.random() * (hi - lo + 1)) + lo) * 60_000;
  const jitterBedMs  = randMin(-15, 45);
  const jitterWakeMs = randMin(-10, 10);

  let bedAt = shanghaiTodayTsForHHMM(row.bed_time, todayKey) + jitterBedMs;
  // 如果 bed_time < wake_time（如 22:00 / 07:30）说明跨天，wake 在 bed 后；
  // 如果 bed_time >= wake_time（如 02:00 / 07:30 倒挂）就把 bed 算成"昨天"的 bed。
  let wakeAt = shanghaiTodayTsForHHMM(row.wake_time, todayKey) + jitterWakeMs;
  if (wakeAt <= bedAt) {
    // wake 在次日：bed 23:00 → wake 07:30 跨天
    wakeAt += 24 * 3600_000;
  }
  // 如果当前已经是凌晨而上一晚还没结束（now < wakeAt 且 now < bedAt 但 now < wakeAt - 24h+something），
  // 把 bed/wake 推回到对应"昨晚~今早"区间。
  // 简化：如果 now < wakeAt 且 now < bedAt && wakeAt - bedAt < 24h，
  // 检查 (bedAt - 24h, wakeAt - 24h) 是不是包含 now，若是则用前一天的窗口。
  if (now < bedAt && now + 24 * 3600_000 < wakeAt) {
    bedAt -= 24 * 3600_000;
    wakeAt -= 24 * 3600_000;
  }

  return upsertSleepSchedule(companionId, {
    today_date: todayKey,
    today_bed_at: bedAt,
    today_wake_at: wakeAt,
  });
}

/**
 * 当前是否处于"睡眠中"。处于 [bedAt, wakeAt) 视为睡眠。
 */
export function isSleepingNow(companionId, now = Date.now()) {
  const row = getOrRefreshTodaySchedule(companionId, now);
  if (!row || !row.enabled) return false;
  if (!row.today_bed_at || !row.today_wake_at) return false;
  return now >= row.today_bed_at && now < row.today_wake_at;
}

/**
 * 标记进入睡眠（幂等）。返回是否本次新进入。
 */
export function enterSleep(companionId, now = Date.now()) {
  const row = ensureSleepRow(companionId);
  if (row.is_sleeping) return false;
  upsertSleepSchedule(companionId, { is_sleeping: 1, sleep_started_at: now });
  return true;
}

/**
 * 标记结束睡眠（幂等）。返回是否本次新离开。
 */
export function exitSleep(companionId) {
  const row = ensureSleepRow(companionId);
  if (!row.is_sleeping) return false;
  upsertSleepSchedule(companionId, { is_sleeping: 0 });
  return true;
}

// v1.10.6: 挽留延后参数（模拟真人"哎呀那再陪你一会"）
const PLEA_GRACE_MS = 30 * 60_000;   // 刚入睡 30min 内挽留有效；再晚就睡熟了，要打电话叫
const PLEA_EXTEND_MS = 20 * 60_000;  // 每次挽留续 20min 陪聊
function isPleaToStay(text) {
  return /陪陪|再陪|多陪|陪我|陪一?[会會]|别睡|別睡|不要睡|先别睡|别走|別走|等等|再聊|聊一?[会會]|留下|不困|再待|抱抱/.test(String(text || ''));
}

/**
 * 入口拦截：bot.mjs / playground 收到消息后调用。
 *   - 处于睡眠时段 → 入队 missed 表 + 返回 { blocked: true }
 *   - 刚入睡 grace 期 + 挽留词 → 延后入睡继续陪聊，返回 { blocked: false, reason: 'plea_to_stay' }
 *   - 否则 → 顺手记一笔学习样本 → { blocked: false }
 */
export function maybeSleepBlock({ companionId, msgType, content, receivedAt = Date.now() }) {
  try {
    const row = getOrRefreshTodaySchedule(companionId, receivedAt);
    if (!row.enabled) {
      recordUserActivitySample(companionId, receivedAt);
      return { blocked: false, reason: 'disabled' };
    }
    if (receivedAt >= row.today_bed_at && receivedAt < row.today_wake_at) {
      // 挽留延后：刚入睡 grace 期内 + 挽留词 → 延后 20min 继续陪聊
      const sinceBed = receivedAt - row.today_bed_at;
      if (sinceBed < PLEA_GRACE_MS && isPleaToStay(content)) {
        upsertSleepSchedule(companionId, { today_bed_at: receivedAt + PLEA_EXTEND_MS, is_sleeping: 0 });
        recordUserActivitySample(companionId, receivedAt);
        log('info', `[Sleep] 挽留延后 companion=${companionId} +${PLEA_EXTEND_MS / 60000}min`);
        return { blocked: false, reason: 'plea_to_stay' };
      }
      enterSleep(companionId, receivedAt);
      queueMissedMessage(companionId, { msgType, content, receivedAt });
      return { blocked: true, reason: 'sleeping' };
    }
    recordUserActivitySample(companionId, receivedAt);
    return { blocked: false };
  } catch (e) {
    log('warn', `[Sleep] maybeSleepBlock failed companion=${companionId}: ${e.message}`);
    return { blocked: false, reason: 'error' };
  }
}

/**
 * 记录学习样本：每天用户首条/末条消息时间。
 * locked 状态下也照样记（便于日后重学）。
 */
export function recordUserActivitySample(companionId, ts) {
  const row = ensureSleepRow(companionId);
  const samples = parseSamples(row);
  const dateKey = shanghaiDateKey(new Date(ts));
  const hhmm = shanghaiHHMM(ts);
  let entry = samples.find(s => s.date === dateKey);
  if (!entry) {
    entry = { date: dateKey, first_msg: hhmm, last_msg: hhmm };
    samples.push(entry);
  } else {
    if (hhmm < entry.first_msg) entry.first_msg = hhmm;
    if (hhmm > entry.last_msg)  entry.last_msg  = hhmm;
  }
  // 只保留最近 14 天
  samples.sort((a, b) => a.date.localeCompare(b.date));
  while (samples.length > 14) samples.shift();
  upsertSleepSchedule(companionId, { observed_samples_json: JSON.stringify(samples) });
}

function hhmmToMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(n => parseInt(n, 10) || 0);
  return h * 60 + m;
}
function minToHHMM(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}

/**
 * 学习期满 7 天后固化：算 last_msg 中位数 → bed_time（再 +30min "她真睡前"缓冲），
 * first_msg 中位数 → wake_time（再 -10min "她在你起之前起" 缓冲）。
 * 夹合理区间：bed 21:00-02:30，wake 06:00-11:30。
 */
export function tryLockSchedule(companionId, now = Date.now()) {
  const row = ensureSleepRow(companionId);
  if (row.user_set) return { locked: false, reason: 'user_set' };
  if (row.learn_state === 'locked') return { locked: false, reason: 'already_locked' };
  const samples = parseSamples(row);
  if (samples.length < 7) return { locked: false, reason: `need_samples ${samples.length}/7` };
  // 用最近 7 天
  const recent = samples.slice(-7);
  const lastMins  = recent.map(s => hhmmToMin(s.last_msg));
  // 处理跨午夜：last_msg 在 0:00-04:00 也算"昨晚"，加 1440 避免拉低中位数
  const lastMinsAdj = lastMins.map(m => (m < 4 * 60 ? m + 1440 : m));
  const firstMins = recent.map(s => hhmmToMin(s.first_msg));

  let bedMin  = median(lastMinsAdj);    // 比如 23:42 → 23:42（不调），02:10 → 26:10
  let wakeMin = median(firstMins);      // 比如 08:05
  // 缓冲：她比你早起 10min、比你晚睡 30min
  bedMin  = bedMin  + 30;
  wakeMin = wakeMin - 10;

  // 夹合理区间
  const bedLo  = 21 * 60,         bedHi  = 26 * 60 + 30;    // 21:00 - 次日 02:30
  const wakeLo = 6 * 60,          wakeHi = 11 * 60 + 30;    // 06:00 - 11:30
  bedMin  = clamp(bedMin,  bedLo,  bedHi);
  wakeMin = clamp(wakeMin, wakeLo, wakeHi);

  const bedHHMM  = minToHHMM(bedMin);
  const wakeHHMM = minToHHMM(wakeMin);

  upsertSleepSchedule(companionId, {
    bed_time: bedHHMM,
    wake_time: wakeHHMM,
    learn_state: 'locked',
    // 重置今日 cache 让下次 tick 重算
    today_date: null,
    today_bed_at: null,
    today_wake_at: null,
  });
  log('info', `[Sleep] learn locked companion=${companionId} bed=${bedHHMM} wake=${wakeHHMM} (from ${recent.length} days)`);
  return { locked: true, bed_time: bedHHMM, wake_time: wakeHHMM };
}

/**
 * 用户在 dashboard 设作息：立即 user_set=1, learn_state=locked。
 */
export function setUserSchedule(companionId, { bed_time, wake_time, jitter_min, enabled }) {
  const updates = {};
  if (bed_time)  updates.bed_time = String(bed_time).slice(0, 5);
  if (wake_time) updates.wake_time = String(wake_time).slice(0, 5);
  if (jitter_min !== undefined) updates.jitter_min = clamp(parseInt(jitter_min, 10) || 0, 0, 90);
  if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;
  // 校验 HH:MM 格式
  for (const k of ['bed_time', 'wake_time']) {
    if (updates[k] && !/^\d{1,2}:\d{2}$/.test(updates[k])) {
      throw new Error(`invalid time format: ${k}=${updates[k]}`);
    }
  }
  updates.user_set = 1;
  updates.learn_state = 'locked';
  // 重置今日 cache 让下次 tick 重算
  updates.today_date = null;
  updates.today_bed_at = null;
  updates.today_wake_at = null;
  return upsertSleepSchedule(companionId, updates);
}

/**
 * 重置学习：删除 user_set，learn_state 回 observing，清空样本。
 */
export function resetLearn(companionId) {
  return upsertSleepSchedule(companionId, {
    user_set: 0,
    learn_state: 'observing',
    observed_samples_json: '[]',
    today_date: null,
    today_bed_at: null,
    today_wake_at: null,
  });
}

/**
 * 打电话叫醒。返回结构告诉调用方应该让 AI 用什么 prompt 生成回执。
 */
export function wakeUpByCall(companionId, now = Date.now()) {
  const row = ensureSleepRow(companionId);
  if (!row.is_sleeping) {
    return { ok: false, code: 'not_sleeping', message: '她现在醒着，不用打电话叫她哦' };
  }
  const wokenToday = (Number(row.woken_today) || 0) + 1;
  upsertSleepSchedule(companionId, {
    is_sleeping: 0,
    woken_today: wokenToday,
    last_woken_at: now,
  });
  return {
    ok: true,
    woken_today: wokenToday,
    prompt_hint: buildWakePromptHint(wokenToday, row),
  };
}

function buildWakePromptHint(wokenToday, row) {
  const fragments = [
    '【场景】他刚刚打电话把你吵醒了。你正在熟睡。',
    '【你的反应】带睡意 + 不耐烦的真实反应：声音含糊、有起床气、可能抱怨"几点了""你干嘛吵我"，但不要骂人。',
    '【口吻】≤20 字，1-2 条短消息，第二条可以是"…困" "…几点啊" "…让我再睡会儿" 这种。',
    '【禁止】不要立刻热情；不要长段问候；不要"你怎么了？发生什么了？" —— 是你被吵醒不是她。',
  ];
  if (wokenToday >= 2) fragments.push(`【今天第 ${wokenToday} 次被叫醒】明显更烦，语气更冲，可以说"又是你""能不能让我睡"。`);
  return fragments.join('\n');
}

/**
 * 起床后取出未读消息并标记 consumed。
 */
export function drainMissed(companionId) {
  const rows = getUnconsumedMissed(companionId, 50);
  if (rows.length) markMissedConsumed(companionId);
  return rows;
}

/**
 * 返回给前端的状态视图
 */
export function getSleepStatus(companionId, now = Date.now()) {
  const row = getOrRefreshTodaySchedule(companionId, now);
  const sleeping = isSleepingNow(companionId, now);
  const samples = parseSamples(row);
  return {
    enabled: !!row.enabled,
    bed_time: row.bed_time,
    wake_time: row.wake_time,
    jitter_min: row.jitter_min,
    user_set: !!row.user_set,
    learn_state: row.learn_state,
    learn_samples: samples.length,
    today_bed_at: row.today_bed_at,
    today_wake_at: row.today_wake_at,
    is_sleeping: !!sleeping,
    woken_today: row.woken_today || 0,
    last_woken_at: row.last_woken_at || null,
  };
}

export function listEnabledRows() {
  return listSleepRowsEnabled();
}
