/**
 * 用智谱 GLM-4V 批量检查图片是否还有 AI 生成水印。
 * 用法：node --env-file=.env scripts/check_watermark.mjs [dir]
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || path.resolve(process.cwd(), 'public/avatars/preset');
const KEY = process.env.ZHIPU_API_KEY;
const MODEL = 'glm-4v-flash';

async function check(filePath) {
  const buf = fs.readFileSync(filePath);
  const dataUrl = `data:image/webp;base64,${buf.toString('base64')}`;
  const r = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: '仔细看这张图的右下角，是否能看到 "AI 生成" 或 "AI生成" 这四个字组成的小徽章或水印？只回答两个字：有 或 没有。' },
        ],
      }],
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  const text = (d.choices?.[0]?.message?.content || '').trim();
  return text;
}

async function main() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.webp'));
  console.log(`检查 ${DIR}，共 ${files.length} 张`);
  const stats = { clean: [], dirty: [], err: [] };
  const queue = [...files];
  const CONCURRENCY = 3;
  async function worker() {
    while (queue.length > 0) {
      const f = queue.shift();
      if (!f) break;
      try {
        const ans = await check(path.join(DIR, f));
        const has = ans.startsWith('有');
        if (has) {
          stats.dirty.push(f);
          console.log(`  ✗ ${f.slice(0,60)} → ${ans}`);
        } else {
          stats.clean.push(f);
        }
      } catch (e) {
        stats.err.push(f);
      }
    }
  }
  await Promise.all(Array(CONCURRENCY).fill(0).map(() => worker()));
  console.log(`\n干净: ${stats.clean.length} | 仍有水印: ${stats.dirty.length} | 检查失败: ${stats.err.length}`);
  if (stats.dirty.length > 0) {
    console.log('\n仍有水印的文件:');
    stats.dirty.forEach(f => console.log('  -', f));
  }
  // 输出文件名列表供下一步处理
  if (stats.dirty.length > 0) {
    fs.writeFileSync('/tmp/dirty_avatars.txt', stats.dirty.join('\n'));
    console.log('\n已写入 /tmp/dirty_avatars.txt');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
