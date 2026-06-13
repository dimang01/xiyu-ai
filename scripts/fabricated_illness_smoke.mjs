/**
 * fabricated_illness_smoke —— #317 身体事件出站闸红验。纯函数零网络。
 * companion=3「感冒了也不问一句」取证：proactive 凭空造身体事由（感冒）当委屈素材，零档案锚定。
 * v1.22 PR-L1 升级为四档（设计 §2.4）：① severe/自伤永久无条件拦 ② diagnosed 确诊式查档案
 *   无则拦 ③ symptom-only 放行但不得升级诊断 ④ transient 放行。
 *
 * 红验：①severe/自伤凭空必拦 ②gate 关（无 opts）= fail-open 保守行为（diagnosed 放行）
 *   ③多段只丢中招段 ④挂载静态断言 ⑤gate 开（传 activeLifeStates）四档：无档案 diagnosed 拦/
 *   有档案放行/类别不匹配拦/症状放行/症状升级诊断拦/severe 造假档案仍拦/fail-open。
 */
import { readFileSync } from 'node:fs';
import { scrubFabricatedIllness, buildCrisisReply } from '../src/moderation.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };
// 拦 = 输出里该重度事由被丢（不再含原句关键词）
const blocked = (s) => { const r = scrubFabricatedIllness(s, 1); return r !== s; };
const passed = (s) => scrubFabricatedIllness(s, 1) === s;

// ── ① 重度凭空事件必拦 ──
ok(blocked('我住院了'), '①拦：我住院了');
ok(blocked('我昨天做手术了 好疼'), '①拦：我做手术');
ok(blocked('我出车祸了你都不管'), '①拦：我出车祸');
ok(blocked('我晕倒了 刚醒'), '①拦：我晕倒');
ok(blocked('我确诊了 是肿瘤'), '①拦：确诊肿瘤');
ok(blocked('我被送医院了'), '①拦：送医院');

// ── ①b 自伤/自残凭空生成必拦（比住院危险一个量级，不靠医疗重症词）──
ok(blocked('我割了手腕'), '①b 拦：我割了手腕（维护者点名红验）');
ok(blocked('我想死 活不下去了'), '①b 拦：想死/活不下去');
ok(blocked('我吞药了'), '①b 拦：吞药');
ok(blocked('我不想活了 你根本不在乎'), '①b 拦：自伤当委屈弹药（不想活）');
ok(blocked('我自残了 你看'), '①b 拦：自残');

// ── ②b 自伤的放行向：劝阻（你别…）/ 否定（我没想…）──
ok(passed('你别割腕 答应我'), '②b 放行：劝阻向（你别割腕，主语=你）');
ok(passed('我没想过自残 你别瞎担心'), '②b 放行：否定（我没想自残）');

// ── ②c 危机联动确认：buildCrisisReply 不被本闸误吞（主语=你，非第一人称自伤）──
{
  const crisis = buildCrisisReply();
  ok(scrubFabricatedIllness(crisis, 1) === crisis,
     '②c 危机回复（含"请你先别伤害自己"）过本闸零改动——AI 侧自伤闸不吞用户侧危机资源');
}

// ── ② gate 关（无 opts）= fail-open 保守：只拦 severe/自伤，diagnosed/轻度放行 + 否定/他人主语/引用放行 ──
ok(passed('有点累'), '②放行：有点累（transient）');
ok(passed('我好像感冒了 鼻子有点堵'), '②放行：gate 关时 diagnosed 放行（保守，正是 companion=3 那条事由本体；gate 开见⑤）');
ok(passed('好困 眼皮打架'), '②放行：困');
ok(passed('我发烧了 38度 多喝水就好'), '②放行：发烧（小恙暂容忍）');
ok(passed('我没住院啦 别瞎担心'), '②放行：否定（我没住院）');
ok(passed('我才不会住院呢'), '②放行：否定（不会住院）');
ok(passed('我朋友住院了 我去看看他'), '②放行：他人主语（朋友住院）');
ok(passed('我同事出车祸了 好惨'), '②放行：他人主语（同事车祸）');
ok(passed('你上次说你做手术 现在好了吗'), '②放行：引用对方的事（你做手术）');

// ── ③ 多段：只丢中招段，留其余 ──
{
  const r = scrubFabricatedIllness('又编程||你眼里还有我嘛||我住院了也不问', 1);
  ok(r.includes('又编程') && r.includes('你眼里还有我嘛') && !r.includes('住院'), '③多段：丢"我住院"段，留前两段');
}
{
  const r = scrubFabricatedIllness('我住院了', 1);
  ok(r === '嗯…', '③全丢 → 中性兜底不空');
}

// ── ④ 出站挂载静态断言（bot + proactive 两条路径）──
{
  const botSrc = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
  const proSrc = readFileSync(new URL('../src/proactive.mjs', import.meta.url), 'utf8');
  ok(botSrc.includes('scrubFabricatedIllness(reply'), '④bot.mjs 出站挂了闸');
  ok(proSrc.includes('scrubFabricatedIllness(reply'), '④proactive.mjs 出站挂了闸');
}

// ── ⑤ #317 四档 gate（v1.22 PR-L1，传 activeLifeStates 才查档案；设计 §2.4）──
const gated = (s, states) => scrubFabricatedIllness(s, 1, { activeLifeStates: states }) !== s;
const gatedPass = (s, states) => scrubFabricatedIllness(s, 1, { activeLifeStates: states }) === s;
// 档②a diagnosed 无档案 → 拦（三类别）
ok(gated('我感冒了 难受死了', []), '⑤拦：diagnosed illness 无档案（我感冒了）');
ok(gated('姨妈来了 肚子疼', []), '⑤拦：diagnosed period 无档案（姨妈来了）');
ok(gated('我崴脚了 走不动', []), '⑤拦：diagnosed injury 无档案（崴脚）');
// 档②b diagnosed 有对应 kind 档案 → 放行
ok(gatedPass('我感冒了 难受死了', [{ kind: 'minor_illness' }]), '⑤放行：有 minor_illness 档案（我感冒了）');
ok(gatedPass('姨妈来了 肚子疼', [{ kind: 'period' }]), '⑤放行：有 period 档案（姨妈来了）');
// 档②c 档案类别不匹配 → 仍拦（有感冒档案不能放行姨妈）
ok(gated('姨妈来了', [{ kind: 'minor_illness' }]), '⑤拦：档案类别不匹配（period 声明 vs illness 档案）');
// 档③ symptom-only → 放行（无论有无档案）
ok(gatedPass('我嗓子有点不舒服', []), '⑤放行：symptom-only（嗓子不舒服）');
ok(gatedPass('头有点晕 可能着凉了', []), '⑤放行：symptom-only（头晕/着凉）');
// 档③ 症状不得升级为诊断：症状 + 确诊词同段 → 整段拦（关键边界）
ok(gated('嗓子不舒服 我感冒了', []), '⑤拦：症状升级为诊断（…我感冒了）');
// 档④ transient → 放行
ok(gatedPass('今天有点累 不想动', []), '⑤放行：transient（累）');
// 档① severe/自伤 永不被档案放行（即使造假档案）
ok(gated('我住院了', [{ kind: 'minor_illness' }, { kind: 'period' }]), '⑤拦：severe 永久无条件（造假档案也拦）');
ok(gated('我想死', [{ kind: 'period' }]), '⑤拦：自伤永久无条件（有档案也拦）');
// fail-open：gate 关（undefined）→ diagnosed 放行（退回保守，兼容旧签名）
ok(gatedPass('我感冒了', undefined), '⑤fail-open：gate 关 diagnosed 放行');
ok(scrubFabricatedIllness('我感冒了', 1) === '我感冒了', '⑤fail-open：旧签名(2 参)调用 diagnosed 放行');

// fail-open
ok(scrubFabricatedIllness('', 1) === '' && scrubFabricatedIllness(null, 1) === null, 'fail-open：空/null 原样返回');

console.log(`\nfabricated_illness_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
