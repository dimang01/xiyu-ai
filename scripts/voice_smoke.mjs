#!/usr/bin/env node
/**
 * voice_smoke.mjs — Sprint 1 端到端冒烟脚本
 *
 * 用途：本地验证 TTS pipeline。
 *
 * 用法：
 *   MINIMAX_API_KEY=sk-xxx MINIMAX_GROUP_ID=xxx TTS_PROVIDER=minimax \
 *     node scripts/voice_smoke.mjs ["要合成的中文"]
 *
 * 输出：
 *   /tmp/voice_smoke_<ts>.mp3   原始 MiniMax mp3
 *   /tmp/voice_smoke_<ts>.silk  转码后的 SILK（微信用）
 *   stdout 打印：provider / voice_id / chars / mp3 bytes / silk bytes / duration_ms
 *
 * 不进 release，开发自查工具。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';
import { writeFile } from 'node:fs/promises';
import { synthesizeAndConvertToSilk } from '../src/voice_pipeline.mjs';

const TEXT = process.argv[2] || '你好呀，我是溪语，今天过得怎么样？';

async function main() {
  if (!process.env.TTS_PROVIDER) {
    console.error('✗ 请先设 TTS_PROVIDER=minimax');
    process.exit(1);
  }
  if (!process.env.MINIMAX_API_KEY) {
    console.error('✗ 请先设 MINIMAX_API_KEY');
    process.exit(1);
  }
  if (!process.env.MINIMAX_GROUP_ID) {
    console.error('✗ 请先设 MINIMAX_GROUP_ID');
    process.exit(1);
  }

  console.log(`→ 合成文本: "${TEXT}" (${TEXT.length} 字)`);
  const t0 = Date.now();
  const { silk, mp3, duration_ms, provider, voice_id } = await synthesizeAndConvertToSilk(TEXT);
  const elapsed = Date.now() - t0;

  const ts = Date.now();
  const mp3Path = path.join(os.tmpdir(), `voice_smoke_${ts}.mp3`);
  const silkPath = path.join(os.tmpdir(), `voice_smoke_${ts}.silk`);
  await writeFile(mp3Path, mp3);
  await writeFile(silkPath, silk);

  console.log('');
  console.log('✓ 全流程成功');
  console.log(`  provider     : ${provider}`);
  console.log(`  voice_id     : ${voice_id}`);
  console.log(`  耗时         : ${elapsed} ms`);
  console.log(`  mp3 字节     : ${mp3.length}`);
  console.log(`  silk 字节    : ${silk.length}`);
  console.log(`  duration_ms  : ${duration_ms}`);
  console.log('');
  console.log(`  mp3 路径     : ${mp3Path}    （可用本机播放器试听）`);
  console.log(`  silk 路径    : ${silkPath}   （微信路径用，可 wx-voice decode 反解）`);
}

main().catch(e => {
  console.error('✗ FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
