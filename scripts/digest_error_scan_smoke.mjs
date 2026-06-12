/**
 * digest_error_scan_smoke —— 锁死 v1.21.6 报警盲区修复（arc-digest 错误签名段扫描范围）。
 *
 * 已知的火回测（拿真实的 06-11 400 当 fixture）：错误签名段曾只扫 [ERROR]，而 planner
 * 对象断图的 400 是 [WARN][ai] → 静默 1.5 天。修复后 isReportableErrorLine 必须对它返回 true。
 *
 * 双向红色验证：
 *   - 拦：真实 400 [WARN][ai] / 各类上游调用失败 WARN → 必须上报（否则报警器又瞎）
 *   - 放：日常 fail-open 噪声 WARN（cooldown/daily count failed）→ 必须不上报（否则签名段成噪声墙）
 */
import { isReportableErrorLine, isWarnEscalated, normalizeErrorSignature } from './error_signature.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// 真实的火（06-11 生产原样，含时间戳前缀）
const FIRE_400 = '[2026-06-11T14:08:01.600Z] [WARN] [ai] extractStructuredInfo 失败: 400 Failed to deserialize the JSON body into the target type: messages[1]: content should be a string or a list at line 15 column 3';
const FIRE_400_B = '[2026-06-11T14:05:13.484Z] [WARN] [ai] extractStructuredInfo 失败: 400 Failed to deserialize the JSON body into the target type: messages[1]: content should be a string or a list at line 9 column 3';
const FIRE_ECONNRESET = '[2026-06-11T06:38:38.259Z] [WARN] [ai] extractStructuredInfo 失败: Invalid response body while trying to fetch https://api.deepseek.com/chat/completions: read ECONNRESET';
const FIRE_REPLY = '[2026-06-11T10:00:00.000Z] [WARN] [ai] generateReply 失败: 500 Internal Server Error';

// 日常 fail-open 噪声 WARN（绝不能进签名段）
const NOISE_COOLDOWN = '[2026-06-11T10:00:00.000Z] [WARN] [PhotoPlanner] daily count failed: db locked';
const NOISE_EMO = '[2026-06-11T10:00:00.000Z] [WARN] [Proactive] photo emotion state unavailable companion=3 error=x';
const NOISE_VISUAL = '[2026-06-11T10:00:00.000Z] [WARN] [Photo] 读取参考图失败 companion=3: ENOENT';

const REAL_ERROR = '[2026-06-11T10:00:00.000Z] [ERROR] [Proactive] tick 异常: Assignment to constant variable';
const PLAIN_INFO = '[2026-06-11T10:00:00.000Z] [INFO] [Photo] 已发送 companion=3 source=request activity="在家"';

// ── 拦：真实的火必须上报 ──
ok(isReportableErrorLine(FIRE_400), '红色验证·拦：06-11 真实 400 [WARN][ai] 必上报（旧扫描漏了它 1.5 天）');
ok(isReportableErrorLine(FIRE_400_B), '拦：另一条 400 上报');
ok(isReportableErrorLine(FIRE_ECONNRESET), '拦：extractStructuredInfo ECONNRESET 上报');
ok(isReportableErrorLine(FIRE_REPLY), '拦：generateReply 500 上报');
ok(isReportableErrorLine(REAL_ERROR), '拦：[ERROR] 仍上报（不回归）');

// ── 放：噪声 WARN 必须不上报 ──
ok(!isReportableErrorLine(NOISE_COOLDOWN), '红色验证·放：daily count failed 噪声不上报');
ok(!isReportableErrorLine(NOISE_EMO), '放：photo emotion unavailable 噪声不上报');
ok(!isReportableErrorLine(NOISE_VISUAL), '放：读取参考图失败 噪声不上报');
ok(!isReportableErrorLine(PLAIN_INFO), '放：[INFO] 不上报');
ok(!isWarnEscalated(NOISE_COOLDOWN) && !isWarnEscalated(NOISE_EMO), 'isWarnEscalated 对噪声 false');

// ── 归一化：两条 400（line/column 不同）聚成同一签名 ──
ok(normalizeErrorSignature(FIRE_400) === normalizeErrorSignature(FIRE_400_B),
  '两条 400（line 15 vs 9 / col 3）归一成同一签名（聚类对）');
ok(normalizeErrorSignature(FIRE_400).includes('[WARN]') && normalizeErrorSignature(FIRE_400).includes('extractStructuredInfo'),
  '签名保留 [WARN]+模块，digest 里可辨升格来源');

console.log(`\ndigest_error_scan_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
