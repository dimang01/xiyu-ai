/**
 * first_turn_smoke.mjs — v1.16.x 首轮破冰护栏
 * buildFirstTurnHint 是注入首次回复的破冰指令(onboarding 留人)。
 * 校验:含破冰标记/角色名/话题钩子/人设调制/守边界，且对空输入健壮。
 * 跑：node scripts/first_turn_smoke.mjs
 */
import { buildFirstTurnHint } from '../src/companion.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.error('✗ FAIL:', name); } };

const h = buildFirstTurnHint({ name: '溪语' });
check('含"第一次聊天·破冰"标记', h.includes('第一次聊天') && h.includes('破冰'));
check('带出角色名',              h.includes('溪语'));
check('给好接的话题钩子',         h.includes('怎么找到') || h.includes('叫什么') || h.includes('今天过得'));
check('留"还想再聊"的尾巴',       h.includes('还想再聊') || h.includes('想多聊'));
check('按人设调制(高冷别硬热情)', h.includes('高冷') && h.includes('人设'));
check('开黄腔→先守边界再引正',     h.includes('守住边界') && h.includes('引正'));
check('空 companion 不崩',        typeof buildFirstTurnHint({}) === 'string' && buildFirstTurnHint(null).length > 0);

console.log(`\nfirst_turn_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
