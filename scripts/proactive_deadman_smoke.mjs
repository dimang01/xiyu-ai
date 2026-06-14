/**
 * proactive 死人开关 smoke（v1.21.2 PR-C → 2026-06-13 三桶信号分离重写；临时 DB 真函数，零 LLM）。
 *
 * 三向红色验证（2026-06-13 拍板）：
 *   ① #263 形态（active>0、发送路径报错 errored>0、sent=0、tick 活）→ 连 2 周期 **必叫**
 *   ② 显式克制（restrained>0、errored=0、sent=0、tick 活）→ **永不计 strike、必不叫**（回放本次误报）
 *   ③ tick 死（心跳 stale）→ **必叫**
 *   ④（补充①）心跳"从未写入" + 过启动宽限 → **必叫**（#263 最深变体：tick 线程从未跑起）；宽限内不误判
 * 另验：已发送即清零 / 无活跃即便 errored>0 也不报 / 夜间不判 / 冷却不重发 / fail-open 吞错 /
 *       零自愈源码断言 / 快照三桶全量 + per-companion 克制细分（补充②③ digest 可见性）。
 */
process.env.DB_PATH = '/tmp/deadman_smoke.db';
process.env.ADMIN_ALERT_EMAIL = 'ops@example.com';
import { readFileSync, unlinkSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const { getDb, setAppSetting, getAppSetting } = await import('../src/db.mjs');
const { checkProactiveDeadman } = await import('../src/proactive_deadman.mjs');
const { HEALTH_KEYS } = await import('../src/proactive_health.mjs');

// 固定白天时间锚（上海 14:00 = UTC 06:00）——全部数据相对它构造，不依赖真实系统时间。
const DAY = new Date('2026-06-11T06:00:00Z');
const HOUR = 3600e3;

const db = getDb();
db.pragma('foreign_keys = OFF');
db.prepare("INSERT INTO users (id, wechat_user_id) VALUES (1, 'wxu_1')").run();
db.prepare(`INSERT INTO companions (id, user_id, bot_id, name, proactive_enabled, last_user_reply_at)
            VALUES (12, 1, 'b', '溪', 1, ?)`).run(new Date(DAY.getTime() - 2 * HOUR).toISOString());
db.prepare("INSERT INTO wechat_accounts (wechat_user_id, bot_id, bot_token, is_active, account_id) VALUES ('wxu_1','b','t',1,1)").run();

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };
const mails = [];
const fakeSend = async (to, subject, text) => { mails.push({ to, subject, text }); };
const reset = () => { setAppSetting('proactive_deadman_strikes', '0'); setAppSetting('proactive_deadman_last_alert', '0'); mails.length = 0; };

// 在下一次 check 前设三桶 + 心跳（check 内 drain 会清零三桶，故每周期都要重设）。
function setHealth({ sent = 0, restrained = 0, errored = 0, restrainedBy = {}, tickAtMs, tickNever = false } = {}) {
  setAppSetting(HEALTH_KEYS.sent, String(sent));
  setAppSetting(HEALTH_KEYS.restrained, String(restrained));
  setAppSetting(HEALTH_KEYS.errored, String(errored));
  setAppSetting(HEALTH_KEYS.restrainedBy, JSON.stringify(restrainedBy));
  if (tickNever) db.prepare('DELETE FROM app_settings WHERE key = ?').run(HEALTH_KEYS.tickRun);
  else if (tickAtMs !== undefined) setAppSetting(HEALTH_KEYS.tickRun, String(tickAtMs));
}
const fresh = (now) => now.getTime();                  // 心跳新鲜（age≈0）
const stale = (now) => now.getTime() - 20 * 60_000;    // 心跳 20min 前（>15min 死阈）

// ── 红验①：#263 形态（errored>0、sent=0、tick 活）→ 连 2 周期必叫 ─────────────
reset();
setHealth({ errored: 1, tickAtMs: fresh(DAY) });
let r = await checkProactiveDeadman({ now: DAY, sendAlert: fakeSend });
ok(r.bucket === 'error' && r.strikes === 1 && !r.alerted, `红验①#263 第1周期：bucket=error 记 strike 不告警（实测 ${r.bucket}/${r.strikes}）`);
const DAY1 = new Date(DAY.getTime() + HOUR);
setHealth({ errored: 1, tickAtMs: fresh(DAY1) });
r = await checkProactiveDeadman({ now: DAY1, sendAlert: fakeSend });
ok(r.bucket === 'error' && r.strikes === 2 && r.alerted === true, `红验①#263 第2周期：★必告警（实测 ${r.bucket}/${r.strikes}/${r.alerted}）`);
ok(mails.length === 1 && mails[0].to === 'ops@example.com' && mails[0].subject.includes('静默断供'), '告警邮件发到 ADMIN_ALERT_EMAIL');
ok(mails[0].text.includes('零自愈'), '邮件声明纯报警零自愈');

// ── 红验②：显式克制（restrained>0、errored=0、tick 活）→ 永不计 strike、必不叫 ──
reset();
for (let i = 0; i < 4; i++) {
  const t = new Date(DAY.getTime() + i * HOUR);
  setHealth({ restrained: 3, restrainedBy: { 12: { v2_deny: 3 } }, tickAtMs: fresh(t) });
  r = await checkProactiveDeadman({ now: t, sendAlert: fakeSend });
  ok(r.bucket === 'restrained' && r.strikes === 0 && !r.alerted, `红验②正当克制 周期${i + 1}：永不计 strike（实测 ${r.bucket}/${r.strikes}）`);
}
ok(mails.length === 0, '红验②：正当克制零邮件（修掉本次误报）');

// ── 红验③：tick 死（心跳 stale）→ 连 2 周期必叫 ──────────────────────────────
reset();
setHealth({ tickAtMs: stale(DAY) });
r = await checkProactiveDeadman({ now: DAY, sendAlert: fakeSend });
ok(r.bucket === 'tick_dead' && r.strikes === 1, `红验③tick 死 第1周期：bucket=tick_dead（实测 ${r.bucket}/${r.strikes}）`);
setHealth({ tickAtMs: stale(DAY1) });
r = await checkProactiveDeadman({ now: DAY1, sendAlert: fakeSend });
ok(r.bucket === 'tick_dead' && r.strikes === 2 && r.alerted === true, `红验③tick 死 第2周期：★必告警（实测 ${r.alerted}）`);

// ── 红验④（补充①）：心跳"从未写入"盲区——宽限内不误判、过宽限必叫 ──────────────
reset();
setHealth({ tickNever: true });
r = await checkProactiveDeadman({ now: DAY, uptimeS: 5 * 60, sendAlert: fakeSend });   // 启动 5min（<30min 宽限）
ok(r.bucket === 'idle_no_due' && r.strikes === 0 && !r.alerted, `红验④宽限内：心跳从未写也不误判（实测 ${r.bucket}/${r.strikes}）`);
setHealth({ tickNever: true });
r = await checkProactiveDeadman({ now: DAY, uptimeS: 31 * 60, sendAlert: fakeSend });   // 启动 31min（>30min 宽限）
ok(r.bucket === 'tick_dead' && r.strikes === 1, `红验④过宽限 第1周期：心跳从未出现=tick_dead（实测 ${r.bucket}/${r.strikes}）`);
setHealth({ tickNever: true });
r = await checkProactiveDeadman({ now: DAY1, uptimeS: 91 * 60, sendAlert: fakeSend });
ok(r.bucket === 'tick_dead' && r.strikes === 2 && r.alerted === true, '红验④过宽限 第2周期：★必告警（tick 线程从未跑起=最深 #263 变体）');

// ── 已发送即清零（健康恢复）──────────────────────────────────────────────────
reset();
setHealth({ errored: 1, tickAtMs: fresh(DAY) });
await checkProactiveDeadman({ now: DAY, sendAlert: fakeSend });          // strikes=1
setHealth({ sent: 2, tickAtMs: fresh(DAY1) });
r = await checkProactiveDeadman({ now: DAY1, sendAlert: fakeSend });
ok(r.bucket === 'sent' && r.strikes === 0, `已发送 → strikes 清零（实测 ${r.bucket}/${r.strikes}）`);

// ── 无活跃用户：即便 errored>0 也不报（闸门）────────────────────────────────────
reset();
db.prepare('UPDATE companions SET last_user_reply_at = ? WHERE id = 12').run(new Date(DAY.getTime() - 30 * HOUR).toISOString());
setHealth({ errored: 5, tickAtMs: fresh(DAY) });
r = await checkProactiveDeadman({ now: DAY, sendAlert: fakeSend });
ok(r.active === 0 && r.bucket === 'idle_no_active' && r.strikes === 0 && !r.alerted, `无活跃 → 即便 errored>0 也不告警（实测 active=${r.active}/${r.bucket}）`);
db.prepare('UPDATE companions SET last_user_reply_at = ? WHERE id = 12').run(new Date(DAY.getTime() - 2 * HOUR).toISOString());  // 复原

// ── 夜间静默期（quiet hours：写活体心跳但不判——错误不累计、不清零、不告警）────────────
// C 修（2026-06-14）：夜间不再整段 skip，而是 bucket='quiet'、写 quiet=1 心跳行（活体证明 7×24），
// 仅 strike/告警保持夜间静默。否则 digest 早上扫到午夜后的窗口零 cycle → 误报"无心跳"。
reset();
setAppSetting('proactive_deadman_strikes', '1');
const NIGHT = new Date('2026-06-11T19:00:00Z');   // 上海 03:00
setHealth({ errored: 5, tickAtMs: fresh(NIGHT) });
r = await checkProactiveDeadman({ now: NIGHT, sendAlert: fakeSend });
ok(r.quiet === true && r.bucket === 'quiet', `夜间：写心跳但不判（quiet 桶，实测 quiet=${r.quiet}/${r.bucket}）`);
ok(Number(getAppSetting('proactive_deadman_strikes')) === 1, '夜间：strikes 冻结（errored=5 也不累计、不清零，原样=1）');
ok(r.alerted === false, '夜间：绝不发告警邮件（半夜静默）');
const nightSnap = JSON.parse(getAppSetting('proactive_deadman_last_class') || '{}');
ok(nightSnap.quiet === true && nightSnap.bucket === 'quiet', '夜间：活体心跳快照照写 quiet=1（digest 不再误报"无 cycle 心跳行"）');

// ── 告警冷却：同冷却期内再叫 CRITICAL 但不重复发邮件 ─────────────────────────────
reset();
setHealth({ errored: 1, tickAtMs: fresh(DAY) });
await checkProactiveDeadman({ now: DAY, sendAlert: fakeSend });            // strike1
setHealth({ errored: 1, tickAtMs: fresh(DAY1) });
await checkProactiveDeadman({ now: DAY1, sendAlert: fakeSend });          // strike2 + 邮件
const DAY2 = new Date(DAY.getTime() + 2 * HOUR);
setHealth({ errored: 1, tickAtMs: fresh(DAY2) });
r = await checkProactiveDeadman({ now: DAY2, sendAlert: fakeSend });      // strike3，冷却
ok(r.strikes === 3 && mails.length === 1, `冷却期内不重复发邮件（CRITICAL 照打；实测 strikes=${r.strikes} mails=${mails.length}）`);

// ── fail-open：邮件函数抛错吞掉，CRITICAL 仍打、流程不断 ──────────────────────────
reset();
setHealth({ errored: 1, tickAtMs: fresh(DAY) });
await checkProactiveDeadman({ now: DAY, sendAlert: fakeSend });
setHealth({ errored: 1, tickAtMs: fresh(DAY1) });
r = await checkProactiveDeadman({ now: DAY1, sendAlert: async () => { throw new Error('smtp down'); } });
ok(r.strikes === 2 && r.alerted === false, `fail-open：邮件抛错吞掉，CRITICAL 仍打（实测 strikes=${r.strikes} alerted=${r.alerted}）`);

// ── 补充③：快照含 per-companion 克制细分（digest 🟡 据此印"谁·为何"）─────────────
reset();
setHealth({ restrained: 4, restrainedBy: { 12: { v2_deny: 3, safety: 1 } }, tickAtMs: fresh(DAY) });
await checkProactiveDeadman({ now: DAY, sendAlert: fakeSend });
let snap = JSON.parse(getAppSetting('proactive_deadman_last_class') || '{}');
ok(snap.restrainedBy?.['12']?.v2_deny === 3 && snap.restrainedBy?.['12']?.safety === 1, '补充③：快照含 per-companion 克制主因细分');
ok(snap.sent === 0 && snap.restrained === 4 && snap.errored === 0, '补充②：快照三桶全量可见');

// ── 补充②：sent>0 但同窗 errored>0——不计 strike（对）但 errored 数字必须可见 ─────────
reset();
setHealth({ sent: 1, errored: 2, tickAtMs: fresh(DAY) });
r = await checkProactiveDeadman({ now: DAY, sendAlert: fakeSend });
ok(r.bucket === 'sent' && r.strikes === 0, 'sent>0：不计 strike（部分失败归错误签名段管）');
snap = JSON.parse(getAppSetting('proactive_deadman_last_class') || '{}');
ok(snap.errored === 2, '补充②：sent>0 时同窗 errored 数字仍可见（别让"一次成功"遮断供）');

// ── 纯报警零自愈源码断言：模块里绝无 restart/exec/写 companion 类自愈动作 ───────────
{
  const src = readFileSync('src/proactive_deadman.mjs', 'utf8');
  ok(!/systemctl|exec|spawn|restart|patchCompanion|upsert|UPDATE companions/i.test(src), '源码：零自愈（无重启/无写 companion/无调参）');
}

for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
console.log(`proactive_deadman_smoke: 通过 ${pass} 失败 ${fail}`);
process.exit(fail ? 1 : 0);
