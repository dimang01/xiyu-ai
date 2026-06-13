/**
 * works_schedule_sandbox —— PR-W5 日程结构化真 LLM 验收（手动跑，不进 CI）。2026-06-13。
 *
 * 连续 3 天：每天按在档时长推进 works 进度 → 用真实档案生成当天日程（真 chat provider）→
 * 打印日程 + 进度，验「她在读的书在日程里前后自洽、进度渐进、不漂移出档案外书名」。贴 PR。
 *
 * 用法：node scripts/works_schedule_sandbox.mjs
 */
import 'dotenv/config';
process.env.DB_PATH = '/tmp/works_sched_sandbox.db';
import { unlinkSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const { buildScheduleWorksHint, workProgressRatio, progressStageNote, lifecycleDays } = await import('../src/current_works.mjs');
const { extractStructuredInfo } = await import('../src/ai.mjs');

// 档案：一本真实验证书 + 一件 craft（固定，模拟 W1 已建档）
const bookDays = lifecycleDays('book', new Date().toISOString());
function worksOnDay(dayIdx) {
  // started_at 往前推，使 day0/1/2 的 ratio 落在 早/中/晚 三段
  const startedDaysAgo = Math.round(bookDays * (0.1 + dayIdx * 0.38));   // ~0.1 / 0.48 / 0.86
  const startedAt = new Date(Date.now() - startedDaysAgo * 86400_000).toISOString();
  const ratio = workProgressRatio({ kind: 'book', started_at: startedAt });
  return [
    { kind: 'book', title: '活着', verify_status: 'verified', progress_note: progressStageNote('book', ratio), started_at: startedAt },
    { kind: 'craft', title: '给外婆织围巾', verify_status: 'skip', progress_note: progressStageNote('craft', 0.3 + dayIdx * 0.3) },
  ];
}

const FORBIDDEN_DRIFT = /《(?!活着》)([^》]{2,})》/g;   // 出现「非《活着》」的书名号=日程层漂移

let warn = 0;
console.log('════════ PR-W5 日程结构化沙箱（真 LLM · 连续 3 天）════════');
console.log(`档案：在看《活着》（book 生命周期 ${bookDays} 天）+ 在做 给外婆织围巾\n`);

for (let day = 0; day < 3; day++) {
  const works = worksOnDay(day);
  const hint = buildScheduleWorksHint(works);
  const book = works[0];
  const sys = `你帮一个虚拟角色生成"今天的日程"，要符合人设、真实可信、有生活气息。
角色：溪语，21岁，邻家女孩，爱好：阅读、看剧。
今天日期：第 ${day + 1} 天（工作日）
【强制约束 - 极其重要】
${hint}
【风格要求】输出 8-12 个时间点（07:00-23:30），其中至少 1 条是"读书"类活动。
返回 JSON：{"items":[{"time":"HH:MM","activity":"...","importance":1-10}]}`;

  let items;
  try {
    const raw = await extractStructuredInfo(sys, '生成今天的日程 JSON', { maxTokens: 1200 });
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    items = m ? (JSON.parse(m[0]).items || []) : [];
  } catch (e) { console.log(`  day${day + 1} 生成失败: ${e.message}`); continue; }

  console.log(`──── 第 ${day + 1} 天（《活着》进度："${book.progress_note}" · ratio≈${workProgressRatio(book).toFixed(2)}）────`);
  const readItems = items.filter(it => /读|看书|阅读|《|书|织|围巾|看剧|追/.test(it.activity || ''));
  for (const it of readItems) console.log(`  ${it.time}  ${it.activity}`);

  // 红验：日程里出现的书名号条目必 ∈ 档案（不得漂移出"活着"以外的新书名）
  const allText = items.map(it => it.activity).join(' ');
  const drift = [...allText.matchAll(FORBIDDEN_DRIFT)].map(x => x[1]);
  if (drift.length) { console.log(`    ⚠ 日程层漂移出档案外书名：${JSON.stringify(drift)}`); warn += drift.length; }
  const mentionsBook = allText.includes('活着');
  if (!mentionsBook) { console.log('    ⚠ 日程没引用档案书《活着》（worksHint 未生效？）'); warn++; }
  else console.log('    ✓ 日程引用了档案书《活着》、无漂移');
  console.log('');
}

console.log(`════════ 沙箱结束：${warn === 0 ? '✅ 三天均自洽（引用《活着》·进度渐进·零漂移）' : `⚠ ${warn} 条告警（人工判读）`} ════════`);
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
