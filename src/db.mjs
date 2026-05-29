/**
 * SQLite 数据访问层（全部操作 + schema 迁移）
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'node:path';
import fs from 'node:fs';

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
    migrateAppSettings();
  }
  return db;
}

function migrateUserAccounts() {
  addColIfMissing('user_accounts', 'birthday', 'TEXT');
  addColIfMissing('user_accounts', 'age_at_registration', 'INTEGER');
  addColIfMissing('user_accounts', 'terms_accepted_at', 'DATETIME');
  addColIfMissing('user_accounts', 'terms_version', 'TEXT');
  addColIfMissing('user_accounts', 'is_banned', 'INTEGER DEFAULT 0');
  addColIfMissing('user_accounts', 'banned_reason', 'TEXT');
  addColIfMissing('user_accounts', 'banned_at', 'DATETIME');
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
      affection_level INTEGER DEFAULT 0,
      relationship_stage TEXT DEFAULT '陌生人',

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
  addColIfMissing('companions', 'last_photo_at', 'DATETIME');
  addColIfMissing('companions', 'last_photo_caption', 'TEXT');
}

// ─── Memory v3：分层 / 权重 / 状态 / 遗忘曲线 ─────────────────────────────────
function migrateMemoryV3() {
  addColIfMissing('companion_memories', 'memory_layer',  "TEXT DEFAULT 'event'");
  addColIfMissing('companion_memories', 'memory_weight', 'INTEGER DEFAULT 3');
  addColIfMissing('companion_memories', 'memory_status', "TEXT DEFAULT 'active'");
  addColIfMissing('companion_memories', 'memory_source', "TEXT DEFAULT 'auto'");
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
}

// ─── Proactive Engine v2 ───────────────────────────────────────────────────────
function migrateProactiveEngineV2() {
  addColIfMissing('companions', 'proactive_intensity',    "TEXT DEFAULT 'normal'");
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
}

export function insertEmotionHistory(companionId, state, source = 'auto') {
  const db = getDb();
  db.prepare(`
    INSERT INTO companion_emotion_history
      (companion_id, affection, trust, dependency, possessiveness, security, energy, mood, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    companionId,
    state.affection   ?? null,
    state.trust       ?? null,
    state.dependency  ?? null,
    state.possessiveness ?? null,
    state.security    ?? null,
    state.energy      ?? null,
    state.mood        ?? null,
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
]);
const BOOL_FIELDS = new Set([
  'use_kaomoji', 'can_joke', 'avoid_cheesy', 'no_pressure', 'occasional_tantrum',
  'encouraging', 'proactive_enabled', 'voice_reply_enabled', 'sticker_reply_enabled',
  'memory_enabled',
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
  'proactive_enabled', 'proactive_frequency', 'proactive_time_window',
  'voice_reply_enabled', 'sticker_reply_enabled',
  'call_user_as', 'user_call_her_as',
  'persona_prompt', 'forbidden_topics',
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
 */
export function getBotContextForCompanion(companionId) {
  if (!companionId) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT wa.bot_id, wa.bot_token, wa.wechat_user_id
    FROM wechat_accounts wa
    JOIN companions c ON c.id = ?
    LEFT JOIN users u ON u.id = c.user_id
    WHERE wa.is_active = 1
      AND wa.bot_token IS NOT NULL AND wa.bot_token <> ''
      AND (wa.companion_id = c.id OR wa.wechat_user_id = u.wechat_user_id)
    ORDER BY wa.updated_at DESC
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

function findCurrentCompanionForAccount(db, accountId, botId) {
  return db.prepare(`
    SELECT c.*
    FROM companions c
    LEFT JOIN users u
      ON u.id = c.user_id
    LEFT JOIN wechat_accounts wa_by_companion
      ON wa_by_companion.companion_id = c.id
     AND wa_by_companion.account_id = ?
    LEFT JOIN wechat_accounts wa_by_user
      ON wa_by_user.wechat_user_id = u.wechat_user_id
     AND wa_by_user.account_id = ?
    WHERE wa_by_companion.id IS NOT NULL
       OR wa_by_user.id IS NOT NULL
       OR c.user_id = ?
    ORDER BY
      CASE WHEN c.bot_id = ? THEN 0 ELSE 1 END,
      c.updated_at DESC
    LIMIT 1
  `).get(accountId, accountId, accountId, botId);
}

function ensureCompanionBot(db, companionId, botId) {
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

export function getCompanionByAccountId(accountId) {
  const db = getDb();
  return parseCompanionRow(db.prepare(`
    SELECT c.*
    FROM wechat_accounts wa
    LEFT JOIN users u
      ON u.wechat_user_id = wa.wechat_user_id
    LEFT JOIN wechat_accounts historical_wa
      ON historical_wa.account_id = wa.account_id
     AND historical_wa.wechat_user_id IS NOT NULL
    LEFT JOIN users historical_u
      ON historical_u.wechat_user_id = historical_wa.wechat_user_id
    JOIN companions c
      ON c.id = wa.companion_id
      OR (c.user_id = u.id AND c.bot_id = wa.bot_id)
      OR c.id = historical_wa.companion_id
      OR c.user_id = historical_u.id
      OR c.user_id = wa.account_id
    WHERE wa.account_id = ?
      AND wa.is_active = 1
    ORDER BY
      wa.updated_at DESC,
      CASE
        WHEN c.id = wa.companion_id THEN 0
        WHEN c.user_id = u.id AND c.bot_id = wa.bot_id THEN 1
        WHEN c.id = historical_wa.companion_id THEN 2
        WHEN c.user_id = historical_u.id THEN 3
        ELSE 4
      END,
      c.updated_at DESC
    LIMIT 1
  `).get(accountId));
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

    const owned = db.prepare(`
      SELECT c.id
      FROM wechat_accounts wa
      JOIN users u
        ON u.wechat_user_id = wa.wechat_user_id
      JOIN companions c
        ON c.user_id = u.id
       AND c.bot_id = wa.bot_id
      WHERE wa.account_id = ?
        AND wa.is_active = 1
        AND c.id = ?
      LIMIT 1
    `).get(accountId, companionId);
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
  const fields = buildUpsertFields(data);
  const info = db.prepare(`
    INSERT INTO companions (user_id, bot_id${fields.cols.length ? ', ' + fields.cols.join(', ') : ''})
    VALUES (?, ?${fields.cols.length ? ', ' + fields.placeholders.join(', ') : ''})
  `).run(user.id, botId, ...fields.values);
  return getCompanionById(info.lastInsertRowid);
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
  return getCompanionById(id);
}

/** 直接更新 companion 的特定字段（供内部使用，跳过白名单） */
export function patchCompanion(id, fields) {
  const db = getDb();
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const vals = Object.values(fields);
  db.prepare(`UPDATE companions SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(...vals, id);
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

export function saveMemories(memories) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO companion_memories (companion_id, user_id, memory_type, content, importance, pinned, keywords, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(list => {
    for (const m of list) {
      const imp = m.importance || 5;
      const pinned = m.pinned !== undefined ? (m.pinned ? 1 : 0) : (imp >= 7 ? 1 : 0);
      const kw = Array.isArray(m.keywords) ? JSON.stringify(m.keywords) : (m.keywords || null);
      const emb = m.embedding ? packEmbedding(m.embedding) : null;
      stmt.run(m.companionId, m.userId, m.memoryType, m.content, imp, pinned, kw, emb);
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

export function isCompanionOwnedByAccount(companionId, accountId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT 1 FROM companions c
    JOIN wechat_accounts wa ON
      wa.companion_id = c.id OR
      wa.wechat_user_id IN (SELECT wechat_user_id FROM users WHERE id = c.user_id)
    WHERE c.id = ? AND wa.account_id = ? AND wa.is_active = 1
    LIMIT 1
  `).get(companionId, accountId);
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
