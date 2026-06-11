/**
 * 入站去重 smoke（#279，临时 DB 真函数 + 纯函数，零 LLM）。
 *
 * 双向红色验证（任务书要求两个方向都有断言）：
 *   ① 回放取证案例必须被拦——
 *      窗口2 形态（单条轮）：history 尾部含当前条 → strip 后 LLM 上下文不重复
 *      窗口1 形态（coalesce 合并轮）：history 尾部两条原始消息 + userText 合并体 → 全剔
 *      修复前形态复现：不 strip 直接拼 messages → 断言重复**存在**（证明 bug 真实）
 *   ② "故意连发两条相同消息"必须放行——
 *      strip：两条同句都在本轮 parts → history 剔 2 条但 userText 含 2 条，无丢失
 *      协议查重：wx_create_time 不同 → 不算重推，两条都落库都回复
 *
 * 另：协议重推拦截（同 sender+内容+同 wx_create_time）/ 退化短窗 / fail-open。
 */
process.env.DB_PATH = '/tmp/inbound_dedup_smoke.db';
import { unlinkSync, readFileSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

const { stripCurrentTurnFromHistory, isProtocolDuplicate } = await import('../src/inbound_dedup.mjs');
const { saveMessage, findRecentInboundCandidate, getDb } = await import('../src/db.mjs');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const row = (direction, content, msAgo) => ({ direction, content, created_at: iso(msAgo) });

// 模拟 generateReply 的 messages 拼装（与 ai.mjs 同逻辑），数"用户句"出现次数
function countInLlmContext(history, userMessage, sentence) {
  const msgs = history.filter(h => h.content && h.content !== '[图片]' && h.content !== '[语音]')
    .map(h => ({ role: h.direction === 'in' ? 'user' : 'assistant', content: h.content }));
  msgs.push({ role: 'user', content: userMessage });
  return msgs.filter(m => m.role === 'user').reduce((n, m) => n + (m.content.split(sentence).length - 1), 0);
}

// ── 红色验证 ①a：修复前形态复现（不 strip → 重复必须存在） ────────────────
const S = '我已经睡醒起来上班了';
const histSingle = [row('in', '早上好', 600_000), row('out', '早呀', 590_000), row('in', S, 20_000)];
ok(countInLlmContext(histSingle, S, S) === 2, '修复前复现：单条轮同句进上下文 2 次（bug 实锤）');

// 窗口1 合并轮形态：两条原始消息 + userText 合并体
const A = '早安呀', B = '今天有点冷';
const histBurst = [row('out', '晚安', 900_000), row('in', A, 25_000), row('in', B, 15_000)];
const merged = `${A}\n${B}`;
ok(countInLlmContext(histBurst, merged, A) === 2 && countInLlmContext(histBurst, merged, B) === 2,
   '修复前复现：合并轮每条 part 各进上下文 2 次（"复读机"形态）');

// ── 红色验证 ①b：修复后两个取证形态都不重复 ──────────────────────────────
const s1 = stripCurrentTurnFromHistory(histSingle, [S], { nowMs: NOW });
ok(countInLlmContext(s1, S, S) === 1, '窗口2 回放：strip 后单条轮同句只出现 1 次');
ok(s1.length === 2 && s1[0].content === '早上好', 'strip 只剔当前条，更早历史原样保留');

const s2 = stripCurrentTurnFromHistory(histBurst, [A, B], { nowMs: NOW });
ok(countInLlmContext(s2, merged, A) === 1 && countInLlmContext(s2, merged, B) === 1,
   '窗口1 回放：strip 后合并轮每条 part 只出现 1 次');

// ── 红色验证 ②：故意连发两条相同消息必须放行 ──────────────────────────────
// strip 方向：用户连发两句"在吗"，coalesce 成一轮 → history 剔 2、userText 含 2，语义无丢失
const histDouble = [row('out', '嗯嗯', 300_000), row('in', '在吗', 12_000), row('in', '在吗', 8_000)];
const sd = stripCurrentTurnFromHistory(histDouble, ['在吗', '在吗'], { nowMs: NOW });
ok(sd.length === 1 && countInLlmContext(sd, '在吗\n在吗', '在吗') === 2,
   '故意连发同句：history 两条都剔（属于本轮），userText 合并体保留 2 句——不吞不重');
// 只剔本轮：历史上昨天也说过"在吗"，不能被误删
const histOld = [row('in', '在吗', 86_400_000), row('out', '在呀', 86_399_000), row('in', '在吗', 9_000)];
const so = stripCurrentTurnFromHistory(histOld, ['在吗'], { nowMs: NOW });
ok(so.length === 2 && so[0].created_at === iso(86_400_000), '昨天的同句历史不被误删（出站行阻断+只销一次）');

// 时间窗保护：尾部 in 行太旧（>10min）不算本轮
const histStale = [row('in', S, 11 * 60_000)];
ok(stripCurrentTurnFromHistory(histStale, [S], { nowMs: NOW }).length === 1, '超过 10 分钟窗的尾部同句不剔（不属于本轮）');

// 协议查重方向：wx_create_time 不同 = 两条真实消息，放行
ok(!isProtocolDuplicate({ wx_create_time: '1780000001', created_at: iso(5000) }, { wxCreateTime: '1780000007' }, { nowMs: NOW }),
   '故意重发（wx_create_time 不同）→ 放行');

// ── 协议重推拦截（纵深主路径） ────────────────────────────────────────────
ok(isProtocolDuplicate({ wx_create_time: '1780000001', created_at: iso(5000) }, { wxCreateTime: '1780000001' }, { nowMs: NOW }),
   '协议重推（同 wx_create_time）→ 拦截');
ok(!isProtocolDuplicate(null, { wxCreateTime: '1780000001' }), '库内无候选 → 放行');
ok(!isProtocolDuplicate({ wx_create_time: null, created_at: iso(5000) }, { wxCreateTime: '1780000001' }, { nowMs: NOW }),
   '只有一边有时间戳 → 判不了，放行（宁放勿吞）');
// 退化短窗：双方都无 create_time
ok(isProtocolDuplicate({ wx_create_time: null, created_at: iso(30_000) }, { wxCreateTime: null }, { nowMs: NOW }),
   '退化路径：双方无时间戳 + 30s 内同句 → 拦');
ok(!isProtocolDuplicate({ wx_create_time: null, created_at: iso(90_000) }, { wxCreateTime: null }, { nowMs: NOW }),
   '退化路径：90s 外 → 放行');

// ── db 层：wx_create_time 落库 + 候选查询 + fail-open ────────────────────
getDb().pragma('foreign_keys = OFF');
saveMessage({ msgId: 'm1', fromUser: 'u1', toUser: 'b1', msgType: 'text', content: '在吗', direction: 'in', wxCreateTime: '1780000001' });
const cand = findRecentInboundCandidate('u1', 'b1', '在吗');
ok(cand && String(cand.wx_create_time) === '1780000001', 'wx_create_time 落库且候选查询取回');
ok(findRecentInboundCandidate('u1', 'b1', '不存在的内容') === null, '无匹配返回 null');
ok(findRecentInboundCandidate(null, undefined, null) === null, '坏参数 fail-open 返回 null（不拦不炸）');
// 出站消息不当候选
saveMessage({ msgId: 'm2', fromUser: 'b1', toUser: 'u1', msgType: 'text', content: '你好呀', direction: 'out' });
ok(findRecentInboundCandidate('b1', 'u1', '你好呀') === null, '出站消息不进重推候选');

// ── 挂载静态断言 ──────────────────────────────────────────────────────────
const bot = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
ok(bot.includes('stripCurrentTurnFromHistory(') && bot.includes('userParts || [userText]'),
   'bot.mjs 主回复链已挂 strip（含合并轮 parts）');
ok(bot.includes('isProtocolDuplicate(') && bot.includes("log('error', `[InboundDedup]"),
   'bot.mjs 接收段已挂协议查重且命中走 [ERROR]（进 digest 签名段）');
ok(bot.includes('wxCreateTime: msg.createTime'), 'saveMessage 已传微信侧 create_time');

console.log(`\ninbound_dedup_smoke: ${pass} passed, ${fail} failed`);
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
process.exit(fail ? 1 : 0);
