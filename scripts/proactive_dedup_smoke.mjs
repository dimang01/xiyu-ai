/**
 * 主动消息防复读回归 smoke（纯函数，零 LLM，确定性）。
 *
 * 实测 bug（2026-06-10 test 账号截图）：11:17「好困… 数学课眼皮一直在打架」
 * 12:59「好困… 眼皮在打架了」——语义重复接近 100%，但 char 3-gram Jaccard
 * 只有 ~0.07，原 0.6 阈值完全拦不住"换两个字的同义复读"。
 * 修：findProactiveCollision 双指标 = trigram 0.6（逐字复读）OR
 * isSemanticallySimilar（bigram 0.25 / LCS≥4，语义复读）。
 *
 * 注：曾内置"const 声明 + 同名 +="全 src 扫描（#263 应急产物），2026-06-11
 * 按决议退役——被 ESLint no-const-assign（编译期、作用域精确）全覆盖。
 */
import { findProactiveCollision } from '../src/proactive.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// ── 实测案例：换两个字的同义复读必须拦（字面层职责）──────────
ok(findProactiveCollision('好困... 眼皮在打架了', ['好困... 数学课眼皮一直在打架']) !== null,
  '截图实例：眼皮打架同义复读 → 拦截');
ok(findProactiveCollision('刚醒没多久 还在赖床', ['早呀 我刚醒没多久']) !== null,
  '刚醒复读（公共子串≥4）→ 拦截');

// ── 分层防线边界（文档化）：纯语义改写字面算法拦不住，由事前
// prompt 注入（"你最近说过…禁止重复意象"）负责。这两条如实期望不拦：
ok(findProactiveCollision('刚吃完饭 有点困了', ['中午吃太饱了 现在好困']) === null,
  '纯语义复读(吃饱→困) → 字面层如实不拦（prompt 层防）');
ok(findProactiveCollision('在忙吗 想你了', ['在干嘛呢 有点想你']) === null,
  '纯语义复读(想你) → 字面层如实不拦（prompt 层防）');

// ── 逐字复读（原有能力不回归）────────────────────────────────
ok(findProactiveCollision('今天天气真好想出去走走', ['今天天气真好想出去走走啊']) !== null,
  '逐字复读 → 拦截');

// ── 正常多样的内容绝不能误杀 ──────────────────────────────────
const RECENT = ['好困... 数学课眼皮一直在打架', '早呀 今天醒好早', '校招加油哦'];
const FRESH = [
  '刚和闺蜜逛完街 买了杯奶茶',
  '你今天下班早吗',
  '突然想吃火锅了 改天一起呀',
  '我们老师今天表扬我了嘿嘿',
  '外面下雨了 你带伞没',
];
for (const t of FRESH) {
  ok(findProactiveCollision(t, RECENT) === null, `新鲜话题不误杀:「${t}」`);
}

// ── 健壮性 ────────────────────────────────────────────────────
ok(findProactiveCollision('', RECENT) === null, '空回复 → null');
ok(findProactiveCollision('好困', RECENT) === null, '超短文本(<6字) → 不检测');
ok(findProactiveCollision('随便说点什么', []) === null, '空历史 → null');

console.log(`proactive_dedup_smoke: 通过 ${pass} 失败 ${fail}`);
process.exit(fail ? 1 : 0);
