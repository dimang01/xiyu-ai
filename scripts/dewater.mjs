/**
 * 去除智谱 CogView 生成图片右下角"AI 生成"水印。
 * 策略：放大 12% 后从顶部 gravity north 切回原尺寸 — 保持 aspect ratio，主体居中略放大，丢掉底部 ~11% 区域（水印所在）。
 *
 * 用法：
 *   node scripts/dewater.mjs           # 处理 preset 池 + landing 图
 *   node scripts/dewater.mjs --preset  # 只处理 preset 池
 *   node scripts/dewater.mjs --landing # 只处理 landing
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PRESET_DIR = path.resolve(process.cwd(), 'public/avatars/preset');
const LANDING_DIR = path.resolve(process.cwd(), 'public/assets/landing');
const ZOOM_RATIO = 1.13;  // 放大 13% 保证底部 11-12% 被切掉

function processOne(srcPath, targetSize) {
  return new Promise((resolve, reject) => {
    const zoomed = Math.round(targetSize * ZOOM_RATIO);
    const proc = spawn('convert', [
      srcPath,
      '-resize', `${zoomed}x${zoomed}^`,
      '-gravity', 'north',
      '-crop', `${targetSize}x${targetSize}+0+0`,
      '+repage',
      '-strip',
      '-quality', '85',
      srcPath,
    ]);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error('convert code=' + code)));
    proc.on('error', reject);
  });
}

async function processDir(dir, targetSize) {
  if (!fs.existsSync(dir)) {
    console.log(`  跳过 ${dir}（不存在）`);
    return;
  }
  const files = fs.readdirSync(dir).filter(f => /\.webp$/i.test(f));
  console.log(`处理 ${dir} ${files.length} 个文件 → 切顶 ${targetSize}x${targetSize}`);
  let ok = 0, fail = 0;
  const queue = [...files];
  const CONCURRENCY = 4;
  async function worker() {
    while (queue.length > 0) {
      const f = queue.shift();
      if (!f) break;
      try {
        await processOne(path.join(dir, f), targetSize);
        ok++;
      } catch (e) {
        fail++;
        console.error(`  ✗ ${f}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array(CONCURRENCY).fill(0).map(() => worker()));
  console.log(`  done: ${ok} 成功 / ${fail} 失败`);
}

async function main() {
  const onlyPreset = process.argv.includes('--preset');
  const onlyLanding = process.argv.includes('--landing');
  if (!onlyLanding) await processDir(PRESET_DIR, 512);
  if (!onlyPreset) await processDir(LANDING_DIR, 1024);
}

main().catch(e => { console.error(e); process.exit(1); });
