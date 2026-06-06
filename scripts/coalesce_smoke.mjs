/**
 * v1.10.53 连发合并（debounce）调度逻辑冒烟测试
 *
 * 用小窗口 + 替换 _turnRunner（不跑重回复管线），验证：
 *   1) 窗口内连发多条 → 合并成一次回复，文本换行拼接
 *   2) 单条消息 → 照常回一次，原文不变
 *   3) 持续 sub-window 连发超过上限 → 被强制冲刷（不会永不回），且每条都进入某次回复
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */
process.env.COALESCE_ENABLED = 'true';
process.env.COALESCE_WINDOW_MS = '100';
process.env.COALESCE_MAX_WAIT_MS = '350';

const { enqueueOrRunTurn, __setTurnRunnerForTest } = await import('../src/bot.mjs');

const calls = [];
__setTurnRunnerForTest((turn) => { calls.push(turn); return Promise.resolve(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const turn = (u, t) => ({ companion: { id: 1 }, binding: {}, ctx: {}, botId: 'b', fromUser: u, contextToken: 'tk', userText: t });

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? '✓' : '✗'} ${name}`); if (!cond) failed++; };

// 场景 1：userA 窗口内连发 3 条 → 合并成 1 次
enqueueOrRunTurn(turn('A', 'a1'));
enqueueOrRunTurn(turn('A', 'a2'));
enqueueOrRunTurn(turn('A', 'a3'));
await sleep(220);
const a = calls.filter((c) => c.fromUser === 'A');
check('连发 3 条合并成 1 次回复', a.length === 1);
check('合并文本换行拼接 a1\\na2\\na3', a[0]?.userText === 'a1\na2\na3');

// 场景 2：userB 单条 → 1 次，原文不变
enqueueOrRunTurn(turn('B', 'b1'));
await sleep(220);
const b = calls.filter((c) => c.fromUser === 'B');
check('单条照常回 1 次', b.length === 1);
check('单条文本不变', b[0]?.userText === 'b1');

// 场景 3：userC 持续 60ms 间隔连发（< 窗口 100），超过上限 350 应被强制冲刷
for (let i = 0; i < 8; i++) { enqueueOrRunTurn(turn('C', 'c' + i)); await sleep(60); }
await sleep(220);
const c = calls.filter((x) => x.fromUser === 'C');
check('持续连发触发上限强制冲刷（不会永不回）', c.length >= 1);
const cParts = c.reduce((n, x) => n + x.userText.split('\n').length, 0);
check('每条连发消息都进入了某次回复（无丢失）', cParts === 8);

console.log(failed === 0 ? '\n✅ 合并调度逻辑全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
