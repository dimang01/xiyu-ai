/**
 * scene_state_smoke —— #324 失忆修红验（current_scene 事件驱动持久 + open_loop 约定注入 + TTL；零 LLM）。
 *
 * 根因：current_scene 字段存在且已无条件注入(§6「你现在在：X」)却从不自动更新→stale"在家"反客为主，
 * 密聊下真场景滑出 16 行窗口后 LLM 凭空编场景。修法搭车 extractAndSaveMemories 的 LLM pass 自动更新。
 */
process.env.DB_PATH = '/tmp/scene_state_smoke.db';
import { unlinkSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const { getDb, patchCompanion, getCompanionById, saveOpenLoop } = await import('../src/db.mjs');
const { applySceneUpdate, resetScenesForNewDay } = await import('../src/memory.mjs');
const { buildOpenLoopsHint } = await import('../src/open_loops.mjs');
const { buildSystemPrompt } = await import('../src/companion.mjs');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };
const db = getDb();
db.pragma('foreign_keys = OFF');
db.prepare("INSERT INTO companions (id, user_id, bot_id, name) VALUES (1,1,'b','溪语')").run();
const comp = () => getCompanionById(1);

// ── ① applySceneUpdate：事件驱动 + 跨轮持久 + 失败回落 ──────────────────────────
applySceneUpdate(1, '图书馆');
ok(comp().current_scene === '图书馆', '①抓到场景→patch current_scene=图书馆');
applySceneUpdate(1, '');
ok(comp().current_scene === '图书馆', '①本轮无场景→保留现值（跨轮持久＝修复要害）');
applySceneUpdate(1, '日常');
ok(comp().current_scene === '图书馆', '①占位"日常"不覆盖真实场景');
applySceneUpdate(1, '咖啡馆');
ok(comp().current_scene === '咖啡馆', '①新场景→覆盖（场景切换）');
applySceneUpdate(1, '在家');
ok(comp().current_scene === '在家', '①"到家了"→"在家"是真实场景切换，不被当占位跳过');
applySceneUpdate(1, null, { extractionFailed: true });
ok(comp().current_scene === '日常', '①抽取失败→回落"日常"（fail-open 反转，不留过期值）');

// ── ② §6 注入：current_scene 进 prompt（本 bug 的注入点）─────────────────────────
patchCompanion(1, { current_scene: '图书馆' });
let p = buildSystemPrompt(comp(), { promptMode: 'reply' });
ok(/你现在在：图书馆/.test(p), '②current_scene=图书馆→prompt 注入"你现在在：图书馆"');
patchCompanion(1, { current_scene: '日常' });
p = buildSystemPrompt(comp(), { promptMode: 'reply' });
ok(/你现在在家/.test(p) && !/你现在在：/.test(p), '②"日常"→退回"你现在在家随意聊"（中性默认）');

// ── ②B open_loops 注入 + appointment 置顶 ────────────────────────────────────────
saveOpenLoop({ companionId: 1, title: '他周五考试', loopKind: 'user_said', emotionalWeight: 60 });
saveOpenLoop({ companionId: 1, title: '约了一起吃晚饭', loopKind: 'appointment', emotionalWeight: 50 });
const hint = buildOpenLoopsHint(1);
ok(/约了一起吃晚饭/.test(hint) && /你俩的约定/.test(hint), '②B约定注入串含"约了一起吃晚饭（你俩的约定）"');
ok(hint.indexOf('约了一起吃晚饭') < hint.indexOf('他周五考试'), '②B appointment 置顶（即便 weight 更低；最易被挤出）');
p = buildSystemPrompt(comp(), { promptMode: 'reply', openLoopsHint: hint });
ok(/约了一起吃晚饭/.test(p), '②B openLoopsHint 进 buildSystemPrompt（无条件注入）');
ok(!/约了一起吃晚饭/.test(buildSystemPrompt(comp(), { promptMode: 'reply' })), '②B红验：不传 openLoopsHint 则不注入（纯函数零依赖）');

// ── ③ TTL 次日清场 ──────────────────────────────────────────────────────────────
patchCompanion(1, { current_scene: '图书馆' });
db.prepare("INSERT INTO companions (id,user_id,bot_id,name,current_scene) VALUES (2,1,'b','x','在家')").run();
const changed = resetScenesForNewDay();
ok(comp().current_scene === '日常', '③次日清场：图书馆→日常');
ok(getCompanionById(2).current_scene === '在家', '③清场不动"在家"（本就中性）');
ok(changed >= 1, '③返回清场条数');

// ── #324 端到端回归：场景滑出 16 行窗口后仍不失忆（治本）────────────────────────────
patchCompanion(1, { current_scene: '图书馆' });
const farTurns = Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '兔子狐狸的故事' + i }));
p = buildSystemPrompt(comp(), { promptMode: 'reply', recentTurns: farTurns });
ok(/你现在在：图书馆/.test(p), '#324回归：场景滑出 16 行窗口后 current_scene 仍注入图书馆（不再编"麻辣香锅"）');

for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
console.log(`scene_state_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
