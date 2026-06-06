#!/usr/bin/env node
/**
 * ESM import smoke test —— `node --check` 只验语法，不验 ESM 解析顺序、
 * 循环依赖、命名导出、初始化时 throw。本脚本动态 import 所有核心模块，
 * 任何一个失败就退出码 1。
 *
 * 用法：node scripts/import_smoke.mjs
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const MODULES = [
  'src/db.mjs',
  'src/logger.mjs',
  'src/ai.mjs',
  'src/companion.mjs',
  'src/memory.mjs',
  'src/memory_v2.mjs',
  'src/emotion_state.mjs',
  'src/inner_os.mjs',
  'src/user_profile.mjs',
  'src/ai_taste_guard.mjs',
  'src/open_loops.mjs',
  'src/proactive.mjs',
  'src/proactive_engine.mjs',
  'src/plan_tasks.mjs',
  'src/playground.mjs',
  'src/voice_inbound.mjs',
  'src/voice_emotion.mjs',
  'src/visual_identity_candidates.mjs',
  'src/image_beautify.mjs',
  'src/bot.mjs',
  'src/api.mjs',
];

let pass = 0;
let fail = 0;
const failures = [];

for (const mod of MODULES) {
  const absUrl = pathToFileURL(path.join(ROOT, mod)).href;
  try {
    const m = await import(absUrl);
    const exportCount = Object.keys(m).length;
    console.log(`  ✓ ${mod}  (${exportCount} exports)`);
    pass++;
  } catch (err) {
    console.error(`  ✗ ${mod}`);
    console.error(`    ${err?.message || err}`);
    failures.push({ mod, err });
    fail++;
  }
}

console.log('');
console.log(`  Pass: ${pass} / Fail: ${fail}`);

if (fail > 0) {
  console.error('');
  console.error('IMPORT SMOKE FAILED — fix ESM import errors above before releasing.');
  process.exit(1);
}
