/**
 * 照片承诺生命周期 smoke（PR-B，临时 DB 真函数 + 静态断言，零 LLM）。
 *
 * 覆盖：
 *   - her_promise open_loop：saveOpenLoop(loopKind) 落库 / listDueHerPromises 时间窗+kind+status
 *     过滤 / markHerPromiseDelivered → resolved
 *   - 承诺前可行性闸门（静态断言）：bot.mjs 调用方不再在 firePhotoTask 之前发 ack
 *     （ack 移入 firePhotoTask，planner 通过才承诺——修案 A/B 自打脸）
 *   - 超时/失败 → 改期兜底 + her_promise（静态断言 firePhotoTask 含 withTimeout + recordPhotoPromise）
 *   - planner 拒绝保留人设婉拒句（declineCaption/canRetakeLater）
 *   - 时序修复：companion.mjs 不再授权首轮"刚才没拍好"
 *   - 全链失败响：[PhotoPromise] 走 [ERROR]（静态断言）
 *   - 改期履约：proactive deliverPhotoPromiseMakeup 接线
 */
process.env.DB_PATH = '/tmp/photo_promise_smoke.db';
import { unlinkSync, readFileSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const { getDb, saveOpenLoop, listDueHerPromises, markHerPromiseDelivered } = await import('../src/db.mjs');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const db = getDb();
db.pragma('foreign_keys = OFF');
db.prepare("INSERT INTO companions (id, user_id, bot_id, name) VALUES (5,1,'b','溪')").run();

// ── her_promise 落库 + 查询 ──
const past = new Date(Date.now() - 3600_000).toISOString();
const future = new Date(Date.now() + 7 * 3600_000).toISOString();
const id1 = saveOpenLoop({ companionId: 5, title: '答应拍照片', dueAt: past, loopKind: 'her_promise', promisePayload: JSON.stringify({ userText: '看看封面', scene: '在家' }) });
const id2 = saveOpenLoop({ companionId: 5, title: '答应拍照片2', dueAt: future, loopKind: 'her_promise' });
saveOpenLoop({ companionId: 5, title: '他说明天面试', dueAt: past, loopKind: 'user_said' });   // 不是 her_promise

const due = listDueHerPromises(5);
ok(due.length === 1 && due[0].id === id1, `listDueHerPromises 只取到期的 her_promise（实际 ${due.length} 条）`);
ok(JSON.parse(due[0].promise_payload).userText === '看看封面', 'promise_payload 原样取回（补发用原始索求）');
ok(!due.some(p => p.id === id2), '未到期 her_promise 不返回');
ok(!due.some(p => p.loop_kind === 'user_said'), 'user_said 不混入 her_promise 队列');

markHerPromiseDelivered(id1, '喏 补给你的');
ok(listDueHerPromises(5).length === 0, 'markHerPromiseDelivered 后 resolved，不再到期');
ok(db.prepare('SELECT status FROM companion_open_loops WHERE id=?').get(id1).status === 'resolved', '履约状态=resolved');

// ── 静态断言：承诺前可行性闸门（核心根因修复）──
const bot = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
// 调用方：strong 路径不再在 firePhotoTask 前发 ackText
const callerBlock = bot.slice(bot.indexOf('inflightPhoto.add(companion.id);\n      firePhotoTask'));
ok(bot.includes('ack 不再在此无条件发') && bot.includes('ack/婉拒/图/兜底全由 firePhotoTask 统一发'),
   '调用方 ack 已移除（不再 ack-before-feasibility）');
// firePhotoTask：planner 通过才发 ack
ok(bot.includes('if (!plan.shouldSendPhoto)') && bot.includes('if (!silentOnDecline) await sendLine(pickPhotoAck())'),
   'firePhotoTask：planner 判可行后才发 ack');
ok(bot.includes('withTimeout(sendCompanionPhoto') && bot.includes('PHOTO_GEN_TIMEOUT_MS'),
   'gen 有超时包裹');
ok(bot.includes('recordPhotoPromise(cid') && bot.includes("loopKind: 'her_promise'"),
   '失败/改期写 her_promise');
ok((bot.match(/\[PhotoPromise\][^]*?'error'/g) || bot.match(/log\('error', `\[PhotoPromise\]/g) || []).length >= 1
   || bot.includes("log('error', `[PhotoPromise]"),
   '兑现失败走 [ERROR]（进 digest 签名段）');
ok(bot.includes('PHOTO_DEFER_OPTIONS') && !bot.slice(bot.indexOf('firePhotoTask({ ctx, msg, botId, photoCompanion, binding, userText, companion, gate });')).includes('pickPhotoRequestFallback'),
   '改期兜底用 PHOTO_DEFER（指向"改天补"，非罐头"刚才没拍好"）');

// ── 静态断言：planner 保留婉拒句 ──
const planner = readFileSync(new URL('../src/photo_planner.mjs', import.meta.url), 'utf8');
ok(planner.includes('declineCaption') && planner.includes('canRetakeLater'),
   'planner 拒绝保留 declineCaption + canRetakeLater');

// ── 静态断言：时序修复（companion 不授权首轮"刚才没拍好"）──
const comp = readFileSync(new URL('../src/companion.mjs', import.meta.url), 'utf8');
ok(comp.includes('绝不要在本轮第一次提到拍照时就说') && !comp.includes('可以自然带过：「刚才没拍好」'),
   'companion.mjs 不再授权首轮"刚才没拍好"');

// ── 静态断言：改期履约接线 ──
const pro = readFileSync(new URL('../src/proactive.mjs', import.meta.url), 'utf8');
ok(pro.includes('deliverPhotoPromiseMakeup') && pro.includes('listDueHerPromises(companion.id)'),
   'proactive tick 钩入 her_promise 补发');
ok(pro.includes('markHerPromiseDelivered(promise.id') && pro.includes('喏 补给你的'),
   '补发成功 markHerPromiseDelivered + "喏 补给你的"');

console.log(`\nphoto_promise_smoke: ${pass} passed, ${fail} failed`);
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
process.exit(fail ? 1 : 0);
