/**
 * export-corpus.mjs — 标注语料 JSONL 导出（v1.21.4，微调语料的最终形态）。
 *
 * 每行：{ "context": [{role, content}...], "reply": "...", "label": "good|bad",
 *        "tags": [...], "note": "..." }
 *
 * 用法：
 *   DB_PATH=/opt/xiyu-ai-new/data/bot.db node scripts/export-corpus.mjs            # 单文件
 *   DB_PATH=... node scripts/export-corpus.mjs --split                             # good/bad 分文件
 *   DB_PATH=... node scripts/export-corpus.mjs --out /opt/xiyu-ai-new/data/exports
 *
 * 隐私：导出含用户对话原文，默认落 DB 同目录的 exports/（生产即 /opt 数据目录），
 * 不进 git（.gitignore 有 exports/ 规则），不进 PR 描述。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const SPLIT = argv.includes('--split');
const outIdx = argv.indexOf('--out');
const DB_PATH = process.env.DB_PATH || 'data/bot.db';
const OUT_DIR = outIdx > -1 ? argv[outIdx + 1] : path.join(path.dirname(DB_PATH), 'exports');

const { listAnnotationsForExport } = await import('../src/db.mjs');
const rows = listAnnotationsForExport({ contextN: 4 });
if (!rows.length) { console.log('（标注表为空——先去 /app/annotate.html 标几条）'); process.exit(0); }

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const toJsonl = (list) => list.map(r => JSON.stringify(r)).join('\n') + '\n';

if (SPLIT) {
  for (const label of ['good', 'bad']) {
    const subset = rows.filter(r => r.label === label);
    if (!subset.length) continue;
    const f = path.join(OUT_DIR, `corpus_${label}_${stamp}.jsonl`);
    writeFileSync(f, toJsonl(subset));
    console.log(`${label}: ${subset.length} 条 → ${f}`);
  }
} else {
  const f = path.join(OUT_DIR, `corpus_${stamp}.jsonl`);
  writeFileSync(f, toJsonl(rows));
  console.log(`全部: ${rows.length} 条 → ${f}`);
}
console.log(`good=${rows.filter(r => r.label === 'good').length} bad=${rows.filter(r => r.label === 'bad').length}`);
