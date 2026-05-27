/**
 * 用智谱 GLM-4V-Flash 给预生成头像打美感分。
 * 评分 < 7 的自动 disable，不进入用户匹配池。
 *
 * 用法：node --env-file=.env scripts/score_avatar_presets.mjs [--all]
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { listAvatarPresets, updateAvatarPresetScore } from '../src/db.mjs';

const PRESET_DIR = path.resolve(process.cwd(), 'public/avatars/preset');
const ZHIPU_API = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL = process.env.ZHIPU_VISION_MODEL || 'glm-4v-flash';

const SCORE_PROMPT = `你是动漫头像审美评分员，给这张图打 1-10 分。

评分标准：
- 9-10：超可爱/有气质，构图完美，五官精致
- 7-8：还不错，可以用
- 5-6：一般，有明显瑕疵（脸怪/构图偏）
- 1-4：差（脸崩、身体诡异）

严格只输出 JSON，不要 markdown 代码块：
{"score": 数字, "issues": "20字内简评"}`;

async function scoreOne(fileName) {
  const filePath = path.join(PRESET_DIR, fileName);
  let buf;
  try {
    buf = await fs.readFile(filePath);
  } catch (e) {
    return null;
  }
  const dataUrl = `data:image/webp;base64,${buf.toString('base64')}`;
  try {
    const r = await fetch(ZHIPU_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.ZHIPU_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: SCORE_PROMPT },
          ],
        }],
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`HTTP ${r.status}: ${text.slice(0, 150)}`);
    }
    const data = await r.json();
    const content = data.choices?.[0]?.message?.content || '';
    // 提取 JSON
    const m = content.match(/\{[\s\S]*?\}/);
    if (!m) throw new Error('未找到 JSON: ' + content.slice(0, 80));
    let j;
    try { j = JSON.parse(m[0]); }
    catch {
      // GLM 偶尔输 markdown，二次清洗
      const cleaned = content.replace(/```json|```/g, '');
      const m2 = cleaned.match(/\{[\s\S]*?\}/);
      j = JSON.parse(m2[0]);
    }
    const score = Math.min(10, Math.max(0, Number(j.score) || 0));
    return { score, notes: String(j.issues || '').replace(/[\[\]{}"]/g, '').slice(0, 60) };
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  const presets = listAvatarPresets({ onlyEnabled: false });
  const todo = process.argv.includes('--all') ? presets : presets.filter(p => !p.score || p.score === 0);
  console.log(`待评分：${todo.length} / 总数 ${presets.length}`);
  const stats = { graded: 0, kept: 0, dropped: 0, fail: 0 };

  // GLM-4V-flash 限速比 Gemini 宽松。并发 3 应该 OK
  const CONCURRENCY = 3;
  const queue = [...todo];
  async function worker() {
    while (queue.length > 0) {
      const p = queue.shift();
      if (!p) break;
      let r = await scoreOne(p.file_name);
      // 失败重试一次
      if (r && r.error) {
        await new Promise(s => setTimeout(s, 3000));
        r = await scoreOne(p.file_name);
      }
      if (!r || r.error) {
        stats.fail++;
        console.log(`  ✗ ${p.file_name.slice(0,55)} 评分失败 ${(r && r.error) || ''}`);
        continue;
      }
      updateAvatarPresetScore(p.file_name, r.score, r.notes);
      stats.graded++;
      if (r.score >= 7) {
        stats.kept++;
        console.log(`  ✓ ${p.file_name.slice(0,55)} → ${r.score.toFixed(1)} ${r.notes}`);
      } else {
        stats.dropped++;
        console.log(`  ✗ ${p.file_name.slice(0,55)} → ${r.score.toFixed(1)} ${r.notes} (禁用)`);
      }
    }
  }
  await Promise.all(Array(CONCURRENCY).fill(0).map(() => worker()));
  console.log(`\n完成：评分 ${stats.graded} | 保留 ${stats.kept} | 禁用 ${stats.dropped} | 失败 ${stats.fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
