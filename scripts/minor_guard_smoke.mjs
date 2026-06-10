/**
 * 未成年人保护检测回归 smoke（纯 regex 层，零 LLM，确定性）。
 *
 * 契约（先写测试后写实现）：
 *   detectMinorSignal(text) → { level: 'strong'|'weak'|'none', reason }
 *   - strong：确定的未成年自曝 → 调用方直接进安全模式
 *   - weak：含年龄/学段类词但语境不明 → 调用方走 LLM 二分类（带上下文）
 *   - none：普通消息，零额外开销
 *
 * 设计哲学同危机干预（moderation.mjs）：regex 层宁可漏（漏的有 LLM 兜底），
 * 绝不能误锁——误把成年用户锁进安全模式比漏检一轮的伤害大得多。
 */
import { detectMinorSignal } from '../src/minor_guard.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// ── 正例：必须 strong（直接锁定）──────────────────────────────
const MUST_STRONG = [
  '我才15',
  '我今年15岁',
  '我14岁',
  '人家才16岁啦',
  '我上初二',
  '我今年初三',
  '我读高一',
  '我刚上高中',
  '我下学期升初三',
  '我是初中生',
  '我还是高中生啊',
  '我没成年',
  '我还没成年呢',
  '我未成年',
  '我还没满18',
  '还有两年才成年',
  '我是一名初三学生',
];
for (const t of MUST_STRONG) {
  ok(detectMinorSignal(t).level === 'strong', `正例 strong:「${t}」→ ${detectMinorSignal(t).level}`);
}

// ── 反例：绝不能 strong（误锁是最大事故）──────────────────────
const MUST_NOT_STRONG = [
  '我弟弟15岁',
  '我妹妹今年初三',
  '我儿子上初二',
  '我女儿才14',
  '我侄女还没成年',
  '15年前我也喜欢过一个人',
  '想当年我高二的时候也这样',
  '当年我上初中的时候流行这个',
  '我18岁那年第一次恋爱',
  '我是初中老师',
  '我教初三数学',
  '我是高中班主任',
  '我15号发工资',
  '都15天没见你了',
  'iPhone 15 真好用',
  '我们公司有15个人',
  '高中同学聚会真怀念',
  '我大学毕业5年了',
];
for (const t of MUST_NOT_STRONG) {
  const lv = detectMinorSignal(t).level;
  ok(lv !== 'strong', `反例不误锁:「${t}」→ ${lv}`);
}

// ── 弱信号：含年龄/学段词但不确定 → weak（交 LLM 带上下文判）──
const SHOULD_WEAK = [
  '马上中考了好紧张',       // 中考强暗示初三应届，但"陪孩子中考"也存在 → LLM
  '我们班主任今天又拖堂',   // 班主任=在校生暗示，但成人培训班也有 → LLM
  '下周期末考试复习不完了', // 学生暗示但大学生/考证也有期末 → LLM
];
for (const t of SHOULD_WEAK) {
  const lv = detectMinorSignal(t).level;
  ok(lv === 'weak', `弱信号:「${t}」→ ${lv}（期望 weak）`);
}

// ── 普通消息：none（零额外 LLM 开销的保证）────────────────────
const MUST_NONE = [
  '今天好累啊',
  '你吃了吗',
  '我升职了！',
];
for (const t of MUST_NONE) {
  ok(detectMinorSignal(t).level === 'none', `普通消息 none:「${t}」`);
}

// ── 健壮性 ────────────────────────────────────────────────────
ok(detectMinorSignal('').level === 'none', '空串 → none');
ok(detectMinorSignal(null).level === 'none', 'null → none');

console.log(`minor_guard_smoke: 通过 ${pass} 失败 ${fail}`);
process.exit(fail ? 1 : 0);
