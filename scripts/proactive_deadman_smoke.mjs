/**
 * proactive 死人开关 smoke（v1.21.2 PR-C，#263 后续；临时 DB 真函数，零 LLM）。
 *
 * 红色验证核心：沙箱模拟 #263 形态——活跃 companion 在、proactive 全部静默失败
 * （last_proactive_sent_at 不更新）→ 心跳必须连续 2 周期后 CRITICAL + 告警。
 * 同时验证：恢复即清零 / 夜间不误报 / 无活跃不误报 / 邮件冷却 / fail-open 吞错。
 */
process.env.DB_PATH = '/tmp/deadman_smoke.db';
process.env.ADMIN_ALERT_EMAIL = 'ops@example.com';
import { unlinkSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const { getDb, setAppSetting } = await import('../src/db.mjs');
const { checkProactiveDeadman } = await import('../src/proactive_deadman.mjs');

// 固定白天时间锚（上海 14:00 = UTC 06:00）——全部数据相对它构造，不依赖真实系统时间
const DAY = new Date('2026-06-11T06:00:00Z');

const db = getDb();
db.pragma('foreign_keys = OFF');
db.prepare("INSERT INTO users (id, wechat_user_id) VALUES (1, 'wxu_1')").run();
db.prepare(`INSERT INTO companions (id, user_id, bot_id, name, proactive_enabled, last_user_reply_at)
            VALUES (12, 1, 'b', '溪', 1, ?)`).run(new Date(DAY.getTime() - 2 * 3600e3).toISOString());
db.prepare("INSERT INTO wechat_accounts (wechat_user_id, bot_id, bot_token, is_active, account_id) VALUES ('wxu_1','b','t',1,1)").run();

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };
const mails = [];
const fakeSend = async (to, subject, text) => { mails.push({ to, subject, text }); };
const reset = () => { setAppSetting('proactive_deadman_strikes', '0'); setAppSetting('proactive_deadman_last_alert', '0'); mails.length = 0; };

// ── 红色验证：#263 形态（活跃>0、发送=0）→ 连续 2 周期必须叫 ─────────────
reset();
let r = await checkProactiveDeadman({ now: DAY, sendAlert: fakeSend });
ok(r.active === 1 && r.sent === 0 && r.strikes === 1 && !r.alerted, '#263 形态第 1 周期：记 strike 不告警');
r = await checkProactiveDeadman({ now: new Date(DAY.getTime() + 3600e3), sendAlert: fakeSend });
ok(r.strikes === 2 && r.alerted === true, '#263 形态第 2 周期：★ 必须告警（红色验证）');
ok(mails.length === 1 && mails[0].to === 'ops@example.com' && mails[0].subject.includes('静默断供'), '告警邮件发到 ADMIN_ALERT_EMAIL');
ok(mails[0].text.includes('零自愈'), '邮件声明纯报警零自愈');

// ── 告警冷却：同小时再叫 CRITICAL 但不重复发邮件 ─────────────────────────
r = await checkProactiveDeadman({ now: new Date(DAY.getTime() + 2 * 3600e3), sendAlert: fakeSend });
ok(r.strikes === 3 && mails.length === 1, '冷却期内不重复发邮件（CRITICAL 日志照打）');

// ── 恢复即清零 ────────────────────────────────────────────────────────────
db.prepare('UPDATE companions SET last_proactive_sent_at = ? WHERE id = 12')
  .run(Math.floor((DAY.getTime() + 3 * 3600e3) / 1000));
r = await checkProactiveDeadman({ now: new Date(DAY.getTime() + 3 * 3600e3 + 60e3), sendAlert: fakeSend });
ok(r.sent === 1 && r.strikes === 0, '恢复发送 → strikes 清零');

// ── 夜间不判定（quiet hours 里 sent=0 是正常的，凌晨累计全是误报）─────────
reset();
db.prepare('UPDATE companions SET last_proactive_sent_at = 0 WHERE id = 12').run();
const NIGHT = new Date('2026-06-11T19:00:00Z');   // 上海 03:00
r = await checkProactiveDeadman({ now: NIGHT, sendAlert: fakeSend });
ok(r.skipped === true && Number((await import('../src/db.mjs')).getAppSetting('proactive_deadman_strikes') || 0) === 0, '夜间跳过：不累计不清零');

// ── 无活跃用户不误报 ──────────────────────────────────────────────────────
reset();
db.prepare("UPDATE companions SET last_user_reply_at = ? WHERE id = 12")
  .run(new Date(DAY.getTime() - 30 * 3600e3).toISOString());
r = await checkProactiveDeadman({ now: DAY, sendAlert: fakeSend });
ok(r.active === 0 && r.strikes === 0, '无近 6h 活跃 → 不累计（深夜后早晨场景）');

// ── fail-open：邮件函数抛错不阻塞、心跳自身炸了也只 warn ──────────────────
reset();
db.prepare("UPDATE companions SET last_user_reply_at = ? WHERE id = 12")
  .run(new Date(DAY.getTime() - 3600e3).toISOString());
await checkProactiveDeadman({ now: DAY, sendAlert: fakeSend });
r = await checkProactiveDeadman({ now: new Date(DAY.getTime() + 3600e3), sendAlert: async () => { throw new Error('smtp down'); } });
ok(r.strikes === 2 && r.alerted === false, 'fail-open: 邮件抛错吞掉，CRITICAL 仍打、流程不断');

// 纯报警零自愈源码断言：模块里绝无 restart/exec/patchCompanion 类自愈动作
{
  const src = (await import('node:fs')).readFileSync('src/proactive_deadman.mjs', 'utf8');
  ok(!/systemctl|exec|spawn|restart|patchCompanion|upsert|UPDATE companions/i.test(src), '源码: 零自愈（无重启/无写 companion/无调参）');
}

for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
console.log(`proactive_deadman_smoke: 通过 ${pass} 失败 ${fail}`);
process.exit(fail ? 1 : 0);
