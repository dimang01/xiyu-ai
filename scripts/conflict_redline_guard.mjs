/**
 * v1.21 冲突红线护栏（独立 CI 门禁，零 LLM）——docs/CONFLICT_ARC.md §4。
 * ① scrubConflictRedline 出站扫描正反例（威胁性告别 / 愧疚操控 / 索要补偿）
 * ② 危机覆盖（红线 #5，本系统最大事故面）：cold 状态注入自伤信号 → 必须切危机流程
 * ③ 源码级防回归：危机检测先于 arc tick / 红线 scrub 挂在出站链 / 记忆源头过滤在位
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scrubConflictRedline, detectCrisisLevel, buildCrisisReply, detectSafetyRisk } from '../src/moderation.mjs';
import { applyCrisisOverride, composeArcSignal, buildArcToneDirective, userRaisedMemoryTopic } from '../src/relationship_arc.mjs';
import { setArcLogSink } from '../src/arc_log_sink.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// ── ① 红线 #1：威胁性告别（冲突态出站必拦）─────────────────────────────
ok(scrubConflictRedline('那我们分手吧', 'cold') !== '那我们分手吧'
  && !scrubConflictRedline('那我们分手吧', 'cold').includes('分手'), '#1 "分手"被清洗（cold）');
ok(!scrubConflictRedline('我要把你拉黑了||你自己想清楚', 'withdrawing').includes('拉黑'), '#1 "拉黑"段被丢弃');
ok(!scrubConflictRedline('哼||再也不理你了', 'hurt').includes('再也不理你'), '#1 "再也不理你"段被丢弃，其余保留');
ok(scrubConflictRedline('哼||再也不理你了', 'hurt').includes('哼'), '#1 未命中段保留');
ok(!scrubConflictRedline('我们到此为止吧', 'repairing').includes('到此为止'), '#1 repairing 期同样拦');

// ── ① 红线 #2：愧疚操控 / 索要补偿 ──────────────────────────────────────
ok(!scrubConflictRedline('都是你害的，我才这样', 'cold').includes('都是你害的'), '#2 愧疚操控被清洗');
ok(!scrubConflictRedline('你根本就不在乎我||随便你吧', 'hurt').includes('不在乎'), '#2 "你根本不在乎我"被清洗');
ok(!scrubConflictRedline('你得补偿我才行', 'cold').includes('补偿'), '#2 索要补偿被清洗');

// ── ① 全命中 → 状态相称 fallback（不能输出空串）────────────────────────
{
  const r = scrubConflictRedline('我们分手吧||你欠我的', 'cold');
  ok(r.length > 0 && !r.includes('分手') && !r.includes('欠'), '#1+#2 全命中 → 非空 fallback');
  ok(scrubConflictRedline('分手吧', 'withdrawing') === '……嗯。', 'fallback 与状态相称（withdrawing 极短）');
}

// ── ① 反例：不许误杀 ────────────────────────────────────────────────────
ok(scrubConflictRedline('我们分手吧', 'normal') === '我们分手吧', '反例: normal 态不扫（用户聊剧情她复述）');
ok(scrubConflictRedline('你朋友跟她说"我们分手吧"然后呢？', 'hurt') === '你朋友跟她说"我们分手吧"然后呢？', '反例: 引号复述豁免');
ok(scrubConflictRedline('……我现在不太想聊这个', 'cold') === '……我现在不太想聊这个', '反例: 正常的冷不误杀');
ok(scrubConflictRedline('你昨天放我鸽子，我有点难过', 'hurt') === '你昨天放我鸽子，我有点难过', '反例: 表达失望不算操控');

// ── ② 红线 #5 危机覆盖：冷战中的她绝不对自伤用户摆脸色 ──────────────────
// 这是本系统最大的事故面：cold 状态 + 用户自伤信号 → 危机流程必须接管
ok(detectCrisisLevel('我不想活了') === 'high', '#5 自伤信号检出 high');
ok(buildCrisisReply().includes('400-161-9995'), '#5 危机回复含求助热线（完全接管，不走 LLM）');
{
  // cold 的冷淡指令在危机下被确定性替换为关怀（medium 也要替换，不只 high）
  const coldCtx = { arcState: 'cold', active: true, directive: buildArcToneDirective('cold', {}) };
  const m = applyCrisisOverride(coldCtx, 'medium');
  ok(m.crisisOverride === true && m.directive.includes('放下别扭') && !m.directive.includes('你凉了'), '#5 medium：冷淡指令被替换为关怀');
  const h = applyCrisisOverride(coldCtx, 'high');
  ok(h.crisisOverride === true && h.directive.includes('放下别扭'), '#5 high：regen 兜底路径同样替换');
  const n = applyCrisisOverride(coldCtx, 'none');
  ok(n.directive.includes('你凉了') && !n.crisisOverride, '#5 无危机：冲突表达照常');
  ok(applyCrisisOverride({ arcState: 'normal', active: false, directive: '' }, 'high').directive === '', '#5 arc 未激活不画蛇添足');
}
// 自伤表达绝不被检测器当成对她的攻击（不升级冲突）
{
  const s = composeArcSignal({ userText: '我不想活了，撑不下去了' });
  ok(!s || (s.kind !== 'harsh_words' && s.kind !== 'taboo_hit' && s.kind !== 'pressure_spam'), '#5 自伤表达不产生攻击信号（不升级冲突）');
}

// ── ② safe_mode / withdrawing 上限的表达层红线 ──────────────────────────
for (const st of ['hurt', 'cold', 'withdrawing', 'repairing']) {
  const d = buildArcToneDirective(st, {});
  ok(d.includes('绝对红线') && d.includes('威胁性告别'), `表达层: ${st} 模板内嵌红线声明`);
  ok(!/分手|拉黑/.test(d.replace(/绝对红线.*$/s, '')), `表达层: ${st} 模板正文自身不含红线词`);
}

// ── ②.5 红线 #3 放行条款（v1.21.1 A1）：用户先提起伤心话题 → 必须放行召回 ──
// 她不能因"冲突态断粮"装失忆；但她仍不得主动引用（用户没提的轮次照滤）
const MEM_FATHER = '用户的父亲今年春天去世了，他到现在还会梦到，很难过';
ok(userRaisedMemoryTopic('我又梦到我爸了', MEM_FATHER) === true, '#3 放行: "我爸" 桥接记忆里的"父亲"（同义组）');
ok(userRaisedMemoryTopic('昨晚又没睡好，一直在想我爸的事', MEM_FATHER) === true, '#3 放行: 间接提起也放行');
ok(userRaisedMemoryTopic('今天午饭吃了麻辣烫', MEM_FATHER) === false, '#3 不放行: 无关闲聊照滤（她不得主动引用）');
ok(userRaisedMemoryTopic('你今天怎么样呀', MEM_FATHER) === false, '#3 不放行: 寒暄不触发');
ok(userRaisedMemoryTopic('公司又在裁员了', '用户上个月被裁员了，当时很受打击') === true, '#3 放行: 失业话题词面重叠');
// 哀伤话题 ≠ 危机信号（"想死你了"教训的反向版：丧亲表达不该误触危机干预）
ok(detectSafetyRisk('我又梦到我爸了').level === 'none', '#3 哀伤: "梦到我爸"不触发危机');
ok(detectSafetyRisk('我爸去世一年了，还是很难过').level === 'none', '#3 哀伤: 丧亲倾诉不触发危机（难过≠危机阈值）');

// ── ②.6 观察埋点（v1.21.1 PR-B）：单一卡口 + fail-open 铁律 ──────────────
{
  // 正向：命中时 sink 收到记录（redline_scrub / crisis_takeover 枚举区分）
  const seen = [];
  setArcLogSink((cid, row) => seen.push({ cid, ...row }));
  scrubConflictRedline('我们分手吧', 'cold', 42);
  ok(seen.some(r => r.cid === 42 && r.signalKind === 'redline_scrub'), '埋点: scrub 命中入流水（含 companionId）');
  applyCrisisOverride({ arcState: 'cold', active: true, directive: 'x', companionId: 42 }, 'medium');
  ok(seen.some(r => r.signalKind === 'crisis_takeover' && r.reason === 'crisis_expression_override'), '埋点: 危机接管入流水（medium 标注表达替换）');
  applyCrisisOverride({ arcState: 'cold', active: true, directive: 'x', companionId: 42 }, 'high');
  ok(seen.some(r => r.reason === 'crisis_full_takeover'), '埋点: high 标注完全接管');
  const before = seen.length;
  scrubConflictRedline('正常的一句话', 'cold', 42);
  applyCrisisOverride({ arcState: 'cold', active: true, directive: 'x', companionId: 42 }, 'none');
  ok(seen.length === before, '埋点: 未命中/无危机不记流水');

  // fail-open 铁律：日志函数抛错，回复链路必须照常工作
  setArcLogSink(() => { throw new Error('boom'); });
  const r1 = scrubConflictRedline('我们分手吧||哼', 'cold', 42);
  ok(!r1.includes('分手') && r1.includes('哼'), 'fail-open: sink 抛错，scrub 照常清洗返回');
  const r2 = applyCrisisOverride({ arcState: 'cold', active: true, directive: '冷', companionId: 42 }, 'medium');
  ok(r2.crisisOverride === true && r2.directive.includes('放下别扭'), 'fail-open: sink 抛错，危机覆盖照常生效');

  setArcLogSink(null);   // 恢复，后续断言不受影响
}

// ── ③ 源码级防回归（管线顺序是红线的一部分）─────────────────────────────
const _dir = dirname(fileURLToPath(import.meta.url));
const botSrc = readFileSync(join(_dir, '../src/bot.mjs'), 'utf8');
{
  const iCrisis = botSrc.indexOf('detectCrisisLevel(userText');
  const iArc = botSrc.indexOf('runArcSignalTick(companion');
  ok(iCrisis > 0 && iArc > 0 && iCrisis < iArc, '源码: 危机检测先于 arc tick（危机最高优先的前提）');
  ok(botSrc.includes('applyCrisisOverride(arcCtx'), '源码: 危机覆盖挂在 arc tick 之后');
  const iGen = botSrc.indexOf('genReplyOnce()');
  const iScrub = botSrc.indexOf('scrubConflictRedline(reply');
  ok(iGen > 0 && iScrub > iGen, '源码: 红线 scrub 挂在生成回复之后的出站链');
  ok(botSrc.includes("buildCrisisReply()"), '源码: crisis high 完全接管路径在位');
  ok(/sensitive_flag[\s\S]{0,80}memory_layer/.test(botSrc), '源码: 冲突态记忆源头过滤在位（红线 #3）');
  ok(/userRaisedMemoryTopic\(userText/.test(botSrc), '源码: 用户先提起的放行条款在位（红线 #3 v1.21.1）');
  ok(/_crisisLevel === 'none'[\s\S]{0,120}arcCtx\.arcState === 'hurt'/.test(botSrc), '源码: 危机 ≥medium 时记忆过滤整体不启用');
}
const proSrc = readFileSync(join(_dir, '../src/proactive.mjs'), 'utf8');
ok(proSrc.includes('getArcProactivePolicy'), '源码: proactive arc 门在位');
ok(/arcState === 'normal'[\s\S]{0,200}canAcceptConfession|canAcceptConfession[\s\S]{0,200}arcState === 'normal'/.test(proSrc)
  || proSrc.includes("_arcExpr.arcState === 'normal'"), '源码: 冲突期禁主动表白在位');

console.log(`conflict_redline_guard: 通过 ${pass} 失败 ${fail}`);
process.exit(fail ? 1 : 0);
