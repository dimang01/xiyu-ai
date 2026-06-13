/**
 * proactive_health.mjs —— proactive tick 健康三桶计数 + tick 心跳（deadman 信号分离，#263 误报修）。
 *
 * 背景：deadman 旧版只读 DB last_proactive_sent_at，把三类 sent=0（未到点 / 正当克制 /
 * 真断供）混为一谈→对单活跃用户密聊期的正当克制误报 CRITICAL（2026-06-13 终判 B=正当克制误报）。
 * 修法 = 让 tick 把自己每周期的处置自报到三桶计数 + 心跳，deadman 据此分桶，**仅「错误 /
 * 无心跳」计 strike**（克制/已发送/无活跃皆不计）。
 *
 *   sent       —— 真发出去了（recordProactiveSentTimestamp 汇聚点）
 *   restrained —— 有理由克制（v2 拒发 / 节流 inflight / 安全门 / arc 降频）；顺带按
 *                 companion+主因细分（digest 🟡 行：谁·在用户活跃期被持续克制·各自主因）
 *   errored    —— 发送路径抛错（evaluateProactive 抛 / 本 tick catch / 照片失败）= #263 形态
 *
 * 心跳 proactive_tick_last_run：每 tick 末写——证明调度线程活着。deadman 据此判 tick 死
 * （含「心跳从未写入 + 过启动宽限」的最深 #263 变体）。
 *
 * 红线：纯计数零副作用，全链 fail-open（任何异常只 warn，绝不影响 tick / deadman 主流程）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */
import { getAppSetting, setAppSetting } from './db.mjs';
import { log } from './logger.mjs';

export const HEALTH_KEYS = {
  tickRun: 'proactive_tick_last_run',
  sent: 'proactive_health_sent',
  restrained: 'proactive_health_restrained',
  errored: 'proactive_health_errored',
  restrainedBy: 'proactive_health_restrained_by',   // JSON {companionId: {reason: count}}
};

const BUCKETS = new Set(['sent', 'restrained', 'errored']);

function readInt(key) {
  const v = Number(getAppSetting(key));
  return Number.isFinite(v) ? v : 0;
}

/** tick 末写心跳（fail-open）。 */
export function recordTickHeartbeat(nowMs = Date.now()) {
  try { setAppSetting(HEALTH_KEYS.tickRun, String(nowMs)); }
  catch (e) { log('warn', `[ProactiveHealth] 心跳写入失败（已忽略）: ${e.message}`); }
}

/**
 * 计一桶。kind ∈ sent|restrained|errored。restrained 顺带按 companion+reason 细分（成本：
 * bump 点本就有 companionId）。全 fail-open——计数失败绝不阻塞发送/克制主流程。
 */
export function bumpProactiveHealth(kind, { companionId = null, reason = null } = {}) {
  if (!BUCKETS.has(kind)) return;
  try {
    setAppSetting(HEALTH_KEYS[kind], String(readInt(HEALTH_KEYS[kind]) + 1));
    if (kind === 'restrained' && companionId != null) {
      let map;
      try { map = JSON.parse(getAppSetting(HEALTH_KEYS.restrainedBy) || '{}') || {}; } catch { map = {}; }
      const cid = String(companionId);
      const r = String(reason || 'unknown');
      map[cid] = map[cid] || {};
      map[cid][r] = (Number(map[cid][r]) || 0) + 1;
      setAppSetting(HEALTH_KEYS.restrainedBy, JSON.stringify(map));
    }
  } catch (e) {
    log('warn', `[ProactiveHealth] 计数失败 kind=${kind}（已忽略）: ${e.message}`);
  }
}

/** 读当前三桶 + 心跳（不清零；诊断用）。 */
export function readProactiveHealth() {
  let restrainedBy;
  try { restrainedBy = JSON.parse(getAppSetting(HEALTH_KEYS.restrainedBy) || '{}') || {}; } catch { restrainedBy = {}; }
  const tickRunRaw = getAppSetting(HEALTH_KEYS.tickRun);
  return {
    sent: readInt(HEALTH_KEYS.sent),
    restrained: readInt(HEALTH_KEYS.restrained),
    errored: readInt(HEALTH_KEYS.errored),
    restrainedBy,
    tickLastRun: (tickRunRaw == null || tickRunRaw === '') ? null : Number(tickRunRaw),
  };
}

/**
 * 读并清零三桶（deadman 每周期 drain；心跳不清——它是绝对时间戳不是计数）。返回 drain 前快照。
 * 单线程同步执行（better-sqlite3 同步、read→reset 之间无 await）→ 无丢 bump 之虞。
 */
export function drainProactiveHealth() {
  const snap = readProactiveHealth();
  try {
    setAppSetting(HEALTH_KEYS.sent, '0');
    setAppSetting(HEALTH_KEYS.restrained, '0');
    setAppSetting(HEALTH_KEYS.errored, '0');
    setAppSetting(HEALTH_KEYS.restrainedBy, '{}');
  } catch (e) {
    log('warn', `[ProactiveHealth] 清零失败（已忽略）: ${e.message}`);
  }
  return snap;
}
