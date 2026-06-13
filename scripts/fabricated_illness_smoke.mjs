/**
 * fabricated_illness_smoke —— 临时止血闸红验（2026-06-13）。纯函数零网络。
 * companion=3「感冒了也不问一句」取证：proactive 凭空造身体事由（感冒）当委屈素材，
 * 零档案锚定。临时闸拦重度（住院/重伤/重病/急症），轻度（累/困/小恙/感冒/发烧）放行；
 * life_state 档案化（v1.22）落地后升级为「档案没有才拦」。
 *
 * 红验双向：①重度凭空事件必拦（我住院了/做手术/出车祸/确诊癌）②轻度+否定+他人主语+
 *   引用 必放行（有点累/我感冒了/我没住院/我朋友住院）③多段只丢中招段 ④挂载静态断言。
 */
import { readFileSync } from 'node:fs';
import { scrubFabricatedIllness } from '../src/moderation.mjs';

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

// ── ② 轻度 / 否定 / 他人主语 / 引用 必放行 ──
ok(passed('有点累'), '②放行：有点累');
ok(passed('我好像感冒了 鼻子有点堵'), '②放行：感冒（轻度·正是 companion=3 那条事由本体）');
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

// fail-open
ok(scrubFabricatedIllness('', 1) === '' && scrubFabricatedIllness(null, 1) === null, 'fail-open：空/null 原样返回');

console.log(`\nfabricated_illness_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
