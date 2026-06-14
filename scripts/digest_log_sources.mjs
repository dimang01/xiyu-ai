/**
 * digest_log_sources —— arc-digest 的「轮转感知」日志行读取（2026-06-14·B 修）。
 *
 * 背景（06-14 晨 digest 假警报）：logrotate 在沪 00:00 切日志，deadman cycle 心跳行只在沪
 * 09:00–22:59 写——所以早上跑 digest 时，昨天白天的 cycle 行已被轮转进 bot.log.1，而 digest
 * 只扫当前 bot.log（午夜后只剩夜间窗）→ 误报「无 cycle 心跳行」。修法 = digest 跨 bot.log +
 * 轮转件（bot.log.1 + 近期 .gz）一起扫，按时间窗过滤，跨午夜的白天行重新可见。
 *
 * 纯只读（与 arc-digest 同红线）。按时间戳 sinceMs 过滤，旧件整体落窗外即被逐行丢弃。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */
import { existsSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

/**
 * 当前日志 + 轮转件，**旧→新**排序（让消费方 push 出的数组保持时间升序，slice(-N)=最近 N）。
 * logrotate 命名：bot.log（最新）/ bot.log.1 / bot.log.2.gz / bot.log.3.gz …
 */
export function logFileCandidates(logFile, { maxGz = 6 } = {}) {
  const files = [];
  for (let i = maxGz; i >= 2; i--) {                 // 最老的 .gz 先（旧→新）
    const f = `${logFile}.${i}.gz`;
    if (existsSync(f)) files.push(f);
  }
  const dot1 = `${logFile}.1`;
  if (existsSync(dot1)) files.push(dot1);            // 次新（未压缩）
  if (existsSync(logFile)) files.push(logFile);     // 最新（当前活动文件）
  return files;
}

/**
 * 跨当前+轮转件逐行产出 { ts, line }，只产出时间戳 ≥ sinceMs 的行（无时间戳前缀的行丢弃）。
 * .gz 走 gunzip 流式解压，不整体载入内存。
 */
export async function* iterLogLines(logFile, sinceMs) {
  for (const f of logFileCandidates(logFile)) {
    const raw = createReadStream(f);
    const input = f.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
    const rl = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const tm = line.match(/^\[([^\]]+)\]/);
        const ts = tm ? new Date(tm[1]).getTime() : NaN;
        if (!Number.isFinite(ts) || ts < sinceMs) continue;
        yield { ts, line };
      }
    } finally {
      rl.close();
      raw.destroy();
    }
  }
}
