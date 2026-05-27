/**
 * 简易 logger：控制台 + 文件（logs/bot.log）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import fs from 'fs';
import path from 'path';

const LOG_DIR = process.env.LOG_DIR || path.resolve(process.cwd(), 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 1;

let logFileWritable = true;
let logFile;
try {
  logFile = fs.createWriteStream(path.join(LOG_DIR, 'bot.log'), { flags: 'a' });
  logFile.on('error', (err) => {
    logFileWritable = false;
    console.error(`[${new Date().toISOString()}] [ERROR] log file unavailable: ${err.message}`);
  });
} catch (e) {
  logFileWritable = false;
}

export function log(level, message) {
  if ((LEVELS[level] ?? 1) < currentLevel) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${message}`;
  console.log(line);
  if (logFileWritable && logFile) logFile.write(line + '\n');
}
