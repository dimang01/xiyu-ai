/**
 * v1.9.11: 管理员用户画像
 *
 * 综合 SQL 统计 + 关键词词典 + 可选 LLM 推断，给 admin 后台一个用户的
 * 多维度画像。
 *
 * ⚠️ 伦理边界（与 SECURITY.md 同步）：
 * - 本模块面向**单实例自托管自查**，**不可**作为商业用户画像 / 操纵工具
 * - LLM 推断的"年龄段 / 依赖程度 / 消费能力 / 付出索取"是粗略估算，**不持久化**
 *   到 DB，每次 admin 打开页面时实时计算
 * - safety_events 仅统计计数，**不**回放具体内容
 * - 已在 SECURITY.md "数据敏感性" 段强调此模块的使用限制
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { getDb } from './db.mjs';
import { extractStructuredInfo } from './ai.mjs';
import { log } from './logger.mjs';

// ─── 1. SQL 维度：基础统计 ──────────────────────────────────────────────────

/**
 * 拿到该 account 名下所有 companion id（用于聚合数据）
 */
function getCompanionIdsForAccount(accountId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT c.id FROM companions c
    WHERE c.user_id = ?
       OR EXISTS (
         SELECT 1 FROM wechat_accounts wa
         WHERE wa.companion_id = c.id AND wa.account_id = ? AND wa.is_active = 1
       )
  `).all(accountId, accountId);
  return rows.map(r => r.id);
}

function inClause(ids) {
  // 生成 SQL IN (?, ?, ?) 占位符
  return ids.length === 0 ? '(NULL)' : `(${ids.map(() => '?').join(',')})`;
}

/**
 * 消息总量 + 日均 + 跨度
 */
export function computeMessageStats(accountId) {
  const ids = getCompanionIdsForAccount(accountId);
  if (ids.length === 0) return { total: 0, user_turns: 0, ai_turns: 0, daily_avg: 0, span_days: 0 };
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) AS user_turns,
      SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END) AS ai_turns,
      MIN(created_at) AS first_at,
      MAX(created_at) AS last_at
    FROM companion_conversation_turns
    WHERE companion_id IN ${inClause(ids)}
  `).get(...ids);
  const spanDays = row?.first_at && row?.last_at
    ? Math.max(1, Math.round((new Date(row.last_at) - new Date(row.first_at)) / 86_400_000))
    : 0;
  const dailyAvg = spanDays > 0 ? Math.round(row.total / spanDays * 10) / 10 : row?.total || 0;
  return {
    total: row?.total || 0,
    user_turns: row?.user_turns || 0,
    ai_turns: row?.ai_turns || 0,
    daily_avg: dailyAvg,
    span_days: spanDays,
    first_at: row?.first_at || null,
    last_at: row?.last_at || null,
  };
}

/**
 * 活跃时段直方图（7 dow × 24 hour）
 * 用 user turns 反映真实使用模式（assistant 消息时间是后端生成时间）
 */
export function computeActivityHeatmap(accountId) {
  const ids = getCompanionIdsForAccount(accountId);
  if (ids.length === 0) return { grid: [], total: 0 };
  const db = getDb();
  // SQLite 用 'localtime' modifier 转上海时区不可靠（依赖系统 tz），用 UTC 偏移 +8h
  const rows = db.prepare(`
    SELECT
      CAST(strftime('%w', datetime(created_at, '+8 hours')) AS INT) AS dow,
      CAST(strftime('%H', datetime(created_at, '+8 hours')) AS INT) AS hour,
      COUNT(*) AS n
    FROM companion_conversation_turns
    WHERE role = 'user' AND companion_id IN ${inClause(ids)}
    GROUP BY dow, hour
  `).all(...ids);
  // 输出 grid[dow][hour] = n
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let total = 0;
  for (const r of rows) {
    if (r.dow >= 0 && r.dow < 7 && r.hour >= 0 && r.hour < 24) {
      grid[r.dow][r.hour] = r.n;
      total += r.n;
    }
  }
  return { grid, total };
}

/**
 * 主动 vs 被动：用户在长时间沉默（> 60min）后发的第一句视为"主动开启对话"
 */
export function computeInitiationRatio(accountId) {
  const ids = getCompanionIdsForAccount(accountId);
  if (ids.length === 0) return { user_initiated: 0, total_user_messages: 0, ratio: 0 };
  const db = getDb();
  // 用 LAG 找前一条 turn 的时间
  const row = db.prepare(`
    WITH t AS (
      SELECT created_at, role,
        LAG(created_at) OVER (ORDER BY id) AS prev_at
      FROM companion_conversation_turns
      WHERE companion_id IN ${inClause(ids)}
      ORDER BY id
    )
    SELECT
      SUM(CASE WHEN role='user' AND (prev_at IS NULL OR (julianday(created_at) - julianday(prev_at)) * 1440 > 60) THEN 1 ELSE 0 END) AS user_initiated,
      SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) AS total_user
    FROM t
  `).get(...ids);
  const ratio = row?.total_user > 0 ? Math.round(row.user_initiated / row.total_user * 100) / 100 : 0;
  return {
    user_initiated: row?.user_initiated || 0,
    total_user_messages: row?.total_user || 0,
    ratio,  // 0-1：1 = 几乎全是用户主动找她，0 = 几乎全在回她
  };
}

/**
 * 使用天数 + 中断次数（连续 ≥ 3 天没聊算一次中断）
 */
export function computeUsagePattern(accountId) {
  const ids = getCompanionIdsForAccount(accountId);
  if (ids.length === 0) return { active_days: 0, span_days: 0, gaps: 0, longest_gap_days: 0 };
  const db = getDb();
  const days = db.prepare(`
    SELECT DISTINCT date(datetime(created_at, '+8 hours')) AS day
    FROM companion_conversation_turns
    WHERE companion_id IN ${inClause(ids)}
    ORDER BY day
  `).all(...ids).map(r => r.day);

  const activeDays = days.length;
  let gaps = 0;
  let longestGap = 0;
  for (let i = 1; i < days.length; i++) {
    const diff = (new Date(days[i]) - new Date(days[i - 1])) / 86_400_000;
    if (diff >= 3) gaps++;
    if (diff > longestGap) longestGap = diff;
  }
  const spanDays = days.length > 0
    ? Math.round((new Date(days[days.length - 1]) - new Date(days[0])) / 86_400_000) + 1
    : 0;
  return { active_days: activeDays, span_days: spanDays, gaps, longest_gap_days: Math.round(longestGap) };
}

/**
 * 关系阶段进展速度（用 companion_stage_milestones 表）
 */
export function computeRelationshipProgress(accountId) {
  const ids = getCompanionIdsForAccount(accountId);
  if (ids.length === 0) return { current_stages: [], milestones: [] };
  const db = getDb();
  const milestones = db.prepare(`
    SELECT companion_id, from_stage, to_stage, days_since_meet, affection_at_upgrade, created_at
    FROM companion_stage_milestones
    WHERE companion_id IN ${inClause(ids)}
    ORDER BY created_at ASC
  `).all(...ids);
  const currents = db.prepare(`
    SELECT id, name, relationship_stage, affection_level, created_at
    FROM companions
    WHERE id IN ${inClause(ids)}
  `).all(...ids);
  return { current_stages: currents, milestones };
}

/**
 * 平均回复长度（用户 vs AI）
 */
export function computeReplyLength(accountId) {
  const ids = getCompanionIdsForAccount(accountId);
  if (ids.length === 0) return { user_avg: 0, ai_avg: 0 };
  const db = getDb();
  const row = db.prepare(`
    SELECT
      AVG(CASE WHEN role='user' THEN length(content) END) AS user_avg,
      AVG(CASE WHEN role='assistant' THEN length(content) END) AS ai_avg
    FROM companion_conversation_turns
    WHERE companion_id IN ${inClause(ids)}
  `).get(...ids);
  return {
    user_avg: Math.round(row?.user_avg || 0),
    ai_avg: Math.round(row?.ai_avg || 0),
  };
}

/**
 * Open Loops 完成率
 */
export function computeOpenLoopStats(accountId) {
  const ids = getCompanionIdsForAccount(accountId);
  if (ids.length === 0) return { total: 0, resolved: 0, open: 0, stale: 0, completion_rate: 0 };
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status='stale' THEN 1 ELSE 0 END) AS stale
    FROM companion_open_loops
    WHERE companion_id IN ${inClause(ids)}
  `).get(...ids);
  const total = row?.total || 0;
  return {
    total,
    resolved: row?.resolved || 0,
    open: row?.open || 0,
    stale: row?.stale || 0,
    completion_rate: total > 0 ? Math.round((row.resolved / total) * 100) / 100 : 0,
  };
}

/**
 * Safety 事件计数（不回放内容！只数字）
 */
export function computeSafetyStats(accountId) {
  const ids = getCompanionIdsForAccount(accountId);
  if (ids.length === 0) return { high: 0, medium: 0, total: 0, last_at: null };
  const db = getDb();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN level='high'   THEN 1 ELSE 0 END) AS high,
      SUM(CASE WHEN level='medium' THEN 1 ELSE 0 END) AS medium,
      COUNT(*) AS total,
      MAX(created_at) AS last_at
    FROM safety_events
    WHERE companion_id IN ${inClause(ids)}
  `).get(...ids);
  return {
    high: row?.high || 0,
    medium: row?.medium || 0,
    total: row?.total || 0,
    last_at: row?.last_at ? new Date(row.last_at).toISOString() : null,
  };
}

/**
 * AI 用量（从 ai_usage_daily 聚合）
 */
export function computeAiUsage(accountId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      SUM(prompt_tokens)     AS prompt_tokens,
      SUM(completion_tokens) AS completion_tokens,
      SUM(message_count)     AS messages,
      MIN(day)               AS first_day,
      MAX(day)               AS last_day
    FROM ai_usage_daily WHERE account_id = ?
  `).get(accountId);
  return {
    prompt_tokens: row?.prompt_tokens || 0,
    completion_tokens: row?.completion_tokens || 0,
    total_tokens: (row?.prompt_tokens || 0) + (row?.completion_tokens || 0),
    messages: row?.messages || 0,
    first_day: row?.first_day || null,
    last_day: row?.last_day || null,
  };
}

// ─── 2. 关键词词典：话题倾向 ────────────────────────────────────────────────
// 词典是粗略匹配，不区分上下文，仅用作"倾向"参考
const TOPIC_KEYWORDS = {
  work:     ['工作', '上班', '老板', '同事', '加班', '项目', '客户', '会议', 'KPI', 'OKR', '面试', '简历', '辞职', '裸辞', '跳槽', '公司'],
  study:    ['学习', '考试', '老师', '同学', '宿舍', '上课', '作业', '论文', '高考', '考研', '复习', '挂科', '学分', '导师'],
  family:   ['爸爸', '妈妈', '家里', '家人', '父母', '兄弟', '姐妹', '亲戚', '爷爷', '奶奶', '外公', '外婆', '老家'],
  romance:  ['亲亲', '抱抱', '想你', '爱你', '宝贝', '老婆', '老公', '想你了', '亲一个', '在一起'],
  emotion_neg: ['难过', '伤心', '生气', '委屈', '哭', '崩溃', '绝望', '抑郁', '焦虑', '失眠', '孤独'],
  emotion_pos: ['开心', '哈哈', '嘻嘻', '快乐', '幸福', '激动', '兴奋'],
  health:   ['生病', '医院', '感冒', '发烧', '失眠', '健身', '减肥', '体检', '吃药', '看病'],
  food:     ['吃', '饭', '菜', '餐', '美食', '外卖', '做菜', '火锅', '烧烤', '奶茶'],
  travel:   ['旅游', '旅行', '出去玩', '景点', '机票', '酒店', '飞机', '高铁'],
  finance:  ['钱', '工资', '房贷', '房租', '存款', '股票', '基金', '理财', '买房', '车贷'],
  hobby_game: ['游戏', '主机', 'steam', '电脑', '王者', '原神', '吃鸡', '打游戏'],
  hobby_show: ['电视剧', '综艺', '电影', '追剧', '看剧', '爱豆', '偶像'],
};

/**
 * 话题倾向（命中频次 + 占比）
 * 只扫 user role 的 turns content，避免 AI 重复关键词带偏
 */
export function computeTopicTendency(accountId) {
  const ids = getCompanionIdsForAccount(accountId);
  if (ids.length === 0) return { topics: {}, total_user_messages: 0 };
  const db = getDb();
  const turns = db.prepare(`
    SELECT content FROM companion_conversation_turns
    WHERE role = 'user' AND companion_id IN ${inClause(ids)}
    LIMIT 2000
  `).all(...ids);
  const counts = {};
  for (const topic of Object.keys(TOPIC_KEYWORDS)) counts[topic] = 0;
  for (const t of turns) {
    const text = String(t.content || '');
    for (const [topic, words] of Object.entries(TOPIC_KEYWORDS)) {
      for (const w of words) {
        if (text.includes(w)) { counts[topic]++; break; }  // 一条消息一个主题命中一次
      }
    }
  }
  // 转 ratio
  const topics = {};
  for (const [topic, n] of Object.entries(counts)) {
    topics[topic] = {
      hits: n,
      ratio: turns.length > 0 ? Math.round((n / turns.length) * 1000) / 1000 : 0,
    };
  }
  return { topics, total_user_messages: turns.length };
}

/**
 * 情绪基线（从 turns 里负面 vs 正面词出现率，简单粗算）
 */
export function computeEmotionBaseline(accountId) {
  const t = computeTopicTendency(accountId);
  const neg = t.topics.emotion_neg?.hits || 0;
  const pos = t.topics.emotion_pos?.hits || 0;
  const total = t.total_user_messages;
  return {
    negative_hits: neg,
    positive_hits: pos,
    negative_ratio: total > 0 ? Math.round((neg / total) * 1000) / 1000 : 0,
    positive_ratio: total > 0 ? Math.round((pos / total) * 1000) / 1000 : 0,
    polarity: pos + neg > 0 ? Math.round((pos - neg) / (pos + neg) * 100) / 100 : 0,  // -1 到 +1
  };
}

// ─── 3. LLM 推断（不持久化，每次调时实时算）─────────────────────────────────

/**
 * 取最近 N 条 user 消息文本，用于 LLM 推断输入
 */
function getRecentUserText(accountId, limit = 50) {
  const ids = getCompanionIdsForAccount(accountId);
  if (ids.length === 0) return [];
  const db = getDb();
  return db.prepare(`
    SELECT content FROM companion_conversation_turns
    WHERE role = 'user' AND companion_id IN ${inClause(ids)}
    ORDER BY id DESC LIMIT ?
  `).all(...ids, limit).map(r => String(r.content || '').slice(0, 200)).reverse();
}

/**
 * v1.9.11: LLM 综合推断 — 仅 age_range + dependency_score
 *
 * 返回：
 *   age_range: string (e.g. "20-22")
 *   dependency_score: 1-10
 *   confidence: 0-1
 *   reason: string (LLM 的简短解释，仅 admin 看)
 *
 * 设计原则：只做对运营理解用户有用的维度。消费档位 / 付出索取经济学
 * 这类"商业操纵"导向的推断**故意不做**（边界见 SECURITY.md）。
 *
 * ⚠️ 不持久化，不导出。仅 admin 当下查看。
 */
export async function llmInferUserPersona(accountId) {
  const msgs = getRecentUserText(accountId, 60);
  if (msgs.length < 5) {
    return { skipped: 'too_few_messages', sample_size: msgs.length };
  }
  const sample = msgs.map((m, i) => `${i + 1}. ${m}`).join('\n').slice(0, 6000);

  const sys = `你是聊天画像分析助手。基于他给 AI 女友发的真实消息样本，推断 2 个维度。
必须输出 JSON，结构严格如下，不输出任何其他文字：

{
  "age_range": "14-16" | "16-18" | "18-20" | "20-22" | "22-24" | "24-26" | "26-28" | "28-30" | "30-35" | "35+" | "unknown",
  "dependency_score": <1-10 整数>,
  "confidence": <0-1 浮点>,
  "reason": "<≤80字简短解释>"
}

判断依据：
- age_range：词汇风格、关心话题（学校/上班/家庭/养老）、网络用语年代感。每 2 岁一档。把握不准就 "unknown"
- dependency_score：1=很独立偶尔聊，10=高频依附（结合对话频率/凌晨消息比例/情感强度）
- confidence：你对整体判断的把握。样本不足或信号弱要主动给低值

不要编造，看不出就 unknown / 中间值 / 低 confidence。不要推断消费能力、不要推断付出索取关系。`;

  const userContent = `以下是他最近 ${msgs.length} 条消息（按时间正序）：\n\n${sample}\n\n请输出 JSON。`;

  try {
    const raw = await extractStructuredInfo(sys, userContent, { maxTokens: 250, temperature: 0.2 });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { error: 'no_json', raw: raw.slice(0, 200) };
    const parsed = JSON.parse(m[0]);
    return {
      age_range: typeof parsed.age_range === 'string' ? parsed.age_range : 'unknown',
      dependency_score: Math.max(1, Math.min(10, Number(parsed.dependency_score) || 5)),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.3)),
      reason: String(parsed.reason || '').slice(0, 200),
      sample_size: msgs.length,
    };
  } catch (e) {
    log('warn', `[user-profile] llm infer failed account=${accountId}: ${e.message}`);
    return { error: e.message, sample_size: msgs.length };
  }
}

// ─── 4. 主入口：聚合所有维度 ────────────────────────────────────────────────

/**
 * 完整画像。SQL 维度同步算，LLM 推断异步。
 * @param {number} accountId
 * @param {{ withLlm?: boolean }} opts — withLlm=true 时跑 LLM 推断（约 1-2s）
 */
export async function computeFullProfile(accountId, { withLlm = false } = {}) {
  if (!accountId) return null;
  const result = {
    account_id: accountId,
    computed_at: new Date().toISOString(),
    sql: {
      messages:         computeMessageStats(accountId),
      activity_heatmap: computeActivityHeatmap(accountId),
      initiation:       computeInitiationRatio(accountId),
      usage_pattern:    computeUsagePattern(accountId),
      relationship:     computeRelationshipProgress(accountId),
      reply_length:     computeReplyLength(accountId),
      open_loops:       computeOpenLoopStats(accountId),
      safety:           computeSafetyStats(accountId),
      ai_usage:         computeAiUsage(accountId),
    },
    keywords: {
      topics:  computeTopicTendency(accountId),
      emotion: computeEmotionBaseline(accountId),
    },
    llm: null,
  };
  if (withLlm) {
    result.llm = await llmInferUserPersona(accountId);
  }
  return result;
}
