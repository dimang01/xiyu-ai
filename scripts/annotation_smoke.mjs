/**
 * 标注语料工具 smoke（v1.21.4，临时 DB 真函数，零 LLM）。
 *
 * 覆盖：CRUD 与覆盖更新 / 列表含上下文与 arc_state / synthetic 不进列表 /
 * 计数 / 导出字段齐全（context[]/reply/label/tags/note）/ 入参校验 /
 * 静态断言（API admin-only、页面零 token 泄漏、.gitignore 含导出目录、
 * 运行时零依赖——bot/proactive 不 import 标注函数）。
 */
process.env.DB_PATH = '/tmp/annotation_smoke.db';
import { unlinkSync, readFileSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const {
  getDb, saveConversationTurn, bulkInsertSyntheticTurns,
  upsertAnnotation, listAnnotatableTurns, annotationStats, listAnnotationsForExport,
} = await import('../src/db.mjs');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const db = getDb();
db.pragma('foreign_keys = OFF');
db.prepare("INSERT INTO users (id, wechat_user_id) VALUES (1,'w')").run();
db.prepare("INSERT INTO companions (id, user_id, bot_id, name, arc_state) VALUES (5,1,'b','溪','hurt')").run();

saveConversationTurn(5, 'user', '今天有点累', null);
saveConversationTurn(5, 'assistant', '怎么了 工作不顺吗', null);
saveConversationTurn(5, 'user', '嗯 加班到现在', null);
saveConversationTurn(5, 'assistant', '检测到他的情绪为疲惫，建议给予安慰', null);   // 化验单腔调样本
bulkInsertSyntheticTurns(5, [{ created_at: '2026-05-01 12:00:00', role: 'assistant', content: '虚拟历史回复', topic: null }]);

// ── 列表 ──
const list = listAnnotatableTurns({ companionId: 5, limit: 10 });
ok(list.length === 2, `列表只取真实 assistant turns（实际 ${list.length}，synthetic 不进）`);
ok(list[0].arc_state === 'hurt' && list[0].companion_name === '溪', '列表带 arc_state 与 companion 名');
ok(list[0].context.length === 2 && list[0].context[0].role === 'assistant', '前 2 条上下文（含她自己的上一条）');
ok(list[0].annotation === null, '未标注时 annotation 为 null');

// ── 标注 + 覆盖更新 ──
const badTurn = list[0];   // 化验单腔调那条
upsertAnnotation({ turnId: badTurn.id, companionId: 5, label: 'bad', tags: ['化验单腔调', 'AI味'], note: '抽取腔进台词' });
let st = annotationStats();
ok(st.today === 1 && st.bad === 1 && st.good === 0, `首标计数（today=${st.today} bad=${st.bad}）`);

upsertAnnotation({ turnId: badTurn.id, companionId: 5, label: 'good', tags: ['神来之笔'], note: null });
st = annotationStats();
ok(st.bad === 0 && st.good === 1, '同 turn 重复标注=覆盖更新（一条回复只有一个最新判定）');
const after = listAnnotatableTurns({ companionId: 5, limit: 10 });
ok(after[0].annotation?.label === 'good' && JSON.parse(after[0].annotation.tags)[0] === '神来之笔',
   '列表回显最新标注');

// 第二条标 bad（导出要 good/bad 都有）
upsertAnnotation({ turnId: after[1].id, companionId: 5, label: 'bad', tags: ['化验单腔调'] });

// ── 导出字段 ──
const exp = listAnnotationsForExport();
ok(exp.length === 2, '导出全部标注');
const e0 = exp.find(r => r.label === 'bad');
ok(Array.isArray(e0.context) && typeof e0.reply === 'string' && Array.isArray(e0.tags) && 'note' in e0,
   '导出字段齐全：context[]/reply/label/tags/note');
ok(e0.context.every(c => c.role && typeof c.content === 'string'), 'context 元素为 {role, content}');

// ── 入参校验 ──
let threw = false;
try { upsertAnnotation({ turnId: 1, companionId: 5, label: 'meh' }); } catch { threw = true; }
ok(threw, '非法 label 拒绝');

// ── 静态断言 ──
const api = readFileSync(new URL('../src/api.mjs', import.meta.url), 'utf8');
for (const ep of ["'/admin/annotate/turns'", "'/admin/annotate'", "'/admin/annotate/stats'", "'/admin/annotate/tags'"]) {
  const idx = api.indexOf(ep);
  ok(idx > -1 && api.slice(idx, idx + 80).includes('requireAdmin'), `端点 ${ep} admin-only`);
}
const page = readFileSync(new URL('../public/app/annotate.html', import.meta.url), 'utf8');
ok(page.includes('xiyu_admin_token') && page.includes("location.href = '/app/admin.html'"),
   '页面走 admin token 且 401 跳回登录');
ok(readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').includes('exports/'),
   '.gitignore 含导出目录（语料原文不进 git）');
// 运行时零依赖：回复链路不碰标注函数
for (const f of ['bot.mjs', 'proactive.mjs', 'companion.mjs', 'ai.mjs']) {
  const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  ok(!src.includes('upsertAnnotation') && !src.includes('annotation_corpus'),
     `${f} 零标注依赖（纯 admin 工具不碰运行时）`);
}

console.log(`\nannotation_smoke: ${pass} passed, ${fail} failed`);
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
process.exit(fail ? 1 : 0);
