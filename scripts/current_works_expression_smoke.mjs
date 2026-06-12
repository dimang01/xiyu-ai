/**
 * current_works_expression_smoke —— current_works 表达层红色验证（v1.21.4 PR-W2）。
 * 纯函数零真网络零 DB：buildSystemPrompt 是零依赖纯函数，works 表达全是纯逻辑。
 * 设计 docs/V1214_DESIGN.md §8（注入/proactive 供给/冷却）+ §7（存量退场表达规则）。
 *
 * 红验（烧坏版本必须红）：
 *   · 注入排序：arc 主导语气指令永在 works 注入之后（cold 表达不被 works 稀释）
 *     —— 静态钉死 bot.mjs/proactive.mjs：worksHint 走 buildSystemPrompt 参数，
 *        绝不在 `+ arcCtx.directive` 之后再拼（头插/尾插都会让 cold 让位）
 *   · 冷却放行双向：48h 冷却内 pickProactiveWork 不选它（她不主动提）；
 *     但 buildWorksPromptHint 永远把它列上（他问起永放行——对话召回不挂冷却）
 *   · 存量虚构退场：注入段含"以前提过但不在上面 → 看完了，别展开别否认"断言
 *   · generic 不指名（模糊但不虚构）；craft 自由文本
 */
import { readFileSync } from 'node:fs';
import {
  buildWorksPromptHint, worksSceneSeed, pickProactiveWork, workMaterialId,
  buildWorkArchiveMemory, worksConfig,
} from '../src/current_works.mjs';
import { buildSystemPrompt } from '../src/companion.mjs';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

const baseC = { id: 1, name: '溪语', age: 21, relationship_stage: '恋人', affection_level: 70 };
const verifiedBook = { id: 11, kind: 'book', title: '活着', creator: '余华', verify_status: 'verified', progress_note: '看到一半，挺压抑' };
const craftWork = { id: 12, kind: 'craft', title: '给外婆织围巾', verify_status: 'skip', progress_note: '快收尾了' };
const genericBook = { id: 13, kind: 'book', title: '推理小说', creator: null, verify_status: 'generic', progress_note: null };

// ── 1. 注入段事实行 + 三条行为约束 ──────────────────────────────────────────
{
  const h = buildWorksPromptHint([verifiedBook, craftWork]);
  ok(h.includes('《活着》') && h.includes('看到一半'), 'verified 指名《活着》+ 进度');
  ok(h.includes('给外婆织围巾'), 'craft 自由文本入注入');
  ok(h.includes('永远正常接') || h.includes('正常接'), '约束①他问起永放行（对话召回）在场');
  ok(h.includes('别每条'), '约束②她别每条自荐（克制）在场');
  ok(h.includes('这就是你现在手头在看') || h.includes('现在手头在看/在做的全部'),
     '档案权威性断言在场（压过近 16 轮上下文——沙箱实测旧虚构名还在上下文里时必须靠这条）');
  ok(h.includes('早看完') && h.includes('绝不接着说') && (h.includes('别否认') || h.includes('没提过')),
     '约束③存量退场：旧作品名→看完了/绝不接着说进度剧情/不否认（红验④的注入侧断言）');
  ok(buildWorksPromptHint([]) === '' && buildWorksPromptHint(null) === '', '无 works → 空注入');
}

// ── 2. generic 不指名（模糊但不虚构）──────────────────────────────────────
{
  const h = buildWorksPromptHint([genericBook]);
  ok(h.includes('一本推理小说'), 'generic → "一本推理小说"（题材不指名）');
  ok(!h.includes('《'), 'generic 绝不带书名号具体名（零虚构）');
}

// ── 3. 注入排序：arc 主导语气永在 works 之后（cold 不被稀释）────────────────
{
  const worksHint = buildWorksPromptHint([verifiedBook]);
  const sys = buildSystemPrompt(baseC, { worksHint, promptMode: 'reply' });
  ok(sys.includes('【手头的事】'), 'worksHint 进 buildSystemPrompt 注入');
  // 调用方在返回后才追加 arc 指令（最高优先）——模拟拼接，断言顺序
  const COLD_DIR = '\n【★ 当前主导语气：冷淡】你这会儿在闹别扭，话少、淡、别撒娇。';
  const assembled = sys + COLD_DIR;
  ok(assembled.indexOf('【手头的事】') < assembled.indexOf('当前主导语气'),
     'works 注入结构上在 arc 指令之前（arc 在最后=最高优先，cold 不被 works 冲淡）');
  // works 注入落在生活背景带：在【今日日程】族之后、不在身份/规则段最前（非头插）
  ok(sys.indexOf('【手头的事】') > sys.indexOf('你叫溪语'), 'works 非头插（在核心身份之后）');
}

// ── 4. 静态钉死：worksHint 走参数注入，绝不拼在 arcCtx.directive 之后 ──────────
{
  const botSrc = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
  const proSrc = readFileSync(new URL('../src/proactive.mjs', import.meta.url), 'utf8');
  ok(/buildSystemPrompt\([^)]*worksHint/s.test(botSrc), 'bot.mjs：worksHint 是 buildSystemPrompt 参数');
  ok(/buildSystemPrompt\([^`]*worksHint/s.test(proSrc), 'proactive.mjs：worksHint 是 buildSystemPrompt 参数');
  // 红线：assembly 尾部绝不出现 `+ worksHint`（那会插到 arc 指令同层或之后）
  ok(!/\+\s*worksHint/.test(botSrc), 'bot.mjs：worksHint 绝不被 `+ 拼接`（防尾插稀释 arc）');
  ok(!/\}\s*\)\s*}\s*\$\{stickerHint[^]*\+\s*worksHint/.test(proSrc), 'proactive.mjs：worksHint 不在 hint 链尾拼接');
}

// ── 5. 冷却放行双向：pickProactiveWork 锁主动；buildWorksPromptHint 永放行 ──────
{
  const cfg = worksConfig();
  const works = [verifiedBook];
  // 放行向：他问起——注入段永远列出（不管冷却）
  const hCooled = buildWorksPromptHint(works);
  ok(hCooled.includes('《活着》'), '放行向：冷却中她也答得上（注入段始终列出该书）');
  // 锁主动向：48h 冷却内不被 pickProactiveWork 选中
  const cooled = pickProactiveWork(works, { usedIds: new Set([workMaterialId(11)]), cfg });
  ok(cooled === null, '锁主动向：48h 冷却内 pickProactiveWork 不选它（她不主动提）');
  // 未冷却 → 选中
  const fresh = pickProactiveWork(works, { usedIds: new Set(), cfg, rng: () => 0 });
  ok(fresh && fresh.id === 11, '未冷却 → 被选为主动话题候选');
  // 周上限：达 cap → 不选（计数闸）
  const capped = pickProactiveWork(works, { usedIds: new Set(), weeklyCount: () => cfg.weeklyMentionCap, cfg });
  ok(capped === null, `周上限 ≥${cfg.weeklyMentionCap} → 不选（与 48h 冷却互为双闸）`);
  // eligible：照片侧只拍 verified/craft，generic 排除
  const photoEligible = (w) => w.verify_status === 'verified' || String(w.kind).toLowerCase() === 'craft';
  ok(pickProactiveWork([genericBook], { eligible: photoEligible, cfg }) === null, '照片侧：generic（无实物名）不拍');
  ok(pickProactiveWork([verifiedBook], { eligible: photoEligible, cfg, rng: () => 0 })?.id === 11, '照片侧：verified 真书可拍');
}

// ── 6. 素材 ID 规范 + 照片 sceneSeed（封面护栏在场）────────────────────────
{
  ok(workMaterialId(5) === 'work:5', '素材 ID 规范 work:5');
  const seed = worksSceneSeed(verifiedBook);
  ok(seed.includes('活着') && seed.includes('POV') && seed.includes('不出现脸'), 'sceneSeed：拍《活着》POV 无脸');
  ok(seed.includes('护栏') && seed.includes('封面'), 'sceneSeed 自带封面护栏（绝不完整正面封面）');
  ok(worksSceneSeed(null) === '', '空 work → 空 seed');
}

// ── 7. 完结/弃读归档记忆（对话召回"你之前看的那本"接得住）──────────────────
{
  const fin = buildWorkArchiveMemory(verifiedBook, false);
  ok(fin.memoryType === 'event' && fin.content.includes('看完了《活着》'), '完结归档：看完了《活着》(event 层)');
  const drop = buildWorkArchiveMemory(verifiedBook, true);
  ok(drop.content.includes('弃') || drop.content.includes('看不下去'), '弃读归档：弃了/看不下去措辞');
  const gfin = buildWorkArchiveMemory(genericBook, false);
  ok(gfin.content.includes('一本推理小说') && !gfin.content.includes('《'), 'generic 归档不指名');
  const cfin = buildWorkArchiveMemory(craftWork, false);
  ok(cfin.content.includes('围巾'), 'craft 归档：织围巾做完了');
}

console.log(`\ncurrent_works_expression_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
