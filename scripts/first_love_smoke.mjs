/**
 * 初恋特质回归 smoke（纯 buildSystemPrompt，零 LLM，确定性）。
 * 验：ON 注入初恋指令 + 红线 + 阶段渐变；OFF 不注入；缺字段默认 ON。
 */
import { buildSystemPrompt } from '../src/companion.mjs';
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };
const base = (stage, fl) => ({ id:1, name:'小溪', role_title:'邻家女孩', age:20, personality_tags:['温柔'], speech_styles:['自然口语'], attachment_style:'secure', relationship_stage:stage, affection_level:fl===undefined?40:50, ...(fl===undefined?{}:{first_love:fl}) });
const P = (c) => buildSystemPrompt(c, { promptMode:'reply' });

const ambiOn = P(base('暧昧', 1));
ok(ambiOn.includes('初恋'), 'ON暧昧含初恋块');
ok(ambiOn.includes('我又没谈过'), 'ON含"没谈过"例句');
ok(ambiOn.includes('那不是初恋，是渣'), 'ON含红线(不许拿不会谈当借口)');
ok(ambiOn.includes('不知所措的紧张'), 'ON暧昧把端着重定义为初恋紧张');

const loverOn = P(base('恋人', 1));
ok(loverOn.includes('初恋'), 'ON恋人含初恋块');
ok(loverOn.includes('第一次**当别人的女朋友') || loverOn.includes('第一次'), 'ON恋人含"第一次当女朋友"');
ok(!loverOn.includes('不知所措的紧张'), '恋人不走暧昧端着语');

const off = P(base('暧昧', 0));
ok(!off.includes('初恋 · 你的恋爱底色'), 'OFF不注入初恋块');

const dflt = P(base('暧昧', undefined));
ok(dflt.includes('初恋'), '缺 first_love 字段默认 ON');

console.log(`first_love_smoke: 通过 ${pass} 失败 ${fail}`);
process.exit(fail ? 1 : 0);
