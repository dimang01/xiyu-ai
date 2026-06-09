/**
 * lastcall_smoke.mjs — v1.16.x「窗口将关·临门一脚」护栏
 *
 * 校验 shouldSendWindowLastCall 的触发边界：
 *  1) 只在 idle 21–23.5h（微信 24h 推送窗口将关前）触发
 *  2) 每个离开周期只发一次（last_lastcall_at > last_user_reply_at 即已发）
 *  3) 无聊天记录 / 非法时间 → 不触发
 *
 * 跑：node scripts/lastcall_smoke.mjs
 */
import { shouldSendWindowLastCall } from '../src/proactive.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; }
  else { fail++; console.error('✗ FAIL:', name); }
};

const NOW = Date.now();
// 构造一个 idle=h 小时、last_lastcall 为 lastcallSec(秒, 默认未发) 的 companion
const mk = (h, lastcallSec = 0) => ({
  last_user_reply_at: new Date(NOW - h * 3_600_000).toISOString(),
  last_lastcall_at: lastcallSec,
});
const now = new Date(NOW);

// ── 1. 时间窗口边界 ──────────────────────────────────────────────
check('idle 20h（窗口还早）→ 不发',     shouldSendWindowLastCall(mk(20),   now) === false);
check('idle 21h（窗口将关下界）→ 发',   shouldSendWindowLastCall(mk(21),   now) === true);
check('idle 22h（窗口将关）→ 发',       shouldSendWindowLastCall(mk(22),   now) === true);
check('idle 23h（窗口将关上沿）→ 发',   shouldSendWindowLastCall(mk(23),   now) === true);
check('idle 23.5h（上界）→ 发',         shouldSendWindowLastCall(mk(23.5), now) === true);
check('idle 24h（窗口已关）→ 不发',     shouldSendWindowLastCall(mk(24),   now) === false);
check('idle 30h（早过窗口）→ 不发',     shouldSendWindowLastCall(mk(30),   now) === false);

// ── 2. 每离开周期只发一次 ────────────────────────────────────────
// last_lastcall 在 last_user_reply 之后（= 本周期已发）→ 不重发
check('本周期已发过 → 不重发',
  shouldSendWindowLastCall(mk(22, Math.floor(NOW / 1000)), now) === false);
// last_lastcall 是上个周期的旧时间戳（远早于 last_user_reply）→ 可发
check('上周期发过、本周期未发 → 可发',
  shouldSendWindowLastCall(mk(22, Math.floor((NOW - 200 * 3_600_000) / 1000)), now) === true);

// ── 3. 边界/异常 ────────────────────────────────────────────────
check('无聊天记录 → 不发',   shouldSendWindowLastCall({}, now) === false);
check('null companion → 不发', shouldSendWindowLastCall(null, now) === false);
check('非法时间 → 不发',     shouldSendWindowLastCall({ last_user_reply_at: 'not-a-date' }, now) === false);

console.log(`\nlastcall_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
