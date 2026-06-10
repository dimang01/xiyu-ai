/**
 * v1.20 "她的承诺"闭环 smoke（纯函数，零 LLM，确定性）。
 * 验：#1 hasCompanionPromiseSignal gate 正反例（多数回复 0 LLM 调用的前提）
 *     #2 normalizeCompanionPromise 防滥用兜底（模糊客套/照片/坏日期/无期限提醒一律丢）
 *
 * 背景：她说"明天提醒你带伞""周末给你讲那个故事"以前是顺着人设的空话，
 * 没有系统接住。本闭环：出口抽取(owner='companion') → 到期 proactive 升格
 * promise_keep 兑现。说了不做比不说更伤信任；但只接"明确承诺"，模糊客套不算。
 */
import { hasCompanionPromiseSignal, normalizeCompanionPromise } from '../src/open_loops.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// ── #1 gate 正例：明确承诺信号必须命中（漏 = 承诺永远不入账）─────────────
ok(hasCompanionPromiseSignal('明天提醒你带伞，别又淋成落汤鸡'), '#1 "明天提醒你带伞" 命中');
ok(hasCompanionPromiseSignal('那说好了，周末给你讲那个故事'), '#1 "周末给你讲那个故事" 命中');
ok(hasCompanionPromiseSignal('好啦，下次我先找你，一言为定'), '#1 "下次我先找你" 命中');
ok(hasCompanionPromiseSignal('我答应你，周五一定给你答复'), '#1 "我答应你" 命中');
ok(hasCompanionPromiseSignal('到时候我叫你起床，赖床鬼'), '#1 "叫你起床" 命中');
ok(hasCompanionPromiseSignal('晚点给你唱我新学的那首歌哦'), '#1 "晚点给你唱" 命中');
ok(hasCompanionPromiseSignal('下周带你去吃那家火锅'), '#1 "下周带你去" 命中');
ok(hasCompanionPromiseSignal('我保证明天不赖床'), '#1 "我保证" 命中');

// ── #1 gate 负例：日常聊天不触发（误报 = 每条回复都烧一次 LLM）────────────
ok(!hasCompanionPromiseSignal('吃了呀，你呢'), '#1 闲聊"吃了呀"不触发');
ok(!hasCompanionPromiseSignal('今天好累哦，刚到家'), '#1 状态分享不触发');
ok(!hasCompanionPromiseSignal('突然有点想你了怎么办'), '#1 想念表达不触发');
ok(!hasCompanionPromiseSignal('我会想你的呀'), '#1 情感宣言"我会想你的"不触发（裸"我会"不收）');
ok(!hasCompanionPromiseSignal('改天聊吧，我先去忙啦'), '#1 模糊客套"改天聊"不触发（0 LLM）');
ok(!hasCompanionPromiseSignal('你明天要去面试呀，加油'), '#1 用户的事（她在关心）不触发');
ok(!hasCompanionPromiseSignal('哈哈哈哈笑死我了'), '#1 纯笑场不触发');
ok(!hasCompanionPromiseSignal('好呀'), '#1 短回复不触发');
ok(!hasCompanionPromiseSignal(''), '#1 空回复不触发');

// ── #2 normalize 正例 ──────────────────────────────────────────────────────
const TODAY = '2026-06-10';
const r1 = normalizeCompanionPromise(
  { title: '明天提醒他带伞', kind: 'remind', due_at: '2026-06-11', expected_followup: '主动发消息提醒他出门带伞' },
  TODAY,
);
ok(r1 && r1.promiseKind === 'remind' && r1.dueAt === '2026-06-11', '#2 提醒承诺正常入账');
ok(r1 && r1.title === '她答应明天提醒他带伞', '#2 title 自动加"她答应"前缀');
ok(r1 && r1.emotionalWeight === 80, '#2 remind 权重固定 80（不收 LLM 的值）');

const r2 = normalizeCompanionPromise(
  { title: '她答应周末给他讲小时候的故事', kind: 'do', due_at: '2026-06-13', expected_followup: '主动提起并把故事讲给他听' },
  TODAY,
);
ok(r2 && r2.promiseKind === 'do' && r2.dueAt === '2026-06-13', '#2 陪伴承诺正常入账');
ok(r2 && r2.title === '她答应周末给他讲小时候的故事', '#2 已有"她"开头不重复加前缀');
ok(r2 && r2.emotionalWeight === 60, '#2 do 权重固定 60');

const r3 = normalizeCompanionPromise({ title: '下次主动先找他聊天', kind: 'do', due_at: null }, TODAY);
ok(r3 && r3.dueAt === '2026-06-12', '#2 do 无日期 → 默认后天兑现（不无限挂账）');
const r3b = normalizeCompanionPromise({ title: '下次主动先找他聊天', kind: 'do', due_at: null }, '2026-06-29');
ok(r3b && r3b.dueAt === '2026-07-01', '#2 默认后天跨月正确');
const r4 = normalizeCompanionPromise({ title: '明天陪他看球赛', kind: '怪值', due_at: '2026-06-11' }, TODAY);
ok(r4 && r4.promiseKind === 'do', '#2 非法 kind 保守归 do（不会变成硬时点提醒）');

// ── #2 normalize 反例：防滥用确定性兜底（LLM 说什么都拦得住）──────────────
ok(normalizeCompanionPromise({ title: '改天和他聊聊', kind: 'do', due_at: '2026-06-12' }, TODAY) === null, '#2 模糊"改天"丢弃（即使 LLM 给了日期）');
ok(normalizeCompanionPromise({ title: '下次一定陪他', kind: 'do', due_at: null }, TODAY) === null, '#2 敷衍"下次一定"丢弃');
ok(normalizeCompanionPromise({ title: '有空再给他讲', kind: 'do', due_at: null }, TODAY) === null, '#2 "有空再"丢弃');
ok(normalizeCompanionPromise({ title: '等下拍照片给他看', kind: 'do', due_at: '2026-06-10' }, TODAY) === null, '#2 照片承诺丢弃（photo promise 链路已接管，防双发）');
ok(normalizeCompanionPromise({ title: '明天发自拍给他', kind: 'remind', due_at: '2026-06-11' }, TODAY) === null, '#2 自拍承诺丢弃');
ok(normalizeCompanionPromise({ title: '明天提醒他带伞', kind: 'remind', due_at: '2026-06-11', expected_followup: '顺便拍一张给他' }, TODAY) === null, '#2 followup 涉照片也丢');
ok(normalizeCompanionPromise({ title: '提醒他多喝水', kind: 'remind', due_at: null }, TODAY) === null, '#2 无期限提醒丢弃（没法兑现 = 空头支票）');
ok(normalizeCompanionPromise({ title: '明天提醒他交材料', kind: 'remind', due_at: '明天' }, TODAY) === null, '#2 相对日期"明天"丢弃（LLM 没换算）');
ok(normalizeCompanionPromise({ title: '提醒他赶火车', kind: 'remind', due_at: '2026-06-09' }, TODAY) === null, '#2 过去日期丢弃（LLM 换算错误防护）');
ok(normalizeCompanionPromise({ title: '提醒他续签合同', kind: 'remind', due_at: '2026-08-15' }, TODAY) === null, '#2 超 30 天丢弃（防垃圾长期挂表）');
ok(normalizeCompanionPromise({ title: '嗯', kind: 'do', due_at: null }, TODAY) === null, '#2 title 过短丢弃');
ok(normalizeCompanionPromise(null, TODAY) === null, '#2 null 输入安全');
ok(normalizeCompanionPromise('字符串', TODAY) === null, '#2 非对象输入安全');

console.log(`companion_promise_smoke: 通过 ${pass} 失败 ${fail}`);
process.exit(fail ? 1 : 0);
