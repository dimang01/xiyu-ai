/**
 * reflection_memory_mapping_smoke —— A 契约对齐 + B 边界映射红验（2026-06-12）。
 *
 * A：saveMemory 传 memorySource/memoryLayer/memoryWeight 必真落库；不传走列默认(向后兼容)。
 * B：layer→旧 type 边界映射表正确；映射不到的(relationship_rule/core_persona)返回 null
 *    → reflection 必 reject 不静默落库成错类型。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

// 必须在 import db.mjs 前设 DB_PATH（模块加载时读一次）——用临时库，零污染生产。
const tmp = path.join(os.tmpdir(), `xiyu_savemem_smoke_${process.pid}.db`);
process.env.DB_PATH = tmp;

const { saveMemory, legacyTypeForLayer, getDb } = await import('../src/db.mjs');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

// ── B 映射表（纯函数，CI 核心；维护者过目的就是这张表）──
ok(legacyTypeForLayer('user_fact') === 'fact', 'user_fact → fact');
ok(legacyTypeForLayer('preference') === 'preference', 'preference → preference');
ok(legacyTypeForLayer('event') === 'event', 'event → event');
ok(legacyTypeForLayer('emotion') === 'emotion', 'emotion → emotion');
ok(legacyTypeForLayer('summary') === 'daily_summary', 'summary → daily_summary（兜底）');
ok(legacyTypeForLayer('relationship_rule') === null, '红验：relationship_rule → null（必 reject，不静默落库）');
ok(legacyTypeForLayer('core_persona') === null, '红验：core_persona → null');

// ── A 契约：传三参必落库 ──
const db = getDb();
db.pragma('foreign_keys = OFF');   // 本 smoke 只验 saveMemory 写列逻辑，不验 companion FK 完整性
const cid = 999001, uid = 'smoke';
saveMemory({ companionId: cid, userId: uid, memoryType: 'fact', content: 'A契约-带参-zzz', importance: 4, memorySource: 'reflection', memoryLayer: 'user_fact', memoryWeight: 5 });
const r1 = db.prepare("SELECT memory_type, memory_source, memory_layer, memory_weight FROM companion_memories WHERE companion_id=? AND content LIKE '%带参-zzz%'").get(cid);
ok(r1 && r1.memory_source === 'reflection', `A：memorySource 真落库 reflection（实得 ${r1?.memory_source}）`);
ok(r1 && r1.memory_layer === 'user_fact', `A：memoryLayer 真落库 user_fact（实得 ${r1?.memory_layer}）`);
ok(r1 && r1.memory_weight === 5, `A：memoryWeight 真落库 5（实得 ${r1?.memory_weight}）`);
ok(r1 && r1.memory_type === 'fact', 'A：memory_type=fact（CHECK 约束认的旧 type）');

// ── A 向后兼容：不传三参 → 走列默认（既有 6 caller 零行为变更）──
saveMemory({ companionId: cid, userId: uid, memoryType: 'event', content: 'A契约-不带参-zzz', importance: 3 });
const r2 = db.prepare("SELECT memory_source, memory_layer FROM companion_memories WHERE companion_id=? AND content LIKE '%不带参-zzz%'").get(cid);
ok(r2 && r2.memory_source === 'auto', `A 向后兼容：不传 source → 默认 auto（实得 ${r2?.memory_source}）`);
ok(r2 && r2.memory_layer === 'event', `A 向后兼容：不传 layer → 默认 event（实得 ${r2?.memory_layer}）`);

console.log(`\nreflection_memory_mapping_smoke: ${pass} passed, ${fail} failed`);
try { db.close(); } catch { /* noop */ }
try { fs.rmSync(tmp); fs.rmSync(`${tmp}-wal`, { force: true }); fs.rmSync(`${tmp}-shm`, { force: true }); } catch { /* noop */ }
process.exit(fail ? 1 : 0);
