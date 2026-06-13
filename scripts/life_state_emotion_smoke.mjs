/**
 * life_state_emotion_smoke —— v1.22 PR-L3 情绪路由 + PMS shadow 红验。纯函数零网络零真 DB。
 * 设计 docs/LIFE_STATE_DESIGN.md §3.3/§4 + §附录L3（两轮评审合并八条）。
 * 覆盖：① bodyLowEnergy 两层模板 + arc 让位（红线A）② PMS patTone 不写回主状态（批注①）
 *   ③ shadow 分方向 + 红线B（off 不改判）④ 红线C（无 regex 不改判）⑤ 合成上限（绝不取和/不到 cold）
 *   ⑥ 愧疚扩词（红线③）⑦ 静态断言（A/B/合成上限/safe_mode 双保险）。
 */
import { readFileSync } from 'node:fs';
import { buildEmotionPromptHint } from '../src/emotion_state.mjs';
import { tickArcOnSignal, composeArcSignal } from '../src/relationship_arc.mjs';
import { scrubConflictRedline } from '../src/moderation.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

// ── ① bodyLowEnergy 两层模板 + arc 让位（红线A 严肃度不稀释 / 红线① 无升温）──
{
  const ble = buildEmotionPromptHint({ mood: 'neutral', patience: 60, annoyance: 0 }, { bodyLowEnergy: true });
  ok(/身体低能量|身体不舒服/.test(ble), '①bodyLowEnergy 注入身体向模板');
  ok(/内部归因/.test(ble) && /仅追问/.test(ble), '①两层模板：内部归因 + 仅追问才解释');
  ok(!/懒得理你|你烦死了|不想理你/.test(ble), '①红线A素材：低能量无"指向用户的冷淡"语义');
  ok(!/暧昧|想要你|亲密地|撩|欲望/.test(ble), '①红线①：period 路由无升温/暧昧分支');
  const bleArc = buildEmotionPromptHint({ mood: 'cold', patience: 60 }, { bodyLowEnergy: true, arcActive: true });
  ok(!/身体低能量/.test(bleArc), '①红线A：arcActive 时 bodyLowEnergy 让位（不注入，arc 严肃度不被稀释）');
}

// ── ② PMS patTone 只进语气底色、不写回主状态（批注①）──
{
  const st = { mood: 'neutral', patience: 35, annoyance: 0 };
  const pmsHint = buildEmotionPromptHint(st, { pmsActive: true });   // 35 + (−8) = 27 ≤ 30
  ok(/耐心不够/.test(pmsHint), '②PMS patTone：patience 35−8=27→触发"耐心不够"档');
  ok(st.patience === 35, '②批注①：patTone 绝不写回主状态（emotionState.patience 仍 35）');
  const noPms = buildEmotionPromptHint({ mood: 'neutral', patience: 35, annoyance: 0 }, {});
  ok(!/耐心不够/.test(noPms), '②无 PMS：patience 35>30 不触发"耐心不够"');
}

// ── ③④⑤ PMS shadow / 红线B / 红线C / 合成上限（tickArcOnSignal）──
const tick = (signal, extra = {}) => tickArcOnSignal({
  state: 'normal', style: 'secure', safeMode: false, openEvent: null,
  signal, now: new Date(), rng: () => 0.99, ...extra,   // rng>0.6：secure 不走 voice_concern，确定入 hurt
});
const sig = (o = {}) => ({ kind: 'taboo_hit', severity: 2, perceivedHurt: 2, regexHit: true, ...o });

// 红线B：ENABLED=off → shadow.changed=true 但 arc 不改判（纯观测）
{
  const rB = tick(sig(), { pmsActive: true, pmsArcEnabled: false });
  ok(rB.pmsShadow?.changed === true, '③shadow.changed=true（经前 sev2+perceived2 若开会入 hurt）');
  ok(rB.state === 'normal' && !rB.eventOp, '③红线B：ENABLED=off shadow.changed=true 但 arc_state/event 零改动');
  ok(rB.pmsShadow.direction === 'not_hurt_to_hurt', '③shadow 分方向：not_hurt_to_hurt（刻板化风险类）');
  ok(rB.pmsShadow.deltaCap === 1 && rB.pmsShadow.pmsEff === 3 && rB.pmsShadow.baseEff === 2, '③shadow 记 base/pmsEff/封顶后 changed');
}
// ENABLED=on → 生效建事件
{
  const rOn = tick(sig(), { pmsActive: true, pmsArcEnabled: true });
  ok(rOn.eventOp?.op === 'create' && rOn.state === 'hurt', '④ENABLED=on：PMS 生效→建事件入 hurt');
}
// 红线C：无 regex → PMS 不得改判（"无 regex 不建事件"在 shadow 里也守）
{
  const rC = tick(sig({ regexHit: false, perceivedHurt: 3 }), { pmsActive: true, pmsArcEnabled: true });
  ok(rC.pmsShadow?.changed === false && rC.state === 'normal' && !rC.eventOp, '④红线C：无 regex→PMS 不改判（即便 perceived3）');
}
// 合成上限：anxious+PMS+perceived2→入（一档）；perceived1→不入（绝不二档下移）；封顶不到 cold
{
  const rCap1 = tick(sig({ perceivedHurt: 2 }), { style: 'anxious', pmsActive: true, pmsArcEnabled: true });
  ok(rCap1.eventOp?.op === 'create' && rCap1.state === 'hurt', '⑤合成：anxious+PMS+perceived2→入 hurt（一档下移）');
  ok(rCap1.state !== 'cold', '⑤合成上限：sev2 双 bump 封顶 eff=3（hurt），绝不到 4（cold）');
  const rCap0 = tick(sig({ perceivedHurt: 1 }), { style: 'anxious', pmsActive: true, pmsArcEnabled: true });
  ok(rCap0.state === 'normal' && !rCap0.eventOp, '⑤合成上限：anxious+PMS+perceived1→不入（绝不二档下移到 perceived1）');
}
// composeArcSignal 产出 regexHit（红线C 来源）
{
  const llmOnly = composeArcSignal({ userText: '今天天气不错', inner: { perceived_hurt: 2 } });
  ok(llmOnly && llmOnly.regexHit === false, '④composeArcSignal：LLM-only(无 regex)→regexHit=false');
}

// ── ⑥ 愧疚操控扩词（红线③）──
ok(scrubConflictRedline('我难受还不是因为你', 'cold') !== '我难受还不是因为你', '⑥红线③扩词：我难受还不是因为你→拦');
ok(scrubConflictRedline('你都不知道照顾我', 'cold') !== '你都不知道照顾我', '⑥红线③：你都不知道照顾我→拦');
ok(scrubConflictRedline('你害我不舒服', 'hurt') !== '你害我不舒服', '⑥红线③：你害我不舒服→拦');

// ── ⑦ 静态断言（A/B/合成上限/safe_mode 双保险/情色化走 NSFW 链）──
{
  const emoSrc = readFileSync(new URL('../src/emotion_state.mjs', import.meta.url), 'utf8');
  const arcSrc = readFileSync(new URL('../src/relationship_arc.mjs', import.meta.url), 'utf8');
  const botSrc = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
  ok(/const bodyLowEnergy = !arcActive && !!opts\.bodyLowEnergy/.test(emoSrc), '⑦A静态：bodyLowEnergy 带 !arcActive（arc 激活让位）');
  ok(/pmsArcEnabled \? pmsEff : baseEff/.test(arcSrc), '⑦B静态：ENABLED 决定 eff，off→baseEff（shadow 不改判）');
  ok(/deltaCap: 1/.test(arcSrc), '⑦合成上限 deltaCap=1 钉死');
  ok(/Number\(companion\.safe_mode\) \? '' :/.test(botSrc), '⑦红线②双保险：safe_mode 时 emotionHint 整体为空（L3 情绪路由侧不漏）');
}

console.log(`\nlife_state_emotion_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
