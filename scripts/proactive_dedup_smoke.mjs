/**
 * 主动消息防复读回归 smoke（纯函数，零 LLM，确定性）。
 *
 * 实测 bug（2026-06-10 test 账号截图）：11:17「好困… 数学课眼皮一直在打架」
 * 12:59「好困… 眼皮在打架了」——语义重复接近 100%，但 char 3-gram Jaccard
 * 只有 ~0.07，原 0.6 阈值完全拦不住"换两个字的同义复读"。
 * 修：findProactiveCollision 双指标 = trigram 0.6（逐字复读）OR
 * isSemanticallySimilar（bigram 0.25 / LCS≥4，语义复读）。
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

// ── 源码级防回归：const 声明 + 同函数 += 的静默 TypeError ─────────────────
// 事故（2026-06-10）：v1.20"事前反复读注入"的 systemPrompt += 撞上 const 声明，
// TypeError 被 tick 的 catch 吃成 error 日志——进程不崩、冒烟不红，活跃用户的
// normal 主动消息静默断供半天（665 次失败）才被发现。这里按**函数块**粗扫
// src/ 全部 .mjs：同一函数内 const X 声明后出现 X += 直接红。
{
  const { readFileSync, readdirSync } = await import('node:fs');
  let hits = 0;
  for (const f of readdirSync('src').filter(x => x.endsWith('.mjs'))) {
    const src = readFileSync(`src/${f}`, 'utf8');
    // 以顶层 function/=> 函数体为粗块：用缩进近似——退而求其次按"两个声明间距 ≤ 函数平均长度"
    // 的简单可靠版本：逐行扫描，遇 const X = 记录；同名 X += 在其后 300 行内且中间没有
    // 重新 let/var/const 声明同名 → 视为命中（300 行覆盖本仓最长函数，误报由白名单排）
    const lines = src.split('\n');
    const lastConst = new Map();
    lines.forEach((l, i) => {
      let m = l.match(/^\s*const\s+(\w+)\s*=[^=]/);
      if (m) lastConst.set(m[1], i);
      m = l.match(/^\s*(?:let|var)\s+(\w+)\s*=?/);
      if (m) lastConst.delete(m[1]);
      m = l.match(/^\s*(\w+)\s*\+=/);
      if (m && lastConst.has(m[1]) && i - lastConst.get(m[1]) <= 300) {
        hits++;
        console.log(`  ✗ src/${f}:${i + 1} '${m[1]}' += 但最近声明是 const（:${lastConst.get(m[1]) + 1}）——静默 TypeError 风险`);
      }
    });
  }
  ok(hits === 0, '全 src 无 "const 声明 + 同名 +=" 病灶（systemPrompt 事故防回归）');
}

console.log(`proactive_dedup_smoke: 通过 ${pass} 失败 ${fail}`);
process.exit(fail ? 1 : 0);
