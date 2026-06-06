/**
 * v1.10.33 sticker 自动重打标签
 *
 * 用 zhipu glm-4v-flash 扫每张 sticker，识别 age_group / emotion /
 * scene_tags / extra_tags 写回 manifest.json：
 *   - age_group === 'child' → disabled:true（不合任何成人 AI 陪伴人设）
 *   - tags 合并新标签（去重）
 *   - emotion 覆盖（如果新值更具体）
 *
 * GIF 先用 ffmpeg 提首帧 PNG 再发（zhipu 不接 GIF 原文）。
 *
 * 已处理的 sticker 会写 _retagged_v110_33: true，再跑只处理未标记的。
 * 中断可恢复。
 */
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import 'dotenv/config';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.resolve(__dir, '../assets/stickers/manifest.json');
const STICKERS_DIR = path.resolve(__dir, '../assets/stickers');
const LIMIT = Number(process.env.RETAG_LIMIT || 0) || Infinity;
const DRY = process.env.RETAG_DRY === '1';

const PROMPT = `请看这张表情包，输出严格 JSON：
{"age_group":"adult|teen|child|animal|unknown","emotion":"happy|love|sad|sleepy|shy|angry|shock|cute|mock|kiss|cheer|hug|wave|other","scene_tags":["1-3 个场景词，英文小写"],"extra_tags":["3-5 个动作或氛围词，英文小写"]}
只输出 JSON，不要 markdown / 代码块 / 解释。键名和字符串必须双引号。`;

function gifToPng(gifBuf) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-i', 'pipe:0', '-vframes', '1', '-f', 'image2', '-vcodec', 'png', 'pipe:1']);
    const out = [];
    const errBuf = [];
    ff.stdout.on('data', d => out.push(d));
    ff.stderr.on('data', d => errBuf.push(d));
    ff.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(errBuf).toString().slice(0, 200)}`)));
    ff.on('error', reject);
    ff.stdin.end(gifBuf);
  });
}

async function analyzeWithZhipu(b64, mime) {
  const key = process.env.ZHIPU_API_KEY;
  if (!key) throw new Error('ZHIPU_API_KEY 未配置');
  const model = process.env.STICKER_TAG_MODEL || 'glm-4v-flash';
  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        { type: 'text', text: PROMPT },
      ],
    }],
    temperature: 0,
  };
  const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`zhipu HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || '';
  let s = String(text).trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  if (!s.startsWith('{')) { const m = s.match(/\{[\s\S]*\}/); if (m) s = m[0]; }
  try { return JSON.parse(s); } catch {}
  try { return JSON.parse(s.replace(/'/g, '"')); } catch {}
  throw new Error(`zhipu output not JSON: ${s.slice(0, 200)}`);
}

function mimeFromExt(file) {
  const ext = (file.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

async function main() {
  console.log(`[retag] manifest=${MANIFEST} dry=${DRY} limit=${LIMIT}`);
  const m = JSON.parse(await readFile(MANIFEST, 'utf-8'));
  let processed = 0, disabledByAge = 0, errs = 0, skipped = 0;
  for (const s of m.stickers) {
    if (processed >= LIMIT) break;
    if (s._retagged_v110_33) { skipped++; continue; }
    const filePath = path.join(STICKERS_DIR, s.file);
    let buf;
    try { buf = await readFile(filePath); } catch (e) { console.warn(`[retag] skip ${s.id}: missing file`); skipped++; continue; }

    let sendBuf = buf;
    let sendMime = mimeFromExt(s.file);
    if (sendMime === 'image/gif') {
      try {
        sendBuf = await gifToPng(buf);
        sendMime = 'image/png';
      } catch (e) {
        console.warn(`[retag] ${s.id}: GIF→PNG 失败 ${e.message}`);
        errs++; continue;
      }
    }

    try {
      const r = await analyzeWithZhipu(sendBuf.toString('base64'), sendMime);
      s.age_group = r.age_group || 'unknown';
      const merged = [...new Set([
        ...(Array.isArray(s.tags) ? s.tags : []),
        ...(Array.isArray(r.scene_tags) ? r.scene_tags : []),
        ...(Array.isArray(r.extra_tags) ? r.extra_tags : []),
      ].map(t => String(t).toLowerCase().trim()).filter(Boolean))];
      s.tags = merged;
      if (r.emotion && r.emotion !== 'other') s.emotion = r.emotion;
      if (r.age_group === 'child' && !s.disabled) {
        s.disabled = true;
        s.disabled_reason = 'v1.10.33 vision 检测年龄段为儿童';
        disabledByAge++;
      }
      s._retagged_v110_33 = true;
      processed++;
      if (processed % 5 === 0) console.log(`[retag] processed ${processed} (disabledByAge=${disabledByAge} errs=${errs})`);
      // 每 5 张 flush 一次（防中断丢进度）
      if (!DRY && processed % 5 === 0) await writeFile(MANIFEST, JSON.stringify(m, null, 2));
    } catch (e) {
      console.warn(`[retag] err ${s.id}: ${e.message}`);
      errs++;
    }
  }
  if (!DRY) await writeFile(MANIFEST, JSON.stringify(m, null, 2));
  console.log(`\n[retag] done: processed=${processed} disabledByAge=${disabledByAge} errors=${errs} skipped=${skipped}`);
}

main().catch(e => { console.error(e); process.exit(1); });
