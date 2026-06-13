/**
 * works_schedule_smoke —— PR-W5 日程结构化红验（2026-06-13）。纯函数零网络零 LLM。
 * 设计 §7「进行中」：日程消费 works 档案 + progress 渐进推进 + life_state 预留位。
 *
 * 红验：①progress 渐进单调不跳/不回退 ②advanceWorkProgress 跨阶段才写、generic 不动
 *   ③ensureCurrentWorks 真推进 active works 进度并与生命周期换档衔接 ④buildScheduleWorksHint
 *   只含档案真实条目（杜绝日程层漂移）+ life_state 预留位在场 ⑤静态：plan_tasks 先刷档案再生成日程。
 */
import { readFileSync } from 'node:fs';
import {
  workProgressRatio, progressStageNote, advanceWorkProgress, buildScheduleWorksHint,
  ensureCurrentWorks, isWorkFinished, lifecycleDays,
} from '../src/current_works.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };
const daysAgo = (d) => new Date(Date.now() - d * 86400_000).toISOString();

// ── ① progress 渐进：ratio 单调↑ → stage idx 单调↑（绝不跳级/回退）──
{
  const seq = [0, 0.1, 0.19, 0.2, 0.45, 0.5, 0.79, 0.8, 0.99, 1].map(r => progressStageNote('book', r));
  const stages = ['才翻开没几页', '看了几章了', '看到一半了', '快读完了'];
  const idxs = seq.map(s => stages.indexOf(s));
  ok(idxs.every(i => i >= 0), 'book 各 ratio 都落在合法阶段文案');
  ok(idxs.every((v, i) => i === 0 || v >= idxs[i - 1]), 'progress 单调不回退（ratio↑ 文案只进不退）');
  ok(progressStageNote('book', 0) === '才翻开没几页' && progressStageNote('book', 1) === '快读完了', '两端=刚开始/快读完');
  ok(progressStageNote('series', 0.6) === '追到一半了' && progressStageNote('craft', 0.9) === '快收尾了', 'kind 专属文案（剧/手工）');
}

// ── workProgressRatio：时长比例 0~1 clamp ──
{
  const book = { kind: 'book', started_at: daysAgo(0) };
  ok(workProgressRatio(book) < 0.15, '刚建档 ratio≈0');
  const half = { kind: 'book', started_at: daysAgo(lifecycleDays('book', daysAgo(99)) / 2) };
  ok(workProgressRatio(half) > 0.3 && workProgressRatio(half) < 0.7, '半程 ratio≈0.5');
  ok(workProgressRatio({ kind: 'book', started_at: daysAgo(999) }) === 1, '超期 clamp 到 1');
}

// ── ② advanceWorkProgress：跨阶段才写、同阶段 null、generic 不动 ──
{
  const fresh = { kind: 'book', started_at: daysAgo(0), progress_note: '才翻开没几页', verify_status: 'verified' };
  ok(advanceWorkProgress(fresh) === null, '同阶段 → null（不重复写库）');
  const moved = { kind: 'book', started_at: daysAgo(999), progress_note: '才翻开没几页', verify_status: 'verified' };
  ok(advanceWorkProgress(moved) === '快读完了', '跨到末阶段 → 返回新文案');
  const generic = { kind: 'book', started_at: daysAgo(999), progress_note: null, verify_status: 'generic' };
  ok(advanceWorkProgress(generic) === null, 'generic 泛读态不推进具体进度');
}

// ── ③ ensureCurrentWorks 真推进 active works + 与换档衔接 ──
{
  const rows = []; let id = 0;
  const db = {
    getActive: (cid) => rows.filter(r => r.companion_id === cid && r.status === 'active'),
    insert: (cid, w) => { rows.push({ id: ++id, companion_id: cid, status: 'active', ...w, title: w.title, verify_status: w.verifyStatus, progress_note: w.progressNote, started_at: w.startedAt }); return id; },
    setStatus: (wid, s) => { const r = rows.find(x => x.id === wid); if (r) r.status = s; },
    setProgress: (wid, note) => { const r = rows.find(x => x.id === wid); if (r) r.progress_note = note; },
  };
  // 半程的 verified 书（未到完结）→ 应推进进度
  rows.push({ id: ++id, companion_id: 1, status: 'active', kind: 'book', title: '活着', verify_status: 'verified', progress_note: '才翻开没几页', started_at: daysAgo(Math.ceil(lifecycleDays('book', daysAgo(99)) * 0.6)) });
  const out = await ensureCurrentWorks({ id: 1 }, { getActive: db.getActive, insert: db.insert, setStatus: db.setStatus, setProgress: db.setProgress, generate: async () => null });
  ok(out.progressed >= 1, `半程 active 书进度被推进（progressed=${out.progressed}）`);
  ok(db.getActive(1)[0].progress_note !== '才翻开没几页', `progress_note 已推进（实测"${db.getActive(1)[0].progress_note}"）`);
  // 衔接：超期书 isWorkFinished=true（换档接力，不在 progress 推进里被卡住）
  ok(isWorkFinished({ kind: 'book', started_at: daysAgo(999) }) === true, '超期书到完结点（生命周期换档接力）');
}

// ── ④ buildScheduleWorksHint：只含档案真实条目 + life_state 预留位 ──
{
  const works = [
    { kind: 'book', title: '活着', verify_status: 'verified', progress_note: '看到一半了' },
    { kind: 'craft', title: '给外婆织围巾', verify_status: 'skip', progress_note: '快收尾了' },
    { kind: 'book', title: '推理小说', verify_status: 'generic', progress_note: null },
  ];
  const h = buildScheduleWorksHint(works);
  ok(h.includes('《活着》') && h.includes('看到一半了'), '注入真实书名+进度');
  ok(h.includes('给外婆织围巾'), 'craft 自由文本');
  ok(h.includes('一本推理小说') && !/《推理小说》/.test(h), 'generic 不指名（不带书名号）');
  ok(h.includes('绝不另编') || h.includes('必须引用'), '强约束：日程只用档案条目、绝不另编（杜绝漂移）');
  ok(h.includes('life_state') && (h.includes('生理期') || h.includes('身体状态')), 'life_state 预留位在场（v1.22 生理期同位注入）');
  ok(buildScheduleWorksHint([]) === '' && buildScheduleWorksHint(null) === '', '无 works → 空 hint');
  // 一致性：hint 里出现的《》书名必 ∈ 档案（结构上不可能注入档案外名）
  const titlesInHint = [...h.matchAll(/《([^》]+)》/g)].map(m => m[1]);
  const archive = works.map(w => w.title);
  ok(titlesInHint.every(t => archive.includes(t)), `hint 内书名全 ∈ 档案（实测 ${JSON.stringify(titlesInHint)}）`);
}

// ── ⑤ 静态：plan_tasks 先刷 works 档案、再生成日程（日程消费的是刷新后的档案）──
{
  const src = readFileSync(new URL('../src/plan_tasks.mjs', import.meta.url), 'utf8');
  const iRefresh = src.indexOf('await refreshCurrentWorks(comp)');
  const iSched = src.indexOf('await generateScheduleFor(comp');
  ok(iRefresh > 0 && iSched > 0 && iRefresh < iSched, 'runDailySchedules：refreshCurrentWorks 在 generateScheduleFor 之前');
  ok(src.includes('buildScheduleWorksHint(getActiveCurrentWorks(comp.id))'), '日程 sys 注入 buildScheduleWorksHint(active works)');
  ok(src.includes('${worksScheduleHint}'), 'worksScheduleHint 进日程 prompt');
}

console.log(`\nworks_schedule_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
