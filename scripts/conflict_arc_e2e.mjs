/**
 * 冲突与和好弧——runtime 落库链端到端冒烟（临时 DB 真函数，零 LLM）。
 * 走完整生命周期：踩雷(taboo sev4) → cold → proactive 降频 → matched 道歉 →
 * repairing → avoidant 解冻慢 → 不许秒和好 → 修复达标 → normal + 事件 resolved
 * + 冲突和好入长期记忆 + 时间批零错。
 * conflict_arc_smoke 测纯函数转移表；这里测 runtime 协调层（落库/副作用/记忆）。
 */
process.env.DB_PATH = process.env.DB_PATH || '/tmp/conflict_arc_e2e.db';
import { unlinkSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const { getDb, getArcState, upsertPreference } = await import('../src/db.mjs');
const { runArcSignalTick, getArcProactivePolicy, runArcTimeTickBatch } = await import('../src/relationship_arc_runtime.mjs');

const db = getDb();
db.pragma('foreign_keys = OFF');
db.prepare("INSERT INTO companions (id, user_id, bot_id, name, attachment_style) VALUES (9001, 1, 'b', '溪语', 'avoidant')").run();
upsertPreference({ companionId: 9001, type: 'taboo', target: '催婚', intensity: 5 });
const comp = {
  id: 9001, user_id: 1, bot_id: 'b', attachment_style: 'avoidant', safe_mode: 0,
  last_user_reply_at: new Date().toISOString(), wechat_user_id: null,
};

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// 1) 踩最高强度 taboo → 直接 cold，主导语气指令就位
const r1 = runArcSignalTick(comp, { userText: '你爸妈什么时候催婚啊，赶紧的' });
ok(r1.arcState === 'cold' && r1.directive.includes('你凉了'), `踩雷 sev4 → cold + 指令（实际 ${r1.arcState}）`);
ok(getArcState(9001).arc_state === 'cold', 'arc_state 落库 cold');

// 2) proactive 策略：cold 降频 + 禁撒娇类 kind
const pol = getArcProactivePolicy(comp, () => 0.99);
ok(pol.skip === true && pol.forbidKinds.includes('photo') && pol.forbidKinds.includes('confession'), 'proactive: cold 降频 + 禁 photo/confession');

// 3) matched 道歉开门 → repairing
const r2 = runArcSignalTick(comp, { userText: '对不起，我刚才不该催你的，我以后再也不提了' });
ok(r2.arcState === 'repairing' && r2.directive.includes('和好进行中'), `matched 道歉 → repairing（实际 ${r2.arcState}）`);

// 4) avoidant 解冻慢（from cold 需 warm×6）：5 次不够
for (let i = 0; i < 5; i++) runArcSignalTick(comp, { userText: '给你带了奶茶哦，辛苦了' });
ok(getArcState(9001).arc_state === 'repairing', 'avoidant 解冻慢：warm×5 仍 repairing');

// 5) warm 数够但最短时长（cold 来源 24h）未到 → 不许秒和好
const r3 = runArcSignalTick(comp, { userText: '想你了，抱抱' });
ok(r3.arcState === 'repairing', '不许秒和好（最短 24h 未到）');

// 6) 倒拨 25h 再 warm → 修复达标 normal；事件 resolved；和好入长期记忆
db.prepare('UPDATE companions SET arc_state_changed_at = ? WHERE id = 9001')
  .run(new Date(Date.now() - 25 * 3600e3).toISOString());
const r4 = runArcSignalTick(comp, { userText: '多喝水呀，晚上想吃什么我请你' });
ok(r4.arcState === 'normal', `修复达标 → normal（实际 ${r4.arcState}）`);
const ev = db.prepare('SELECT * FROM companion_relationship_events WHERE companion_id = 9001').all();
ok(ev.length === 1 && ev[0].repair_status === 'resolved' && ev[0].apology_kind === 'matched', '事件 resolved + apology=matched');
const mem = db.prepare('SELECT * FROM companion_memories WHERE companion_id = 9001').all();
ok(mem.length === 1 && mem[0].content.includes('和好'), '冲突与和好入长期记忆（她记得这次别扭）');

// 7) 时间批不炸
const batch = runArcTimeTickBatch();
ok(batch.errors === 0, `时间批 errors=0（total=${batch.total}）`);

for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
console.log(`conflict_arc_e2e: 通过 ${pass} 失败 ${fail}`);
process.exit(fail ? 1 : 0);
