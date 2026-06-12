/**
 * error_signature.mjs —— 错误日志签名归一 + 上报判定（arc-digest 错误签名段共用）。
 *
 * v1.21.6 扩扫描范围：除 [ERROR] 外，捕获被 fail-open 吞成 [WARN] 的**高信号上游调用
 * 失败**（LLM/图片 provider 的 4xx/5xx、extractStructuredInfo/generateReply 失败）。
 *
 * 背景（已知的火）：planner prompt 对象断图的 400 全程是 `[WARN] [ai] extractStructuredInfo
 * 失败: 400 ...`，而错误签名段（#265）只扫 `[ERROR]` → 1.5 天静默没尖叫。拿这场火回测
 * 报警器：isReportableErrorLine 现在必须对它返回 true。
 *
 * 白名单**故意收窄**：只收"调用失败被吞"的形态，不是所有 WARN——否则日常 fail-open
 * 噪声（cooldown/daily count failed 之类）会把签名段灌成噪声墙，等于没有报警。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

// 高信号 WARN 形态：上游调用（LLM/图片/搜索）失败被 catch 吞掉，虽 WARN 但等同事故。
export const WARN_ESCALATE_PATTERNS = [
  /extractStructuredInfo\s*失败/,
  /generateReply\s*失败/,
  /generateImage\s*失败/,
  /(chatComplete\w*|callLLM|requestLLM|webSearch)\b[^]*?失败/,
  /失败[:：]\s*[45]\d\d\b/,                                   // "失败: 4xx/5xx"（provider HTTP 错误码）
  /[45]\d\d[^]*?(deserialize|Bad Request|Unauthorized|Too Many Requests|Internal Server Error)/i,
];

/** 是否高信号 WARN（被 fail-open 吞掉的上游调用失败）。 */
export function isWarnEscalated(line) {
  return line.includes('[WARN]') && WARN_ESCALATE_PATTERNS.some(re => re.test(line));
}

/** 这一行该不该进错误签名段：[ERROR] 一律进；高信号 [WARN] 也进。 */
export function isReportableErrorLine(line) {
  return line.includes('[ERROR]') || isWarnEscalated(line);
}

/**
 * 归一化：去时间戳前缀、companion=N→#、长 hex/数字→#、引号内容→"…"，让同类错误聚成一个签名。
 * 保留 [LEVEL]/[模块] 前缀，方便区分 [ERROR] 与升格的 [WARN]。
 */
export function normalizeErrorSignature(line) {
  return line
    .replace(/^\[[^\]]+\]\s*/, '')                       // 去时间戳前缀（仅第一个 []）
    .replace(/companion[=\s]#?\d+/gi, 'companion=#')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')                  // hex id / clientId
    .replace(/\b\d{3,}\b/g, '#')                         // 长数字（端口/毫秒/计数/HTTP 码）
    .replace(/"[^"]{0,60}"/g, '"…"').replace(/「[^」]{0,60}」/g, '「…」')
    .trim().slice(0, 140);
}
