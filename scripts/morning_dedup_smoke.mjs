/**
 * morning 重复早安修复回归 smoke（纯函数，零 LLM，确定性）。
 *
 * 实测 bug（2026-06-10 test 账号）：wake≈7 点已发"刚醒"早安、8:04 用户互动，
 * 07:46 部署重启丢内存排程 → 重算把 morning 又排上 → 09:32 又发"早…刚醒"。
 * 验 shouldDemoteMorning 的两道判定：已发过早安 / 今早已互动。
 */
import { shouldDemoteMorning } from '../src/proactive.mjs';
import { shanghaiDateKey } from '../src/db.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const today = shanghaiDateKey();
const yesterday = shanghaiDateKey(new Date(Date.now() - 24 * 3600_000));

// 上海时间今天 HH:MM 的 ISO 串（DB 存 UTC："YYYY-MM-DD HH:MM:SS"）
const shToday = (hh, mm = 0) => {
  const utc = new Date();
  const [y, m, d] = today.split('-').map(Number);
  utc.setUTCFullYear(y, m - 1, d);
  utc.setUTCHours(hh - 8, mm, 0, 0); // 上海 = UTC+8
  return utc.toISOString().replace('T', ' ').slice(0, 19);
};

// ── 1) 已发过早安 → 降级（重启重算场景，issue 实测） ──
let r = shouldDemoteMorning({ goodmorningSentForDate: today, todayKey: today, lastUserReplyAt: null });
ok(r.demote && r.alreadySent, '今天早安已发 → 降级（重启重算实例）');

r = shouldDemoteMorning({ goodmorningSentForDate: yesterday, todayKey: today, lastUserReplyAt: null });
ok(!r.demote, '昨天发的早安标记 → 今天正常发');

r = shouldDemoteMorning({ goodmorningSentForDate: null, todayKey: today, lastUserReplyAt: null });
ok(!r.demote, '从未发过早安 → 正常发');

// ── 2) 今早已互动 → 降级（8:04 他说"早"她回了，9:32 不许再装刚醒） ──
r = shouldDemoteMorning({ goodmorningSentForDate: null, todayKey: today, lastUserReplyAt: shToday(8, 4) });
ok(r.demote && r.talkedThisMorning, '今早 8:04 聊过 → 降级（截图实例）');

// 半夜睡前聊的不算——凌晨 0:30 聊过、早上 7 点说"刚醒"不穿帮
r = shouldDemoteMorning({ goodmorningSentForDate: null, todayKey: today, lastUserReplyAt: shToday(0, 30) });
ok(!r.demote, '凌晨 0:30 聊过(<05:00) → 早安正常发');

// 昨天聊的不算
const shYesterday = (() => {
  const utc = new Date(Date.now() - 24 * 3600_000);
  utc.setUTCHours(20 - 8, 0, 0, 0);
  return utc.toISOString().replace('T', ' ').slice(0, 19);
})();
r = shouldDemoteMorning({ goodmorningSentForDate: null, todayKey: today, lastUserReplyAt: shYesterday });
ok(!r.demote, '昨晚 20:00 聊过 → 今早早安正常发');

// ── 3) 双条件同时命中 ──
r = shouldDemoteMorning({ goodmorningSentForDate: today, todayKey: today, lastUserReplyAt: shToday(8, 4) });
ok(r.demote && r.alreadySent && r.talkedThisMorning, '双条件同时命中 → 降级');

// ── 4) 健壮性：脏输入不抛错、不误降 ──
r = shouldDemoteMorning({ goodmorningSentForDate: null, todayKey: today, lastUserReplyAt: 'not-a-date' });
ok(!r.demote, '脏时间串 → 不误降级');
r = shouldDemoteMorning({});
ok(!r.demote, '空参数 → 不误降级');

console.log(`morning_dedup_smoke: 通过 ${pass} 失败 ${fail}`);
process.exit(fail ? 1 : 0);
