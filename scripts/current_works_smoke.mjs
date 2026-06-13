/**
 * current_works_smoke —— current_works 真实性验证双闸红色验证（v1.21.4 PR-W1）。
 * 纯函数零真网络：mock webSearch + 内存 db 注入。设计 docs/V1214_DESIGN.md §14。
 *
 * 红验（烧坏版本必须红）：
 *   ① mock 永远查无此书 → 重试耗尽降级 generic，档案具体名零虚构（注释验证直接入档→红）
 *   ② mock provider 故障 ok:false → 降级 generic，不把真书判假（把 ok:false 当无证据→红）
 *   ③ LLM 自报 craft 但 title 含《》→ 书名号兜底强制验证（删兜底→红）
 *   + 任务追加：虚构书《她总在转角处等我》入档尝试必须被双闸拦下降级泛读
 */
import {
  verifyWorkCandidate, requiresVerification, ensureCurrentWorks, lifecycleDays, isWorkFinished,
  buildWorkGenPrompt,
} from '../src/current_works.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

function makeDb() {
  const rows = []; let id = 0;
  return {
    rows,
    getActive: (cid) => rows.filter(r => r.companion_id === cid && r.status === 'active'),
    insert: (cid, w) => { rows.push({ id: ++id, companion_id: cid, status: 'active', kind: w.kind, title: w.title, verify_status: w.verifyStatus, started_at: w.startedAt }); return id; },
    setStatus: (wid, s) => { const r = rows.find(x => x.id === wid); if (r) r.status = s; },
  };
}

// ── ③ 书名号兜底（闸1）──
ok(requiresVerification('craft', '《三体》') === true, '红验③：kind=craft 但 title 含《》→ 强制验证（书名号兜底）');
ok(requiresVerification('craft', '给外婆织围巾') === false, 'craft 无《》→ 免验 skip');
ok(requiresVerification('book', '活着') === true, 'book 类必验');
{
  const v = await verifyWorkCandidate({ kind: 'craft', title: '《三体》', creator: '刘慈欣' },
    { search: async () => ({ ok: true, results: [] }), findCached: () => null });
  ok(v.status !== 'skip', `craft 自报但《》→ 不 skip、走验证（实测 ${v.status}）`);
}

// ── ② provider 故障 → generic，不判真书为假 ──
{
  const v = await verifyWorkCandidate({ kind: 'book', title: '《活着》', creator: '余华' },
    { search: async () => ({ ok: false, error: 'ECONNRESET' }), findCached: () => null });
  ok(v.status === 'generic', `红验②：provider 故障 ok:false → generic（不判真书为假，实测 ${v.status}）`);
}
{
  const v = await verifyWorkCandidate({ kind: 'book', title: '《活着》', creator: '余华' },
    { search: async () => ({ ok: true, results: [{ title: '活着 余华 长篇小说', snippet: '余华代表作《活着》讲述…' }] }), findCached: () => null });
  ok(v.status === 'verified', `真书命中证据 → verified（实测 ${v.status}）`);
}

// ── ① + 虚构书：搜不到 → 降级 generic 泛读，零虚构名入档 ──
{
  const db = makeDb();
  const FICTION = '她总在转角处等我';
  const out = await ensureCurrentWorks({ id: 1 }, {
    getActive: db.getActive, insert: db.insert, setStatus: db.setStatus,
    generate: async () => ({ kind: 'book', title: FICTION, creator: '某作者', genre: '推理小说' }),
    search: async () => ({ ok: true, results: [] }),   // 永远查无此书
    findCached: () => null, rng: () => 0.9,
  });
  const added = db.getActive(1)[0];
  ok(out.statusOfAdded === 'generic', `红验①：虚构书搜不到 → 重试耗尽降级 generic（实测 ${out.statusOfAdded}）`);
  ok(added && added.title !== FICTION, `虚构书名《${FICTION}》零入档（实测入档 title="${added?.title}"）`);
  ok(db.rows.every(r => r.title !== FICTION), '档案里没有任何虚构书名');
  ok(added && added.verify_status === 'generic', '降级条目 verify_status=generic（表达层据此走"泛读"文案）');
}

// ── 真书走 ensureCurrentWorks → verified 入档具体名 ──
{
  const db = makeDb();
  const out = await ensureCurrentWorks({ id: 2 }, {
    getActive: db.getActive, insert: db.insert, setStatus: db.setStatus,
    generate: async () => ({ kind: 'book', title: '活着', creator: '余华', genre: '小说' }),
    search: async () => ({ ok: true, results: [{ title: '活着 余华', snippet: '余华长篇小说《活着》' }] }),
    findCached: () => null, rng: () => 0.9,
  });
  const added = db.getActive(2)[0];
  ok(out.statusOfAdded === 'verified' && added.title === '活着', `真书 → verified 入档具体名（实测 ${out.statusOfAdded}/${added?.title}）`);
}

// ── 缓存：已 verified 免重搜；负结果不缓存 ──
{
  let searched = false;
  const v = await verifyWorkCandidate({ kind: 'book', title: '《活着》', creator: '余华' }, {
    search: async () => { searched = true; return { ok: true, results: [] }; },
    findCached: () => ({ title: '活着', creator: '余华', verify_evidence: '缓存证据' }),
  });
  ok(v.status === 'verified' && !searched, '缓存命中 verified → 免重搜（只缓正结果）');
}

// ── 生命周期：完结到点换新 ──
{
  const db = makeDb();
  db.rows.push({ id: 99, companion_id: 3, status: 'active', kind: 'book', title: '老书', started_at: new Date(Date.now() - 40 * 86400e3).toISOString() });
  const out = await ensureCurrentWorks({ id: 3 }, {
    getActive: db.getActive, insert: db.insert, setStatus: db.setStatus,
    generate: async () => ({ kind: 'book', title: '新书', creator: '作者', genre: '小说' }),
    search: async () => ({ ok: true, results: [{ title: '新书 作者', snippet: '作者的新书' }] }),
    findCached: () => null, rng: () => 0.9,   // >dropProb → finished 非 dropped
  });
  ok(out.finished === 1, `40 天前的 book 到点完结（book 上限 ${lifecycleDays('book', new Date(Date.now() - 40 * 86400e3).toISOString())} 天，实测 finished=${out.finished}）`);
  ok(out.added === 1 && db.getActive(3)[0].title === '新书', '完结后槽位空 → 换新建档');
}
// 生命周期天数在配置区间
ok(lifecycleDays('book', new Date().toISOString()) >= 10 && lifecycleDays('book', new Date().toISOString()) <= 21, 'book 生命周期 ∈ [10,21]');
ok(isWorkFinished({ kind: 'book', started_at: new Date(Date.now() - 40 * 86400e3).toISOString() }) === true, '40 天前 book 必完结');
ok(isWorkFinished({ kind: 'book', started_at: new Date().toISOString() }) === false, '刚建的 book 不完结');

// ── digest 跟进（换档生成质量）：#2 入库剥《》 + #1 多样性 + #3 人设软提示 ──
{
  const db = makeDb();
  const out = await ensureCurrentWorks({ id: 20 }, {
    getActive: db.getActive, insert: db.insert, setStatus: db.setStatus,
    generate: async () => ({ kind: 'book', title: '《活着》', creator: '余华', genre: '小说' }),  // LLM 不守"不加《》"
    search: async () => ({ ok: true, results: [{ title: '活着 余华', snippet: '余华长篇小说《活着》' }] }),
    findCached: () => null, rng: () => 0.9,
  });
  ok(out.statusOfAdded === 'verified', '剥《》前置：真书仍 verified');
  ok(db.getActive(20)[0].title === '活着', `#2 入库统一剥《》（实测 "${db.getActive(20)[0].title}"，与缓存查询口径一致）`);
}
{
  const c = { id: 21, age: 19, personality_tags: JSON.stringify(['文静', '内向']), hobbies: JSON.stringify(['阅读']) };
  const { prompt } = buildWorkGenPrompt(c, { existingTitles: ['活着'], recentTitles: ['《百年孤独》', '百年孤独'] });
  ok(prompt.includes('19 岁') && prompt.includes('文静'), '#3 人设软提示：年龄/性格进 prompt');
  ok(prompt.includes('品味') && (prompt.includes('真实存在') || prompt.includes('必须真实')), '#3 是"调品味不拦真书"措辞（仍要求真实存在）');
  ok(prompt.includes('百年孤独') && prompt.includes('避免雷同'), '#1 多样性：他人近期作品进"避免雷同"清单');
  ok((prompt.match(/百年孤独/g) || []).length === 1, '#1 avoid 去重（《百年孤独》+百年孤独 → 合一条）');
  ok(prompt.includes('不加书名号'), '#2 源头：prompt 明令 title 不加书名号（入库 stripBrackets 双保险）');
}

console.log(`\ncurrent_works_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
