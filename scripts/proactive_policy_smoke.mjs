/**
 * proactive_policy_smoke —— proactive 主动行为调度层红验（PR-2，2026-06-14·降噪+矜持化）。
 *
 * 覆盖两条生死线 + 四档实现 + 反勒索红线：
 *  ① 早安豁免静默闸(续命器零误伤)·但不清零 ② 矜持≠冷淡(语气兜底不写拒绝)
 *  静默闸/想你三档 drop/photo 48h≤1 不连发/不勒索反验=0。
 */
import {
  classifyProactive, isSilenceExemptType, isSilenceExemptKind, silenceSuppress, SILENCE_LIMIT,
  missYouVerdict, photoPushAllowed, hasRealContext, buildReservedToneHint, PHOTO_PUSH_MIN_HOURS,
} from '../src/proactive_policy.mjs';
import { shouldBackoffProactive } from '../src/proactive_engine.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };
const agoSql = (h) => new Date(Date.now() - h * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

// ── 7 类分类 ──
ok(classifyProactive({ kind: 'morning' }) === 'morning_anchor', '分类 morning→morning_anchor');
ok(classifyProactive({ kind: 'goodnight' }) === 'goodnight', '分类 goodnight');
ok(classifyProactive({ kind: 'photo' }) === 'photo_push', '分类 photo→photo_push');
ok(classifyProactive({ kind: 'normal', isPhoto: true }) === 'photo_push', '分类 normal+isPhoto→photo_push');
ok(classifyProactive({ kind: 'reminder' }) === 'open_loop_followup', '分类 reminder→open_loop_followup');
ok(classifyProactive({ kind: 'normal', openLoopActive: true }) === 'open_loop_followup', '分类 normal+openLoop→open_loop_followup');
ok(classifyProactive({ kind: 'normal', content: '突然好想你呀', realContext: false }) === 'generic_miss_you', '分类 想你无上下文→generic_miss_you');
ok(classifyProactive({ kind: 'normal', content: '突然好想你', realContext: true }) === 'contextual_care', '分类 想你有上下文→contextual_care');
ok(classifyProactive({ kind: 'normal', content: '你今天面试别太赶', realContext: true }) === 'contextual_care', '分类 具体牵挂→contextual_care');
ok(classifyProactive({ kind: 'normal', content: '刚泡了杯茶发会呆' }) === 'random_life_share', '分类 随机碎片→random_life_share');

// ── 静默闸豁免 ──
ok(isSilenceExemptType('morning_anchor') && isSilenceExemptType('open_loop_followup'), '豁免类型：morning_anchor/open_loop_followup');
ok(!isSilenceExemptType('generic_miss_you') && !isSilenceExemptType('random_life_share'), '非豁免：generic_miss_you/random_life_share');
ok(isSilenceExemptKind('morning') && isSilenceExemptKind('reminder') && isSilenceExemptKind('confession'), '豁免 kind：morning/reminder/confession');
ok(!isSilenceExemptKind('normal') && !isSilenceExemptKind('goodnight') && !isSilenceExemptKind('photo'), '非豁免 kind：normal/goodnight/photo');

// ── 静默闸：连续 N 非豁免没回→拦 ──
ok(SILENCE_LIMIT === 2, 'SILENCE_LIMIT 默认 2(连2没回拦第3)');
ok(silenceSuppress({ type: 'random_life_share', unansweredNonExempt: 1 }).suppress === false, '非豁免连发1没回→不拦');
ok(silenceSuppress({ type: 'random_life_share', unansweredNonExempt: 2 }).suppress === true, '非豁免连发2没回→拦第3(进静默)');
ok(silenceSuppress({ type: 'morning_anchor', unansweredNonExempt: 9 }).suppress === false, '★生死线①：早安永不被静默拦(豁免)');
ok(silenceSuppress({ type: 'open_loop_followup', unansweredNonExempt: 9 }).suppress === false, '牵挂接住永不被静默拦');

// ── ★ 生死线① 集成红验：shouldBackoffProactive 早安豁免静默闸但 normal 被拦 ──
const c = { proactive_intensity: 'normal', attachment_style: 'secure', proactive_unanswered: 3, last_proactive_reply_at: agoSql(5), last_user_reply_at: agoSql(24) };
ok(shouldBackoffProactive(c, { kind: 'normal' }) === true, 'normal + unanswered≥2 → 静默拦(治对空气)');
ok(shouldBackoffProactive(c, { kind: 'morning' }) === false, '★早安豁免静默闸：昨天没回·今天早安【仍发】(续命器)');
ok(shouldBackoffProactive(c, { kind: 'reminder' }) === false, 'reminder 豁免静默闸');
// 早安仍受依恋风格长期退场(>72h 没回·保持现状不扩张)
const cold = { ...c, last_user_reply_at: agoSql(96) };
ok(shouldBackoffProactive(cold, { kind: 'morning' }) === true, '早安仍受依恋风格长期退场(secure >72h·现状保留·非无脑永远发)');

// ── 想你三档 ──
ok(missYouVerdict({ content: '突然好想你呀', realContext: false }) === 'drop', '想你无上下文→drop(不强行改写)');
ok(missYouVerdict({ content: '好想你', realContext: true }) === 'rewrite', '想你+弱上下文→rewrite(改具体牵挂)');
ok(missYouVerdict({ content: '想你呀宝贝', openLoopActive: true }) === 'keep_light', '想你+open_loop/亲密→keep_light(轻量带一句)');
ok(missYouVerdict({ content: '刚路过那家奶茶店', realContext: false }) === 'pass', '非想你→pass(不归本闸)');

// ── photo 限频(矜持化) ──
ok(photoPushAllowed({ hoursSinceLastProactivePhoto: 20, affection: 35 }).allowed === false, '暗恋期 48h 内已 push→deny');
ok(photoPushAllowed({ hoursSinceLastProactivePhoto: 60, affection: 35 }).allowed === true, '暗恋期 ≥48h→allow');
ok(photoPushAllowed({ hoursSinceLastProactivePhoto: 60, lastProactiveWasPhoto: true, affection: 35 }).allowed === false, '不连续两次 proactive 都 photo');
ok(photoPushAllowed({ hoursSinceLastProactivePhoto: 20, affection: 35, isUserRequested: true }).allowed === true, '用户请求→永远正常给(不计入限)');
ok(photoPushAllowed({ hoursSinceLastProactivePhoto: 20, affection: 70 }).allowed === true, '关系够熟(affection≥55)→走原节流不强限');
ok(photoPushAllowed({ hoursSinceLastProactivePhoto: null, affection: 35 }).allowed === true, '暗恋期从未 push 过→allow 第一张');
ok(PHOTO_PUSH_MIN_HOURS === 48, 'PHOTO_PUSH_MIN_HOURS 默认 48');

// ── 真实牵挂判定 ──
ok(hasRealContext({ recentUserText: '我明天有个面试好紧张' }) === true, '现实事项(面试)→真牵挂');
ok(hasRealContext({ recentUserText: '我周末去露营' }) === true, '现实事项(露营)→真牵挂');
ok(hasRealContext({ recentUserText: '哈哈嗯嗯' }) === false, '纯闲聊→非真牵挂');
ok(hasRealContext({ recentUserText: '', openLoopActive: true }) === true, 'open_loop active→真牵挂');

// ── 矜持≠冷淡 + 不勒索红线 ──
const tone = buildReservedToneHint();
ok(/矜持/.test(tone) && /接住|记得|在乎/.test(tone), '语气兜底=矜持但仍接住/记得/在乎(矜持≠冷淡)');
ok(!/你怎么不理我|等了你?好久|你都不回我|我等了/.test(tone), '★不勒索：兜底串绝无愧疚勒索话术');
ok(/别.*我们还不熟|✅|❌/.test(tone), '兜底串带正反例(✅可接受/❌冷淡拒绝)');
ok(!/用户/.test(tone), '过 user_wording_guard：兜底串不含"用户"');

console.log(`\nproactive_policy_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
