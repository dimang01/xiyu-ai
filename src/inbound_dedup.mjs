/**
 * inbound_dedup.mjs — 入站消息去重与上下文去重（issue #279）
 *
 * 两层职责（取证结论：两个事发窗口的库层都干净，重复只存在于 LLM 眼前）：
 *
 * 1. stripCurrentTurnFromHistory —— 根因修复。
 *    接收段先落库（saveMessage），回复段再拉 getRecentHistory：当前这轮的
 *    消息因此**同时**出现在 history 尾部和 generateReply 的 userMessage 里，
 *    LLM 看到同一句话两遍（v1.0.0 起结构性存在）。单条轮重复 1 次
 *    （"你这句话说了两遍诶"），coalesce 合并轮每条 part 各重复 1 次
 *    （"复读机"）。修法：组装前把 history 尾部"属于本轮"的入站行剔掉。
 *    剔除条件三重限定，绝不误删真实历史：
 *      - 只从尾部往前回溯，碰到出站行即停（本轮入站段结束）
 *      - 内容必须精确命中本轮 parts（burst 缓冲原文）之一，每条最多销一次
 *      - 行的 created_at 必须在近窗内（默认 10 分钟，防撞历史同句）
 *
 * 2. isProtocolDuplicate —— 纵深防御（本次未发生，防协议重推）。
 *    判定键：同 sender + 同内容 + 同微信侧 create_time（协议重推的是同一条
 *    消息，微信侧原始发送时间相同）。拿不到 create_time 才退化为
 *    sender + 内容 + 短窗（≤60s）。**用户故意连发两句"在吗"是合法行为**
 *    （发送时间不同），绝不能吞——这就是键里必须带微信侧时间戳的原因。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

/** 默认"本轮窗口"：history 行早于它就不可能属于本轮 */
export const STRIP_WINDOW_MS = 10 * 60_000;
/** create_time 缺失时的退化查重窗 */
export const FALLBACK_DEDUP_WINDOW_SEC = 60;

function rowAgeMs(createdAt, nowMs) {
  // wechat_messages.created_at 是 UTC 'YYYY-MM-DD HH:MM:SS'
  const t = new Date(String(createdAt).replace(' ', 'T') + 'Z').getTime();
  return Number.isFinite(t) ? nowMs - t : Infinity;
}

/**
 * 把 history 尾部"属于本轮"的入站行剔除（见文件头）。纯函数，不改入参。
 * @param {Array<{direction:string, content:string, created_at:string}>} history
 * @param {string[]} parts 本轮 burst 缓冲的原始消息（单条轮即 [userText]）
 */
export function stripCurrentTurnFromHistory(history, parts, { nowMs = Date.now(), windowMs = STRIP_WINDOW_MS } = {}) {
  if (!Array.isArray(history) || !history.length) return history || [];
  const need = Array.isArray(parts) ? parts.filter(p => typeof p === 'string' && p) : [];
  if (!need.length) return history;
  const remaining = [...need];
  const out = [...history];
  for (let i = out.length - 1; i >= 0 && remaining.length; i--) {
    const h = out[i];
    if (!h || h.direction !== 'in') break;                    // 出站行 = 本轮入站段结束
    if (rowAgeMs(h.created_at, nowMs) > windowMs) break;      // 太旧，不属于本轮
    const idx = remaining.lastIndexOf(h.content);
    if (idx === -1) break;                                    // 尾部入站但不是本轮内容 → 停
    remaining.splice(idx, 1);
    out.splice(i, 1);
  }
  return out;
}

/**
 * 协议重推判定（纯函数：给定库里最近的同 sender+content 候选行，判断新到
 * 消息是否它的重推）。返回 true = 重推，调用方应拦截。
 * @param {{wx_create_time:any, created_at:string}|null} candidate
 * @param {{wxCreateTime:any}} incoming
 */
export function isProtocolDuplicate(candidate, incoming, { nowMs = Date.now() } = {}) {
  if (!candidate) return false;
  const inTs = incoming?.wxCreateTime != null && incoming.wxCreateTime !== '' ? String(incoming.wxCreateTime) : null;
  const dbTs = candidate.wx_create_time != null && candidate.wx_create_time !== '' ? String(candidate.wx_create_time) : null;
  if (inTs && dbTs) return inTs === dbTs;                     // 主键路径：微信侧发送时间相同 = 重推
  if (inTs || dbTs) return false;                             // 只有一边有：判不了，放行（宁放勿吞）
  // 双方都没有 create_time：退化短窗（协议重推通常秒级到达）
  return rowAgeMs(candidate.created_at, nowMs) <= FALLBACK_DEDUP_WINDOW_SEC * 1000;
}
