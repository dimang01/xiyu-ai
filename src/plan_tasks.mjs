/**
 * 用户分级长期记忆任务
 *
 * 时间表（上海时区）：
 *   每天 02:00  → 对所有 active 人设生成"昨日总结"，保留最近 60 天 daily_summary
 *   每周日 02:30 → 把上周 7 天 daily_summary 合并成 weekly_summary
 *   每月 1 号 03:00 → 把上月所有 weekly_summary 合并成 monthly_summary
 *
 * v1.3.4: 开源版无套餐分级，所有 active companion 一视同仁参与所有任务。
 *
 * 双层存储：
 *   1. companion_memories 表：供 AI 实时召回（速度快）
 *   2. <DATA_DIR>/user_memories/<companion_id>/{daily|weekly|monthly}/<date>.md
 *      供运维/审阅/备份；同时 buildLongTermDigest() 也会从这里读取
  *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupPlanMemories, getAllActiveCompanions, getConversationTurnsBetween,
  saveMemory, summaryMemoryExists, getDb, shanghaiDateKey, shanghaiBoundsForDateKey,
  getRecentSummaries,
  saveDailySchedule, getDailySchedule,
  listEpisodicMemoriesOlderThan, deleteMemoriesByIds,   // v1.9.8 老记忆压缩
  cleanupProcessedMessages,                              // Issue #1 去重表清理
  cleanupAiUsageEvents,                                  // P1-7 成本明细清理
  getActiveCurrentWorks,                                 // v1.21.4 PR-W5 日程结构化：消费 works 档案
} from './db.mjs';
import { applyMemoryDecayBatch } from './memory_v2.mjs';
import { runDailyReflectionForCompanion, runWeeklyReflectionForCompanion } from './reflection.mjs';
import { formatReflectionRollup } from './reflection_heartbeat.mjs';
import { generateDailyDiaryForCompanion, generateWeeklyDiaryForCompanion } from './diary.mjs';
import { generateDailyThoughtForCompanion } from './thoughts.mjs';
import { openMaturedCapsulesBatch } from './time_capsule.mjs';
import { runRelationalDiariesBatch } from './relational_diary.mjs';
import { runEmotionRecalcBatch } from './emotion_state.mjs';
import { runArcTimeTickBatch } from './relationship_arc_runtime.mjs';
import { checkProactiveDeadman } from './proactive_deadman.mjs';
import { refreshCurrentWorks, buildScheduleWorksHint } from './current_works.mjs';   // v1.21.4 PR-W1 换档 / W5 日程消费档案
import { refreshLifeState } from './life_state.mjs';   // v1.22 PR-L1 身体状态档案推进/归档
import { generateReply, extractStructuredInfo, embedText } from './ai.mjs';
import { log } from './logger.mjs';
import { tryAchievement } from './achievements.mjs';
import {
  listEnabledRows as listSleepEnabled,
  getOrRefreshTodaySchedule,
  enterSleep,
  exitSleep,
  tryLockSchedule,
} from './sleep.mjs';
import { dispatchUrgentGoodnight, dispatchUrgentMorning } from './proactive.mjs';

const TZ = 'Asia/Shanghai';
const TICK_MS = 60_000;
const ran = new Set();

const MEMORY_ROOT = process.env.USER_MEMORIES_DIR
  || path.resolve(process.cwd(), 'data', 'user_memories');

export function startPlanTasks() {
  log('info', '[PlanTasks] 用户分级定时任务启动');
  tick().catch(err => log('error', `[PlanTasks] tick 异常: ${err.message}`));
  return setInterval(() => {
    tick().catch(err => log('error', `[PlanTasks] tick 异常: ${err.message}`));
  }, TICK_MS);
}

async function tick(now = new Date()) {
  const parts = shanghaiParts(now);
  // 00:30 — 为每个 companion 生成今日日程
  await runOnce(parts, 'daily-schedule', parts.hour === 0 && parts.minute === 30, () => runDailySchedules(parts.dateKey, parts.weekdayLabel, parts.weekday));
  // 02:00 — 所有人的日总结 + 清理
  await runOnce(parts, 'daily-summary', parts.hour === 2 && parts.minute === 0, () => runDaily(parts.dateKey));
  // 周日 02:30 — Pro 周总结
  await runOnce(parts, 'weekly-summary', parts.weekday === 0 && parts.hour === 2 && parts.minute === 30, () => runWeekly(parts.dateKey));
  // 每月 1 号 03:00 — Pro 月总结
  await runOnce(parts, 'monthly-summary', parts.day === 1 && parts.hour === 3 && parts.minute === 0, () => runMonthly(parts.dateKey));
  // 每小时整点 — 数据库清理（过期 session / 旧验证码记录 / 历史消息）
  await runOnce(parts, `cleanup-${parts.hour}`, parts.minute === 5, () => runHourlyCleanup());
  // 23:30 — 把今日日程中 importance>=6 的项归档为长期记忆
  await runOnce(parts, 'archive-schedule', parts.hour === 23 && parts.minute === 30, () => runArchiveDailySchedule(parts.dateKey));
  // 03:20 — 记忆衰减写回
  await runOnce(parts, 'memory-decay', parts.hour === 3 && parts.minute === 20, () => runMemoryDecay());
  // v1.8.0 #4: 03:30 — 清理过期 stale open loops
  await runOnce(parts, 'cleanup-stale-loops', parts.hour === 3 && parts.minute === 30, async () => {
    const m = await import('./open_loops.mjs');
    m.cleanupStaleOpenLoops();
  });
  // 02:15 — 每日反思（在 daily summary 后运行）
  await runOnce(parts, 'daily-reflection', parts.hour === 2 && parts.minute === 15, () => runDailyReflections(parts.dateKey));
  // 周日 02:45 — 每周反思
  await runOnce(parts, 'weekly-reflection', parts.weekday === 0 && parts.hour === 2 && parts.minute === 45, () => runWeeklyReflections(parts.dateKey));
  // 02:20 — 每日日记（在反思 02:15 之后，复用同一批昨日对话）
  await runOnce(parts, 'daily-diary', parts.hour === 2 && parts.minute === 20, () => runDailyDiaries(parts.dateKey));
  // 周日 02:50 — 每周日记（紧随每周反思）
  await runOnce(parts, 'weekly-diary', parts.weekday === 0 && parts.hour === 2 && parts.minute === 50, () => runWeeklyDiaries(parts.dateKey));
  // v1.4.1: 02:35 — 「她今天想对你说的话」（紧跟日记，复用情绪 + 近 3 天对话）
  await runOnce(parts, 'daily-thought', parts.hour === 2 && parts.minute === 35, () => runDailyThoughts(parts.dateKey));
  // v1.5: 每小时第 10 分钟 — 扫描所有到期未开封的时光胶囊，让"现在的她"写感想
  await runOnce(parts, `time-capsules-${parts.hour}`, parts.minute === 10, () => openMaturedCapsulesBatch({ limit: 20 }));
  // v1.5: 02:25 — 反向日记（紧跟内省日记 02:20，复用昨日对话窗口）
  await runOnce(parts, 'relational-diary', parts.hour === 2 && parts.minute === 25, () => runRelationalDiariesBatch());
  // v1.5.2: 每半小时（:00 和 :30）— 7 维情绪定时重算（pure rule，0 LLM 成本）
  // 让"她想你的程度"即使在用户不发消息时也按现实时间推进。
  await runOnce(parts, `emotion-tick-${parts.hour}-${parts.minute}`,
    parts.minute === 0 || parts.minute === 30,
    () => runEmotionRecalcBatch());

  // v1.21: 冲突弧时间结算搭同一节奏的便车（neglect 升级 / cold 超时 / withdrawing
  // 硬上限 / scar 淡出都在这结算；消息到来时 bot.mjs 还会即时结算一次，无空窗）
  await runOnce(parts, `arc-tick-${parts.hour}-${parts.minute}`,
    parts.minute === 0 || parts.minute === 30,
    () => runArcTimeTickBatch());

  // v1.21.2 (#263 后续)：proactive 死人开关——每小时 :50 心跳。活跃用户>0 但
  // proactive 成功=0 连续 2 周期 → CRITICAL + 运维邮件。纯报警零自愈，fail-open。
  await runOnce(parts, `deadman-${parts.hour}`, parts.minute === 50,
    () => checkProactiveDeadman());

  // v1.10.0 sleep tick：每分钟跑（轻量，no LLM）
  try {
    runSleepTick(now, parts);
  } catch (e) {
    log('warn', `[Sleep] tick failed: ${e.message}`);
  }
}

// ─── v1.10.0 sleep ─────────────────────────────────────────────────────────
function runSleepTick(now) {
  const nowMs = now.getTime();
  const rows = listSleepEnabled();
  for (const row of rows) {
    try {
      // 重算今日 bed/wake（若已是今天则不动）
      const fresh = getOrRefreshTodaySchedule(row.companion_id, nowMs);
      // 0) 到点入睡：now 进入睡眠窗口且还没睡 → enterSleep。睡前晚安由 proactive goodnight
      //    先发（约 bed 前），这里才真正开始拦截，中间留出挽留窗口。
      if (!fresh.is_sleeping && fresh.today_bed_at && fresh.today_wake_at
          && nowMs >= fresh.today_bed_at && nowMs < fresh.today_wake_at) {
        // v1.10.24 兜底：proactive 在 23:59 没发出晚安（服务重启 / schedule 跨午夜
        // 等情况）就直接进了 bed_at → 用户感知"没说晚安就睡了"。先 fire-and-forget
        // 紧急补发，再 enterSleep，体感"她说了晚安后入睡"。
        const todayKey = shanghaiDateKey(now);
        if (fresh.goodnight_sent_for_date !== todayKey) {
          dispatchUrgentGoodnight(row.companion_id)
            .then(r => log('info', `[Sleep] urgent goodnight companion=${row.companion_id} result=${r}`))
            .catch(e => log('warn', `[Sleep] urgent goodnight failed companion=${row.companion_id}: ${e.message}`));
        }
        enterSleep(row.companion_id, nowMs);
        log('info', `[Sleep] enterSleep at bed_at companion=${row.companion_id}`);
      }
      // 1) 起床兜底：今天 wake 已过 + 还标记 is_sleeping → 强制 exit
      //    （proactive morning kind 通常已经 exitSleep；这里救场 proactive 失败/disabled 的情况）
      if (fresh.is_sleeping && fresh.today_wake_at && nowMs >= fresh.today_wake_at + 5 * 60_000) {
        // v1.10.29 兜底（对称 goodnight v1.10.24）：proactive morning 没在
        // [wake-15, wake+120] 内匹配第一条 normal 时不会被抬出，用户起床收不到早安。
        // 进入 fallback exitSleep 前先 fire-and-forget 紧急补发 morning；
        // morning hook 自己会 exitSleep + drainMissed + 标 goodmorning_sent_for_date。
        const todayKey = shanghaiDateKey(now);
        if (fresh.goodmorning_sent_for_date !== todayKey) {
          dispatchUrgentMorning(row.companion_id)
            .then(r => log('info', `[Sleep] urgent morning companion=${row.companion_id} result=${r}`))
            .catch(e => log('warn', `[Sleep] urgent morning failed companion=${row.companion_id}: ${e.message}`));
        }
        exitSleep(row.companion_id);
        log('info', `[Sleep] fallback exitSleep companion=${row.companion_id} (no morning sent within 5min of wake)`);
      }
      // 2) 学习固化：每天 03:40 cron 时尝试（避开高峰）
      if (now.getHours() === 3 && now.getMinutes() === 40) {
        tryLockSchedule(row.companion_id, nowMs);
      }
    } catch (e) {
      log('warn', `[Sleep] tick companion=${row.companion_id}: ${e.message}`);
    }
  }
}

// ─── 日程归档为记忆 ─────────────────────────────────────────────────────────
async function runArchiveDailySchedule(dateKey) {
  const db = getDb();
  const companions = db.prepare(`
    SELECT c.id, c.user_id, c.name
    FROM companions c
    JOIN users u ON u.id = c.user_id
    JOIN wechat_accounts wa ON wa.wechat_user_id = u.wechat_user_id
    WHERE wa.is_active = 1
  `).all();
  let total = 0;
  for (const c of companions) {
    const sched = getDailySchedule(c.id, dateKey);
    if (!sched || !Array.isArray(sched.items)) continue;
    const important = sched.items.filter(it => (it.importance || 0) >= 6);
    if (important.length === 0) continue;
    for (const it of important) {
      try {
        const content = `${dateKey} ${it.time} ${it.activity}`.slice(0, 60);
        const embedding = await embedText(content);
        saveMemory({
          companionId: c.id,
          userId: c.user_id,
          memoryType: 'event',
          content,
          importance: it.importance,
          embedding,
          // 不 pin 日程类记忆（仅大事件 importance>=9 才自动 pin via saveMemory 默认逻辑）
        });
        total++;
      } catch (e) {
        log('warn', `[ArchiveSchedule] companion=${c.id} item="${it.activity}" fail: ${e.message}`);
      }
    }
  }
  log('info', `[ArchiveSchedule] ${dateKey} 归档 ${total} 条日程记忆 across ${companions.length} companions`);
}

// ─── 今日日程生成 ───────────────────────────────────────────────────────────
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

async function runDailySchedules(dateKey, weekdayLabel, weekdayNum) {
  const db = getDb();
  const companions = db.prepare(`
    SELECT c.id, c.user_id, c.name, c.age, c.role_title, c.personality_tags, c.hobbies, c.safe_mode
    FROM companions c
    JOIN users u ON u.id = c.user_id
    JOIN wechat_accounts wa ON wa.wechat_user_id = u.wechat_user_id
    WHERE wa.is_active = 1
  `).all();
  log('info', `[DailySchedule] 准备为 ${companions.length} 个 companion 生成日程 date=${dateKey} weekday=${weekdayLabel}`);
  for (const comp of companions) {
    // v1.21.4 PR-W5: 先换档+进度推进 works 档案，再生成日程——让本日日程消费「刚刷新的」
    // 档案（书名/进度最新、完结的已换新书）。W1 原是日程后搭便车换档；W5 提前到日程前，
    // 因为日程要结构化消费档案（§7 进行中），档案必须先就位。fail-open 绝不阻断日程。
    try {
      const r = await refreshCurrentWorks(comp);
      if (r.added || r.finished || r.dropped || r.progressed) log('info', `[CurrentWorks] companion=${comp.id} 完结${r.finished}/弃${r.dropped}/新建${r.added}(${r.statusOfAdded || '-'})/进度推进${r.progressed}`);
    } catch (e) {
      log('warn', `[CurrentWorks] 换档失败 companion=${comp.id}: ${e.message}`);
    }
    // v1.22 PR-L1 引擎推进/归档 + PR-L2 period onset（成年门控 + 周期窗口建档），搭同一日程批
    // 便车（不新增定时器）。传 comp 对象（含 age/safe_mode/role/personality）做成年门控；
    // **onset 只建档案、零情绪副作用**（情绪路由=L3）。refreshLifeState 内部 fail-open。
    refreshLifeState(comp);
    try {
      await generateScheduleFor(comp, dateKey, weekdayLabel, weekdayNum);
    } catch (e) {
      log('warn', `[DailySchedule] companion=${comp.id} 失败: ${e.message}`);
    }
  }
}

async function generateScheduleFor(comp, dateKey, weekdayLabel, weekdayNum) {
  const personality = (() => {
    try { return JSON.parse(comp.personality_tags || '[]').join('、'); } catch { return ''; }
  })();
  const hobbies = (() => {
    try { return JSON.parse(comp.hobbies || '[]').join('、'); } catch { return ''; }
  })();

  const age = comp.age || 22;
  const isWeekend = weekdayNum === 0 || weekdayNum === 6;
  const occupationHint = ageOccupationHint(age, isWeekend, comp.role_title);

  // v1.12.0「她有自己的连续生活线」：把昨天日程里值得延续的事喂进来，让今天不是全新的人和事
  let continuityHint = '';
  try {
    const y = getDailySchedule(comp.id, addDays(dateKey, -1));
    const threads = (y?.items || [])
      .filter(it => (it.importance || 0) >= 5)
      .map(it => it.activity).filter(Boolean).slice(0, 5);
    if (threads.length) {
      continuityHint = `
【延续生活线 - 重要】你昨天的生活里有这些事：${threads.join('；')}。
今天的日程要**自然延续其中 1-2 条**，让你的生活有惯性、像真的在过日子：
- 该有后续的给后续（追的剧今天看到第几集、闺蜜那事后来怎样、没做完的接着做）
- 该收尾的收尾、该换的自然换（剧追完了、烦心事解决了换件新的）
- 别整天都是全新的人和全新的事，那样不像一个真实在生活的人`;
    }
  } catch { /* 拿不到昨天就正常生成 */ }

  // v1.21.4 PR-W5：日程结构化消费 works 档案——日程里「读书/看番/打游戏/做手工」类
  // 活动必须引用档案真实条目（杜绝日程层重新漂移出档案外书名）。fail-open。
  let worksScheduleHint = '';
  try { worksScheduleHint = buildScheduleWorksHint(getActiveCurrentWorks(comp.id)); }
  catch (e) { log('warn', `[CurrentWorks] 日程 works hint 失败 companion=${comp.id}: ${e.message}`); }

  const sys = `你帮一个虚拟角色生成"今天的日程"，要符合人设、真实可信、有生活气息。

角色：${comp.name}，${age}岁，${comp.role_title || '邻家女孩'}${personality ? '，性格' + personality : ''}${hobbies ? '，爱好：' + hobbies : ''}
今天日期：${dateKey} ${weekdayLabel}（${isWeekend ? '周末' : '工作日'}）

【强制约束 - 极其重要】
${occupationHint}
${continuityHint}
${worksScheduleHint}

【风格要求】
- 输出 8-12 个时间点，覆盖从 07:00 到 23:30
- 活动描述 8-18 字要具体（"和同桌分享便当里的玉子烧" 不是 "和朋友吃饭"）
- 不要剧透爱情/情感事件，不要提到"对方/他聊天"
- 要符合${isWeekend ? '周末' : '工作日'}的节奏
- 不同年龄段不同活动：学生别去酒吧，上班族别去操场跑圈

每个 item 必须有 importance 字段（1-10）：
- 9-10：标志性事件（考试 / 面试 / 生日 / 重要约会）
- 7-8：值得提起的事（学了新东西 / 看了一部好电影 / 朋友间发生的事）
- 5-6：日常但有信息（午餐吃了什么 / 看了什么剧）
- 3-4：例行公事（上课 / 通勤）
- 1-2：纯流水账（起床洗漱）

【情绪段】mood_segments 三段：morning（07:00-12:00）/ afternoon（12:00-18:00）/ evening（18:00-23:30）
每段写一句 15-25 字描述这个时段的内心状态，要和日程衔接。

严格输出 JSON：
{
  "items": [
    {"time": "07:30", "activity": "描述", "importance": 4},
    ...
  ],
  "mood_arc": "今天整体感受（30字内）",
  "mood_segments": {
    "morning": "早晨这段的心情描述",
    "afternoon": "下午这段的心情描述",
    "evening": "晚上这段的心情描述"
  }
}`;

  // 给足 max_tokens — 中文日程 8-12 项 + 情绪段，400 token 常被截断
  const raw = await extractStructuredInfo(sys, '生成今天的日程 JSON', { maxTokens: 1500 });
  const parsed = parseLooseJson(raw);
  if (!parsed) throw new Error('AI 未返回可解析的 JSON');
  const items = Array.isArray(parsed.items)
    ? parsed.items
        .filter(it => it.time && it.activity)
        .map(it => ({
          time: String(it.time).slice(0, 5),
          activity: String(it.activity).slice(0, 40),
          importance: Math.min(Math.max(Number(it.importance) || 4, 1), 10),
        }))
    : [];
  if (items.length < 3) throw new Error(`items 太少 (${items.length})`);
  const moodSegments = parsed.mood_segments && typeof parsed.mood_segments === 'object'
    ? {
        morning: String(parsed.mood_segments.morning || '').slice(0, 80),
        afternoon: String(parsed.mood_segments.afternoon || '').slice(0, 80),
        evening: String(parsed.mood_segments.evening || '').slice(0, 80),
      }
    : null;
  saveDailySchedule(comp.id, dateKey, items, parsed.mood_arc || null, moodSegments);
  log('info', `[DailySchedule] companion=${comp.id} ${comp.name} ✓ ${items.length} 段 ${isWeekend ? '周末' : '工作日'} segments=${moodSegments ? '3' : '0'}`);
}

// 鲁棒 JSON 提取：剥 ```json``` 围栏；若末尾被 max_tokens 截断，按 items 数组就近闭合
function parseLooseJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  s = s.slice(start);
  try { return JSON.parse(s); } catch { /* fallthrough */ }
  // 截断兜底：截到最后一个 } 后补 ]} 闭合 items 数组
  const itemsKey = s.indexOf('"items"');
  if (itemsKey >= 0) {
    const lastItemEnd = s.lastIndexOf('}');
    if (lastItemEnd > itemsKey) {
      const partial = s.slice(0, lastItemEnd + 1) + ']}';
      try { return JSON.parse(partial); } catch { /* fallthrough */ }
    }
  }
  return null;
}

// 自愈：按需为单个 companion 补当天的日程（proactive 发现缺失时调用）
// 内置 30 分钟级 debounce 避免持续失败时反复重试
const _ensureScheduleAttempts = new Map(); // key: `${companionId}:${dateKey}` -> lastAttemptMs
export async function ensureScheduleForCompanion(companionId, dateKey) {
  if (getDailySchedule(companionId, dateKey)) return true;
  const key = `${companionId}:${dateKey}`;
  const last = _ensureScheduleAttempts.get(key) || 0;
  if (Date.now() - last < 30 * 60_000) return false;
  _ensureScheduleAttempts.set(key, Date.now());
  const db = getDb();
  const comp = db.prepare(`SELECT id, name, age, role_title, personality_tags, hobbies FROM companions WHERE id = ?`).get(companionId);
  if (!comp) return false;
  const weekdayNum = new Date(dateKey + 'T12:00:00+08:00').getDay();
  const weekdayLabel = WEEKDAY_LABELS[weekdayNum];
  try {
    await generateScheduleFor(comp, dateKey, weekdayLabel, weekdayNum);
    log('info', `[DailySchedule] 自愈补建 ${dateKey} companion=${companionId} ✓`);
    return true;
  } catch (e) {
    log('warn', `[DailySchedule] 自愈补建失败 companion=${companionId}: ${e.message}`);
    return false;
  }
}

function ageOccupationHint(age, isWeekend, roleTitle) {
  if (age <= 15) return '⚠️ 未满 16 岁角色未授权使用，请按 16 岁默认处理';
  if (age >= 16 && age <= 18) {
    return isWeekend
      ? '你是高中生：周末可以补习/作业 + 出门和朋友逛街/看电影/在家看番剧/打游戏，要有"周末感"不要上学'
      : '你是高中生：**必须**早上 07:00-07:30 起床去学校，上午到下午 17:00 都在上课/课间/午休，傍晚回家做作业，晚上写作业看手机。不要出现"在公司""开会"';
  }
  if (age >= 19 && age <= 22) {
    return isWeekend
      ? '你是大学生：周末可以睡到 9-10 点起，去图书馆/咖啡店/社团/和朋友出去玩/在宿舍追剧打游戏'
      : '你是大学生：早上 07:30-08:30 起，上午有课就上课没课就自习/睡懒觉，中午食堂或外卖，下午图书馆/社团/约朋友，晚上自习/玩/和室友聊天';
  }
  if (age >= 23 && age <= 35) {
    return isWeekend
      ? '你是上班族：周末睡到 9-10 点，可以健身/聚餐/逛街/看展/在家追剧/打扫整理'
      : '你是上班族：早上 07:30 起来通勤，09:00 到公司开始工作，可能有会议/午饭外卖/下午继续干活/18:00-20:00 下班，晚上吃饭运动追剧';
  }
  return isWeekend
    ? '你 35+，周末可以陪家人/朋友聚会/买菜做饭/看书/休闲'
    : '你 35+，工作日通常工作 + 处理家庭事务，节奏比年轻人慢';
}

// ─── 记忆衰减写回 ────────────────────────────────────────────────────────────
async function runMemoryDecay() {
  try {
    const db = getDb();
    const result = applyMemoryDecayBatch(db, { batchSize: 200 });
    log('info', `[PlanTasks] memory-decay checked=${result.checked} written=${result.written}`);
  } catch (e) {
    log('error', `[PlanTasks] memory-decay 异常: ${e.message}`);
  }
}

// ─── 每日反思 ─────────────────────────────────────────────────────────────────
async function runDailyReflections(dateKey) {
  const companions = getAllActiveCompanions();
  log('info', `[PlanTasks] daily-reflection start date=${dateKey} companions=${companions.length}`);
  const t = { ran: 0, candidates: 0, inserted: 0, merged: 0, rejected: 0, updated: 0 };
  for (const c of companions) {
    try {
      const r = await runDailyReflectionForCompanion(c.id, { userId: c.user_id });
      if (r) { t.ran++; t.candidates += r.candidates; t.inserted += r.inserted; t.merged += r.merged; t.rejected += r.rejected; t.updated += r.updated; }
    } catch (e) {
      log('warn', `[PlanTasks] daily-reflection 异常 companion=${c.id}: ${e.message}`);
    }
  }
  // 正向心跳：批跑完必留产出统计行（没有报错 ≠ 有产出）。rejected>0 = 有记忆在静默蒸发。
  log('info', `[PlanTasks] ${formatReflectionRollup('daily', dateKey, `${t.ran}/${companions.length}`, t)}`);
}

// ─── 每周反思 ─────────────────────────────────────────────────────────────────
async function runWeeklyReflections(dateKey) {
  const companions = getAllActiveCompanions();
  log('info', `[PlanTasks] weekly-reflection start date=${dateKey} pro=${companions.length}`);
  const t = { ran: 0, candidates: 0, inserted: 0, merged: 0, rejected: 0, updated: 0 };
  for (const c of companions) {
    try {
      const r = await runWeeklyReflectionForCompanion(c.id, { userId: c.user_id });
      if (r) { t.ran++; t.candidates += r.candidates; t.inserted += r.inserted; t.merged += r.merged; t.rejected += r.rejected; t.updated += r.updated; }
    } catch (e) {
      log('warn', `[PlanTasks] weekly-reflection 异常 companion=${c.id}: ${e.message}`);
    }
  }
  log('info', `[PlanTasks] ${formatReflectionRollup('weekly', dateKey, `${t.ran}/${companions.length}`, t)}`);
}

// ─── 今天她想你（v1.4.1）─────────────────────────────────────────────────────
async function runDailyThoughts(dateKey) {
  const companions = getAllActiveCompanions();
  log('info', `[PlanTasks] daily-thought start date=${dateKey} companions=${companions.length}`);
  for (const c of companions) {
    try {
      await generateDailyThoughtForCompanion(c.id, { userId: c.user_id });
    } catch (e) {
      log('warn', `[PlanTasks] daily-thought 异常 companion=${c.id}: ${e.message}`);
    }
  }
}

// ─── 每日日记 ─────────────────────────────────────────────────────────────────
async function runDailyDiaries(dateKey) {
  const companions = getAllActiveCompanions();
  log('info', `[PlanTasks] daily-diary start date=${dateKey} companions=${companions.length}`);
  for (const c of companions) {
    try {
      await generateDailyDiaryForCompanion(c.id, { userId: c.user_id });
    } catch (e) {
      log('warn', `[PlanTasks] daily-diary 异常 companion=${c.id}: ${e.message}`);
    }
  }
}

// ─── 每周日记（Pro）─────────────────────────────────────────────────────────────
async function runWeeklyDiaries(dateKey) {
  const companions = getAllActiveCompanions();
  log('info', `[PlanTasks] weekly-diary start date=${dateKey} pro=${companions.length}`);
  for (const c of companions) {
    try {
      await generateWeeklyDiaryForCompanion(c.id, { userId: c.user_id });
    } catch (e) {
      log('warn', `[PlanTasks] weekly-diary 异常 companion=${c.id}: ${e.message}`);
    }
  }
}

// ─── 每小时清理 ──────────────────────────────────────────────────────────────
async function runHourlyCleanup() {
  try {
    const db = getDb();
    const r1 = db.prepare(`DELETE FROM pending_bind_sessions WHERE expires_at < datetime('now', '-1 day')`).run();
    const r2 = db.prepare(`DELETE FROM email_verification_codes WHERE expires_at_ms < ?`).run(Date.now());
    const r3 = db.prepare(`DELETE FROM email_verification_sends WHERE sent_at_ms < ?`).run(Date.now() - 7 * 86400_000);
    // 消息保留 60 天（开源版统一策略，自托管想加可改这个数）
    const r4 = db.prepare(`DELETE FROM wechat_messages WHERE created_at < datetime('now', '-60 days')`).run();
    // 每个 companion 只保留最新 100 条对话 turn（buildLongTermDigest 已经把更早的归档到 memories 了）
    const r5 = db.prepare(`
      DELETE FROM companion_conversation_turns
      WHERE id IN (
        SELECT id FROM companion_conversation_turns t1
        WHERE id NOT IN (
          SELECT id FROM companion_conversation_turns t2
          WHERE t2.companion_id = t1.companion_id
          ORDER BY t2.created_at DESC LIMIT 100
        )
      )
    `).run();
    log('info', `[PlanTasks] cleanup pending=${r1.changes} v_codes=${r2.changes} v_sends=${r3.changes} msgs=${r4.changes} turns=${r5.changes}`);
  } catch (e) {
    log('error', `[PlanTasks] cleanup 异常: ${e.message}`);
  }
}

async function runOnce(parts, name, shouldRun, fn) {
  const key = `${parts.dateKey}:${name}`;
  if (!shouldRun || ran.has(key)) return;
  ran.add(key);
  await fn();
}

// ─── 每日 02:00 ──────────────────────────────────────────────────────────────
async function runDaily(todayKey) {
  // Issue #1: 清理 7 天前的去重记录（防 processed_messages 无限增长）
  try { const n = cleanupProcessedMessages(7); if (n) log('info', `[PlanTasks] 清理 processed_messages ${n} 条`); } catch {}
  try { const n = cleanupAiUsageEvents(60); if (n) log('info', `[PlanTasks] 清理 ai_usage_events ${n} 条`); } catch {}
  const targetKey = addDays(todayKey, -1);
  const { startSql, endSql } = shanghaiBoundsForDateKey(targetKey);
  const companions = getAllActiveCompanions();
  log('info', `[PlanTasks] daily start target=${targetKey} companions=${companions.length}`);

  for (const companion of companions) {
    try {
      if (summaryMemoryExists(companion.id, companion.user_id, 'daily_summary', `${targetKey} 日记忆：`)) continue;

      const turns = getConversationTurnsBetween(companion.id, startSql, endSql, 800);
      if (turns.length === 0) continue;

      const summary = await summarizeDaily(targetKey, turns);
      saveMemory({
        companionId: companion.id,
        userId: companion.user_id,
        memoryType: 'daily_summary',
        content: `${targetKey} 日记忆：${summary}`,
        importance: 8,
      });
      await writeMemoryFile(companion.id, 'daily', targetKey, summary, {
        companionName: companion.name,
        wechatUserId: companion.wechat_user_id,
      });
      log('info', `[PlanTasks] daily generated companion=${companion.id} date=${targetKey}`);
    } catch (err) {
      log('error', `[PlanTasks] daily 失败 companion=${companion.id}: ${err.message}`);
    }
  }

  const cleaned = cleanupPlanMemories();
  log('info', `[PlanTasks] daily cleanup freeDaily=${cleaned.freeDaily} proDaily=${cleaned.proDaily} proWeekly=${cleaned.proWeekly}`);

  // 每日懒检查：7 天 / 30 天在一起成就
  checkDaysTogetherAchievements(companions);
}

function checkDaysTogetherAchievements(companions) {
  const now = Date.now();
  for (const companion of companions) {
    try {
      if (!companion.created_at) continue;
      const created = new Date(String(companion.created_at).replace(' ', 'T') + (String(companion.created_at).includes('Z') ? '' : 'Z'));
      const days = Math.floor((now - created.getTime()) / 86400_000);
      if (days >= 7)  tryAchievement(companion.id, 'seven_days_together');
      if (days >= 30) tryAchievement(companion.id, 'thirty_days_together');
    } catch { /* 非阻塞 */ }
  }
}

// ─── 周日 02:30（仅 Pro） ───────────────────────────────────────────────────
async function runWeekly(todayKey) {
  const endKey = addDays(todayKey, -1);
  const startKey = addDays(endKey, -6);
  const companions = getAllActiveCompanions();
  log('info', `[PlanTasks] weekly start range=${startKey}~${endKey} pro=${companions.length}`);

  for (const companion of companions) {
    try {
      const prefix = `${startKey}~${endKey} 周记忆：`;
      if (summaryMemoryExists(companion.id, companion.user_id, 'weekly_summary', prefix)) continue;

      const daily = getSummaryMemoriesInRange(companion.id, companion.user_id, 'daily_summary', startKey, endKey, 7);
      if (daily.length === 0) continue;

      const summary = await summarizeMemoryList('周记忆', `${startKey} 到 ${endKey}`, daily);
      saveMemory({
        companionId: companion.id,
        userId: companion.user_id,
        memoryType: 'weekly_summary',
        content: `${prefix}${summary}`,
        importance: 9,
      });
      const weekLabel = isoWeekLabel(endKey);
      await writeMemoryFile(companion.id, 'weekly', weekLabel, summary, {
        companionName: companion.name,
        range: `${startKey} ~ ${endKey}`,
      });
      log('info', `[PlanTasks] weekly generated companion=${companion.id} range=${startKey}~${endKey}`);
    } catch (err) {
      log('error', `[PlanTasks] weekly 失败 companion=${companion.id}: ${err.message}`);
    }
  }
}

// ─── 每月 1 号 03:00（仅 Pro） ─────────────────────────────────────────────
async function runMonthly(todayKey) {
  const month = previousMonthKey(todayKey);
  const companions = getAllActiveCompanions();
  log('info', `[PlanTasks] monthly start month=${month} pro=${companions.length}`);

  for (const companion of companions) {
    try {
      const prefix = `${month} 月记忆：`;
      if (summaryMemoryExists(companion.id, companion.user_id, 'monthly_summary', prefix)) continue;

      const weekly = getSummaryMemoriesInRange(companion.id, companion.user_id, 'weekly_summary', `${month}-01`, `${month}-31`, 6);
      if (weekly.length === 0) continue;

      const summary = await summarizeMemoryList('月记忆', month, weekly);
      saveMemory({
        companionId: companion.id,
        userId: companion.user_id,
        memoryType: 'monthly_summary',
        content: `${prefix}${summary}`,
        importance: 10,
      });
      await writeMemoryFile(companion.id, 'monthly', month, summary, {
        companionName: companion.name,
        month,
      });
      log('info', `[PlanTasks] monthly generated companion=${companion.id} month=${month}`);
    } catch (err) {
      log('error', `[PlanTasks] monthly 失败 companion=${companion.id}: ${err.message}`);
    }

    // v1.9.8: 长期记忆压缩 — 把 90 天前的零碎 fact/event/emotion 合并成
    // "老记忆压缩"摘要，删除原条目。避免半年/一年后零碎记忆无限膨胀。
    // 不动 preference（稳定特征）/ pinned（用户钉住）/ summary（已总结）。
    try {
      await compactOldEpisodicMemories(companion);
    } catch (err) {
      log('warn', `[PlanTasks] compactMemory 失败 companion=${companion.id}: ${err.message}`);
    }
  }
}

/**
 * v1.9.8: 单 companion 的老记忆压缩。按"创建月份"分组，每组合并成
 * monthly_summary（prefix 区分于自动月总结），然后删除原条目。
 * 静默失败（不抛），不影响主 runMonthly 流程。
 */
async function compactOldEpisodicMemories(companion) {
  const compactDays = Math.max(30, Number(process.env.MEMORY_COMPACT_DAYS) || 90);
  const before = new Date(Date.now() - compactDays * 86_400_000).toISOString();
  const rows = listEpisodicMemoriesOlderThan({
    companionId: companion.id,
    userId: companion.user_id,
    beforeDateIso: before,
    limit: 200,
  });
  if (rows.length < 5) return;  // 太少没必要压缩

  // 按 "YYYY-MM" 分组（用 created_at 前 7 位）
  const groups = new Map();
  for (const r of rows) {
    const key = String(r.created_at || '').slice(0, 7); // YYYY-MM
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  if (groups.size === 0) return;

  log('info', `[PlanTasks] compact start companion=${companion.id} rows=${rows.length} groups=${groups.size} cutoff=${compactDays}d`);

  let compactedGroups = 0;
  for (const [groupMonth, groupRows] of groups.entries()) {
    if (groupRows.length < 3) continue;  // 单月不足 3 条 skip
    const prefix = `老记忆压缩 ${groupMonth}：`;
    // 已有同 prefix 的压缩摘要 → 跳过（idempotent 防重复）
    if (summaryMemoryExists(companion.id, companion.user_id, 'monthly_summary', prefix)) continue;

    try {
      const summary = await summarizeMemoryList('老记忆压缩', groupMonth, groupRows);
      saveMemory({
        companionId: companion.id,
        userId: companion.user_id,
        memoryType: 'monthly_summary',
        content: `${prefix}${summary}`,
        importance: 15,  // 高于普通月总结（这是压缩后的精华，回忆时优先召回）
      });
      // 摘要落地成功才删原条目（防摘要失败导致数据丢失）
      const ids = groupRows.map(r => r.id);
      const deleted = deleteMemoriesByIds(ids);
      compactedGroups++;
      log('info', `[PlanTasks] compact group companion=${companion.id} month=${groupMonth} src=${groupRows.length} deleted=${deleted}`);
    } catch (err) {
      log('warn', `[PlanTasks] compact group failed companion=${companion.id} month=${groupMonth}: ${err.message}`);
    }
  }
  if (compactedGroups > 0) {
    log('info', `[PlanTasks] compact done companion=${companion.id} groups=${compactedGroups}`);
  }
}

// ─── AI 调用：生成总结 ───────────────────────────────────────────────────────
async function summarizeDaily(dateKey, turns) {
  const text = turns.map(t => `${t.role === 'user' ? '他' : '她'}：${String(t.content).slice(0, 300)}`).join('\n').slice(0, 12000);
  return summarize('日记忆', `请总结 ${dateKey} 这一天的对话，提炼他（对方）的重要事实、偏好、情绪变化、关系进展和需要下次自然接上的话题（指代对方一律用'他'）。控制在 120 字内，只输出总结正文，不要客套。`, text);
}

async function summarizeMemoryList(kind, label, rows) {
  const text = rows.map(r => `- ${r.content}`).join('\n').slice(0, 12000);
  const sourceKind = kind === '周记忆' ? '日记忆' : '周记忆';
  return summarize(kind, `请把这些${sourceKind}汇总成${label}的${kind}。突出稳定偏好、重要事件、情绪趋势和关系进展。控制在 160 字内，只输出总结正文，不要客套。`, text);
}

async function summarize(kind, instruction, text) {
  const systemPrompt = `你是长期记忆总结助手。为 AI 女友生成${kind}，要求具体、真实、可供后续聊天自然参考。不要编造，不要输出 JSON，不要说自己是 AI。`;
  const result = await generateReply(systemPrompt, [], `${instruction}\n\n材料：\n${text}`, {
    temperature: 0.2,
    max_tokens: 500,
    top_p: 0.9,
  });
  return result.replace(/\s+/g, ' ').slice(0, 500);
}

// ─── 文件存储 ────────────────────────────────────────────────────────────────
async function writeMemoryFile(companionId, kind, key, summary, meta = {}) {
  try {
    const dir = path.join(MEMORY_ROOT, String(companionId), kind);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${key}.md`);
    const front = [
      `# ${kind === 'daily' ? '日记忆' : kind === 'weekly' ? '周记忆' : '月记忆'} · ${key}`,
      '',
      `- companion_id: ${companionId}`,
      meta.companionName ? `- name: ${meta.companionName}` : null,
      meta.wechatUserId ? `- wechat_user_id: ${meta.wechatUserId}` : null,
      meta.range ? `- range: ${meta.range}` : null,
      meta.month ? `- month: ${meta.month}` : null,
      `- generated_at: ${new Date().toISOString()}`,
      '',
      '---',
      '',
    ].filter(Boolean).join('\n');
    await writeFile(file, front + summary.trim() + '\n', 'utf-8');
  } catch (err) {
    log('warn', `[PlanTasks] writeMemoryFile 失败 companion=${companionId} ${kind} ${key}: ${err.message}`);
  }
}

/**
 * 给 bot.mjs / proactive.mjs 调用：拼一段"长期记忆档案"喂给 system prompt。
 * 优先级：月记忆 > 周记忆 > 最近几天日记忆。
 */
// v1.3.4: 第三个参数 { isPro } 已废弃（向后兼容仍接受但忽略）。开源版所有 companion
// 都注入完整长期记忆（月+周+日），不再按账号付费层级筛选。
/**
 * 长期记忆摘要（月/周/日 summary 聚合注入 prompt）。
 *
 * ⚠⚠ 素材冷却闸门【架构铁律】（2026-06-13，接线类第五案；新增旁路强制 review 本条）：
 * summary 经本函数走 longTermDigest 旁路注入 prompt——这是「向 proactive prompt 注入记忆类
 * 素材」的一条**旁路**。生产实锤 mem:509（daily_summary）经此路反复复读 4 次/天：素材级去重
 * （filterRecentlyUsed）只挡 recallMemories 召回路，**覆盖不到本旁路**。漏洞本质不是 summary
 * 特殊，是「旁路绕过了公共冷却闸门」。**任何向 proactive prompt 注入记忆类素材的路径，都必须
 * 过素材冷却闸门**——闸门挂在「注入动作」上而非某条路径，这族接线 bug 才绝后。
 *   故加 opts.excludeUsedIds：**proactive 调用传**（近期已落账素材集，剔除复读 summary）；
 *   **reply/对话召回调用不传**（他问起的 summary 永放行——digest 剔除绝不挂对话路径，这是
 *   「主动是克制、召回不失忆」铁律的延伸）。分得开就靠这一个三元判断。
 */
export async function buildLongTermDigest(companionId, userId, { excludeUsedIds = null } = {}) {
  if (!companionId || !userId) return '';
  const blocks = [];
  // 素材冷却闸门：仅 proactive 传 excludeUsedIds(Set) 时剔除近期已用 summary；reply 不传=全保留。
  const cool = (rows) => (excludeUsedIds instanceof Set && excludeUsedIds.size)
    ? rows.filter(r => !excludeUsedIds.has(`mem:${r.id}`))
    : rows;

  const monthly = cool(getRecentSummaries(companionId, userId, 'monthly_summary', 3));
  if (monthly.length > 0) {
    blocks.push('【月度回顾（最近 3 个月）】\n' + monthly.map(m => `- ${m.content}`).join('\n'));
  }
  const weekly = cool(getRecentSummaries(companionId, userId, 'weekly_summary', 4));
  if (weekly.length > 0) {
    blocks.push('【近期周记（最近 4 周）】\n' + weekly.map(w => `- ${w.content}`).join('\n'));
  }

  const daily = cool(getRecentSummaries(companionId, userId, 'daily_summary', 7));
  if (daily.length > 0) {
    blocks.push('【最近每日小结】\n' + daily.map(d => `- ${d.content}`).join('\n'));
  }

  return blocks.join('\n\n');
}

// ─── 工具 ────────────────────────────────────────────────────────────────────
// v1.3.4: isProUser() 已移除。开源版周反思 / 周日记 / 周月总结对所有 active
// companion 一视同仁触发，不再按账号付费层级过滤。

function getSummaryMemoriesInRange(companionId, userId, memoryType, startKey, endKey, limit) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM companion_memories
    WHERE companion_id = ?
      AND user_id = ?
      AND memory_type = ?
      AND substr(content, 1, 10) >= ?
      AND substr(content, 1, 10) <= ?
    ORDER BY content ASC
    LIMIT ?
  `).all(companionId, userId, memoryType, startKey, endKey, limit);
}

function shanghaiParts(date) {
  const raw = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const wd = weekdayMap[raw.weekday];
  return {
    dateKey: `${raw.year}-${raw.month}-${raw.day}`,
    day: Number(raw.day),
    hour: Number(raw.hour),
    minute: Number(raw.minute),
    weekday: wd,
    weekdayLabel: weekdayLabels[wd],
  };
}

function addDays(dateKey, delta) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return shanghaiDateKey(new Date(Date.UTC(year, month - 1, day + delta, 12, 0, 0)));
}

function previousMonthKey(dateKey) {
  const [year, month] = dateKey.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 2, 1, 12, 0, 0));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function isoWeekLabel(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
