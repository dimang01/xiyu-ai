/**
 * 发布一致性检查（v1.20 PR3，接 npm run check:release 并入 CI）。
 *
 * 背景：今天三连发版后 README 版本历史仍停在 v1.10.53、ROADMAP 标注 v1.19.3
 * ——发版时文档跟不上是惯性问题，靠约定记不住，靠门禁。
 *
 * 对账五项（任一不齐 → 打印 diff 非零退出）：
 *   1. package.json version ↔ 最新 git tag（pkg 可领先 tag 一步=发版窗口，tag 领先 pkg=红）
 *   2. README.md 版本历史含当前 major.minor
 *   3. README.en.md 同
 *   4. docs/ROADMAP.md 标注含当前 major.minor（或下一个 minor=开发中表述）
 *   5. 中英 README 功能表行数一致
 *
 * CI 注意：actions/checkout 需 fetch-tags: true 才有 tags；无 tags 时第 1 项降级
 * 为警告跳过（本地跑仍全量）。
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');

let fail = 0;
const bad = (msg, hint = '') => { fail++; console.log(`  ✗ ${msg}`); if (hint) console.log(`    ${hint}`); };
const good = (msg) => console.log(`  ✓ ${msg}`);

const pkg = JSON.parse(read('package.json'));
const version = String(pkg.version);                       // e.g. 1.19.6
const [maj, min] = version.split('.').map(Number);
const majorMinor = `v${maj}.${min}`;                       // e.g. v1.19
const nextMinor = `v${maj}.${min + 1}`;                    // 开发中表述也算齐（如 v1.20）
console.log(`package.json = v${version} → 对账锚点 ${majorMinor}（或开发中 ${nextMinor}）`);

// ── 1) tag ↔ package.json ───────────────────────────────────────────────
let tag = null;
try {
  tag = execSync('git describe --tags --abbrev=0', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch { /* CI 浅克隆无 tags */ }
if (!tag) {
  console.log('  ℹ 无 git tags（CI 浅克隆？）→ 跳过 tag 对账。ci.yml 的 checkout 需 fetch-tags: true');
} else {
  const tagV = tag.replace(/^v/, '').split('.').map(Number);
  const pkgV = version.split('.').map(Number);
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); } return 0; };
  const d = cmp(pkgV, tagV);
  if (d === 0) good(`tag ${tag} = package.json ✓`);
  else if (d > 0) good(`package.json v${version} 领先 tag ${tag}（发版窗口，合并后记得打 tag）`);
  else bad(`tag ${tag} 比 package.json v${version} 新——忘升版本号了`, '修：发版 PR 里 package.json version 与 tag 一起升');
}

// ── 2/3) README 版本历史含当前 major.minor ──────────────────────────────
for (const f of ['README.md', 'README.en.md']) {
  const src = read(f);
  const section = src.split(/^## (?:版本历史|Version history)/mi)[1] || src;
  if (new RegExp(`\\*\\*${majorMinor.replace('.', '\\.')}[^0-9]`).test(section)
      || new RegExp(`→\\s*${majorMinor.replace('.', '\\.')}`).test(section)
      || new RegExp(`${nextMinor.replace('.', '\\.')}[^0-9]`).test(section)) {
    good(`${f} 版本历史含 ${majorMinor}`);
  } else {
    bad(`${f} 版本历史不含 ${majorMinor}`, `修：在「最近主线」加 ${majorMinor} 条目（可并入浓缩条目）`);
  }
}

// ── 4) ROADMAP 标注 ─────────────────────────────────────────────────────
{
  const src = read('docs/ROADMAP.md');
  if (src.includes(majorMinor) || src.includes(nextMinor)) good(`ROADMAP.md 含 ${majorMinor}/${nextMinor}`);
  else bad(`ROADMAP.md 不含 ${majorMinor}`, '修：刷新尾部 Last updated 标注');
}

// ── 5) 中英功能表行数一致 ───────────────────────────────────────────────
{
  const zh = (read('README.md').split('## 它能做什么')[1] || '').split('\n---')[0].split('\n').filter(l => /^\|/.test(l)).length;
  const en = (read('README.en.md').split(/## What it does/i)[1] || '').split('\n---')[0].split('\n').filter(l => /^\|/.test(l)).length;
  if (zh === en && zh > 0) good(`中英功能表行数一致（${zh} 行）`);
  else bad(`中英功能表行数不一致：zh=${zh} en=${en}`, '修：对照同步两个 README 的功能表（见 issue #231 的做法）');
}

if (fail) {
  console.log(`check-release-consistency: 失败 ${fail} 项`);
  process.exit(1);
}
console.log('check-release-consistency: 全部一致');
