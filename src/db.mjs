/**
 * SQLite 数据访问层（全部操作 + schema 迁移）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'node:path';
import fs from 'node:fs';
import { estimateProviderCost, loadProviderPricing } from './provider_costs.mjs';

const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'data/bot.db');
// 确保 data 目录存在
try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch {}

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // ── 性能调优 ────────────────────────────────────────────────────────────
    db.pragma('synchronous = NORMAL');     // WAL 模式下安全，写比 FULL 快 2-5×
    db.pragma('cache_size = -64000');      // 64MB page cache（默认 2MB）
    db.pragma('mmap_size = 268435456');    // 256MB mmap, 大幅加速读
    db.pragma('temp_store = MEMORY');      // 临时表/索引放内存
    db.pragma('busy_timeout = 5000');      // 高并发时 5s 重试，比默认 0 友好
    initSchema();
    migrateWechatAccounts();
    migratePendingBindSessions();
    migrateUsers();
    migrateCompanionMemories();
    migrateCompanions();
    migratePollState();
    migrateUserAccounts();
    initAiUsageTable();
    migrateCompanionMemoriesV2();
    migrateDailyScheduleV2();
    migrateConfessionFields();
    initAvatarPresets();
    migrateMemoryV3();
    migrateEmotionState();
    migrateProactiveEngineV2();
    migrateEmotionHistory();
    migrateP2Tables();
    migrateDiary();
    migrateReminderPush();
    migrateProactiveDailyTarget();
    migrateVoiceReply();
    migrateContextTokenCache();
    migrateDailyThoughts();
    migrateAppSettings();
    migrateTimeCapsules();
    migrateSilentMode();
    migrateRelationalDiary();
    migrateProactiveLastSent();
    migrateConversationTurnSynthetic();
    migrateBackfillFlag();
    migratePreferences();  // v1.8.0 #3
    migrateCompanionShaping();  // 共建留痕（教她说话/称呼/雷区/约定/专属梗）
    migrateOpenLoops();    // v1.8.0 #4
    migrateSafetyEvents(); // v1.9.0 #1 安全事件记录（高危后暂停普通主动消息）
  }
  return db;
}

// ─── v1.9.0 #1: safety_events 高危/中危安全事件 ──────────────────────────
// 记录用户消息中检测到的自伤/自杀/绝望等信号。proactive 调度前查这张表：
//   · 24h 内有 high   → 仅允许 safety check-in，禁止普通早安/晚安/想念/吃醋/告白
//   · 6h  内有 medium → 禁止占有/吃醋/告白，允许温和关心
// 这是真实风险：用户说"不想活了"后半小时系统发"突然想你了"是不可接受的。
function migrateSafetyEvents() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS safety_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      user_id      INTEGER,
      level        TEXT    NOT NULL CHECK(level IN ('high','medium')),
      signals      TEXT,                 -- JSON array of matched signal keywords
      source_text  TEXT,                 -- 截断到 200 字的原始消息（用于复盘）
      created_at   INTEGER NOT NULL      -- 毫秒时间戳，方便区间查询
    );
    CREATE INDEX IF NOT EXISTS idx_safety_companion_time
      ON safety_events(companion_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_safety_level_time
      ON safety_events(level, created_at DESC);
  `);
}

/**
 * 写入一条安全事件。signals 为字符串数组，会序列化为 JSON。
 * 静默失败：不阻塞主对话流。
 */
export function recordSafetyEvent({ companionId, userId = null, level, signals = [], sourceText = '' }) {
  if (!companionId || !['high','medium'].includes(level)) return null;
  try {
    const stmt = getDb().prepare(`
      INSERT INTO safety_events (companion_id, user_id, level, signals, source_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      companionId,
      userId,
      level,
      JSON.stringify(Array.isArray(signals) ? signals.slice(0, 10) : []),
      String(sourceText || '').slice(0, 200),
      Date.now(),
    );
    return r.lastInsertRowid;
  } catch (e) {
    // 不抛 — 安全事件记录失败不应影响主对话
    return null;
  }
}

/**
 * 查询 companion 最近一段时间内的最高级别安全事件。
 * 默认窗口：high 24h，medium 6h（matches Anthropic-style 安全门设计）。
 * 返回 { level: 'high'|'medium'|'none', recentAt: number|null, signals: string[] }
 */
export function getRecentSafetyRisk(companionId, { highWindowMs = 86_400_000, mediumWindowMs = 21_600_000 } = {}) {
  if (!companionId) return { level: 'none', recentAt: null, signals: [] };
  const now = Date.now();
  try {
    // 优先查 high
    const high = getDb().prepare(`
      SELECT created_at, signals FROM safety_events
      WHERE companion_id = ? AND level = 'high' AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(companionId, now - highWindowMs);
    if (high) {
      let sig = [];
      try { sig = JSON.parse(high.signals || '[]'); } catch {}
      return { level: 'high', recentAt: high.created_at, signals: Array.isArray(sig) ? sig : [] };
    }
    // 再查 medium
    const mid = getDb().prepare(`
      SELECT created_at, signals FROM safety_events
      WHERE companion_id = ? AND level = 'medium' AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(companionId, now - mediumWindowMs);
    if (mid) {
      let sig = [];
      try { sig = JSON.parse(mid.signals || '[]'); } catch {}
      return { level: 'medium', recentAt: mid.created_at, signals: Array.isArray(sig) ? sig : [] };
    }
    return { level: 'none', recentAt: null, signals: [] };
  } catch {
    return { level: 'none', recentAt: null, signals: [] };
  }
}

// ─── v1.8.0 #4: companion_open_loops "未完成的事" ────────────────────────
// "他说明天去招聘会" → 第二天她主动问"面试怎么样"
// 真人陪伴感最强的瞬间之一：她记得用户说过的事
function migrateOpenLoops() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_open_loops (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id     INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      title            TEXT    NOT NULL,
      due_at           TEXT,
      emotional_weight INTEGER DEFAULT 5 CHECK(emotional_weight BETWEEN 0 AND 100),
      expected_followup TEXT,
      status           TEXT NOT NULL DEFAULT 'open'
                       CHECK(status IN ('open','resolved','stale','dismissed')),
      source_message_id TEXT,
      resolved_at      TEXT,
      resolved_text    TEXT,
      followed_up_at   TEXT,
      created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_loops_companion_status_due
      ON companion_open_loops(companion_id, status, due_at);
  `);
}

// ─── v1.8.0 #3: companion_preferences 结构化偏好账本 ───────────────────────
// 比 companions.dislikes (JSON 数组) 更精细：可加强度、原因、来源、type 区分
// 启动 migration 自动把 companions.hobbies + dislikes 同步到本表（source='legacy'）
function migratePreferences() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_preferences (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      type         TEXT    NOT NULL CHECK(type IN ('like','dislike','neutral','taboo')),
      target       TEXT    NOT NULL,
      intensity    INTEGER DEFAULT 3 CHECK(intensity BETWEEN 1 AND 5),
      reason       TEXT,
      source       TEXT    DEFAULT 'system',  -- system / user_observed / generated / legacy
      created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(companion_id, type, target)
    );
    CREATE INDEX IF NOT EXISTS idx_pref_companion ON companion_preferences(companion_id, type);
  `);

  // 一次性 backfill：把 hobbies (JSON) 同步为 like, dislikes (JSON) 同步为 dislike
  // 已存在的 (companion_id, type, target) 用 UNIQUE 跳过
  try {
    const rows = db.prepare(`SELECT id, hobbies, dislikes FROM companions`).all();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO companion_preferences (companion_id, type, target, intensity, source)
      VALUES (?, ?, ?, 3, 'legacy')
    `);
    const tx = db.transaction(list => {
      let synced = 0;
      for (const r of list) {
        const likes = parseJsonSafe(r.hobbies);
        const dislikes = parseJsonSafe(r.dislikes);
        for (const t of likes) if (t) { insert.run(r.id, 'like', String(t)); synced++; }
        for (const t of dislikes) if (t) { insert.run(r.id, 'dislike', String(t)); synced++; }
      }
      return synced;
    });
    const n = tx(rows);
    if (n > 0) console.log(`[migratePreferences] backfilled ${n} rows from hobbies/dislikes`);
  } catch (e) {
    console.error(`[migratePreferences] backfill skipped: ${e.message}`);
  }
}

function parseJsonSafe(s) {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

function migrateUserAccounts() {
  addColIfMissing('user_accounts', 'birthday', 'TEXT');
  addColIfMissing('user_accounts', 'age_at_registration', 'INTEGER');
  addColIfMissing('user_accounts', 'terms_accepted_at', 'DATETIME');
  addColIfMissing('user_accounts', 'terms_version', 'TEXT');
  addColIfMissing('user_accounts', 'is_banned', 'INTEGER DEFAULT 0');
  addColIfMissing('user_accounts', 'banned_reason', 'TEXT');
  addColIfMissing('user_accounts', 'banned_at', 'DATETIME');
  // v1.11.0 安全(M1)：验证码失败尝试计数，错 N 次作废，防爆破
  addColIfMissing('email_verification_codes', 'attempts', 'INTEGER DEFAULT 0');
}

function initAiUsageTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage_daily (
      account_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (account_id, day)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_day ON ai_usage_daily(day);
    CREATE INDEX IF NOT EXISTS idx_ai_usage_account_day ON ai_usage_daily(account_id, day DESC);

    -- P1-7：AI 用量明细（按 provider/model/capability 维度 + 估算成本 + 延迟 + 状态）
    CREATE TABLE IF NOT EXISTS ai_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      companion_id INTEGER,
      provider TEXT,
      model TEXT,
      capability TEXT NOT NULL,            -- chat/image/vision/asr/tts/embedding/search
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      images INTEGER DEFAULT 0,
      audio_seconds INTEGER DEFAULT 0,
      latency_ms INTEGER,
      status TEXT DEFAULT 'ok',            -- ok/error/fallback
      estimated_cost REAL,
      currency TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_events_created ON ai_usage_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_events_cap ON ai_usage_events(capability, created_at DESC);

    CREATE TABLE IF NOT EXISTS companion_daily_schedule (
      companion_id INTEGER NOT NULL,
      date_key TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      mood_arc TEXT,
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (companion_id, date_key)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_schedule_date ON companion_daily_schedule(date_key);

    CREATE TABLE IF NOT EXISTS companion_persona_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_persona_facts_comp ON companion_persona_facts(companion_id, sort_order);

    CREATE TABLE IF NOT EXISTS companion_stage_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL,
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      affection_at_upgrade INTEGER,
      days_since_meet INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_stage_milestones_companion ON companion_stage_milestones(companion_id, created_at);

    -- v1.10.0 作息/睡眠
    -- 每个 companion 一条；today_* 字段每天 cron 重算（含 jitter）。
    -- learn_state='observing' 前 7 天纯观察用户作息，第 8 天 'locked' 固化。
    CREATE TABLE IF NOT EXISTS companion_sleep_schedule (
      companion_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,           -- v1.10.5: 默认开启；默认作息 00:30 睡（避开晚间活跃时段，不打扰）
      bed_time TEXT NOT NULL DEFAULT '00:30',           -- HH:MM 24h，上海/北京时区（v1.10.5: 23:00→00:30）
      wake_time TEXT NOT NULL DEFAULT '07:30',
      jitter_min INTEGER NOT NULL DEFAULT 30,           -- ±N 分钟随机抖动
      user_set INTEGER NOT NULL DEFAULT 0,              -- 0=默认/学习 1=用户手动设
      learn_state TEXT NOT NULL DEFAULT 'observing',    -- observing | locked
      learn_started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      observed_samples_json TEXT NOT NULL DEFAULT '[]', -- [{date, first_msg, last_msg}, ...]
      today_date TEXT,                                  -- 今天 today_* 的有效日 YYYY-MM-DD
      today_bed_at INTEGER,                             -- 今天的入睡时刻 ts(ms)
      today_wake_at INTEGER,                            -- 今天的起床时刻 ts(ms)
      is_sleeping INTEGER NOT NULL DEFAULT 0,
      sleep_started_at INTEGER,
      woken_today INTEGER NOT NULL DEFAULT 0,
      last_woken_at INTEGER,
      goodnight_sent_for_date TEXT,                     -- 今晚是否已发睡前晚安
      goodmorning_sent_for_date TEXT,                   -- 今早是否已发起床早安
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 睡眠期间收到的用户消息（用于起床后补回总结）
    CREATE TABLE IF NOT EXISTS companion_missed_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL,
      received_at INTEGER NOT NULL,                     -- ts(ms)
      msg_type TEXT NOT NULL,                           -- text | image | voice | etc
      content TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_missed_msgs_comp ON companion_missed_messages(companion_id, consumed, received_at);
  `);
}

function migratePollState() {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='poll_state'`).get();
  const sql = row?.sql || '';
  // 旧表是 (id INTEGER PRIMARY KEY, bot_id TEXT UNIQUE NOT NULL, buf TEXT NOT NULL)，
  // 新表是 (bot_id TEXT PRIMARY KEY, buf TEXT NOT NULL DEFAULT '', updated_at DATETIME)
  if (sql.includes('id INTEGER PRIMARY KEY') && sql.includes('bot_id TEXT UNIQUE')) {
    db.exec(`
      CREATE TABLE poll_state_new (
        bot_id TEXT PRIMARY KEY,
        buf TEXT NOT NULL DEFAULT '',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT OR IGNORE INTO poll_state_new (bot_id, buf, updated_at)
        SELECT bot_id, buf, updated_at FROM poll_state;
      DROP TABLE poll_state;
      ALTER TABLE poll_state_new RENAME TO poll_state;
    `);
  }
}

// ─── Schema 初始化 ────────────────────────────────────────────────────────────
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wechat_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT UNIQUE NOT NULL,
      bot_token TEXT NOT NULL,
      display_name TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    DROP TABLE IF EXISTS wechat_bind_sessions;

    CREATE TABLE IF NOT EXISTS pending_bind_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
      bind_code TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','expired','failed')),
      wechat_user_id TEXT,
      companion_id INTEGER,
      error_message TEXT,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      consumed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wechat_user_id TEXT UNIQUE NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      plan TEXT DEFAULT 'free' CHECK(plan IN ('free','pro')),
      plan_expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_active DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS companions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL,

      -- 【1. 基础身份】
      name TEXT DEFAULT '溪语',
      age INTEGER DEFAULT 20,
      role_title TEXT DEFAULT '邻家女孩',
      avatar_url TEXT,

      -- 【2. 外貌】
      hair_color TEXT DEFAULT '黑色',
      hair_style TEXT DEFAULT '长发',
      eye_color TEXT DEFAULT '棕色',
      body_type TEXT DEFAULT '匀称',
      height INTEGER DEFAULT 165,
      clothing_style TEXT DEFAULT '甜美',

      -- 【3. 性格】
      personality_tags TEXT DEFAULT '["温柔","体贴"]',
      mbti TEXT,
      introvert_level INTEGER DEFAULT 5,

      -- 【4. 亲密程度】
      intimacy_level TEXT DEFAULT '慢慢熟悉',

      -- 【5. 说话风格】
      speech_styles TEXT DEFAULT '["自然口语"]',
      use_emoji_level INTEGER DEFAULT 5,
      use_kaomoji INTEGER DEFAULT 0,
      reply_length TEXT DEFAULT '适中(3-4句)',

      -- 【6. 互动边界】
      can_joke INTEGER DEFAULT 1,
      avoid_cheesy INTEGER DEFAULT 0,
      no_pressure INTEGER DEFAULT 0,
      occasional_tantrum INTEGER DEFAULT 0,
      encouraging INTEGER DEFAULT 1,
      nsfw_level INTEGER DEFAULT 0,

      -- 【7. 兴趣爱好】
      hobbies TEXT DEFAULT '[]',
      favorite_food TEXT,
      favorite_music TEXT,
      pet_preference TEXT,

      -- 【8. 关系背景】
      how_met TEXT,
      relationship_status TEXT DEFAULT '普通朋友',
      shared_memory TEXT,

      -- 【9. 记忆重点】
      memory_priorities TEXT DEFAULT '["我的喜好","情绪变化"]',

      -- 【10. 主动行为】
      proactive_enabled INTEGER DEFAULT 1,
      proactive_frequency TEXT DEFAULT '适中',
      proactive_time_window TEXT DEFAULT '07:30-24:00',
      voice_reply_enabled INTEGER DEFAULT 0,
      sticker_reply_enabled INTEGER DEFAULT 0,

      -- 【11. 称呼】
      call_user_as TEXT DEFAULT '你',
      user_call_her_as TEXT,

      -- 【12. 自由描述】
      persona_prompt TEXT DEFAULT '',
      forbidden_topics TEXT DEFAULT '[]',

      -- 【13. 长期记忆】
      memory_enabled INTEGER DEFAULT 1,

      -- 【14. 情绪状态】
      current_mood TEXT DEFAULT '平静',
      mood_updated_at DATETIME,

      -- 【15. 好感度/关系进展】
      -- v1.4.2: 修正定位错位 —— 这是 AI 女友框架，默认从「暧昧」起步（她已经
      -- 对你有好感、心里悄悄喜欢你），不是陌生人慢慢培养的体验。35 落在
      -- 暧昧档中段 (30-54)，保留向恋人/深爱演进的空间。
      -- 已存在的 companion 不动（CREATE TABLE DEFAULT 只对新行生效）。
      affection_level INTEGER DEFAULT 35,
      relationship_stage TEXT DEFAULT '暧昧',

      -- 【16. 场景】
      current_scene TEXT DEFAULT '在家',
      scene_history TEXT DEFAULT '[]',

      -- 【17. 角色背景】
      backstory TEXT,
      family_background TEXT,
      education TEXT,
      secrets TEXT,

      -- 【18. 语音设定】
      voice_style TEXT DEFAULT '温柔',
      voice_speed REAL DEFAULT 1.0,

      -- 【19. 对话模式】
      chat_modes TEXT DEFAULT '["日常聊天"]',
      chat_mode_active TEXT DEFAULT '日常聊天',

      -- 模型参数
      -- v1.2.10: 默认从 (0.7 / 2000 / 0.9) 调到 (0.8 / 3000 / 0.95)，更有创意、
      -- 回复空间更宽、用词更自然；仍在保守范围，不会胡说。已存在的 companion
      -- 保留各自调好的值（CREATE TABLE DEFAULT 只对新行生效），不会被覆盖。
      temperature REAL DEFAULT 0.8,
      max_tokens INTEGER DEFAULT 3000,
      top_p REAL DEFAULT 0.95,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 长期记忆表
    CREATE TABLE IF NOT EXISTS companion_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      memory_type TEXT NOT NULL CHECK(memory_type IN ('fact','preference','event','emotion','image','daily_summary','weekly_summary','monthly_summary')),
      content TEXT NOT NULL,
      importance INTEGER DEFAULT 5 CHECK(importance BETWEEN 1 AND 10),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 图片反应记录表，仅保存 URL/描述/提取结果，不保存图片二进制
    CREATE TABLE IF NOT EXISTS companion_image_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      image_url TEXT,
      image_description TEXT NOT NULL,
      user_message TEXT,
      reaction_text TEXT,
      memories_json TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 最近对话上下文表
    CREATE TABLE IF NOT EXISTS companion_conversation_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      topic TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 送礼记录表
    CREATE TABLE IF NOT EXISTS companion_gifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      gift_id TEXT NOT NULL,
      gift_name TEXT NOT NULL,
      affection_delta INTEGER NOT NULL,
      message TEXT,
      price REAL DEFAULT 0,
      currency TEXT DEFAULT 'CNY',
      paid_required INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 节日/纪念日/自定义提醒表；当前只提供 pending/due 查询，不主动推送
    CREATE TABLE IF NOT EXISTS companion_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      reminder_type TEXT NOT NULL CHECK(reminder_type IN ('birthday','anniversary','holiday','custom')),
      date TEXT NOT NULL,
      repeat_rule TEXT NOT NULL DEFAULT 'once' CHECK(repeat_rule IN ('once','yearly')),
      message_template TEXT,
      enabled INTEGER DEFAULT 1,
      last_triggered_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 用户画像表
    CREATE TABLE IF NOT EXISTS user_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      companion_id INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      user_name TEXT,
      user_occupation TEXT,
      user_hobbies TEXT DEFAULT '[]',
      user_birthday TEXT,
      important_dates TEXT DEFAULT '[]',
      notes TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, companion_id)
    );

    CREATE TABLE IF NOT EXISTS wechat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_id TEXT UNIQUE,
      from_user TEXT NOT NULL,
      to_user TEXT NOT NULL,
      msg_type TEXT NOT NULL,
      content TEXT,
      media_url TEXT,
      media_mime TEXT,
      direction TEXT DEFAULT 'in',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Issue #1: 持久化消息去重（防止重启后重复回复）。轻量专表，7 天清理。
    CREATE TABLE IF NOT EXISTS processed_messages (
      msg_id       TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_processed_messages_at ON processed_messages(processed_at);

    CREATE TABLE IF NOT EXISTS proactive_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      message_template TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      last_run DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS poll_state (
      bot_id TEXT PRIMARY KEY,
      buf TEXT NOT NULL DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS email_verification_codes (
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      sent_at_ms INTEGER NOT NULL,
      PRIMARY KEY (email, purpose)
    );

    CREATE TABLE IF NOT EXISTS email_verification_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      sent_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      birthday TEXT,                                       -- YYYY-MM-DD（注册时收集）
      age_at_registration INTEGER,                         -- 注册当时的年龄（计算并冻结，避免每次按今天算）
      terms_accepted_at DATETIME,                          -- 何时同意协议
      terms_version TEXT,                                  -- 同意的协议版本
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS billing_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL UNIQUE,                       -- 商户订单号 out_trade_no
      account_id INTEGER NOT NULL,                         -- user_accounts.id
      plan TEXT NOT NULL DEFAULT 'pro',
      period TEXT NOT NULL,                                -- monthly / yearly
      amount_cny REAL NOT NULL,                            -- 元（保留两位）
      provider TEXT NOT NULL DEFAULT 'alipay',             -- alipay / wechatpay / stub
      provider_trade_no TEXT,                              -- 支付平台流水号 trade_no
      status TEXT NOT NULL DEFAULT 'pending'               -- pending / paid / refunded / closed / failed
        CHECK(status IN ('pending','paid','refunded','closed','failed')),
      pay_url TEXT,                                        -- PC/H5 跳转地址
      qr_url TEXT,                                         -- 当面付二维码
      raw_create_resp TEXT,                                -- 创建订单时支付平台返回 raw json
      raw_notify TEXT,                                     -- 异步通知 raw payload
      paid_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_companion ON companion_memories(companion_id, user_id, importance DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_created   ON companion_memories(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_image_reactions_companion_created ON companion_image_reactions(companion_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversation_turns_companion_created ON companion_conversation_turns(companion_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_companion_gifts_companion_created ON companion_gifts(companion_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_companion_reminders_due ON companion_reminders(companion_id, enabled, date);
    CREATE INDEX IF NOT EXISTS idx_email_verification_sends_email_time ON email_verification_sends(email, sent_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_user_accounts_username ON user_accounts(username);
    CREATE INDEX IF NOT EXISTS idx_user_accounts_email ON user_accounts(email);
    CREATE INDEX IF NOT EXISTS idx_pending_bind_sessions_user_status ON pending_bind_sessions(user_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pending_bind_sessions_status_created ON pending_bind_sessions(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pending_bind_sessions_expires ON pending_bind_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_billing_orders_account ON billing_orders(account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_billing_orders_status ON billing_orders(status, created_at DESC);
  `);
}

// ─── 迁移：给旧 companions 表补新字段 ────────────────────────────────────────
function addColIfMissing(table, col, def) {
  const has = db.pragma(`table_info(${table})`).some(r => r.name === col);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

function migrateUsers() {
  addColIfMissing('users', 'plan', "TEXT DEFAULT 'free' CHECK(plan IN ('free','pro'))");
  addColIfMissing('users', 'plan_expires_at', 'DATETIME');
}

function migratePendingBindSessions() {
  addColIfMissing('pending_bind_sessions', 'bind_code', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_pending_bind_sessions_bind_code ON pending_bind_sessions(bind_code)');
}

function migrateWechatAccounts() {
  const ensureIndexes = () => {
    db.exec(`
      DROP INDEX IF EXISTS idx_wechat_accounts_account_id;
      DROP INDEX IF EXISTS idx_wechat_accounts_wechat_user_id;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_accounts_account_id ON wechat_accounts(account_id) WHERE account_id IS NOT NULL AND is_active = 1;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_accounts_user_id ON wechat_accounts(user_id) WHERE user_id IS NOT NULL AND is_active = 1;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_accounts_wechat_user_id ON wechat_accounts(wechat_user_id, bot_id) WHERE wechat_user_id IS NOT NULL AND is_active = 1;
      CREATE INDEX IF NOT EXISTS idx_wechat_accounts_session ON wechat_accounts(login_session_id);
      CREATE INDEX IF NOT EXISTS idx_wechat_accounts_companion ON wechat_accounts(companion_id) WHERE companion_id IS NOT NULL;
    `);
  };
  const row = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'wechat_accounts'
  `).get();
  const sql = row?.sql || '';
  if (sql.includes('account_id') && !sql.includes('bot_id TEXT UNIQUE')) {
    addColIfMissing('wechat_accounts', 'user_id', 'INTEGER REFERENCES user_accounts(id) ON DELETE CASCADE');
    addColIfMissing('wechat_accounts', 'companion_id', 'INTEGER');
    db.prepare('UPDATE wechat_accounts SET user_id = account_id WHERE user_id IS NULL AND account_id IS NOT NULL').run();
    ensureIndexes();
    return;
  }

  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      db.exec(`
        ALTER TABLE wechat_accounts RENAME TO wechat_accounts_old;

        CREATE TABLE wechat_accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER REFERENCES user_accounts(id) ON DELETE CASCADE,
          user_id INTEGER REFERENCES user_accounts(id) ON DELETE CASCADE,
          wechat_user_id TEXT,
          bot_id TEXT NOT NULL,
          bot_token TEXT NOT NULL,
          companion_id INTEGER,
          display_name TEXT,
          avatar_url TEXT,
          login_session_id TEXT,
          is_active INTEGER DEFAULT 1,
          bound_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO wechat_accounts
          (id, bot_id, bot_token, display_name, is_active, created_at, updated_at)
        SELECT id, bot_id, bot_token, display_name, is_active, created_at, created_at
        FROM wechat_accounts_old;

        DROP TABLE wechat_accounts_old;
      `);
    });
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }

  ensureIndexes();
}

function migrateCompanions() {
  const cols = [
    // 上轮已有字段 ↓
    ['age',                   'INTEGER DEFAULT 20'],
    ['role_title',            "TEXT DEFAULT '邻家女孩'"],
    ['avatar_url',            'TEXT'],
    ['hair_color',            "TEXT DEFAULT '黑色'"],
    ['hair_style',            "TEXT DEFAULT '长发'"],
    ['eye_color',             "TEXT DEFAULT '棕色'"],
    ['body_type',             "TEXT DEFAULT '匀称'"],
    ['height',                'INTEGER DEFAULT 165'],
    ['clothing_style',        "TEXT DEFAULT '甜美'"],
    ['personality_tags',      'TEXT DEFAULT \'["温柔","体贴"]\''],
    ['mbti',                  'TEXT'],
    ['introvert_level',       'INTEGER DEFAULT 5'],
    ['intimacy_level',        "TEXT DEFAULT '慢慢熟悉'"],
    ['speech_styles',         'TEXT DEFAULT \'["自然口语"]\''],
    ['use_emoji_level',       'INTEGER DEFAULT 5'],
    ['use_kaomoji',           'INTEGER DEFAULT 0'],
    ['reply_length',          "TEXT DEFAULT '适中(3-4句)'"],
    ['can_joke',              'INTEGER DEFAULT 1'],
    ['avoid_cheesy',          'INTEGER DEFAULT 0'],
    ['no_pressure',           'INTEGER DEFAULT 0'],
    ['occasional_tantrum',    'INTEGER DEFAULT 0'],
    ['encouraging',           'INTEGER DEFAULT 1'],
    ['nsfw_level',            'INTEGER DEFAULT 0'],
    ['hobbies',               "TEXT DEFAULT '[]'"],
    ['favorite_food',         'TEXT'],
    ['favorite_music',        'TEXT'],
    ['pet_preference',        'TEXT'],
    ['how_met',               'TEXT'],
    ['relationship_status',   "TEXT DEFAULT '普通朋友'"],
    ['shared_memory',         'TEXT'],
    ['memory_priorities',     'TEXT DEFAULT \'["我的喜好","情绪变化"]\''],
    ['proactive_enabled',     'INTEGER DEFAULT 1'],
    ['proactive_frequency',   "TEXT DEFAULT '适中'"],
    ['proactive_time_window', "TEXT DEFAULT '07:30-24:00'"],
    ['voice_reply_enabled',   'INTEGER DEFAULT 0'],
    ['sticker_reply_enabled', 'INTEGER DEFAULT 0'],
    ['call_user_as',          "TEXT DEFAULT '你'"],
    ['user_call_her_as',      'TEXT'],
    ['forbidden_topics',      "TEXT DEFAULT '[]'"],
    ['updated_at',            'DATETIME DEFAULT CURRENT_TIMESTAMP'],
    // 本轮新增字段 ↓
    ['memory_enabled',        'INTEGER DEFAULT 1'],
    ['current_mood',          "TEXT DEFAULT '平静'"],
    ['mood_updated_at',       'DATETIME'],
    ['affection_level',       'INTEGER DEFAULT 0'],
    ['relationship_stage',    "TEXT DEFAULT '陌生人'"],
    ['current_scene',         "TEXT DEFAULT '在家'"],
    ['scene_history',         "TEXT DEFAULT '[]'"],
    ['backstory',             'TEXT'],
    ['family_background',     'TEXT'],
    ['education',             'TEXT'],
    ['secrets',               'TEXT'],
    ['voice_style',           "TEXT DEFAULT '温柔'"],
    ['voice_speed',           'REAL DEFAULT 1.0'],
    ['chat_modes',            'TEXT DEFAULT \'["日常聊天"]\''],
    ['chat_mode_active',      "TEXT DEFAULT '日常聊天'"],
    // v1.7.0: 她不喜欢的东西（话题/食物/类型/人格特质），聊到时她会直接说不喜欢
    // 而不是假装共鸣。与 forbidden_topics 区别：forbidden 是"完全不聊"，dislikes
    // 是"会聊但表达不喜欢"。
    ['dislikes',              "TEXT DEFAULT '[]'"],
  ];
  for (const [col, def] of cols) addColIfMissing('companions', col, def);
}

function migrateCompanionMemoriesV2() {
  // 语义检索 + pin 机制需要的新列
  addColIfMissing('companion_memories', 'pinned', 'INTEGER DEFAULT 0');
  addColIfMissing('companion_memories', 'keywords', 'TEXT');
  addColIfMissing('companion_memories', 'embedding', 'BLOB');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_pinned ON companion_memories(companion_id, pinned DESC, importance DESC)`);
}

function migrateDailyScheduleV2() {
  addColIfMissing('companion_daily_schedule', 'mood_segments', 'TEXT');
}

function migrateConfessionFields() {
  addColIfMissing('companions', 'confessed_at', 'DATETIME');
  addColIfMissing('companions', 'user_confessed_at', 'DATETIME');
  // v1.x 关系节奏：每日好感上限 + 升恋人时间（深爱时间门槛用）
  addColIfMissing('companions', 'affection_day', 'TEXT');
  addColIfMissing('companions', 'affection_today', 'INTEGER DEFAULT 0');
  addColIfMissing('companions', 'became_lover_at', 'DATETIME');
  addColIfMissing('companions', 'last_photo_at', 'DATETIME');
  addColIfMissing('companions', 'last_photo_caption', 'TEXT');
  // v1.16.x: 「窗口将关·临门一脚」防重复标记（unix 秒）。> last_user_reply_at 即本离开周期已发过。
  addColIfMissing('companions', 'last_lastcall_at', 'INTEGER');
}

// ─── Memory v3：分层 / 权重 / 状态 / 遗忘曲线 ─────────────────────────────────
function migrateMemoryV3() {
  addColIfMissing('companion_memories', 'memory_layer',  "TEXT DEFAULT 'event'");
  addColIfMissing('companion_memories', 'memory_weight', 'INTEGER DEFAULT 3');
  addColIfMissing('companion_memories', 'memory_status', "TEXT DEFAULT 'active'");
  addColIfMissing('companion_memories', 'memory_source', "TEXT DEFAULT 'auto'");
  // v1.x 修(#1)：回填存量 memory_layer（此前 saveMemories 没写 layer，全卡在 'event'）。
  // 只动"被错标成 event 但 type 不是 event/image"的行，幂等（修对后不再匹配）。
  try {
    db.prepare(`
      UPDATE companion_memories SET memory_layer = CASE memory_type
        WHEN 'fact' THEN 'user_fact'
        WHEN 'preference' THEN 'preference'
        WHEN 'emotion' THEN 'emotion'
        WHEN 'daily_summary' THEN 'summary'
        WHEN 'weekly_summary' THEN 'summary'
        WHEN 'monthly_summary' THEN 'summary'
        ELSE 'event' END
      WHERE memory_layer IS NULL
         OR (memory_layer = 'event' AND memory_type NOT IN ('event','image'))
    `).run();
  } catch (e) { /* 表/列尚未就绪时忽略，下次启动再回填 */ }
  addColIfMissing('companion_memories', 'locked',        'INTEGER DEFAULT 0');
  addColIfMissing('companion_memories', 'do_not_mention','INTEGER DEFAULT 0');
  addColIfMissing('companion_memories', 'conflict_of',   'INTEGER');
  addColIfMissing('companion_memories', 'last_used_at',  'TEXT');
  addColIfMissing('companion_memories', 'use_count',     'INTEGER DEFAULT 0');
  addColIfMissing('companion_memories', 'decay_score',   'REAL DEFAULT 1.0');
  addColIfMissing('companion_memories', 'sensitive_flag','INTEGER DEFAULT 0');
  addColIfMissing('companion_memories', 'updated_at',    'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_companion_layer_status
      ON companion_memories(companion_id, memory_layer, memory_status);
    CREATE INDEX IF NOT EXISTS idx_memories_companion_weight
      ON companion_memories(companion_id, memory_weight DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_companion_locked
      ON companion_memories(companion_id, locked, pinned);
    CREATE INDEX IF NOT EXISTS idx_memories_companion_last_used
      ON companion_memories(companion_id, last_used_at DESC);
  `);
}

// ─── Emotion State Machine ─────────────────────────────────────────────────────
function migrateEmotionState() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_emotion_state (
      companion_id INTEGER PRIMARY KEY REFERENCES companions(id) ON DELETE CASCADE,
      affection    INTEGER DEFAULT 0,
      trust        INTEGER DEFAULT 50,
      dependency   INTEGER DEFAULT 30,
      possessiveness INTEGER DEFAULT 20,
      security     INTEGER DEFAULT 50,
      energy       INTEGER DEFAULT 60,
      mood         TEXT    DEFAULT 'neutral',
      updated_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // v1.6: 扩 4 维 — patience（耐心）/ excitement（兴奋短期）/ annoyance（烦躁短期）/ gratitude（感激）
  addColIfMissing('companion_emotion_state', 'patience',   'INTEGER DEFAULT 60');
  addColIfMissing('companion_emotion_state', 'excitement', 'INTEGER DEFAULT 30');
  addColIfMissing('companion_emotion_state', 'annoyance',  'INTEGER DEFAULT 0');
  addColIfMissing('companion_emotion_state', 'gratitude',  'INTEGER DEFAULT 40');
  // v1.8.0 #1: 即时状态 — 她此刻是否方便聊天 / 注意力是否在你身上
  // availability: free / busy / half  （free=完全有空，busy=在忙真不便，half=能回但分心）
  // attention:    0-100  （对你这次消息的注意力。低 → 回复短/略走神/略有延迟感）
  addColIfMissing('companion_emotion_state', 'availability', "TEXT DEFAULT 'free'");
  addColIfMissing('companion_emotion_state', 'attention',    'INTEGER DEFAULT 80');
  // v1.14.3 (C): mood 强度 0-100 —— 让情绪有"惯性"，不被弱刺激一句话切换；负面退出慢。
  addColIfMissing('companion_emotion_state', 'mood_intensity', 'INTEGER DEFAULT 0');
}

// ─── Proactive Engine v2 ───────────────────────────────────────────────────────
function migrateProactiveEngineV2() {
  addColIfMissing('companions', 'proactive_intensity',    "TEXT DEFAULT 'normal'");
  // v1.14 依恋风格：secure（安全型·默认）/ anxious（焦虑型·黏·被冷落时升级快·更追）/ avoidant（回避型·早抽离·话变冷·不示弱）
  addColIfMissing('companions', 'attachment_style',       "TEXT DEFAULT 'secure'");
  // v1.19.3 初恋特质：1=她从没谈过恋爱、你是她初恋（笨拙earnest、珍惜firsts、不会套路）；0=关闭。默认开。
  addColIfMissing('companions', 'first_love',             'INTEGER DEFAULT 1');
  // v1.13 双语：界面/AI 语言（'zh' | 'en'），默认中文
  addColIfMissing('companions', 'locale',                 "TEXT DEFAULT 'zh'");
  addColIfMissing('companions', 'last_user_reply_at',     'TEXT');
  addColIfMissing('companions', 'last_proactive_reply_at','TEXT');
  addColIfMissing('companions', 'missing_score',          'REAL DEFAULT 0');
}

// ─── Emotion History ──────────────────────────────────────────────────────────
function migrateEmotionHistory() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_emotion_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      affection    INTEGER,
      trust        INTEGER,
      dependency   INTEGER,
      possessiveness INTEGER,
      security     INTEGER,
      energy       INTEGER,
      mood         TEXT,
      source       TEXT DEFAULT 'auto',
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_emotion_history_companion_created
      ON companion_emotion_history(companion_id, created_at DESC);
  `);
  // v1.6: 历史表也加 4 维（旧行保持 NULL）
  addColIfMissing('companion_emotion_history', 'patience',   'INTEGER');
  addColIfMissing('companion_emotion_history', 'excitement', 'INTEGER');
  addColIfMissing('companion_emotion_history', 'annoyance',  'INTEGER');
  addColIfMissing('companion_emotion_history', 'gratitude',  'INTEGER');
}

export function insertEmotionHistory(companionId, state, source = 'auto') {
  const db = getDb();
  db.prepare(`
    INSERT INTO companion_emotion_history
      (companion_id, affection, trust, dependency, possessiveness, security, energy, mood,
       patience, excitement, annoyance, gratitude,
       source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    companionId,
    state.affection   ?? null,
    state.trust       ?? null,
    state.dependency  ?? null,
    state.possessiveness ?? null,
    state.security    ?? null,
    state.energy      ?? null,
    state.mood        ?? null,
    state.patience    ?? null,
    state.excitement  ?? null,
    state.annoyance   ?? null,
    state.gratitude   ?? null,
    source,
    new Date().toISOString(),
  );
}

export function getEmotionHistoryTrend(companionId, days = 7) {
  const db = getDb();
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  return db.prepare(`
    SELECT id, companion_id, affection, trust, dependency, possessiveness, security, energy, mood, source, created_at
    FROM companion_emotion_history
    WHERE companion_id = ? AND created_at >= ?
    ORDER BY created_at ASC
  `).all(companionId, since);
}

export function getLastEmotionHistoryAt(companionId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT created_at FROM companion_emotion_history
    WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(companionId);
  return row?.created_at ?? null;
}

export function cleanupOldEmotionHistory(companionId) {
  const db = getDb();
  const cutoff = new Date(Date.now() - 90 * 86400_000).toISOString();
  db.prepare(`DELETE FROM companion_emotion_history WHERE companion_id = ? AND created_at < ?`)
    .run(companionId, cutoff);
}

// ─── Diary（她的日记）─────────────────────────────────────────────────────────
// 每天 / 每周由 src/diary.mjs 用她的人设口吻写的第一人称日记。
// UNIQUE(companion_id, date_key, kind) 保证同一天同类型只有一篇，重跑覆盖（幂等）。
function migrateDiary() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_diary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      user_id INTEGER,
      date_key TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'daily',
      mood TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(companion_id, date_key, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_diary_companion_date
      ON companion_diary(companion_id, date_key DESC);
  `);
}

export function upsertDiaryEntry({ companionId, userId = null, dateKey, kind = 'daily', mood = null, content }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO companion_diary (companion_id, user_id, date_key, kind, mood, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(companion_id, date_key, kind) DO UPDATE SET
      mood = excluded.mood,
      content = excluded.content,
      created_at = excluded.created_at
  `).run(companionId, userId, dateKey, kind, mood, String(content).slice(0, 2000), new Date().toISOString());
  return db.prepare('SELECT * FROM companion_diary WHERE companion_id = ? AND date_key = ? AND kind = ?')
    .get(companionId, dateKey, kind);
}

export function getDiaryEntry(companionId, dateKey, kind = 'daily') {
  const db = getDb();
  return db.prepare('SELECT * FROM companion_diary WHERE companion_id = ? AND date_key = ? AND kind = ?')
    .get(companionId, dateKey, kind) || null;
}

export function getDiaryEntries(companionId, { limit = 30, offset = 0, kind = null } = {}) {
  const db = getDb();
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  if (kind) {
    return db.prepare(`
      SELECT id, companion_id, date_key, kind, mood, content, created_at
      FROM companion_diary WHERE companion_id = ? AND kind = ?
      ORDER BY date_key DESC, id DESC LIMIT ? OFFSET ?
    `).all(companionId, kind, safeLimit, safeOffset);
  }
  return db.prepare(`
    SELECT id, companion_id, date_key, kind, mood, content, created_at
    FROM companion_diary WHERE companion_id = ?
    ORDER BY date_key DESC, id DESC LIMIT ? OFFSET ?
  `).all(companionId, safeLimit, safeOffset);
}

export function countDiaryEntries(companionId, { kind = null } = {}) {
  const db = getDb();
  if (kind) {
    return db.prepare('SELECT COUNT(*) AS n FROM companion_diary WHERE companion_id = ? AND kind = ?')
      .get(companionId, kind).n;
  }
  return db.prepare('SELECT COUNT(*) AS n FROM companion_diary WHERE companion_id = ?')
    .get(companionId).n;
}

// ─── P2 Tables (achievements, event graph) ───────────────────────────────────
function migrateP2Tables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL,
      achievement_key TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      metadata_json TEXT,
      UNIQUE(companion_id, achievement_key)
    );
    CREATE INDEX IF NOT EXISTS idx_achievements_companion
      ON companion_achievements(companion_id, unlocked_at DESC);

    CREATE TABLE IF NOT EXISTS memory_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      name TEXT NOT NULL,
      aliases_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entities_companion
      ON memory_entities(companion_id, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entities_uniq
      ON memory_entities(companion_id, entity_type, name);

    CREATE TABLE IF NOT EXISTS memory_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL,
      source_entity_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      target_entity_id INTEGER NOT NULL,
      evidence_memory_id INTEGER,
      confidence REAL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_memory_relations_companion
      ON memory_relations(companion_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_relations_source
      ON memory_relations(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_memory_relations_target
      ON memory_relations(target_entity_id);
  `);
}

function migrateAppSettings() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      value_type TEXT NOT NULL DEFAULT 'string',
      secret INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function initAvatarPresets() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS avatar_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL UNIQUE,
      prompt TEXT NOT NULL,
      age_range TEXT,                    -- 'teen' / 'college' / 'young_pro'
      hair_color TEXT,                   -- 'black' / 'brown' / 'blonde' / 'pink' / ...
      hair_style TEXT,                   -- 'long' / 'short' / 'twin_tail' / 'curly' / 'bob' / 'ponytail'
      vibe TEXT,                         -- 'sweet' / 'cool' / 'energetic' / 'gentle' / 'tsundere' / 'mature'
      style TEXT,                        -- 'ghibli' / 'pixiv' / 'kyoani' / 'watercolor' / 'modern'
      clothing TEXT,                     -- 'school' / 'casual' / 'sweet' / 'cool' / 'literary'
      score REAL DEFAULT 0,              -- Gemini Vision 评分 0-10
      score_notes TEXT,                  -- 评分理由
      embedding BLOB,                    -- 768 维（基于 prompt 的语义向量，用于匹配）
      enabled INTEGER DEFAULT 1,         -- 评分 < 7 的被禁用
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_avatar_presets_enabled_score ON avatar_presets(enabled, score DESC);
    CREATE INDEX IF NOT EXISTS idx_avatar_presets_vibe ON avatar_presets(vibe);
  `);
}

function migrateCompanionMemories() {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'companion_memories'
  `).get();
  const sql = row?.sql || '';
  if (!sql || sql.includes("'monthly_summary'")) return;

  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      db.exec(`
        ALTER TABLE companion_memories RENAME TO companion_memories_old;

        CREATE TABLE companion_memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          companion_id INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          memory_type TEXT NOT NULL CHECK(memory_type IN ('fact','preference','event','emotion','image','daily_summary','weekly_summary','monthly_summary')),
          content TEXT NOT NULL,
          importance INTEGER DEFAULT 5 CHECK(importance BETWEEN 1 AND 10),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO companion_memories (id, companion_id, user_id, memory_type, content, importance, created_at)
        SELECT id, companion_id, user_id, memory_type, content, importance, created_at
        FROM companion_memories_old;

        DROP TABLE companion_memories_old;
      `);
    });
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_companion ON companion_memories(companion_id, user_id, importance DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_created   ON companion_memories(created_at DESC);
  `);
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────
function parseJson(v, fallback = []) {
  if (Array.isArray(v) || (fallback !== null && typeof fallback === 'object' && !Array.isArray(fallback) && typeof v === 'object')) return v;
  if (typeof v !== 'string') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function toJson(v) {
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v)); } catch { return v; }
  }
  return JSON.stringify(v ?? []);
}

// ─── 字段集合 ─────────────────────────────────────────────────────────────────
const JSON_ARRAY_FIELDS = new Set([
  'personality_tags', 'speech_styles', 'hobbies', 'memory_priorities', 'forbidden_topics',
  'scene_history', 'chat_modes',
  'dislikes',  // v1.7.0: 她不喜欢的话题/食物/类型/人格特质
]);
const BOOL_FIELDS = new Set([
  'use_kaomoji', 'can_joke', 'avoid_cheesy', 'no_pressure', 'occasional_tantrum',
  'encouraging', 'proactive_enabled', 'voice_reply_enabled', 'sticker_reply_enabled',
  'memory_enabled', 'silent_mode',
]);
const ALLOWED_FIELDS = new Set([
  'name', 'age', 'role_title', 'avatar_url',
  'hair_color', 'hair_style', 'eye_color', 'body_type', 'height', 'clothing_style',
  'personality_tags', 'mbti', 'introvert_level',
  'intimacy_level',
  'speech_styles', 'use_emoji_level', 'use_kaomoji', 'reply_length',
  'can_joke', 'avoid_cheesy', 'no_pressure', 'occasional_tantrum', 'encouraging', 'nsfw_level',
  'hobbies', 'favorite_food', 'favorite_music', 'pet_preference',
  'how_met', 'relationship_status', 'shared_memory',
  'memory_priorities',
  'proactive_enabled', 'proactive_frequency', 'proactive_time_window', 'proactive_daily_target',
  'attachment_style', 'first_love',
  'silent_mode',
  'voice_reply_enabled', 'voice_id',
  'voice_reply_enabled', 'sticker_reply_enabled',
  'call_user_as', 'user_call_her_as',
  'persona_prompt', 'forbidden_topics', 'dislikes',
  // 新增
  'memory_enabled', 'current_mood', 'affection_level', 'relationship_stage',
  'current_scene', 'scene_history', 'backstory', 'family_background', 'education', 'secrets',
  'voice_style', 'voice_speed', 'chat_modes', 'chat_mode_active',
  'temperature', 'max_tokens', 'top_p',
]);

function buildUpsertFields(data) {
  const cols = [], values = [];
  for (const [k, v] of Object.entries(data)) {
    if (!ALLOWED_FIELDS.has(k)) continue;
    cols.push(k);
    if (JSON_ARRAY_FIELDS.has(k)) values.push(toJson(v));
    else if (BOOL_FIELDS.has(k))  values.push(v ? 1 : 0);
    else                           values.push(v ?? null);
  }
  return { cols, placeholders: cols.map(() => '?'), values };
}

/** 解析 DB 行为 JS 对象（JSON 字段 + bool 字段） */
export function parseCompanionRow(row) {
  if (!row) return null;
  return {
    ...row,
    personality_tags:     parseJson(row.personality_tags, []),
    speech_styles:        parseJson(row.speech_styles, []),
    hobbies:              parseJson(row.hobbies, []),
    memory_priorities:    parseJson(row.memory_priorities, []),
    forbidden_topics:     parseJson(row.forbidden_topics, []),
    dislikes:             parseJson(row.dislikes, []),
    scene_history:        parseJson(row.scene_history, []),
    chat_modes:           parseJson(row.chat_modes, []),
    use_kaomoji:           !!row.use_kaomoji,
    can_joke:              !!row.can_joke,
    avoid_cheesy:          !!row.avoid_cheesy,
    no_pressure:           !!row.no_pressure,
    occasional_tantrum:    !!row.occasional_tantrum,
    encouraging:           !!row.encouraging,
    proactive_enabled:     !!row.proactive_enabled,
    voice_reply_enabled:   !!row.voice_reply_enabled,
    sticker_reply_enabled: !!row.sticker_reply_enabled,
    memory_enabled:        !!row.memory_enabled,
    silent_mode:           !!row.silent_mode,
  };
}

// ─── poll_state（per bot_id） ────────────────────────────────────────────────
export function upsertPollBuf(botId, buf) {
  if (!botId) return;
  const db = getDb();
  db.prepare(`
    INSERT INTO poll_state (bot_id, buf, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(bot_id) DO UPDATE SET
      buf = excluded.buf,
      updated_at = CURRENT_TIMESTAMP
  `).run(botId, buf || '');
}

export function getPollBuf(botId) {
  if (!botId) return null;
  const db = getDb();
  const row = db.prepare('SELECT buf FROM poll_state WHERE bot_id = ? LIMIT 1').get(botId);
  return row?.buf || null;
}

export function clearPollBuf(botId) {
  if (!botId) return 0;
  const db = getDb();
  return db.prepare('DELETE FROM poll_state WHERE bot_id = ?').run(botId).changes;
}

// ─── 获取所有 active 绑定（multi-tenant polling pool） ──────────────────────
export function getActiveBotAccounts() {
  const db = getDb();
  return db.prepare(`
    SELECT
      account_id,
      user_id,
      wechat_user_id,
      bot_id,
      bot_token,
      companion_id,
      display_name,
      datetime(updated_at) AS updated_at
    FROM wechat_accounts
    WHERE is_active = 1
      AND bot_id IS NOT NULL
      AND bot_token IS NOT NULL
      AND bot_token <> ''
    ORDER BY updated_at DESC
  `).all();
}

export function getActiveBotByAccountId(accountId) {
  if (!accountId) return null;
  const db = getDb();
  return db.prepare(`
    SELECT account_id, user_id, wechat_user_id, bot_id, bot_token, companion_id
    FROM wechat_accounts
    WHERE account_id = ? AND is_active = 1 AND bot_token IS NOT NULL AND bot_token <> ''
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(accountId);
}

/**
 * For proactive sender: find the bot ctx that owns this companion.
 * Returns { token, botId, baseUrl, wechatUserId } or null.
 *
 * v1.9.5 安全修复：与 v1.9.4 同类 — 之前版本含
 * `wa.wechat_user_id = u.wechat_user_id` 隐式 JOIN（"绑了同微信号 =
 * 共享 bot context"），可让 proactive 在数据脏时给 companion A 使用
 * companion B 的 bot_token，把消息发到错误的微信号去。
 *
 * 新规则：只显式 wa.companion_id = ?。如果该 companion 没有 active
 * wechat 绑定行（通常意味着用户还没绑微信，或绑定被停用），返回 null
 * → proactive 主流程会跳过本次发送，是合理 fallback。
 */
export function getBotContextForCompanion(companionId) {
  if (!companionId) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT bot_id, bot_token, wechat_user_id
    FROM wechat_accounts
    WHERE is_active = 1
      AND companion_id = ?
      AND bot_token IS NOT NULL AND bot_token <> ''
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(companionId);
  if (!row) return null;
  return {
    token: row.bot_token,
    botId: row.bot_id,
    wechatUserId: row.wechat_user_id,
  };
}

// ─── email verification codes ────────────────────────────────────────────────
export function getLastVerificationSend(email) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM email_verification_sends
    WHERE email = ?
    ORDER BY sent_at_ms DESC
    LIMIT 1
  `).get(email);
}

export function countVerificationSendsSince(email, sinceMs) {
  const db = getDb();
  return db.prepare(`
    SELECT COUNT(*) AS n FROM email_verification_sends
    WHERE email = ? AND sent_at_ms >= ?
  `).get(email, sinceMs)?.n ?? 0;
}

export function saveVerificationCode({ email, purpose, codeHash, expiresAtMs, sentAtMs }) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO email_verification_codes (email, purpose, code_hash, expires_at_ms, sent_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(email, purpose) DO UPDATE SET
        code_hash = excluded.code_hash,
        expires_at_ms = excluded.expires_at_ms,
        sent_at_ms = excluded.sent_at_ms
    `).run(email, purpose, codeHash, expiresAtMs, sentAtMs);

    db.prepare(`
      INSERT INTO email_verification_sends (email, purpose, sent_at_ms)
      VALUES (?, ?, ?)
    `).run(email, purpose, sentAtMs);

    db.prepare('DELETE FROM email_verification_codes WHERE expires_at_ms < ?').run(sentAtMs);
    db.prepare('DELETE FROM email_verification_sends WHERE sent_at_ms < ?').run(sentAtMs - 24 * 60 * 60 * 1000);
  });
  tx();
}

export function getVerificationCode(email, purpose) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM email_verification_codes
    WHERE email = ? AND purpose = ?
  `).get(email, purpose);
}

export function deleteVerificationCode(email, purpose) {
  const db = getDb();
  db.prepare('DELETE FROM email_verification_codes WHERE email = ? AND purpose = ?').run(email, purpose);
}

// v1.11.0 安全(M1)：验证码每次校验失败调用一次；尝试数 +1，达上限即作废该码，
// 让 6 位码无法被无限暴力穷举（配合 verify-code 端点限流）。
export const MAX_CODE_ATTEMPTS = 5;
export function bumpVerificationAttempt(email, purpose) {
  const db = getDb();
  db.prepare('UPDATE email_verification_codes SET attempts = COALESCE(attempts, 0) + 1 WHERE email = ? AND purpose = ?')
    .run(email, purpose);
  const row = db.prepare('SELECT attempts FROM email_verification_codes WHERE email = ? AND purpose = ?').get(email, purpose);
  if (row && row.attempts >= MAX_CODE_ATTEMPTS) {
    db.prepare('DELETE FROM email_verification_codes WHERE email = ? AND purpose = ?').run(email, purpose);
  }
}

// ─── user accounts ───────────────────────────────────────────────────────────
function publicAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createUserAccount({ username, email, passwordHash, birthday = null, ageAtRegistration = null, termsVersion = null }) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO user_accounts (username, email, password_hash, birthday, age_at_registration, terms_accepted_at, terms_version)
    VALUES (?, ?, ?, ?, ?, CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP ELSE NULL END, ?)
  `).run(username, email, passwordHash, birthday, ageAtRegistration, termsVersion, termsVersion);
  return getUserAccountById(info.lastInsertRowid);
}

/**
 * 单用户模式 (v1.5.1) 用：找/创建一个"主人"账号，作为 SINGLE_USER=true 时自动登录的身份。
 * - 已有任意账号 → 返回 ID 最小且未被封禁的（一般是最早注册的，等价于 admin）
 * - 没有账号 → 创建一个 owner，密码用随机 hash 占位（用户从不用密码登）
 * 注意：调用方应自行先判断 process.env.SINGLE_USER === 'true'，本函数不做环境变量检查。
 */
export function getOrCreateSingleUserOwner() {
  const db = getDb();
  const existing = db.prepare(`
    SELECT * FROM user_accounts
    WHERE COALESCE(is_banned, 0) = 0
    ORDER BY id ASC LIMIT 1
  `).get();
  if (existing) return existing;
  // 创建一个 owner 账号 — 密码 hash 是随机 32 字节 hex，用户永远不会用它登录
  const randomHash = 'single-user-no-password-' + (Math.random().toString(36).slice(2) + Date.now().toString(36));
  return createUserAccount({
    username: 'owner',
    email: 'owner@local',
    passwordHash: randomHash,
    termsVersion: 'single-user-mode',
  });
}

/**
 * 年龄相关 helper：根据 user_accounts.birthday + age_at_registration 返回
 *   { age, isMinor, canNsfw }
 *   - 用户没填生日 → 当成年处理（用户协议已写明禁未成年；不强制 KYC）
 *   - 填了生日 < 16 → canNsfw=false（仍强制 NSFW=0）
 *   - 填了生日 >= 16 → canNsfw=true
 */
export function getUserAgeStatus(accountId) {
  if (!accountId) return { age: null, isMinor: false, canNsfw: true, ageKnown: false };
  const db = getDb();
  const row = db.prepare('SELECT birthday, age_at_registration FROM user_accounts WHERE id = ?').get(accountId);
  if (!row) return { age: null, isMinor: false, canNsfw: true, ageKnown: false };

  let age = null;
  if (row.birthday && /^\d{4}-\d{2}-\d{2}$/.test(row.birthday)) {
    const [y, m, d] = row.birthday.split('-').map(Number);
    const now = new Date();
    age = now.getUTCFullYear() - y;
    const md = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
    const bmd = m * 100 + d;
    if (md < bmd) age -= 1;
  } else if (Number.isInteger(row.age_at_registration)) {
    age = row.age_at_registration;
  }
  const ageKnown = age != null;
  // 没填生日 = 默认按成年处理（协议层禁未成年）
  const canNsfw = !ageKnown || age >= 16;
  const isMinor = ageKnown && age < 18;
  return { age, isMinor, canNsfw, ageKnown };
}

export function getUserAccountById(id) {
  const db = getDb();
  return publicAccount(db.prepare('SELECT * FROM user_accounts WHERE id = ?').get(id));
}

export function getUserAccountByUsername(username) {
  const db = getDb();
  return publicAccount(db.prepare('SELECT * FROM user_accounts WHERE username = ?').get(username));
}

export function getUserAccountByEmail(email) {
  const db = getDb();
  return publicAccount(db.prepare('SELECT * FROM user_accounts WHERE email = ?').get(email));
}

export function getUserAccountWithPassword(account) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM user_accounts
    WHERE username = ? OR email = ?
    LIMIT 1
  `).get(account, account);
}

export function updateUserPassword(accountId, passwordHash) {
  const db = getDb();
  const info = db.prepare(`
    UPDATE user_accounts
    SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(passwordHash, accountId);
  return info.changes > 0;
}

export function setAccountBanned(accountId, banned, reason = null) {
  const db = getDb();
  const info = db.prepare(`
    UPDATE user_accounts
    SET is_banned = ?, banned_reason = ?, banned_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(banned ? 1 : 0, banned ? (reason || null) : null, banned ? 1 : 0, accountId);
  return info.changes > 0;
}

export function isAccountBanned(accountId) {
  const db = getDb();
  const row = db.prepare('SELECT is_banned FROM user_accounts WHERE id = ?').get(accountId);
  return !!(row && row.is_banned);
}

export function listAllAccounts({ limit = 200, offset = 0, search = null } = {}) {
  const db = getDb();
  const params = [];
  let where = '';
  if (search) {
    where = 'WHERE username LIKE ? OR email LIKE ?';
    params.push(`%${search}%`, `%${search}%`);
  }
  params.push(limit, offset);
  return db.prepare(`
    SELECT id, username, email, is_banned, banned_reason, banned_at,
           created_at, updated_at
    FROM user_accounts
    ${where}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(...params);
}

export function countAllAccounts(search = null) {
  const db = getDb();
  if (search) {
    return db.prepare('SELECT COUNT(*) AS n FROM user_accounts WHERE username LIKE ? OR email LIKE ?')
      .get(`%${search}%`, `%${search}%`).n;
  }
  return db.prepare('SELECT COUNT(*) AS n FROM user_accounts').get().n;
}

// ─── AI 用量统计（管理员页面用）────────────────────────────────────────────────
export function recordAiUsage({ accountId, promptTokens = 0, completionTokens = 0, messages = 1, day = null }) {
  if (!accountId) return;
  const db = getDb();
  const dayStr = day || new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO ai_usage_daily (account_id, day, prompt_tokens, completion_tokens, message_count)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, day) DO UPDATE SET
      prompt_tokens     = prompt_tokens + excluded.prompt_tokens,
      completion_tokens = completion_tokens + excluded.completion_tokens,
      message_count     = message_count + excluded.message_count,
      updated_at        = CURRENT_TIMESTAMP
  `).run(accountId, dayStr, promptTokens | 0, completionTokens | 0, messages | 0);
}

/**
 * P1-7：记录一条 AI 用量明细（含 provider/model/capability/延迟/状态 + 估算成本）。
 * best-effort：任何异常都吞掉，绝不影响主请求。accountId 可空（系统调用也记，成本才全）。
 */
export function recordAiUsageEvent({
  accountId = null, companionId = null, provider = '', model = '', capability = 'chat',
  promptTokens = 0, completionTokens = 0, images = 0, audioSeconds = 0,
  latencyMs = null, status = 'ok',
} = {}) {
  try {
    const modelType = capability === 'image' ? 'image' : 'chat'; // pricing 表按 chat/image 计价
    const { estimated_cost, currency } = estimateProviderCost(
      { provider, model_type: modelType, prompt_tokens: promptTokens, completion_tokens: completionTokens, images },
      loadProviderPricing(),
    );
    getDb().prepare(`
      INSERT INTO ai_usage_events
        (account_id, companion_id, provider, model, capability, prompt_tokens, completion_tokens,
         images, audio_seconds, latency_ms, status, estimated_cost, currency, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      accountId, companionId, String(provider || ''), String(model || ''), String(capability || 'chat'),
      promptTokens | 0, completionTokens | 0, images | 0, audioSeconds | 0,
      latencyMs == null ? null : (latencyMs | 0), String(status || 'ok'), estimated_cost, currency, Date.now(),
    );
  } catch { /* best-effort，绝不让计量打断主流程 */ }
}

export function cleanupAiUsageEvents(days = 60) {
  try {
    return getDb().prepare('DELETE FROM ai_usage_events WHERE created_at < ?')
      .run(Date.now() - days * 86_400_000).changes;
  } catch { return 0; }
}

export function getAccountUsageSummary(accountId) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const todayRow = db.prepare(`
    SELECT prompt_tokens, completion_tokens, message_count
    FROM ai_usage_daily WHERE account_id = ? AND day = ?
  `).get(accountId, today) || { prompt_tokens: 0, completion_tokens: 0, message_count: 0 };

  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
           COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
           COALESCE(SUM(message_count), 0) AS message_count
    FROM ai_usage_daily WHERE account_id = ?
  `).get(accountId) || { prompt_tokens: 0, completion_tokens: 0, message_count: 0 };

  return {
    today: {
      prompt_tokens: todayRow.prompt_tokens || 0,
      completion_tokens: todayRow.completion_tokens || 0,
      total_tokens: (todayRow.prompt_tokens || 0) + (todayRow.completion_tokens || 0),
      message_count: todayRow.message_count || 0,
    },
    total: {
      prompt_tokens: totalRow.prompt_tokens || 0,
      completion_tokens: totalRow.completion_tokens || 0,
      total_tokens: (totalRow.prompt_tokens || 0) + (totalRow.completion_tokens || 0),
      message_count: totalRow.message_count || 0,
    },
  };
}

export function getAccountUsageHistory(accountId, days = 30) {
  const db = getDb();
  return db.prepare(`
    SELECT day, prompt_tokens, completion_tokens,
           (prompt_tokens + completion_tokens) AS total_tokens,
           message_count
    FROM ai_usage_daily
    WHERE account_id = ?
    ORDER BY day DESC
    LIMIT ?
  `).all(accountId, days);
}

// ─── 今日日程 ────────────────────────────────────────────────────────────────
export function getDailySchedule(companionId, dateKey) {
  const db = getDb();
  const row = db.prepare(`
    SELECT schedule_json, mood_arc, mood_segments, generated_at
    FROM companion_daily_schedule
    WHERE companion_id = ? AND date_key = ?
  `).get(companionId, dateKey);
  if (!row) return null;
  try {
    return {
      items: JSON.parse(row.schedule_json),
      mood_arc: row.mood_arc,
      mood_segments: row.mood_segments ? JSON.parse(row.mood_segments) : null,
      generated_at: row.generated_at,
    };
  } catch { return null; }
}

export function saveDailySchedule(companionId, dateKey, items, moodArc, moodSegments = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO companion_daily_schedule (companion_id, date_key, schedule_json, mood_arc, mood_segments)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(companion_id, date_key) DO UPDATE SET
      schedule_json = excluded.schedule_json,
      mood_arc = excluded.mood_arc,
      mood_segments = excluded.mood_segments,
      generated_at = CURRENT_TIMESTAMP
  `).run(companionId, dateKey, JSON.stringify(items || []), moodArc || null, moodSegments ? JSON.stringify(moodSegments) : null);
}

// 取最近 N 天的日程（不含今天），用于 prompt 注入"她的近期生活"
export function getRecentSchedules(companionId, todayKey, days = 3) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT date_key, schedule_json, mood_arc
    FROM companion_daily_schedule
    WHERE companion_id = ? AND date_key < ?
    ORDER BY date_key DESC
    LIMIT ?
  `).all(companionId, todayKey, days);
  return rows.map(r => {
    try {
      return {
        date_key: r.date_key,
        items: JSON.parse(r.schedule_json),
        mood_arc: r.mood_arc,
      };
    } catch { return null; }
  }).filter(Boolean);
}

// ─── 关系阶段里程碑 ────────────────────────────────────────────────────────
export function saveStageMilestone({ companionId, fromStage, toStage, affection, daysSinceMeet }) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO companion_stage_milestones (companion_id, from_stage, to_stage, affection_at_upgrade, days_since_meet)
    VALUES (?, ?, ?, ?, ?)
  `).run(companionId, fromStage || null, toStage, affection || 0, daysSinceMeet || 0).lastInsertRowid;
}

export function getStageMilestones(companionId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, from_stage, to_stage, affection_at_upgrade, days_since_meet, created_at
    FROM companion_stage_milestones
    WHERE companion_id = ?
    ORDER BY created_at ASC
  `).all(companionId);
}

// ─── 元认知 / 人生背景 ─────────────────────────────────────────────────────
export function savePersonaFacts(companionId, facts) {
  if (!Array.isArray(facts) || facts.length === 0) return 0;
  const db = getDb();
  // 先清掉旧的（避免重复）
  db.prepare('DELETE FROM companion_persona_facts WHERE companion_id = ?').run(companionId);
  const stmt = db.prepare(`
    INSERT INTO companion_persona_facts (companion_id, category, content, sort_order)
    VALUES (?, ?, ?, ?)
  `);
  const tx = db.transaction(list => {
    list.forEach((f, i) => stmt.run(companionId, String(f.category || 'misc'), String(f.content || '').slice(0, 200), i));
  });
  tx(facts);
  return facts.length;
}

export function getPersonaFacts(companionId) {
  const db = getDb();
  return db.prepare(`
    SELECT category, content
    FROM companion_persona_facts
    WHERE companion_id = ?
    ORDER BY sort_order ASC
  `).all(companionId);
}

export function hasPersonaFacts(companionId) {
  const db = getDb();
  return db.prepare('SELECT 1 FROM companion_persona_facts WHERE companion_id = ? LIMIT 1').get(companionId) != null;
}

// ─── 表白状态 ──────────────────────────────────────────────────────────────
export function markUserConfessed(companionId) {
  const db = getDb();
  db.prepare(`UPDATE companions SET user_confessed_at = CURRENT_TIMESTAMP WHERE id = ? AND user_confessed_at IS NULL`).run(companionId);
}

export function markCompanionConfessed(companionId) {
  const db = getDb();
  db.prepare(`UPDATE companions SET confessed_at = CURRENT_TIMESTAMP WHERE id = ? AND confessed_at IS NULL`).run(companionId);
}

// ─── 头像预设池 ─────────────────────────────────────────────────────────────
export function insertAvatarPreset({ fileName, prompt, age_range, hair_color, hair_style, vibe, style, clothing, embedding = null }) {
  const db = getDb();
  const emb = embedding ? packEmbedding(embedding) : null;
  const info = db.prepare(`
    INSERT INTO avatar_presets (file_name, prompt, age_range, hair_color, hair_style, vibe, style, clothing, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_name) DO UPDATE SET
      prompt = excluded.prompt, age_range = excluded.age_range, hair_color = excluded.hair_color,
      hair_style = excluded.hair_style, vibe = excluded.vibe, style = excluded.style,
      clothing = excluded.clothing, embedding = excluded.embedding
  `).run(fileName, prompt, age_range, hair_color, hair_style, vibe, style, clothing, emb);
  return info.lastInsertRowid;
}

export function updateAvatarPresetScore(fileName, score, notes = '') {
  const db = getDb();
  const enabled = score >= 7 ? 1 : 0;
  db.prepare(`UPDATE avatar_presets SET score = ?, score_notes = ?, enabled = ? WHERE file_name = ?`)
    .run(score, notes, enabled, fileName);
}

export function listAvatarPresets({ onlyEnabled = true } = {}) {
  const db = getDb();
  const where = onlyEnabled ? 'WHERE enabled = 1' : '';
  return db.prepare(`
    SELECT id, file_name, age_range, hair_color, hair_style, vibe, style, clothing, score, embedding
    FROM avatar_presets ${where}
    ORDER BY score DESC
  `).all();
}

export function countAvatarPresets() {
  const db = getDb();
  const all = db.prepare('SELECT COUNT(*) AS n FROM avatar_presets').get()?.n ?? 0;
  const enabled = db.prepare('SELECT COUNT(*) AS n FROM avatar_presets WHERE enabled = 1').get()?.n ?? 0;
  const scored = db.prepare('SELECT COUNT(*) AS n FROM avatar_presets WHERE score > 0').get()?.n ?? 0;
  return { all, enabled, scored };
}

/**
 * 按 companion 的人设匹配 top N 头像预设。
 * 算法：
 *  1. 关键词匹配：年龄段 / 发色 / vibe 大类
 *  2. 在匹配池中按 embedding 余弦相似度排序
 *  3. 池子不够大就放宽过滤
 */
export function matchAvatarPresets(companion, queryEmbedding, topN = 4) {
  const db = getDb();
  const allPresets = db.prepare(`
    SELECT id, file_name, age_range, hair_color, hair_style, vibe, style, clothing, score, embedding
    FROM avatar_presets WHERE enabled = 1
  `).all();
  if (allPresets.length === 0) return [];

  // 派生 companion 的年龄段
  const age = companion.age || 22;
  const targetAgeRange = age <= 18 ? 'teen' : age <= 23 ? 'college' : 'young_pro';

  // 计算每张图的综合分：embedding 相似度 + 维度匹配奖励 + 原始美感分
  const qf = queryEmbedding ? new Float32Array(queryEmbedding) : null;
  const scored = allPresets.map(p => {
    let sim = 0;
    if (qf && p.embedding) {
      const ef = unpackEmbedding(p.embedding);
      sim = cosineSimilarity(qf, ef);
    }
    // 维度匹配奖励
    let bonus = 0;
    if (p.age_range === targetAgeRange) bonus += 0.15;
    // 总分
    const score = sim * 0.6 + (p.score / 10) * 0.25 + bonus;
    return { ...p, similarity: sim, score };
  });
  scored.sort((a, b) => b.score - a.score);
  // 多样化：top N 时避免同 vibe 重复，尽量分布
  const picked = [];
  const seenVibes = new Set();
  for (const item of scored) {
    if (picked.length >= topN) break;
    if (picked.length >= 2 && seenVibes.has(item.vibe)) continue;  // 前 2 允许同 vibe，后续要多样
    picked.push(item);
    seenVibes.add(item.vibe);
  }
  // 如果不够 topN，从未选中的补
  if (picked.length < topN) {
    const remaining = scored.filter(s => !picked.find(p => p.id === s.id));
    for (const item of remaining) {
      if (picked.length >= topN) break;
      picked.push(item);
    }
  }
  return picked.map(p => ({
    file_name: p.file_name,
    url: `/avatars/preset/${p.file_name}`,
    vibe: p.vibe,
    similarity: p.similarity,
    score: p.score,
  }));
}

// ─── 场景照片状态 ────────────────────────────────────────────────────────
export function getLastPhotoAt(companionId) {
  const db = getDb();
  const row = db.prepare('SELECT last_photo_at FROM companions WHERE id = ?').get(companionId);
  return row?.last_photo_at || null;
}

export function markPhotoSent(companionId, caption = '') {
  const db = getDb();
  db.prepare(`UPDATE companions SET last_photo_at = CURRENT_TIMESTAMP, last_photo_caption = ? WHERE id = ?`)
    .run(caption.slice(0, 200), companionId);
}

export function getConfessionState(companionId) {
  const db = getDb();
  const row = db.prepare('SELECT confessed_at, user_confessed_at, affection_level, relationship_stage, created_at FROM companions WHERE id = ?').get(companionId);
  return row || null;
}

// ─── 共同回忆时间轴（聚合 创建/送礼/重要记忆/阶段升级）────────────────────
export function getCompanionTimeline(companionId, limit = 50) {
  const db = getDb();
  const companion = db.prepare('SELECT id, name, created_at, affection_level, relationship_stage FROM companions WHERE id = ?').get(companionId);
  if (!companion) return null;

  // 起点：相识
  const events = [{
    kind: 'meet',
    icon: '✨',
    title: '相识',
    detail: `你创建了${companion.name}，你们的故事开始了`,
    at: companion.created_at,
  }];

  // 阶段升级
  const milestones = db.prepare(`
    SELECT from_stage, to_stage, affection_at_upgrade, days_since_meet, created_at
    FROM companion_stage_milestones
    WHERE companion_id = ?
    ORDER BY created_at ASC
  `).all(companionId);
  for (const m of milestones) {
    const icon = { '朋友': '🤝', '暧昧': '💗', '恋人': '❤️', '深爱': '💞' }[m.to_stage] || '⭐';
    events.push({
      kind: 'stage',
      icon,
      title: `升级到「${m.to_stage}」`,
      detail: `相识第 ${m.days_since_meet} 天，好感度 ${m.affection_at_upgrade}/100`,
      at: m.created_at,
    });
  }

  // 送礼
  const gifts = db.prepare(`
    SELECT gift_id, message, created_at
    FROM companion_gifts
    WHERE companion_id = ?
    ORDER BY created_at DESC LIMIT 50
  `).all(companionId);
  for (const g of gifts) {
    events.push({
      kind: 'gift',
      icon: '🎁',
      title: `你送了 ${g.gift_id}`,
      detail: g.message ? `"${g.message.slice(0, 50)}"` : '一份小礼物',
      at: g.created_at,
    });
  }

  // 重要记忆（importance >= 7 的 event）
  const memories = db.prepare(`
    SELECT memory_type, content, importance, created_at
    FROM companion_memories
    WHERE companion_id = ?
      AND importance >= 7
      AND memory_type IN ('event', 'fact', 'preference')
    ORDER BY created_at DESC LIMIT 30
  `).all(companionId);
  for (const m of memories) {
    const icon = { event: '📖', fact: '📝', preference: '💡' }[m.memory_type] || '✏️';
    events.push({
      kind: 'memory',
      icon,
      title: m.memory_type === 'event' ? '一件值得记住的事' : (m.memory_type === 'preference' ? '她记下了你的喜好' : '她记住了'),
      detail: m.content,
      at: m.created_at,
      importance: m.importance,
    });
  }

  // 按时间倒序
  events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return {
    companion: {
      id: companion.id,
      name: companion.name,
      created_at: companion.created_at,
      affection_level: companion.affection_level,
      relationship_stage: companion.relationship_stage,
      days_together: companion.created_at
        ? Math.floor((Date.now() - new Date(String(companion.created_at).replace(' ', 'T') + 'Z').getTime()) / 86400_000)
        : 0,
    },
    events: events.slice(0, limit),
    total: events.length,
  };
}

export function getGlobalUsageToday() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(`
    SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
           COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
           COALESCE(SUM(message_count), 0) AS message_count,
           COUNT(DISTINCT account_id) AS active_accounts
    FROM ai_usage_daily
    WHERE day = ?
  `).get(today) || {};
  return {
    day: today,
    prompt_tokens: row.prompt_tokens || 0,
    completion_tokens: row.completion_tokens || 0,
    total_tokens: (row.prompt_tokens || 0) + (row.completion_tokens || 0),
    message_count: row.message_count || 0,
    active_accounts: row.active_accounts || 0,
  };
}

// ─── wechat account bindings ────────────────────────────────────────────────
function getActiveBindingByWechat(db, wechatUserId, botId) {
  return db.prepare(`
    SELECT * FROM wechat_accounts
    WHERE wechat_user_id = ?
      AND bot_id = ?
      AND is_active = 1
    LIMIT 1
  `).get(wechatUserId, botId);
}

export function findCurrentCompanionForAccount(db, accountId, botId) {
  // v1.9.6 安全修复：绑定流程"找回当前 companion"时，去掉
  // `wa_by_user.wechat_user_id = u.wechat_user_id` 隐式匹配 —— 该匹配让
  // "account A 曾绑过 B 的微信号" 在重新绑定时关联到 B 的 companion（越权）。
  //
  // 现在只走两条显式安全路径：
  //   1. wa_by_companion：active 显式 companion 绑定到本账号
  //   2. c.user_id === accountId：web 直接创建路径
  // 副作用：纯 wechat 创建、又没有显式 wa.companion_id 绑定行的旧 companion
  // 重绑时找不回 → 会新建 companion（可接受的 graceful degradation；v1.9.4+
  // 之后所有新绑定都会写 wa.companion_id）。
  return db.prepare(`
    SELECT c.*
    FROM companions c
    LEFT JOIN wechat_accounts wa_by_companion
      ON wa_by_companion.companion_id = c.id
     AND wa_by_companion.account_id = ?
     AND wa_by_companion.is_active = 1
    WHERE wa_by_companion.id IS NOT NULL
       OR c.user_id = ?
    ORDER BY
      CASE WHEN c.bot_id = ? THEN 0 ELSE 1 END,
      c.updated_at DESC
    LIMIT 1
  `).get(accountId, accountId, botId);
}

export function ensureCompanionBot(db, companionId, botId) {
  if (!companionId || !botId) return;
  db.prepare(`
    UPDATE companions
    SET bot_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND bot_id <> ?
  `).run(botId, companionId, botId);
}

function createOrMoveWechatUser(db, { wechatUserId, displayName = null, avatarUrl = null, companion = null }) {
  let user = db.prepare('SELECT * FROM users WHERE wechat_user_id = ?').get(wechatUserId);
  if (companion) {
    if (user && Number(user.id) !== Number(companion.user_id)) {
      const targetCompanion = db.prepare(`
        SELECT id FROM companions
        WHERE user_id = ? AND bot_id = ? AND id != ?
        LIMIT 1
      `).get(user.id, companion.bot_id, companion.id);
      if (targetCompanion) {
        const error = new Error('该微信已有历史人设，无法直接重新绑定');
        error.code = 'WECHAT_HAS_COMPANION';
        throw error;
      }
      db.prepare('UPDATE companion_memories SET user_id = ? WHERE companion_id = ? AND user_id = ?')
        .run(user.id, companion.id, companion.user_id);
      db.prepare('DELETE FROM user_profiles WHERE user_id = ? AND companion_id = ?')
        .run(user.id, companion.id);
      db.prepare('UPDATE user_profiles SET user_id = ? WHERE companion_id = ? AND user_id = ?')
        .run(user.id, companion.id, companion.user_id);
      db.prepare('UPDATE companions SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(user.id, companion.id);
    } else if (!user) {
      db.prepare('UPDATE users SET wechat_user_id = ?, display_name = COALESCE(?, display_name), avatar_url = COALESCE(?, avatar_url), last_active = CURRENT_TIMESTAMP WHERE id = ?')
        .run(wechatUserId, displayName, avatarUrl, companion.user_id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(companion.user_id);
    } else {
      db.prepare('UPDATE users SET display_name = COALESCE(?, display_name), avatar_url = COALESCE(?, avatar_url), last_active = CURRENT_TIMESTAMP WHERE id = ?')
        .run(displayName, avatarUrl, user.id);
    }
  } else if (!user) {
    db.prepare(`
      INSERT INTO users (wechat_user_id, display_name, avatar_url, last_active)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `).run(wechatUserId, displayName, avatarUrl);
    user = db.prepare('SELECT * FROM users WHERE wechat_user_id = ?').get(wechatUserId);
  } else {
    db.prepare('UPDATE users SET display_name = COALESCE(?, display_name), avatar_url = COALESCE(?, avatar_url), last_active = CURRENT_TIMESTAMP WHERE id = ?')
      .run(displayName, avatarUrl, user.id);
  }
  return user || db.prepare('SELECT * FROM users WHERE wechat_user_id = ?').get(wechatUserId);
}

export function bindWechatAccount({
  accountId,
  wechatUserId,
  botId,
  botToken,
  displayName = null,
  avatarUrl = null,
  loginSessionId = null,
}) {
  return rebindWechatAccount({
    accountId,
    wechatUserId,
    botId,
    botToken,
    displayName,
    avatarUrl,
    loginSessionId,
  }).binding;
}

export function getWechatAccountByAccountId(accountId) {
  const db = getDb();
  return db.prepare('SELECT * FROM wechat_accounts WHERE account_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1').get(accountId);
}

function getWechatAccountByWechatUserId(wechatUserId) {
  const db = getDb();
  return db.prepare('SELECT * FROM wechat_accounts WHERE wechat_user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1').get(wechatUserId);
}

export function getActiveWechatBinding(wechatUserId, botId) {
  const db = getDb();
  const binding = db.prepare(`
    SELECT
      wa.*,
      COALESCE(
        wa.companion_id,
        active_user_companion.id,
        historical_user_companion.id,
        historical_bound_companion.id
      ) AS resolved_companion_id
    FROM wechat_accounts wa
    LEFT JOIN users u
      ON u.wechat_user_id = wa.wechat_user_id
    LEFT JOIN companions active_user_companion
      ON active_user_companion.user_id = u.id
    LEFT JOIN wechat_accounts historical_wa
      ON historical_wa.account_id = wa.account_id
     AND historical_wa.wechat_user_id IS NOT NULL
    LEFT JOIN users historical_u
      ON historical_u.wechat_user_id = historical_wa.wechat_user_id
    LEFT JOIN companions historical_user_companion
      ON historical_user_companion.user_id = historical_u.id
    LEFT JOIN companions historical_bound_companion
      ON historical_bound_companion.id = historical_wa.companion_id
    WHERE wa.wechat_user_id = ?
      AND wa.bot_id = ?
      AND wa.is_active = 1
    ORDER BY
      wa.updated_at DESC,
      CASE
        WHEN wa.companion_id IS NOT NULL THEN 0
        WHEN active_user_companion.id IS NOT NULL THEN 1
        WHEN historical_user_companion.id IS NOT NULL THEN 2
        WHEN historical_bound_companion.id IS NOT NULL THEN 3
        ELSE 4
      END,
      COALESCE(active_user_companion.updated_at, historical_user_companion.updated_at, historical_bound_companion.updated_at) DESC
    LIMIT 1
  `).get(wechatUserId, botId);
  if (!binding) return null;
  return {
    ...binding,
    user_id: binding.user_id || binding.account_id,
    companion_id: binding.companion_id || binding.resolved_companion_id || null,
  };
}

/**
 * 降噪：某 botId 的活跃绑定若**解析不出任何 companion**（删角色后没重建 / 半成品账号），
 * 把它 is_active=0 停掉，避免 pool 永远空轮询、每次重启刷 session-expired 错误。
 * 有角色的绑定（真实用户，只是会话过期需重绑）**不动**。返回是否停用了。
 */
export function deactivateBindingIfNoCompanion(botId) {
  if (!botId) return false;
  const db = getDb();
  const rows = db.prepare(`
    SELECT wa.id, wa.companion_id,
      (SELECT count(*) FROM companions c WHERE c.id = wa.companion_id) AS direct,
      (SELECT count(*) FROM users u JOIN companions c2 ON c2.user_id = u.id
         WHERE u.wechat_user_id = wa.wechat_user_id) AS viaUser
    FROM wechat_accounts wa
    WHERE wa.bot_id = ? AND wa.is_active = 1
  `).all(botId);
  if (!rows.length) return false;
  const hasCompanion = rows.some(r => (r.companion_id && r.direct > 0) || r.viaUser > 0);
  if (hasCompanion) return false;                 // 有角色 → 保留（需重绑）
  const r = db.prepare(
    `UPDATE wechat_accounts SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE bot_id = ? AND is_active = 1`,
  ).run(botId);
  return r.changes > 0;
}

/**
 * v1.9.4 安全修复：读权限对齐写权限，根除越权读。
 *
 * 之前版本通过 5 路 OR JOIN（含 historical_wa / wechat_user_id 隐式匹配）
 * 让 dashboard 显示给 account A 的 companion 可能实际属于 account B。
 * 写路径 isCompanionOwnedByAccount 已严格，读路径却宽松 →
 * 用户看到别人数据，操作时才被 403 拒绝。
 *
 * 新规则：完全对齐 isCompanionOwnedByAccount —— 只有两条来源：
 *   1. c.user_id === accountId（web 创建路径）
 *   2. 显式 wa.companion_id === c.id（wechat 绑定路径）
 *
 * 如果两条都匹配，**优先返回 wechat 绑定的**（用户当前活跃使用的那个），
 * 否则返回最近更新的。
 */
export function getCompanionByAccountId(accountId) {
  if (!accountId) return null;
  const db = getDb();
  return parseCompanionRow(db.prepare(`
    SELECT c.*
    FROM companions c
    LEFT JOIN wechat_accounts wa
      ON wa.companion_id = c.id
     AND wa.account_id = ?
     AND wa.is_active = 1
    WHERE c.user_id = ?              -- web 直接创建路径
       OR wa.id IS NOT NULL          -- 显式 wechat 绑定路径
    ORDER BY
      CASE WHEN wa.id IS NOT NULL THEN 0 ELSE 1 END,
      c.updated_at DESC
    LIMIT 1
  `).get(accountId, accountId));
}

export function deleteCompanionForAccount(accountId, companionId) {
  const db = getDb();
  const tx = db.transaction(() => {
    const companion = db.prepare(`
      SELECT c.*, u.wechat_user_id
      FROM companions c
      JOIN users u ON u.id = c.user_id
      WHERE c.id = ?
    `).get(companionId);
    if (!companion) {
      const error = new Error('人设不存在');
      error.code = 'NOT_FOUND';
      throw error;
    }

    // v1.9.6 安全修复：删除越权（同 v1.9.4/v1.9.5 漏洞模式，但影响更大 —
    // 删除会 CASCADE 清掉 memories/聊天记录/profiles）。
    //
    // 旧版 owned 检查走 `u.wechat_user_id = wa.wechat_user_id` 隐式 JOIN：
    // account A 绑了 B 的微信号 + bot_id 匹配 → A 能删 B 的 companion 全部数据。
    //
    // 新规则与 isCompanionOwnedByAccount 完全一致（显式两条路径）：
    //   1. c.user_id === accountId（web 直接创建路径）
    //   2. 存在 active wechat_accounts 行 wa.companion_id === c.id 且
    //      wa.account_id === accountId（wechat 显式绑定路径）
    const owned = db.prepare(`
      SELECT c.id FROM companions c
      WHERE c.id = ?
        AND (
          c.user_id = ?
          OR EXISTS (
            SELECT 1 FROM wechat_accounts wa
            WHERE wa.companion_id = c.id
              AND wa.account_id = ?
              AND wa.is_active = 1
          )
        )
      LIMIT 1
    `).get(companionId, accountId, accountId);
    if (!owned) {
      const error = new Error('无权删除该人设');
      error.code = 'FORBIDDEN';
      throw error;
    }

    const cleaned = {};
    cleaned.companion_memories = db.prepare('DELETE FROM companion_memories WHERE companion_id = ?').run(companionId).changes;
    cleaned.companion_gifts = db.prepare('DELETE FROM companion_gifts WHERE companion_id = ?').run(companionId).changes;
    cleaned.companion_reminders = db.prepare('DELETE FROM companion_reminders WHERE companion_id = ?').run(companionId).changes;
    cleaned.companion_conversation_turns = db.prepare('DELETE FROM companion_conversation_turns WHERE companion_id = ?').run(companionId).changes;
    cleaned.companion_image_reactions = db.prepare('DELETE FROM companion_image_reactions WHERE companion_id = ?').run(companionId).changes;
    cleaned.user_profiles = db.prepare('DELETE FROM user_profiles WHERE companion_id = ?').run(companionId).changes;

    const hasBindingCompanionId = db.pragma('table_info(wechat_accounts)').some(col => col.name === 'companion_id');
    cleaned.wechat_accounts_companion_id = hasBindingCompanionId
      ? db.prepare('UPDATE wechat_accounts SET companion_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE companion_id = ?').run(companionId).changes
      : 0;

    cleaned.companions = db.prepare('DELETE FROM companions WHERE id = ?').run(companionId).changes;
    return { companion, cleaned };
  });
  return tx();
}

export function rebindWechatAccount({
  accountId,
  wechatUserId,
  botId,
  botToken,
  displayName = null,
  avatarUrl = null,
  loginSessionId = null,
}) {
  const db = getDb();
  const tx = db.transaction(() => {
    const boundToOther = getActiveBindingByWechat(db, wechatUserId, botId);
    if (boundToOther?.account_id && Number(boundToOther.account_id) !== Number(accountId)) {
      const error = new Error('该微信已绑定其他账号');
      error.code = 'WECHAT_BOUND';
      throw error;
    }

    const currentCompanion = findCurrentCompanionForAccount(db, accountId, botId);
    let companionId = currentCompanion?.id ?? null;
    createOrMoveWechatUser(db, { wechatUserId, displayName, avatarUrl, companion: currentCompanion || null });
    ensureCompanionBot(db, companionId, botId);

    // 防御性兜底：把这个 wechat 用户名下所有 companion 的 bot_id 同步到新 bot
    // 否则旧 companion 会孤儿化（user 重新绑了新 bot 但人设还挂旧 bot 上，proactive SQL 永远 join 不上）
    db.prepare(`
      UPDATE companions
      SET bot_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id IN (SELECT id FROM users WHERE wechat_user_id = ?)
        AND bot_id <> ?
    `).run(botId, wechatUserId, botId);

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE wechat_accounts
      SET is_active = 0, updated_at = ?
      WHERE account_id = ? AND is_active = 1
    `).run(now, accountId);

    db.prepare(`
      INSERT INTO wechat_accounts
        (account_id, user_id, wechat_user_id, bot_id, bot_token, companion_id, display_name, avatar_url, login_session_id, is_active, bound_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(accountId, accountId, wechatUserId, botId, botToken, companionId, displayName, avatarUrl, loginSessionId, now, now);

    return {
      binding: db.prepare('SELECT * FROM wechat_accounts WHERE account_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1').get(accountId),
      companionId,
    };
  });
  return tx();
}

function generatePendingBindCode() {
  const n = crypto.randomInt(0, 1000000);
  return `XYU-${String(n).padStart(6, '0')}`;
}

export function createPendingBindSession({ accountId, ttlMs = 30 * 60 * 1000 }) {
  const db = getDb();
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare(`
    UPDATE pending_bind_sessions
    SET status = 'expired'
    WHERE user_id = ? AND status = 'pending' AND datetime(expires_at) <= datetime('now')
  `).run(accountId);
  for (let i = 0; i < 5; i += 1) {
    const bindCode = generatePendingBindCode();
    try {
      db.prepare(`
        INSERT INTO pending_bind_sessions (id, user_id, bind_code, status, expires_at)
        VALUES (?, ?, ?, 'pending', ?)
      `).run(id, accountId, bindCode, expiresAt);
      return db.prepare('SELECT * FROM pending_bind_sessions WHERE id = ?').get(id);
    } catch (e) {
      if (!String(e.message || '').includes('UNIQUE')) throw e;
    }
  }
  throw new Error('绑定码生成失败');
}

export function getPendingBindSession(sessionId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM pending_bind_sessions WHERE id = ?').get(sessionId);
  if (row?.status === 'pending' && new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare("UPDATE pending_bind_sessions SET status = 'expired' WHERE id = ? AND status = 'pending'").run(sessionId);
    return db.prepare('SELECT * FROM pending_bind_sessions WHERE id = ?').get(sessionId);
  }
  return row;
}

export function consumePendingBindSessionForWechat({ wechatUserId, botId, botToken, bindCode = null, displayName = null, avatarUrl = null }) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE pending_bind_sessions
      SET status = 'expired'
      WHERE status = 'pending' AND datetime(expires_at) <= datetime('now')
    `).run();

    const normalizedBindCode = typeof bindCode === 'string' ? bindCode.trim().toUpperCase() : '';
    let session = null;
    if (normalizedBindCode) {
      if (!/^XYU-\d{6}$/.test(normalizedBindCode)) return null;
      session = db.prepare(`
        SELECT * FROM pending_bind_sessions
        WHERE UPPER(bind_code) = ?
          AND status = 'pending'
          AND consumed_at IS NULL
          AND datetime(expires_at) > datetime('now')
        ORDER BY created_at DESC
        LIMIT 1
      `).get(normalizedBindCode);
    } else {
      const sessions = db.prepare(`
        SELECT * FROM pending_bind_sessions
        WHERE status = 'pending'
          AND consumed_at IS NULL
          AND datetime(expires_at) > datetime('now')
        ORDER BY created_at DESC
        LIMIT 2
      `).all();
      if (sessions.length !== 1) return null;
      session = sessions[0];
    }
    if (!session) return null;

    const boundToOther = getActiveBindingByWechat(db, wechatUserId, botId);
    if (boundToOther?.account_id && Number(boundToOther.account_id) !== Number(session.user_id)) {
      db.prepare(`
        UPDATE pending_bind_sessions
        SET status = 'failed', error_message = ?, consumed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run('该微信已绑定其他账号', session.id);
      return { errorCode: 'WECHAT_BOUND', errorMessage: '该微信已绑定其他账号' };
    }

    const currentCompanion = findCurrentCompanionForAccount(db, session.user_id, botId);
    const wasRebind = Boolean(db.prepare(`
      SELECT id FROM wechat_accounts
      WHERE account_id = ? AND is_active = 1
      LIMIT 1
    `).get(session.user_id));
    const companionId = currentCompanion?.id ?? null;
    createOrMoveWechatUser(db, { wechatUserId, displayName, avatarUrl, companion: currentCompanion || null });
    ensureCompanionBot(db, companionId, botId);

    db.prepare(`
      UPDATE wechat_accounts
      SET is_active = 0, updated_at = CURRENT_TIMESTAMP
      WHERE (account_id = ? OR user_id = ?) AND is_active = 1
    `).run(session.user_id, session.user_id);

    db.prepare(`
      INSERT INTO wechat_accounts
        (account_id, user_id, wechat_user_id, bot_id, bot_token, companion_id, display_name, avatar_url, login_session_id, is_active, bound_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(session.user_id, session.user_id, wechatUserId, botId, botToken, companionId, displayName, avatarUrl, session.id);

    db.prepare(`
      UPDATE pending_bind_sessions
      SET status = 'success',
          wechat_user_id = ?,
          companion_id = ?,
          consumed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('pending', 'expired')
    `).run(wechatUserId, companionId, session.id);

    return {
      session: db.prepare('SELECT * FROM pending_bind_sessions WHERE id = ?').get(session.id),
      binding: db.prepare('SELECT * FROM wechat_accounts WHERE account_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1').get(session.user_id),
      companionId,
      wasRebind,
    };
  });
  const result = tx();
  if (result?.errorCode) {
    const error = new Error(result.errorMessage);
    error.code = result.errorCode;
    throw error;
  }
  return result;
}

// ─── users ────────────────────────────────────────────────────────────────────
export function upsertUser(wechatUserId, displayName) {
  const db = getDb();
  db.prepare(`
    INSERT INTO users (wechat_user_id, display_name, last_active)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(wechat_user_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, display_name),
      last_active  = CURRENT_TIMESTAMP
  `).run(wechatUserId, displayName || null);
  return db.prepare('SELECT * FROM users WHERE wechat_user_id = ?').get(wechatUserId);
}

// ─── companions ───────────────────────────────────────────────────────────────
function getRawByWechatUser(wechatUserId, botId) {
  const db = getDb();
  return db.prepare(`
    SELECT c.* FROM companions c
    JOIN users u ON c.user_id = u.id
    WHERE u.wechat_user_id = ? AND c.bot_id = ?
  `).get(wechatUserId, botId);
}

export function getCompanion(wechatUserId, botId) {
  return parseCompanionRow(getRawByWechatUser(wechatUserId, botId));
}

export function getCompanionById(id) {
  const db = getDb();
  return parseCompanionRow(db.prepare('SELECT * FROM companions WHERE id = ?').get(id));
}

export function getProCompanions() {
  const db = getDb();
  return db.prepare(`
    SELECT c.*, u.wechat_user_id
    FROM companions c
    JOIN users u ON u.id = c.user_id
    WHERE u.plan = 'pro'
      AND (u.plan_expires_at IS NULL OR datetime(u.plan_expires_at) > datetime('now'))
    ORDER BY c.id ASC
  `).all().map(parseCompanionRow);
}

export function getProactiveCompanions(botId) {
  const db = getDb();
  return db.prepare(`
    SELECT
      c.*,
      u.wechat_user_id,
      wa.display_name AS wechat_display_name
    FROM companions c
    JOIN users u
      ON u.id = c.user_id
    JOIN wechat_accounts wa
      ON wa.wechat_user_id = u.wechat_user_id
     AND wa.bot_id = c.bot_id
    WHERE c.bot_id = ?
      AND c.proactive_enabled = 1
      AND wa.is_active = 1
      AND wa.wechat_user_id IS NOT NULL
    ORDER BY c.id ASC
  `).all(botId).map(parseCompanionRow);
}

export function ensureCompanion(wechatUserId, botId) {
  const user = upsertUser(wechatUserId, null);
  let c = getCompanion(wechatUserId, botId);
  if (!c) {
    const db = getDb();
    db.prepare(`INSERT INTO companions (user_id, bot_id, name, persona_prompt) VALUES (?, ?, '溪语', '')`).run(user.id, botId);
    c = getCompanion(wechatUserId, botId);
  }
  return c;
}

// BILLING_DISABLED 2026-05-26：内测期所有用户视为 Pro
// 18 岁后恢复时：把 BETA_ALL_PRO 改为 false 即可还原原逻辑
const BETA_ALL_PRO = true;

export function getUserPlan(userId) {
  if (BETA_ALL_PRO) {
    return { plan: 'pro', plan_expires_at: null, isPro: true, beta: true };
  }
  const db = getDb();
  const row = db.prepare('SELECT id, plan, plan_expires_at FROM users WHERE id = ?').get(userId);
  if (!row) return { plan: 'free', plan_expires_at: null, isPro: false };
  const expiresAt = row.plan_expires_at ? new Date(row.plan_expires_at) : null;
  const isExpired = expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt <= new Date();
  const isPro = row.plan === 'pro' && !isExpired;
  return {
    plan: isPro ? 'pro' : 'free',
    plan_expires_at: row.plan_expires_at || null,
    isPro,
  };
}

export function createCompanion(wechatUserId, botId, data) {
  const user = upsertUser(wechatUserId, null);
  const db   = getDb();
  const existing = getRawByWechatUser(wechatUserId, botId);
  if (existing) {
    const err = new Error('该用户已存在 companion，请用 PUT 更新');
    err.code = 'EXISTS'; err.id = existing.id; throw err;
  }
  // v1.9.9 Bug 4：表情包默认开启（新建 companion 时如果没显式设，给 1）。
  // 之前 schema DEFAULT 0 让新用户聊很多回合都没收到过表情包，体感"功能没生效"。
  // v1.13.x：主动消息每天目标默认 4（原 10 偏高，线上数据显示多数用户会一刀关掉整个
  //   功能而非调低）。列默认值在已存在的库里改不动，这里显式给 4 才对老库的新用户生效。
  const dataWithDefaults = {
    sticker_reply_enabled: 1,
    proactive_daily_target: 4,
    ...data,
  };
  const fields = buildUpsertFields(dataWithDefaults);
  const info = db.prepare(`
    INSERT INTO companions (user_id, bot_id${fields.cols.length ? ', ' + fields.cols.join(', ') : ''})
    VALUES (?, ?${fields.cols.length ? ', ' + fields.placeholders.join(', ') : ''})
  `).run(user.id, botId, ...fields.values);
  const newId = info.lastInsertRowid;
  // v1.8.0 #3: 新建时同步 hobbies/dislikes 到 preferences
  if ('hobbies' in data || 'dislikes' in data) {
    try {
      syncLegacyPreferences(newId, {
        hobbies: 'hobbies' in data ? (Array.isArray(data.hobbies) ? JSON.stringify(data.hobbies) : data.hobbies) : null,
        dislikes: 'dislikes' in data ? (Array.isArray(data.dislikes) ? JSON.stringify(data.dislikes) : data.dislikes) : null,
      });
    } catch (e) {
      console.error(`[createCompanion] preferences sync skipped: ${e.message}`);
    }
  }
  return getCompanionById(newId);
}

export function updateCompanion(id, data) {
  const db = getDb();
  const existing = getCompanionById(id);
  if (!existing) { const err = new Error('companion 不存在'); err.code = 'NOT_FOUND'; throw err; }
  const fields = buildUpsertFields(data);
  if (fields.cols.length === 0) return existing;
  const sets = fields.cols.map(c => `${c} = ?`).join(', ');
  db.prepare(`UPDATE companions SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(...fields.values, id);
  // v1.8.0 #3: 同步 hobbies/dislikes 到 preferences 表（如果本次更新涉及）
  if ('hobbies' in data || 'dislikes' in data) {
    try {
      syncLegacyPreferences(id, {
        hobbies: 'hobbies' in data ? (Array.isArray(data.hobbies) ? JSON.stringify(data.hobbies) : data.hobbies) : null,
        dislikes: 'dislikes' in data ? (Array.isArray(data.dislikes) ? JSON.stringify(data.dislikes) : data.dislikes) : null,
      });
    } catch (e) {
      console.error(`[updateCompanion] preferences sync skipped: ${e.message}`);
    }
  }
  return getCompanionById(id);
}

/** 直接更新 companion 的特定字段（供内部使用，跳过字段白名单但强校验列名） */
export function patchCompanion(id, fields) {
  const db = getDb();
  const keys = Object.keys(fields || {});
  // v1.11.0 安全(M2)：列名必须是合法 SQL 标识符，杜绝列名注入。现有调用方都是
  // 硬编码 key；此校验是防御未来有人误把 req.body 直接传进来。fail-closed。
  for (const k of keys) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(k)) throw new Error(`patchCompanion: 非法列名 ${k}`);
  }
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => fields[k]);
  db.prepare(`UPDATE companions SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(...vals, id);

  // v1.8.0 #3: hobbies/dislikes 更新时同步到 preferences 表
  // 让 chip UI 编辑能立刻反映到结构化偏好账本
  if ('hobbies' in fields || 'dislikes' in fields) {
    try {
      syncLegacyPreferences(id, {
        hobbies: 'hobbies' in fields ? fields.hobbies : null,
        dislikes: 'dislikes' in fields ? fields.dislikes : null,
      });
    } catch (e) {
      console.error(`[patchCompanion] preferences sync skipped: ${e.message}`);
    }
  }
}

// 把 companions.hobbies/dislikes JSON 数组同步到 preferences 表 (source='legacy')
// 删掉旧 legacy 项 + 重新 insert，保证一致性
function syncLegacyPreferences(companionId, { hobbies, dislikes }) {
  const db = getDb();
  if (hobbies !== null) {
    const list = parseJsonSafe(hobbies);
    db.prepare(`DELETE FROM companion_preferences WHERE companion_id = ? AND type = 'like' AND source = 'legacy'`).run(companionId);
    for (const t of list) if (t) upsertPreference({ companionId, type: 'like', target: String(t), source: 'legacy' });
  }
  if (dislikes !== null) {
    const list = parseJsonSafe(dislikes);
    db.prepare(`DELETE FROM companion_preferences WHERE companion_id = ? AND type = 'dislike' AND source = 'legacy'`).run(companionId);
    for (const t of list) if (t) upsertPreference({ companionId, type: 'dislike', target: String(t), source: 'legacy' });
  }
}

// ─── v1.8.0 #3: companion_preferences CRUD ─────────────────────────────────
export function listPreferences(companionId, { type = null } = {}) {
  const db = getDb();
  const sql = type
    ? `SELECT * FROM companion_preferences WHERE companion_id = ? AND type = ? ORDER BY intensity DESC, id`
    : `SELECT * FROM companion_preferences WHERE companion_id = ? ORDER BY type, intensity DESC, id`;
  return type
    ? db.prepare(sql).all(companionId, type)
    : db.prepare(sql).all(companionId);
}

export function upsertPreference({ companionId, type, target, intensity = 3, reason = null, source = 'system' }) {
  if (!companionId || !type || !target) throw new Error('upsertPreference: missing required fields');
  if (!['like','dislike','neutral','taboo'].includes(type)) throw new Error('upsertPreference: invalid type');
  const db = getDb();
  db.prepare(`
    INSERT INTO companion_preferences (companion_id, type, target, intensity, reason, source)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(companion_id, type, target) DO UPDATE SET
      intensity = excluded.intensity,
      reason = COALESCE(excluded.reason, companion_preferences.reason),
      source = excluded.source,
      created_at = companion_preferences.created_at
  `).run(companionId, type, String(target).slice(0, 80), Math.max(1, Math.min(5, intensity)), reason, source);
}

export function deletePreference(companionId, type, target) {
  const db = getDb();
  return db.prepare(`DELETE FROM companion_preferences WHERE companion_id = ? AND type = ? AND target = ?`)
    .run(companionId, type, target).changes;
}

// ─── M0: companion_shaping —— 用户共建/塑造留痕（教她说话/称呼/雷区/约定/专属梗）─────
function migrateCompanionShaping() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_shaping (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      kind         TEXT    NOT NULL CHECK(kind IN ('nickname','style','taboo','pact','fact','lexicon')),
      content      TEXT    NOT NULL,
      raw_msg      TEXT,
      created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(companion_id, kind, content)
    );
    CREATE INDEX IF NOT EXISTS idx_shaping_companion ON companion_shaping(companion_id, kind);
  `);
}

const SHAPING_KINDS = ['nickname','style','taboo','pact','fact','lexicon'];
const SHAPING_SINGLETON = ['nickname', 'style'];   // 单例 kind：只保留最新一条
export function upsertShaping({ companionId, kind, content, rawMsg = null }) {
  if (!companionId || !kind || !content) throw new Error('upsertShaping: missing fields');
  if (!SHAPING_KINDS.includes(kind)) throw new Error('upsertShaping: invalid kind');
  const db = getDb();
  const c = String(content).slice(0, 120);
  if (SHAPING_SINGLETON.includes(kind)) {
    db.prepare(`DELETE FROM companion_shaping WHERE companion_id = ? AND kind = ?`).run(companionId, kind);
  }
  db.prepare(`INSERT OR IGNORE INTO companion_shaping (companion_id, kind, content, raw_msg) VALUES (?, ?, ?, ?)`)
    .run(companionId, kind, c, rawMsg ? String(rawMsg).slice(0, 200) : null);
}

export function listShaping(companionId, { kind = null } = {}) {
  const db = getDb();
  const sql = kind
    ? `SELECT * FROM companion_shaping WHERE companion_id = ? AND kind = ? ORDER BY created_at DESC, id DESC`
    : `SELECT * FROM companion_shaping WHERE companion_id = ? ORDER BY kind, created_at DESC, id DESC`;
  return kind ? db.prepare(sql).all(companionId, kind) : db.prepare(sql).all(companionId);
}

export function deleteShaping(companionId, id) {
  const db = getDb();
  return db.prepare(`DELETE FROM companion_shaping WHERE companion_id = ? AND id = ?`).run(companionId, Number(id)).changes;
}

// ─── v1.8.0 #4: companion_open_loops CRUD ──────────────────────────────────
export function saveOpenLoop({ companionId, title, dueAt = null, emotionalWeight = 5, expectedFollowup = null, sourceMessageId = null }) {
  if (!companionId || !title) throw new Error('saveOpenLoop: missing required fields');
  const db = getDb();
  // 防重复：同 companion 最近 7 天内的相同 title 视为重复（轻量去重）
  const existing = db.prepare(`
    SELECT id FROM companion_open_loops
    WHERE companion_id = ? AND title = ? AND status = 'open'
      AND datetime(created_at) > datetime('now', '-7 days')
    LIMIT 1
  `).get(companionId, title);
  if (existing) return existing.id;
  const info = db.prepare(`
    INSERT INTO companion_open_loops (companion_id, title, due_at, emotional_weight, expected_followup, source_message_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(companionId, String(title).slice(0, 200), dueAt, Math.max(0, Math.min(100, emotionalWeight)),
         expectedFollowup ? String(expectedFollowup).slice(0, 200) : null, sourceMessageId);
  return info.lastInsertRowid;
}

export function listOpenLoops(companionId, { status = 'open', limit = 50 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM companion_open_loops
    WHERE companion_id = ? AND status = ?
    ORDER BY emotional_weight DESC, due_at ASC, id DESC
    LIMIT ?
  `).all(companionId, status, limit);
}

// 临近到期 / 已到期未 resolve 的 loops（给 proactive 用）
export function listDueOpenLoops(companionId, { withinHours = 24 } = {}) {
  const db = getDb();
  // due_at 在 +withinHours 内或已过期；按权重排序
  return db.prepare(`
    SELECT * FROM companion_open_loops
    WHERE companion_id = ? AND status = 'open'
      AND due_at IS NOT NULL
      AND datetime(due_at) <= datetime('now', '+' || ? || ' hours')
    ORDER BY emotional_weight DESC, due_at ASC
    LIMIT 5
  `).all(companionId, withinHours);
}

export function resolveOpenLoop(loopId, resolvedText = null) {
  const db = getDb();
  return db.prepare(`
    UPDATE companion_open_loops
    SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP,
        resolved_text = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(resolvedText, loopId).changes;
}

export function markOpenLoopFollowedUp(loopId) {
  const db = getDb();
  db.prepare(`UPDATE companion_open_loops SET followed_up_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(loopId);
}

// stale: due_at 过期 7+ 天且未 resolve / 没 due_at 但创建 14+ 天的；定期 cron 跑
export function markStaleOpenLoops(companionId = null) {
  const db = getDb();
  const where = companionId ? 'AND companion_id = ?' : '';
  const args = companionId ? [companionId] : [];
  return db.prepare(`
    UPDATE companion_open_loops
    SET status = 'stale', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'open' ${where}
      AND (
        (due_at IS NOT NULL AND datetime(due_at) < datetime('now', '-7 days'))
        OR (due_at IS NULL AND datetime(created_at) < datetime('now', '-14 days'))
      )
  `).run(...args).changes;
}

// 给 prompt 注入用：分组 + 限量
export function getCompanionPreferencesForPrompt(companionId, { maxPerType = 8 } = {}) {
  const all = listPreferences(companionId);
  const byType = { like: [], dislike: [], neutral: [], taboo: [] };
  for (const row of all) {
    const arr = byType[row.type];
    if (arr && arr.length < maxPerType) {
      arr.push({ target: row.target, intensity: row.intensity, reason: row.reason });
    }
  }
  return byType;
}

// ─── companion_memories ───────────────────────────────────────────────────────
function packEmbedding(vec) {
  if (!vec || !Array.isArray(vec) || vec.length === 0) return null;
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer);
}
function unpackEmbedding(buf) {
  if (!buf || buf.length < 4) return null;
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

export function saveMemory({ companionId, userId, memoryType, content, importance = 5, keywords = null, embedding = null, pinned = null }) {
  const db = getDb();
  const isPinned = pinned !== null ? (pinned ? 1 : 0) : (importance >= 7 ? 1 : 0);
  const kw = Array.isArray(keywords) ? JSON.stringify(keywords) : (keywords || null);
  const emb = embedding ? packEmbedding(embedding) : null;
  db.prepare(`
    INSERT INTO companion_memories (companion_id, user_id, memory_type, content, importance, pinned, keywords, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(companionId, userId, memoryType, content, importance, isPinned, kw, emb);
}

// v1.x 修(#1)：memory_type → memory_layer 映射（与 memory_v2.mjs LAYER_MAP 一致，
// 内联避免循环 import）。此前 saveMemories 不写 memory_layer，全默认 'event'，导致
// 网页端 7 层记忆只显示「事件」。
const MEMORY_TYPE_TO_LAYER = {
  fact: 'user_fact', preference: 'preference', event: 'event', emotion: 'emotion',
  image: 'event', daily_summary: 'summary', weekly_summary: 'summary', monthly_summary: 'summary',
};
export const memoryLayerOfType = (t) => MEMORY_TYPE_TO_LAYER[t] || 'event';

export function saveMemories(memories) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO companion_memories (companion_id, user_id, memory_type, memory_layer, content, importance, pinned, keywords, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(list => {
    for (const m of list) {
      const imp = m.importance || 5;
      const pinned = m.pinned !== undefined ? (m.pinned ? 1 : 0) : (imp >= 7 ? 1 : 0);
      const kw = Array.isArray(m.keywords) ? JSON.stringify(m.keywords) : (m.keywords || null);
      const emb = m.embedding ? packEmbedding(m.embedding) : null;
      stmt.run(m.companionId, m.userId, m.memoryType, memoryLayerOfType(m.memoryType), m.content, imp, pinned, kw, emb);
    }
  });
  tx(memories);
}

// 语义相似度（余弦），不进行归一化假设
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 语义召回：当 queryEmbedding 提供时，在 (companion, user) 范围内按余弦相似度排序。
 * importance 加权：score = similarity * 0.7 + (importance / 10) * 0.3
 * pinned=1 的额外 +0.15 分（确保关键记忆优先）
 */
export function recallMemoriesSemantic(companionId, userId, queryEmbedding, limit = 7) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, memory_type, content, importance, pinned, keywords, embedding, created_at
    FROM companion_memories
    WHERE companion_id = ? AND user_id = ? AND embedding IS NOT NULL
  `).all(companionId, userId);

  const qf = new Float32Array(queryEmbedding);
  const scored = rows.map(r => {
    const sim = cosineSimilarity(qf, unpackEmbedding(r.embedding));
    const score = sim * 0.7 + ((r.importance || 5) / 10) * 0.3 + (r.pinned ? 0.15 : 0);
    return { ...r, similarity: sim, score };
  }).sort((a, b) => b.score - a.score).slice(0, limit);

  return scored;
}

export function getMemories(companionId, userId, limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM companion_memories
    WHERE companion_id = ? AND user_id = ?
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `).all(companionId, userId, limit);
}

/**
 * v1.9.8: 找出 N 天前的"零碎"记忆（event / emotion / fact），用于长期压缩 cron。
 * 故意不含 preference（稳定特征不能丢）、daily/weekly/monthly_summary（已是总结）、
 * image（图片识别记忆量小）、pinned=1（用户钉住的）。
 *
 * @param {object} args
 *   companionId, userId
 *   beforeDateIso: ISO 时间字符串（如 '2025-09-01T00:00:00.000Z'）
 *   limit: 单次最多拉多少条，防 LLM context 爆（默认 200）
 * @returns 数组：{ id, memory_type, content, created_at, ... }
 */
export function listEpisodicMemoriesOlderThan({ companionId, userId, beforeDateIso, limit = 200 }) {
  const db = getDb();
  return db.prepare(`
    SELECT id, memory_type, content, created_at, importance
    FROM companion_memories
    WHERE companion_id = ?
      AND user_id = ?
      AND memory_type IN ('fact', 'event', 'emotion')
      AND COALESCE(pinned, 0) = 0
      AND created_at < ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(companionId, userId, beforeDateIso, limit);
}

/**
 * v1.9.8: 批量删除 memory（在压缩成功落地后清掉原条目）。
 * 用事务，要么全删要么不删。
 */
export function deleteMemoriesByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare('DELETE FROM companion_memories WHERE id = ?');
  const tx = db.transaction(arr => {
    let n = 0;
    for (const id of arr) n += stmt.run(id).changes;
    return n;
  });
  return tx(ids);
}

export function recallMemories(companionId, userId, currentMessage, limit = 7) {
  const db = getDb();
  // 提取关键词（2字以上中文词组 & 英文单词）
  const keywords = (currentMessage || '')
    .replace(/[^一-龥a-zA-Z0-9]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .slice(0, 4);

  // 第一档：pinned=1 永远候选
  const pinnedRows = db.prepare(`
    SELECT * FROM companion_memories
    WHERE companion_id = ? AND user_id = ? AND pinned = 1
    ORDER BY importance DESC, created_at DESC
    LIMIT 5
  `).all(companionId, userId);
  const seen = new Set(pinnedRows.map(r => r.id));

  // 第二档：关键词命中
  let keywordRows = [];
  if (keywords.length > 0) {
    const conds = keywords.map(() => 'content LIKE ?').join(' OR ');
    const params = keywords.map(k => `%${k}%`);
    keywordRows = db.prepare(`
      SELECT * FROM companion_memories
      WHERE companion_id = ? AND user_id = ? AND (${conds})
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `).all(companionId, userId, ...params, limit).filter(r => !seen.has(r.id));
    keywordRows.forEach(r => seen.add(r.id));
  }

  // 第三档：高 importance 兜底
  const fill = Math.max(0, limit - pinnedRows.length - keywordRows.length);
  const topRows = fill > 0
    ? db.prepare(`
        SELECT * FROM companion_memories
        WHERE companion_id = ? AND user_id = ?
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `).all(companionId, userId, limit * 2)
        .filter(r => !seen.has(r.id))
        .slice(0, fill)
    : [];

  return [...pinnedRows, ...keywordRows, ...topRows].slice(0, limit);
}

export function deleteMemory(memoryId, companionId) {
  const db = getDb();
  db.prepare('DELETE FROM companion_memories WHERE id = ? AND companion_id = ?').run(memoryId, companionId);
}

export function clearMemories(companionId, userId) {
  const db = getDb();
  db.prepare('DELETE FROM companion_memories WHERE companion_id = ? AND user_id = ?').run(companionId, userId);
}

export function summaryMemoryExists(companionId, userId, memoryType, prefix) {
  const db = getDb();
  return !!db.prepare(`
    SELECT id FROM companion_memories
    WHERE companion_id = ? AND user_id = ? AND memory_type = ? AND content LIKE ?
    LIMIT 1
  `).get(companionId, userId, memoryType, `${prefix}%`);
}

/**
 * 总结保留策略：
 *   免费版：daily_summary 保留 30 天，其它 summary 不存
 *   Pro 版：daily_summary 保留 180 天，weekly_summary 保留 52 周，monthly_summary 永久
 */
export function cleanupPlanMemories(now = new Date()) {
  const db = getDb();
  const freeDailyCutoff = toSqlTimestamp(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
  const proDailyCutoff = toSqlTimestamp(new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000));
  const proWeeklyCutoff = toSqlTimestamp(new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000));

  const freeDaily = db.prepare(`
    DELETE FROM companion_memories
    WHERE memory_type = 'daily_summary'
      AND created_at < ?
      AND user_id IN (
        SELECT id FROM users
        WHERE plan != 'pro'
           OR (plan_expires_at IS NOT NULL AND datetime(plan_expires_at) <= datetime('now'))
      )
  `).run(freeDailyCutoff);

  const proDaily = db.prepare(`
    DELETE FROM companion_memories
    WHERE memory_type = 'daily_summary'
      AND created_at < ?
      AND user_id IN (
        SELECT id FROM users
        WHERE plan = 'pro'
          AND (plan_expires_at IS NULL OR datetime(plan_expires_at) > datetime('now'))
      )
  `).run(proDailyCutoff);

  const proWeekly = db.prepare(`
    DELETE FROM companion_memories
    WHERE memory_type = 'weekly_summary'
      AND created_at < ?
      AND user_id IN (
        SELECT id FROM users
        WHERE plan = 'pro'
          AND (plan_expires_at IS NULL OR datetime(plan_expires_at) > datetime('now'))
      )
  `).run(proWeeklyCutoff);

  return { freeDaily: freeDaily.changes, proDaily: proDaily.changes, proWeekly: proWeekly.changes };
}

/** 列出所有有 active 微信绑定的 companions（无论免费/Pro） */
export function getAllActiveCompanions() {
  const db = getDb();
  return db.prepare(`
    SELECT
      c.*,
      u.wechat_user_id,
      u.plan AS user_plan,
      u.plan_expires_at
    FROM companions c
    JOIN users u ON u.id = c.user_id
    JOIN wechat_accounts wa
      ON wa.wechat_user_id = u.wechat_user_id
     AND wa.bot_id = c.bot_id
     AND wa.is_active = 1
  `).all().map(row => parseCompanionRow(row));
}

/** 取该 companion 最近 N 条已存的指定类型总结，按时间倒序 */
export function getRecentSummaries(companionId, userId, memoryType, limit = 7) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM companion_memories
    WHERE companion_id = ? AND user_id = ? AND memory_type = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(companionId, userId, memoryType, limit);
}

// ─── image reactions ─────────────────────────────────────────────────────────
function parseImageReactionRow(row) {
  if (!row) return null;
  return {
    ...row,
    memories: parseJson(row.memories_json, []),
  };
}

export function saveImageReaction({
  companionId,
  imageUrl = null,
  imageDescription,
  userMessage = null,
  reactionText = null,
  memories = [],
}) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO companion_image_reactions
      (companion_id, image_url, image_description, user_message, reaction_text, memories_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    companionId,
    imageUrl ? String(imageUrl).slice(0, 1000) : null,
    String(imageDescription || '').slice(0, 2000),
    userMessage ? String(userMessage).slice(0, 1000) : null,
    reactionText ? String(reactionText).slice(0, 1000) : null,
    toJson(memories)
  );
  return parseImageReactionRow(
    db.prepare('SELECT * FROM companion_image_reactions WHERE id = ?').get(info.lastInsertRowid)
  );
}

export function getImageReactions(companionId, limit = 50) {
  const db = getDb();
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db.prepare(`
    SELECT * FROM companion_image_reactions
    WHERE companion_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(companionId, safeLimit).map(parseImageReactionRow);
}

// ─── conversation context ────────────────────────────────────────────────────
const CONVERSATION_ROLES = new Set(['user', 'assistant', 'system']);

export function saveConversationTurn(companionId, role, content, topic = null) {
  const db = getDb();
  const safeRole = CONVERSATION_ROLES.has(role) ? role : 'user';
  const safeContent = String(content || '').trim();
  if (!safeContent) return null;

  const info = db.prepare(`
    INSERT INTO companion_conversation_turns (companion_id, role, content, topic)
    VALUES (?, ?, ?, ?)
  `).run(companionId, safeRole, safeContent.slice(0, 2000), topic ? String(topic).slice(0, 100) : null);

  return db.prepare('SELECT * FROM companion_conversation_turns WHERE id = ?').get(info.lastInsertRowid);
}

export function getConversationContext(companionId, limit = 10) {
  const db = getDb();
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  return db.prepare(`
    SELECT id, companion_id, role, content, topic, created_at
    FROM companion_conversation_turns
    WHERE companion_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(companionId, safeLimit).reverse();
}

export function getConversationTurnsBetween(companionId, startSql, endSql, limit = 500) {
  const db = getDb();
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  return db.prepare(`
    SELECT role, content, topic, created_at
    FROM companion_conversation_turns
    WHERE companion_id = ?
      AND created_at >= ?
      AND created_at < ?
      AND COALESCE(synthetic, 0) = 0   -- v1.6 I: 排除 backfill 虚构历史，防 cron 反思"昨日"误抓 90 天前虚拟事件
    ORDER BY created_at ASC
    LIMIT ?
  `).all(companionId, startSql, endSql, safeLimit);
}

export function clearConversationContext(companionId) {
  const db = getDb();
  const info = db.prepare('DELETE FROM companion_conversation_turns WHERE companion_id = ?').run(companionId);
  return info.changes;
}

// ─── gifts ───────────────────────────────────────────────────────────────────
export const GIFT_CATALOG = Object.freeze([
  {
    id: 'flower',
    name: '鲜花',
    affection_delta: 3,
    price: 0,
    currency: 'CNY',
    paid_required: false,
  },
  {
    id: 'milk_tea',
    name: '奶茶',
    affection_delta: 5,
    price: 0,
    currency: 'CNY',
    paid_required: false,
  },
  {
    id: 'necklace',
    name: '项链',
    affection_delta: 10,
    price: 0,
    currency: 'CNY',
    paid_required: false,
  },
  {
    id: 'ring',
    name: '戒指',
    affection_delta: 20,
    price: 0,
    currency: 'CNY',
    paid_required: false,
  },
]);

export function getGiftById(giftId) {
  return GIFT_CATALOG.find(g => g.id === giftId) || null;
}

function parseGiftRow(row) {
  if (!row) return null;
  return {
    ...row,
    paid_required: !!row.paid_required,
  };
}

export function saveCompanionGift({ companionId, gift, message = null }) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO companion_gifts
      (companion_id, gift_id, gift_name, affection_delta, message, price, currency, paid_required)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    companionId,
    gift.id,
    gift.name,
    gift.affection_delta,
    message ? String(message).slice(0, 500) : null,
    gift.price,
    gift.currency,
    gift.paid_required ? 1 : 0
  );
  return parseGiftRow(db.prepare('SELECT * FROM companion_gifts WHERE id = ?').get(info.lastInsertRowid));
}

export function getCompanionGifts(companionId, limit = 50) {
  const db = getDb();
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db.prepare(`
    SELECT * FROM companion_gifts
    WHERE companion_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(companionId, safeLimit).map(parseGiftRow);
}

// ─── reminders ───────────────────────────────────────────────────────────────
const REMINDER_TYPES = new Set(['birthday', 'anniversary', 'holiday', 'custom']);
const REPEAT_RULES = new Set(['once', 'yearly']);

function normalizeReminder(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: !!row.enabled,
  };
}

function buildReminderFields(data, { partial = false } = {}) {
  const fields = {};

  if (!partial || data.title !== undefined) {
    const title = String(data.title || '').trim();
    if (!title) throw Object.assign(new Error('缺少 title'), { code: 'VALIDATION' });
    fields.title = title.slice(0, 100);
  }

  if (!partial || data.reminder_type !== undefined) {
    const type = String(data.reminder_type || '').trim();
    if (!REMINDER_TYPES.has(type)) {
      throw Object.assign(new Error('reminder_type 必须是：birthday/anniversary/holiday/custom'), { code: 'VALIDATION' });
    }
    fields.reminder_type = type;
  }

  if (!partial || data.date !== undefined) {
    const date = String(data.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw Object.assign(new Error('date 必须是 YYYY-MM-DD'), { code: 'VALIDATION' });
    }
    fields.date = date;
  }

  if (!partial || data.repeat_rule !== undefined) {
    const rule = String(data.repeat_rule || 'once').trim();
    if (!REPEAT_RULES.has(rule)) {
      throw Object.assign(new Error('repeat_rule 必须是：once/yearly'), { code: 'VALIDATION' });
    }
    fields.repeat_rule = rule;
  }

  if (data.message_template !== undefined) {
    fields.message_template = data.message_template == null ? null : String(data.message_template).slice(0, 1000);
  } else if (!partial) {
    fields.message_template = null;
  }

  if (data.enabled !== undefined) fields.enabled = data.enabled ? 1 : 0;
  else if (!partial) fields.enabled = 1;

  if (data.last_triggered_at !== undefined) {
    fields.last_triggered_at = data.last_triggered_at == null ? null : String(data.last_triggered_at);
  }

  return fields;
}

export function createReminder(companionId, data) {
  const db = getDb();
  const fields = buildReminderFields(data);
  const cols = Object.keys(fields);
  const vals = Object.values(fields);
  const info = db.prepare(`
    INSERT INTO companion_reminders (companion_id, ${cols.join(', ')})
    VALUES (?, ${cols.map(() => '?').join(', ')})
  `).run(companionId, ...vals);
  return getReminderById(companionId, info.lastInsertRowid);
}

export function getReminderById(companionId, reminderId) {
  const db = getDb();
  return normalizeReminder(db.prepare(`
    SELECT * FROM companion_reminders
    WHERE companion_id = ? AND id = ?
  `).get(companionId, reminderId));
}

export function getReminders(companionId, limit = 100) {
  const db = getDb();
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 300);
  return db.prepare(`
    SELECT * FROM companion_reminders
    WHERE companion_id = ?
    ORDER BY enabled DESC, date ASC, id DESC
    LIMIT ?
  `).all(companionId, safeLimit).map(normalizeReminder);
}

export function updateReminder(companionId, reminderId, data) {
  const db = getDb();
  const existing = getReminderById(companionId, reminderId);
  if (!existing) {
    const error = new Error('reminder 不存在');
    error.code = 'NOT_FOUND';
    throw error;
  }
  const fields = buildReminderFields(data, { partial: true });
  if (Object.keys(fields).length === 0) return existing;

  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  db.prepare(`
    UPDATE companion_reminders
    SET ${sets}, updated_at = CURRENT_TIMESTAMP
    WHERE companion_id = ? AND id = ?
  `).run(...Object.values(fields), companionId, reminderId);
  return getReminderById(companionId, reminderId);
}

export function deleteReminder(companionId, reminderId) {
  const db = getDb();
  const info = db.prepare(`
    DELETE FROM companion_reminders
    WHERE companion_id = ? AND id = ?
  `).run(companionId, reminderId);
  return info.changes;
}

function localDateString(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function sameDay(ts, ymd) {
  return typeof ts === 'string' && ts.slice(0, 10) === ymd;
}

function isReminderDue(reminder, today) {
  if (!reminder.enabled) return false;
  if (sameDay(reminder.last_triggered_at, today)) return false;
  if (reminder.repeat_rule === 'yearly') return reminder.date.slice(5) === today.slice(5);
  return reminder.date <= today;
}

export function getDueReminders(companionId, today = localDateString()) {
  const list = getReminders(companionId, 300);
  return list.filter(r => isReminderDue(r, today));
}

// ─── Reminder 主动推送支持 ─────────────────────────────────────────────────────
// 提醒表早就存在，但此前只查不推、也从不标记 last_triggered_at（导致去重失效）。
// 这里补上：标记已触发 + 自动登记关系纪念日（认识100天 / 在一起一周年）。
function migrateReminderPush() {
  // 防止 ensureRelationshipReminders 在用户删除自动提醒后反复重建。
  addColIfMissing('companions', 'relationship_reminders_seeded', 'INTEGER DEFAULT 0');
}

// ─── Proactive Daily Target ─────────────────────────────────────────────────
// v1.3.3: 替代 v1.3.2 的 free/pro 三段式频率。开源版让用户直接拖动 0-30 整数。
// v1.13.x：新库默认 4（原 10 偏高，线上数据显示多数用户嫌多直接一刀关掉整个功能）。
// 已建库的列默认值改不动，老库的新用户实际值靠 createCompanion 显式给 4 兜底；
// 这里改的是「全新部署」的 schema 默认，两边保持一致。
function migrateProactiveDailyTarget() {
  addColIfMissing('companions', 'proactive_daily_target', 'INTEGER DEFAULT 4');
  // v1.16.x: 未回连发计数（读空气刹车）—— AI 每发一条主动消息 +1、用户回消息清零；
  // 连发到阈值 shouldBackoffProactive 就闭嘴，防"用户不回还自说自话轰炸"。
  addColIfMissing('companions', 'proactive_unanswered', 'INTEGER DEFAULT 0');
}

// v1.5: 沉默陪伴模式
// silent_mode=1 时她不再主动发消息（覆盖 proactive_enabled / proactive_daily_target）；
// dashboard 角落显示一个呼吸光点表示"她还在"。用户主动发她依然会回复。
function migrateSilentMode() {
  addColIfMissing('companions', 'silent_mode', 'INTEGER DEFAULT 0');
}

// v1.5.2: 主动消息发送时间持久化 — 防进程重启后重复发送
// 每发一条主动消息记录到 companions.last_proactive_sent_at，
// 下次发送前 hard 检查"30 分钟内不重复"，重启也生效。
function migrateProactiveLastSent() {
  addColIfMissing('companions', 'last_proactive_sent_at', 'INTEGER');
  addColIfMissing('companions', 'last_proactive_kind', 'TEXT');
}

export function recordProactiveSentTimestamp(companionId, kind) {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    UPDATE companions
    SET last_proactive_sent_at = ?, last_proactive_kind = ?
    WHERE id = ?
  `).run(now, kind || null, companionId);
}

export function getProactiveLastSent(companionId) {
  const row = getDb().prepare(`
    SELECT last_proactive_sent_at, last_proactive_kind FROM companions WHERE id = ?
  `).get(companionId);
  return row ? { lastAt: row.last_proactive_sent_at || 0, lastKind: row.last_proactive_kind || null } : { lastAt: 0, lastKind: null };
}

// v1.16.x: 标记本离开周期已发过「窗口将关·临门一脚」（unix 秒）。
export function markWindowLastCallSent(companionId) {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`UPDATE companions SET last_lastcall_at = ? WHERE id = ?`).run(now, companionId);
}

// v1.16.x: 未回连发计数（读空气刹车）。AI 每发一条主动消息 +1；用户一回消息清零。
export function bumpProactiveUnanswered(companionId) {
  getDb().prepare(`UPDATE companions SET proactive_unanswered = COALESCE(proactive_unanswered,0) + 1 WHERE id = ?`).run(companionId);
}
export function clearProactiveUnanswered(companionId) {
  getDb().prepare(`UPDATE companions SET proactive_unanswered = 0 WHERE id = ?`).run(companionId);
}

// v1.4.0 Sprint 1: 主动发语音功能字段。
// voice_reply_enabled = 0 表示默认关，用户在 dashboard 手动开启才生效。
// voice_id 留空则用 provider 默认音色（见 src/providers/tts.mjs::REGISTRY）。
// voice_speed 早就在 companions 表的 schema 里（DEFAULT 1.0），不重复添加。
function migrateVoiceReply() {
  addColIfMissing('companions', 'voice_reply_enabled', 'INTEGER DEFAULT 0');
  addColIfMissing('companions', 'voice_id', 'TEXT');

  // v1.4.0 Sprint 2: 每日 TTS 用量上限保护。
  // 每天每个 companion 累计字符到 VOICE_DAILY_CHAR_LIMIT 后剩余主动消息回退文本。
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_voice_usage (
      companion_id INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      date_key TEXT NOT NULL,
      char_count INTEGER NOT NULL DEFAULT 0,
      send_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (companion_id, date_key)
    );
    CREATE INDEX IF NOT EXISTS idx_voice_usage_date
      ON companion_voice_usage(date_key);
  `);
}

// v1.4.0 hotfix: iLink context_token 持久化缓存。
// 之前 src/ilink.mjs 的 lastContextTokenByPair 仅存内存 Map，进程一重启 / 任何独立
// 脚本都拿不到，导致主动语音消息没 context 被 iLink 静默丢弃。
// 现在改为内存 Map + SQLite 双写：write 时落表，read miss 时回表恢复到内存。
function migrateContextTokenCache() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ilink_context_tokens (
      bot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (bot_id, user_id)
    );
  `);
}

export function persistContextToken(botId, userId, token) {
  if (!botId || !userId || !token) return;
  const db = getDb();
  db.prepare(`
    INSERT INTO ilink_context_tokens (bot_id, user_id, token, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(bot_id, user_id) DO UPDATE SET
      token = excluded.token,
      updated_at = excluded.updated_at
  `).run(botId, userId, token, Date.now());
}

export function loadPersistedContextToken(botId, userId, maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!botId || !userId) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT token, updated_at FROM ilink_context_tokens
    WHERE bot_id = ? AND user_id = ?
  `).get(botId, userId);
  if (!row) return null;
  if (Date.now() - row.updated_at > maxAgeMs) return null;
  return row.token;
}

// ─── companion_daily_thoughts (v1.4.1) ────────────────────────────────────────
// 每天一句"她今天想对你说的话"。由 src/thoughts.mjs 在 02:30 cron 生成（紧跟反思/日记），
// dashboard 顶部「她今天想你」卡显示，可点 🔊 朗读。每天每个 companion 一条（UNIQUE）。
function migrateDailyThoughts() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_daily_thoughts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      date_key TEXT NOT NULL,
      content TEXT NOT NULL,
      missing_level INTEGER DEFAULT 0,
      mood TEXT,
      generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(companion_id, date_key)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_thoughts_companion_date
      ON companion_daily_thoughts(companion_id, date_key DESC);
  `);
}

export function upsertDailyThought({ companionId, dateKey, content, missingLevel = 0, mood = null }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO companion_daily_thoughts (companion_id, date_key, content, missing_level, mood, generated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(companion_id, date_key) DO UPDATE SET
      content = excluded.content,
      missing_level = excluded.missing_level,
      mood = excluded.mood,
      generated_at = CURRENT_TIMESTAMP
  `).run(companionId, dateKey, String(content).slice(0, 500), missingLevel, mood);
  return db.prepare('SELECT * FROM companion_daily_thoughts WHERE companion_id = ? AND date_key = ?')
    .get(companionId, dateKey);
}

export function getDailyThought(companionId, dateKey) {
  const db = getDb();
  return db.prepare(`
    SELECT id, date_key, content, missing_level, mood, generated_at
    FROM companion_daily_thoughts
    WHERE companion_id = ? AND date_key = ?
  `).get(companionId, dateKey) || null;
}

export function getRecentDailyThoughts(companionId, limit = 7) {
  const db = getDb();
  const n = Math.min(Math.max(Number(limit) || 7, 1), 30);
  return db.prepare(`
    SELECT id, date_key, content, missing_level, mood, generated_at
    FROM companion_daily_thoughts
    WHERE companion_id = ?
    ORDER BY date_key DESC LIMIT ?
  `).all(companionId, n);
}

// ─── voice usage 存取（v1.4.0 Sprint 2）─────────────────────────────────────
export function recordVoiceUsage(companionId, dateKey, charCount) {
  const db = getDb();
  const n = Math.max(0, Math.floor(Number(charCount) || 0));
  db.prepare(`
    INSERT INTO companion_voice_usage (companion_id, date_key, char_count, send_count, updated_at)
    VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(companion_id, date_key) DO UPDATE SET
      char_count = char_count + excluded.char_count,
      send_count = send_count + 1,
      updated_at = CURRENT_TIMESTAMP
  `).run(companionId, dateKey, n);
}

export function getVoiceUsageToday(companionId, dateKey) {
  const db = getDb();
  const row = db.prepare(`
    SELECT char_count, send_count FROM companion_voice_usage
    WHERE companion_id = ? AND date_key = ?
  `).get(companionId, dateKey);
  return row || { char_count: 0, send_count: 0 };
}

export function markRemindersTriggered(companionId, ids, dateKey) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const db = getDb();
  // 用 dateKey 对齐时间戳，保证 isReminderDue 的 sameDay(last_triggered_at, today) 命中。
  const ts = `${dateKey} ${new Date().toISOString().slice(11, 19)}`;
  const stmt = db.prepare(`
    UPDATE companion_reminders
    SET last_triggered_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE companion_id = ? AND id = ?
  `);
  const tx = db.transaction(arr => { for (const id of arr) stmt.run(ts, companionId, id); });
  tx(ids);
  return ids.length;
}

function fmtYmd(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 第一次见到某个 companion 时，自动登记两条关系里程碑提醒（用户可在提醒页编辑/删除/关闭）。
// 用 once + 未来具体日期，避免 yearly 规则在"创建当天"误触发（yearly 只比对 MM-DD）。
export function ensureRelationshipReminders(companion) {
  if (!companion || companion.relationship_reminders_seeded) return false;
  const db = getDb();
  const markSeeded = () => db.prepare('UPDATE companions SET relationship_reminders_seeded = 1 WHERE id = ?').run(companion.id);

  const raw = companion.created_at;
  if (!raw) { markSeeded(); return false; }
  const created = new Date(String(raw).replace(' ', 'T') + (String(raw).includes('Z') ? '' : 'Z'));
  if (isNaN(created.getTime())) { markSeeded(); return false; }

  const day100 = new Date(created.getTime() + 100 * 86400_000);
  const year1  = new Date(created.getTime() + 365 * 86400_000);
  const rows = [
    { title: '认识 100 天 💕', reminder_type: 'anniversary', date: fmtYmd(day100), repeat_rule: 'once', message_template: '今天是我们认识 100 天的日子～' },
    { title: '在一起一周年 🎉', reminder_type: 'anniversary', date: fmtYmd(year1),  repeat_rule: 'once', message_template: '今天是我们认识满一年的纪念日～' },
  ];
  const ins = db.prepare(`
    INSERT INTO companion_reminders (companion_id, title, reminder_type, date, repeat_rule, message_template, enabled)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);
  const tx = db.transaction(() => {
    for (const r of rows) ins.run(companion.id, r.title, r.reminder_type, r.date, r.repeat_rule, r.message_template);
    markSeeded();
  });
  tx();
  return true;
}

// ─── user_profiles ────────────────────────────────────────────────────────────
const PROFILE_JSON_FIELDS = ['user_hobbies', 'important_dates'];

function parseProfileRow(row) {
  if (!row) return null;
  return {
    ...row,
    user_hobbies:    parseJson(row.user_hobbies, []),
    important_dates: parseJson(row.important_dates, []),
  };
}

export function getUserProfile(userId, companionId) {
  const db = getDb();
  return parseProfileRow(
    db.prepare('SELECT * FROM user_profiles WHERE user_id = ? AND companion_id = ?').get(userId, companionId)
  );
}

export function upsertUserProfile(userId, companionId, data) {
  const db = getDb();
  const allowed = ['user_name', 'user_occupation', 'user_hobbies', 'user_birthday', 'important_dates', 'notes'];
  const cols = [], vals = [];
  for (const k of allowed) {
    if (data[k] === undefined) continue;
    cols.push(k);
    vals.push(PROFILE_JSON_FIELDS.includes(k) ? toJson(data[k]) : (data[k] ?? null));
  }
  if (cols.length === 0) return getUserProfile(userId, companionId);

  const existing = getUserProfile(userId, companionId);
  if (!existing) {
    db.prepare(`
      INSERT INTO user_profiles (user_id, companion_id, ${cols.join(', ')})
      VALUES (?, ?, ${cols.map(() => '?').join(', ')})
    `).run(userId, companionId, ...vals);
  } else {
    const sets = cols.map(c => `${c} = ?`).join(', ');
    db.prepare(`UPDATE user_profiles SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND companion_id = ?`)
      .run(...vals, userId, companionId);
  }
  return getUserProfile(userId, companionId);
}

// ─── messages ────────────────────────────────────────────────────────────────

// Issue #1 持久化去重：首次 claim 返回 true(可处理)，重复返回 false。重启不丢。
export function claimMessage(msgId) {
  if (!msgId) return true;   // 无 msgId 不去重，放行
  const info = getDb().prepare('INSERT OR IGNORE INTO processed_messages (msg_id) VALUES (?)').run(String(msgId));
  return info.changes === 1;
}
export function cleanupProcessedMessages(days = 7) {
  try { return getDb().prepare("DELETE FROM processed_messages WHERE processed_at < datetime('now', ?)").run(`-${days} days`).changes; }
  catch { return 0; }
}

export function saveMessage({ msgId, fromUser, toUser, msgType, content, mediaUrl, mediaMime, direction }) {
  const db = getDb();
  try {
    db.prepare(`
      INSERT OR IGNORE INTO wechat_messages
        (msg_id, from_user, to_user, msg_type, content, media_url, media_mime, direction)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msgId || null, fromUser, toUser, msgType,
      content || null, mediaUrl || null, mediaMime || null, direction
    );
  } catch { /* 重复 msg_id，跳过 */ }
}

export function getRecentHistory(wechatUserId, botId, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT direction, content, msg_type, created_at FROM wechat_messages
    WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
    ORDER BY created_at DESC
    LIMIT ?
  `).all(wechatUserId, botId, botId, wechatUserId, limit).reverse();
}

export function countInboundMessagesBetween(wechatUserId, botId, startSql, endSql) {
  const db = getDb();
  return db.prepare(`
    SELECT COUNT(*) AS n FROM wechat_messages
    WHERE from_user = ?
      AND to_user = ?
      AND direction = 'in'
      AND created_at >= ?
      AND created_at < ?
  `).get(wechatUserId, botId, startSql, endSql)?.n ?? 0;
}

export function shanghaiDayBounds(date = new Date()) {
  const dateKey = shanghaiDateKey(date);
  const [year, month, day] = dateKey.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day, -8, 0, 0));
  const end = new Date(Date.UTC(year, month - 1, day + 1, -8, 0, 0));
  return { dateKey, startSql: toSqlTimestamp(start), endSql: toSqlTimestamp(end) };
}

export function shanghaiDateKey(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shanghaiBoundsForDateKey(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day, -8, 0, 0));
  const end = new Date(Date.UTC(year, month - 1, day + 1, -8, 0, 0));
  return { startSql: toSqlTimestamp(start), endSql: toSqlTimestamp(end) };
}

// ─── 支付订单 ────────────────────────────────────────────────────────────────
export function createBillingOrder({
  orderNo, accountId, plan, period, amountCny, provider = 'alipay',
  payUrl = null, qrUrl = null, rawCreateResp = null,
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO billing_orders
      (order_no, account_id, plan, period, amount_cny, provider, pay_url, qr_url, raw_create_resp, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(orderNo, accountId, plan, period, amountCny, provider, payUrl, qrUrl, rawCreateResp);
  return getBillingOrder(orderNo);
}

export function getBillingOrder(orderNo) {
  return getDb().prepare('SELECT * FROM billing_orders WHERE order_no = ?').get(orderNo) || null;
}

export function listBillingOrdersByAccount(accountId, limit = 50) {
  return getDb().prepare(`
    SELECT * FROM billing_orders WHERE account_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(accountId, limit);
}

export function markOrderPaid(orderNo, { providerTradeNo, rawNotify, paidAt = null }) {
  const db = getDb();
  const paid = paidAt || toSqlTimestamp(new Date());
  const info = db.prepare(`
    UPDATE billing_orders
       SET status = 'paid', provider_trade_no = ?, raw_notify = ?, paid_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE order_no = ? AND status = 'pending'
  `).run(providerTradeNo || null, rawNotify || null, paid, orderNo);
  return info.changes > 0;
}

export function updateOrderStatus(orderNo, status, rawNotify = null) {
  return getDb().prepare(`
    UPDATE billing_orders
       SET status = ?, raw_notify = COALESCE(?, raw_notify), updated_at = CURRENT_TIMESTAMP
     WHERE order_no = ?
  `).run(status, rawNotify, orderNo).changes > 0;
}

// 升级用户 plan = 'pro'，按 days 延长。优先沿用已有未过期 plan_expires_at。
export function grantProToAccount(accountId, days) {
  const db = getDb();
  const binding = db.prepare(`SELECT user_id FROM wechat_accounts WHERE account_id = ? AND is_active = 1`).get(accountId);
  const userId = binding?.user_id || accountId;
  const row = db.prepare(`SELECT plan, plan_expires_at FROM users WHERE id = ?`).get(userId);
  if (!row) {
    db.prepare(`INSERT INTO users (id, plan, plan_expires_at) VALUES (?, 'pro', ?)
                ON CONFLICT(id) DO UPDATE SET plan='pro', plan_expires_at=excluded.plan_expires_at`).run(
      userId,
      toSqlTimestamp(new Date(Date.now() + days * 86400_000))
    );
    return { userId, plan: 'pro', plan_expires_at: toSqlTimestamp(new Date(Date.now() + days * 86400_000)) };
  }
  const now = Date.now();
  const existing = row.plan_expires_at ? new Date(row.plan_expires_at.replace(' ', 'T') + 'Z').getTime() : 0;
  const base = (row.plan === 'pro' && existing > now) ? existing : now;
  const newExpires = toSqlTimestamp(new Date(base + days * 86400_000));
  db.prepare(`UPDATE users SET plan='pro', plan_expires_at=? WHERE id=?`).run(newExpires, userId);
  return { userId, plan: 'pro', plan_expires_at: newExpires };
}

function toSqlTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// ─── Memory v3 accessors ──────────────────────────────────────────────────────

export function getMemoriesV2(companionId, { layer, status = 'active', q, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const parts = ['companion_id = ?'];
  const vals  = [companionId];
  if (layer)  { parts.push('memory_layer = ?');  vals.push(layer); }
  if (status) { parts.push('memory_status = ?'); vals.push(status); }
  if (q)      { parts.push('content LIKE ?');    vals.push(`%${q}%`); }
  const where = parts.join(' AND ');
  const rows = db.prepare(`
    SELECT id, memory_layer, memory_weight, memory_status, memory_source,
           content, pinned, locked, do_not_mention, importance,
           use_count, last_used_at, created_at, updated_at
    FROM companion_memories
    WHERE ${where}
    ORDER BY COALESCE(memory_weight, 3) DESC, importance DESC, created_at DESC
    LIMIT ? OFFSET ?
  `).all(...vals, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) as n FROM companion_memories WHERE ${where}`).get(...vals).n;
  return { memories: rows, total };
}

export function patchMemory(memoryId, companionId, fields) {
  const db  = getDb();
  const now = new Date().toISOString();
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE companion_memories SET ${sets}, updated_at = ? WHERE id = ? AND companion_id = ?`)
    .run(...Object.values(fields), now, memoryId, companionId);
}

export function softDeleteMemory(memoryId, companionId) {
  patchMemory(memoryId, companionId, { memory_status: 'deleted' });
}

export function archiveMemory(memoryId, companionId) {
  patchMemory(memoryId, companionId, { memory_status: 'archived' });
}

export function touchMemory(memoryId, companionId) {
  const db  = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE companion_memories
    SET last_used_at = ?, use_count = COALESCE(use_count, 0) + 1, updated_at = ?
    WHERE id = ? AND companion_id = ?
  `).run(now, now, memoryId, companionId);
}

/**
 * v1.9.4 安全修复：companion 所有权检查收紧
 *
 * 之前版本通过 `wa.wechat_user_id IN (SELECT wechat_user_id FROM users WHERE id = c.user_id)`
 * 隐式 JOIN — 只要两个 web account 绑了同一个微信号，就被认为共享 companion
 * 所有权。这导致越权读：account A 注册时手贱选了 account B 的微信号，
 * 立刻能看到 B 的全部 companion 数据（聊天历史 / 记忆 / 日记）。
 *
 * 新规则：所有权仅来自两条**显式**关系：
 *   1. companions.user_id === accountId（web 直接创建路径）
 *   2. wechat_accounts.companion_id === c.id 且 wa.account_id === accountId 且 wa.is_active=1
 *      （wechat 绑定路径，显式 companion 绑定）
 *
 * 不再有"绑了同个微信号 = 共享 companion"的隐式 JOIN。
 */
export function isCompanionOwnedByAccount(companionId, accountId) {
  if (!companionId || !accountId) return false;
  const db = getDb();
  const row = db.prepare(`
    SELECT 1 FROM companions c
    WHERE c.id = ?
      AND (
        c.user_id = ?
        OR EXISTS (
          SELECT 1 FROM wechat_accounts wa
          WHERE wa.companion_id = c.id
            AND wa.account_id = ?
            AND wa.is_active = 1
        )
      )
    LIMIT 1
  `).get(companionId, accountId, accountId);
  return !!row;
}

// ─── Emotion State accessors ──────────────────────────────────────────────────

export function getEmotionState(companionId) {
  const db = getDb();
  return db.prepare('SELECT * FROM companion_emotion_state WHERE companion_id = ?').get(companionId) || null;
}

export function upsertEmotionState(companionId, fields) {
  const db  = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT companion_id FROM companion_emotion_state WHERE companion_id = ?').get(companionId);
  if (!existing) {
    db.prepare(`
      INSERT INTO companion_emotion_state (companion_id, updated_at)
      VALUES (?, ?)
    `).run(companionId, now);
  }
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE companion_emotion_state SET ${sets}, updated_at = ? WHERE companion_id = ?`)
    .run(...Object.values(fields), now, companionId);
  return db.prepare('SELECT * FROM companion_emotion_state WHERE companion_id = ?').get(companionId);
}

// ─── App Settings accessors ───────────────────────────────────────────────────
// secret=1 的设置不通过普通 API 明文返回，value 不写日志。

export function getAppSetting(key) {
  try {
    const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? row.value : undefined;
  } catch {
    return undefined;
  }
}

export function setAppSetting(key, value, { secret = 0, valueType = 'string' } = {}) {
  getDb().prepare(`
    INSERT INTO app_settings (key, value, value_type, secret, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value      = excluded.value,
      value_type = excluded.value_type,
      secret     = excluded.secret,
      updated_at = CURRENT_TIMESTAMP
  `).run(key, value == null ? null : String(value), valueType, secret ? 1 : 0);
}

export function deleteAppSetting(key) {
  getDb().prepare('DELETE FROM app_settings WHERE key = ?').run(key);
}

export function listPublicAppSettings() {
  return getDb()
    .prepare('SELECT key, value, value_type, updated_at FROM app_settings WHERE secret = 0 ORDER BY key')
    .all();
}

// ─── companion_time_capsules (v1.5) ──────────────────────────────────────────
// 用户写一段话存她那里 + 设解锁时间。时间到 cron 自动"打开"并让 AI 写一段"现在的我"感想。
//   body          ← 用户原文（封存后不可改）
//   unlock_at     ← 解锁时间戳（秒）
//   opened_at     ← 实际打开时间戳（NULL = 未开封）
//   her_reaction  ← 她解封时写的感想（NULL = 未生成）
function migrateTimeCapsules() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_time_capsules (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      companion_id INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      body         TEXT    NOT NULL,
      title        TEXT,
      created_at   INTEGER NOT NULL,
      unlock_at    INTEGER NOT NULL,
      opened_at    INTEGER,
      her_reaction TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_time_capsules_user
      ON companion_time_capsules(user_id, companion_id);
    CREATE INDEX IF NOT EXISTS idx_time_capsules_unlock
      ON companion_time_capsules(unlock_at) WHERE opened_at IS NULL;
  `);
}

export function insertTimeCapsule({ userId, companionId, body, title = null, unlockAt }) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare(`
    INSERT INTO companion_time_capsules (user_id, companion_id, body, title, created_at, unlock_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, companionId, String(body).slice(0, 2000), title ? String(title).slice(0, 80) : null, now, Math.floor(unlockAt));
  return db.prepare('SELECT * FROM companion_time_capsules WHERE id = ?').get(info.lastInsertRowid);
}

export function listTimeCapsulesForCompanion(companionId, { status = 'all' } = {}) {
  const db = getDb();
  let where = 'companion_id = ?';
  if (status === 'pending') where += ' AND opened_at IS NULL';
  else if (status === 'opened') where += ' AND opened_at IS NOT NULL';
  return db.prepare(`
    SELECT id, user_id, companion_id, body, title, created_at, unlock_at, opened_at, her_reaction
    FROM companion_time_capsules WHERE ${where}
    ORDER BY
      CASE WHEN opened_at IS NULL THEN unlock_at ELSE -opened_at END ASC
  `).all(companionId);
}

export function getTimeCapsule(id) {
  return getDb().prepare('SELECT * FROM companion_time_capsules WHERE id = ?').get(id) || null;
}

export function deleteTimeCapsule(id, userId) {
  // 只允许 owner 删，且只删未开封的（已开封是历史，保留）
  const info = getDb().prepare(`
    DELETE FROM companion_time_capsules WHERE id = ? AND user_id = ? AND opened_at IS NULL
  `).run(id, userId);
  return info.changes > 0;
}

export function findMaturedTimeCapsules(limit = 50) {
  const now = Math.floor(Date.now() / 1000);
  return getDb().prepare(`
    SELECT id, user_id, companion_id, body, title, created_at, unlock_at
    FROM companion_time_capsules
    WHERE opened_at IS NULL AND unlock_at <= ?
    ORDER BY unlock_at ASC LIMIT ?
  `).all(now, limit);
}

export function markTimeCapsuleOpened(id, herReaction) {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    UPDATE companion_time_capsules
    SET opened_at = ?, her_reaction = ?
    WHERE id = ? AND opened_at IS NULL
  `).run(now, String(herReaction || '').slice(0, 1500), id);
}

// ─── companion_relational_diary (v1.5) ────────────────────────────────────────
// 反向日记：她每天写「今天和你之间发生了什么」(区别于 companion_diary 的内心独白)。
// 用户可编辑/软删/导出。每天每个 companion 最多一条 (UNIQUE)。
//   body          ← AI 生成的正文（用户可编辑覆盖）
//   user_edited   ← 是否被用户改过（用于 UI 加个小标识）
//   deleted_at    ← 软删时间（NOT NULL 时 cron 第二天不会重生覆盖）
function migrateRelationalDiary() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_relational_diary (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id  INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      date_key      TEXT    NOT NULL,
      body          TEXT    NOT NULL,
      mood          TEXT,
      generated_at  INTEGER NOT NULL,
      updated_at    INTEGER,
      user_edited   INTEGER DEFAULT 0,
      deleted_at    INTEGER,
      UNIQUE(companion_id, date_key)
    );
    CREATE INDEX IF NOT EXISTS idx_relational_diary_companion_date
      ON companion_relational_diary(companion_id, date_key DESC);
  `);
}

export function getRelationalDiaryEntry(companionId, dateKey) {
  return getDb().prepare(`
    SELECT * FROM companion_relational_diary
    WHERE companion_id = ? AND date_key = ?
  `).get(companionId, dateKey) || null;
}

export function getRelationalDiaryById(id) {
  return getDb().prepare(`
    SELECT * FROM companion_relational_diary WHERE id = ?
  `).get(id) || null;
}

export function upsertRelationalDiary({ companionId, dateKey, body, mood = null }) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  // 如果已存在（用户改过 or 已生成 or 已软删），跳过 — 由 cron 调用方判断
  // 这个函数是"插入新的"，幂等冲突时不动现有的
  const info = db.prepare(`
    INSERT INTO companion_relational_diary (companion_id, date_key, body, mood, generated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(companion_id, date_key) DO NOTHING
  `).run(companionId, dateKey, String(body).slice(0, 1500), mood ? String(mood).slice(0, 20) : null, now);
  return info.changes > 0
    ? getRelationalDiaryEntry(companionId, dateKey)
    : null;
}

export function listRelationalDiariesForCompanion(companionId, { limit = 30, includeDeleted = false } = {}) {
  const where = includeDeleted ? 'companion_id = ?' : 'companion_id = ? AND deleted_at IS NULL';
  return getDb().prepare(`
    SELECT id, companion_id, date_key, body, mood, generated_at, updated_at, user_edited, deleted_at
    FROM companion_relational_diary WHERE ${where}
    ORDER BY date_key DESC LIMIT ?
  `).all(companionId, Math.min(Math.max(Number(limit) || 30, 1), 200));
}

export function updateRelationalDiaryBody(id, companionId, body) {
  const now = Math.floor(Date.now() / 1000);
  const info = getDb().prepare(`
    UPDATE companion_relational_diary
    SET body = ?, updated_at = ?, user_edited = 1
    WHERE id = ? AND companion_id = ? AND deleted_at IS NULL
  `).run(String(body).slice(0, 1500), now, id, companionId);
  return info.changes > 0;
}

export function softDeleteRelationalDiary(id, companionId) {
  const now = Math.floor(Date.now() / 1000);
  const info = getDb().prepare(`
    UPDATE companion_relational_diary
    SET deleted_at = ?
    WHERE id = ? AND companion_id = ? AND deleted_at IS NULL
  `).run(now, id, companionId);
  return info.changes > 0;
}

// cron 用：检查指定日期是否已存在条目（包含软删 — 软删后不应该再生成）
export function hasRelationalDiaryForDay(companionId, dateKey) {
  const row = getDb().prepare(`
    SELECT id FROM companion_relational_diary
    WHERE companion_id = ? AND date_key = ? LIMIT 1
  `).get(companionId, dateKey);
  return !!row;
}

// 用户主动 regenerate 用：硬删旧记录（含软删/编辑过的）让 upsert 能写入
export function hardDeleteRelationalDiaryByKey(companionId, dateKey) {
  return getDb().prepare(`
    DELETE FROM companion_relational_diary WHERE companion_id = ? AND date_key = ?
  `).run(companionId, dateKey).changes;
}

// ─── v1.6 PR I: 3 个月模拟时间线 backfill ──────────────────────────────────
// conversation_turns 加 synthetic 列，让 reflection / diary cron 跳过虚构历史
function migrateConversationTurnSynthetic() {
  addColIfMissing('companion_conversation_turns', 'synthetic', 'INTEGER DEFAULT 0');
}

// companions 表标记是否已 backfill 过（防重复运行）
function migrateBackfillFlag() {
  addColIfMissing('companions', 'history_backfilled_at', 'INTEGER');
}

/**
 * 批量写入 backfill 出来的虚拟历史 turn。
 * turns: [{ created_at(ISO), role, content, topic? }]
 */
export function bulkInsertSyntheticTurns(companionId, turns) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO companion_conversation_turns (companion_id, role, content, topic, synthetic, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `);
  const tx = db.transaction((rows) => {
    for (const t of rows) {
      const safeRole = t.role === 'assistant' ? 'assistant' : 'user';
      const safeContent = String(t.content || '').trim().slice(0, 2000);
      if (!safeContent) continue;
      stmt.run(companionId, safeRole, safeContent, t.topic || null, t.created_at);
    }
  });
  tx(turns);
  return turns.length;
}

export function markCompanionBackfilled(companionId) {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`UPDATE companions SET history_backfilled_at = ? WHERE id = ?`).run(now, companionId);
}

export function getCompanionBackfillStatus(companionId) {
  const row = getDb().prepare(`
    SELECT history_backfilled_at,
           (SELECT COUNT(*) FROM companion_conversation_turns WHERE companion_id = ? AND synthetic = 1) AS synthetic_count
    FROM companions WHERE id = ?
  `).get(companionId, companionId);
  return row ? { backfilledAt: row.history_backfilled_at || null, syntheticCount: row.synthetic_count || 0 } : null;
}

// ─── v1.10.0 睡眠作息 ────────────────────────────────────────────────────────
export function getSleepRow(companionId) {
  return getDb()
    .prepare(`SELECT * FROM companion_sleep_schedule WHERE companion_id = ?`)
    .get(companionId) || null;
}

export function ensureSleepRow(companionId) {
  const existing = getSleepRow(companionId);
  if (existing) return existing;
  getDb()
    .prepare(`INSERT OR IGNORE INTO companion_sleep_schedule (companion_id) VALUES (?)`)
    .run(companionId);
  return getSleepRow(companionId);
}

export function upsertSleepSchedule(companionId, fields = {}) {
  ensureSleepRow(companionId);
  const allowed = [
    'enabled', 'bed_time', 'wake_time', 'jitter_min', 'user_set',
    'learn_state', 'observed_samples_json',
    'today_date', 'today_bed_at', 'today_wake_at',
    'is_sleeping', 'sleep_started_at',
    'woken_today', 'last_woken_at',
    'goodnight_sent_for_date', 'goodmorning_sent_for_date',
  ];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (keys.length === 0) return getSleepRow(companionId);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => fields[k]);
  vals.push(companionId);
  getDb()
    .prepare(`UPDATE companion_sleep_schedule SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE companion_id = ?`)
    .run(...vals);
  return getSleepRow(companionId);
}

export function listSleepRowsEnabled() {
  return getDb()
    .prepare(`SELECT * FROM companion_sleep_schedule WHERE enabled = 1`)
    .all();
}

export function queueMissedMessage(companionId, { msgType, content, receivedAt }) {
  getDb()
    .prepare(`INSERT INTO companion_missed_messages (companion_id, received_at, msg_type, content, consumed) VALUES (?, ?, ?, ?, 0)`)
    .run(companionId, receivedAt || Date.now(), String(msgType || 'text'), String(content || '').slice(0, 4000));
}

export function getUnconsumedMissed(companionId, limit = 50) {
  return getDb()
    .prepare(`SELECT * FROM companion_missed_messages WHERE companion_id = ? AND consumed = 0 ORDER BY received_at ASC LIMIT ?`)
    .all(companionId, limit);
}

export function markMissedConsumed(companionId) {
  getDb()
    .prepare(`UPDATE companion_missed_messages SET consumed = 1 WHERE companion_id = ? AND consumed = 0`)
    .run(companionId);
}

export function countMissedSince(companionId, sinceTs) {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM companion_missed_messages WHERE companion_id = ? AND received_at >= ?`)
    .get(companionId, sinceTs || 0);
  return row?.n || 0;
}
