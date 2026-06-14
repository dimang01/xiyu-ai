/**
 * intent_dedup_smoke —— 语义/intent 级复读止血红验（PR-1，2026-06-14）。
 *
 * 红验取自 PR-0 retention_board 实测的真实复读案例 + 三条红线的反向验证：
 *  ① u48 露营那晚序列：remind/ask_plan 第 2 次起被冷却 ② "突然好想你呀" 短时第 2 条被拦
 *  ③ 红线：cross-day 早安【不】被误杀（守住唯一续命器）④ 红线：用户连问两次"你吃了吗"都不被冷却。
 */
import {
  classifyIntent, topicKey, isAck, recentIntentEvents, trailingAckStreak,
  isIntentCooled, buildIntentDedupHint, pickMicroAck, INTENT_COOLDOWN_H,
} from '../src/intent_dedup.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };
const HR = 3600e3;
const ev = (intent, topic, agoH, now) => ({ intent, topic, ts: now - agoH * HR });

// ── intent 分类（真实案例）──
ok(classifyIntent('那你可得带齐东西，帐篷睡袋啥的，别到时候手忙脚乱') === 'remind', '分类 remind(带齐东西)');
ok(classifyIntent('你明天还去露营吗') === 'ask_plan', '分类 ask_plan(还去吗)');
ok(classifyIntent('突然好想你呀') === 'miss_you', '分类 miss_you');
ok(classifyIntent('早呀，刚醒，看到你消息了') === 'morning', '分类 morning');
ok(classifyIntent('嗯，晚安~ 早点睡') === 'goodnight', '分类 goodnight');
ok(classifyIntent('你晚饭吃了什么') === 'food', '分类 food');
ok(classifyIntent('别难过啦，抱抱，辛苦了') === 'comfort', '分类 comfort');
ok(classifyIntent('你这个笨蛋，油嘴滑舌') === 'tease', '分类 tease');
ok(classifyIntent('今天写完一张数学卷') === 'other', '分类 other(无高频意图)');
ok(topicKey('那你可得带齐东西，帐篷睡袋啥的') === '露营', 'topicKey 露营(帐篷睡袋)');

// ── isAck（含疑问=非 ack；去呀/知道了宝贝=ack）──
ok(isAck('去呀') && isAck('知道了宝贝') && isAck('好的') && isAck('嗯嗯') && isAck('OK'), 'ack：去呀/知道了宝贝/好的/嗯嗯/OK');
ok(!isAck('你吃了吗') && !isAck('你明天去哪') && !isAck('为什么呀'), '红线：含疑问的消息一律非 ack(用户在问该答)');
ok(!isAck('我今天点了好多外卖没吃完'), '长内容非 ack');

// ── ① u48 露营序列：第 2 次 remind 被冷却 ──
const now = Date.parse('2026-06-13T15:00:00Z');   // 沪 23:00
const u48events = [
  ev('remind', '露营', 1.5, now),                 // 21:34 第一次"带齐东西"
  ev('miss_you', '', 1.0, now),                   // 21:54 "突然好想你呀"
];
const coolRemind = isIntentCooled({ intent: 'remind', topic: '露营', events: u48events, nowMs: now, ackStreak: 1 });
ok(coolRemind.cooled, '① 露营 remind 6h 内第 2 次 → 冷却(止血)');
const coolMiss = isIntentCooled({ intent: 'miss_you', topic: '', events: u48events, nowMs: now });
ok(coolMiss.cooled, '② miss_you 8h 内第 2 次 → 冷却');

// rule3：连续 ≥2 次 user ack 后停追 ask_plan
const askEv = [ev('ask_plan', '露营', 0.5, now)];
ok(isIntentCooled({ intent: 'ask_plan', topic: '露营', events: askEv, nowMs: now, ackStreak: 2 }).cooled, 'rule3：连续 2 次 ack 后停追同 ask_plan');

// ── ③ 红线：cross-day 早安不被误杀（24h 前的早安 > morning 冷却窗 12h）──
const morningYesterday = [ev('morning', '', 24, now)];
ok(!isIntentCooled({ intent: 'morning', topic: '', events: morningYesterday, nowMs: now }).cooled,
  '③ 红线：cross-day 早安(24h前)放行——守住唯一续命器');
ok(INTENT_COOLDOWN_H.morning < 24, '③ morning 冷却窗 < 24h(结构保证 cross-day 早安永不误杀)');
ok(isIntentCooled({ intent: 'morning', topic: '', events: [ev('morning', '', 2, now)], nowMs: now }).cooled,
  '③ 同日 2h 前的早安仍冷却(同日重复防双早安)');

// ── ④ 红线：用户驱动的重复回答不被冷却(intent=other/无近期事件时放行；且 reply 裁剪靠 isAck 闸)──
ok(!isIntentCooled({ intent: 'food', topic: '吃饭', events: [], nowMs: now }).cooled, '④ 无近期同 intent 事件 → 放行');
ok(!isAck('你吃了吗'), '④ 红线：用户问"你吃了吗"非 ack → reply 裁剪闸不触发(正常答两次)');

// ── 不同 topic 的同 intent 放行(别过度压)──
ok(!isIntentCooled({ intent: 'remind', topic: '天气', events: [ev('remind', '露营', 1, now)], nowMs: now }).cooled,
  '同 remind 但不同 topic(天气 vs 露营) → 放行(别误杀真不同提醒)');

// ── recentIntentEvents：从 created_at turns 抽事件 + 窗口过滤 ──
const turns = [
  { role: 'assistant', content: '那你可得带齐东西，帐篷睡袋啥的', created_at: '2026-06-13 13:30:00' },  // 1.5h 前
  { role: 'user', content: '去呀', created_at: '2026-06-13 13:31:00' },
  { role: 'assistant', content: '突然好想你呀', created_at: '2026-06-13 14:00:00' },                  // 1h 前
];
const evs = recentIntentEvents(turns, now);
ok(evs.length === 2 && evs[0].intent === 'remind' && evs[0].topic === '露营', 'recentIntentEvents 从 created_at 抽 assistant intent');
ok(trailingAckStreak(turns) === 1, 'trailingAckStreak：跳过 bot 自己的尾消息，数到用户那条 ack "去呀" → 1');
ok(trailingAckStreak([{ role: 'user', content: '好' }, { role: 'user', content: '知道了' }]) === 2, 'trailingAckStreak：连续两条 user ack → 2');
ok(trailingAckStreak([{ role: 'assistant', content: 'x' }, { role: 'user', content: '我今天去爬山了好累' }]) === 0, 'trailingAckStreak：末尾 user 是实质内容 → 0(不停追)');

// ── 窗口外不计 ──
ok(recentIntentEvents([{ role: 'assistant', content: '突然好想你', created_at: '2026-06-12 00:00:00' }], now).length === 0,
  '24h 窗口外的旧 turn 不计入事件环');

// ── hint / micro-ack ──
ok(buildIntentDedupHint(u48events, now).includes('remind'), 'buildIntentDedupHint 列出近期 intent');
ok(buildIntentDedupHint([], now) === '', '无近期事件 → 空 hint(不污染 prompt)');
const micro = pickMicroAck('remind', ['嗯嗯，记着啦']);
ok(micro && micro !== '嗯嗯，记着啦', 'pickMicroAck 避开最近用过的极简应答');

console.log(`\nintent_dedup_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
