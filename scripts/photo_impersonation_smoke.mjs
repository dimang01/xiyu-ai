/**
 * 表情包冒充照片护栏 smoke（#281，纯函数零 LLM）。
 *
 * 双向红色验证（缺一不可）：
 *   拦截向：16:22 生产案例的同构合成样本（结构一致、内容改写——真实用户
 *           对话原文不进仓库 fixture）必须被拦：STICKER 剥除、声称短语
 *           移除、其余台词一字不动
 *   放行向：① 用户发图后她回"你刚拍的？"+表情 → 不拦（人称区分是命门）
 *           ② 纯表情回复无发图叙事 → 不拦
 *           ③ 真实照片 caption 路径不经过本函数（静态断言结构性豁免）
 */
import { readFileSync } from 'node:fs';
const { scrubPhotoImpersonation } = await import('../src/moderation.mjs');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// ── 拦截向：生产案例同构合成样本（[STICKER:语义错配] || 自称刚拍的+描述 || 追问）──
const synthetic = '[STICKER:ping]||就刚才拍的 它尾巴毛茸茸的||是不是很乖';
const out1 = scrubPhotoImpersonation(synthetic, 1);
ok(out1 === '它尾巴毛茸茸的||是不是很乖',
   `案例回放：产出恰为两段干净台词（实际：${out1}）`);
ok(!out1.includes('[STICKER:'), '案例回放：STICKER 被剥');
ok(!out1.includes('拍的'), '案例回放：声称短语被移除');

// 变体：声称在中段、表情在尾段——命中后全回复剥表情
const v2 = scrubPhotoImpersonation('给你看看我拍的||好不好看||[STICKER:shy]', 1);
ok(!v2.includes('[STICKER:') && v2.includes('好不好看'), '表情在别段也剥，未命中段台词保留');

// 变体："我自己拍的"形态 + 段清空丢弃
const v3 = scrubPhotoImpersonation('我自己拍的||天空特别蓝', 1);
ok(v3 === '天空特别蓝', `声称段清空后丢弃，其余保留（实际：${v3}）`);

// 变体："拍了一张发你"将来完成式声称
ok(!scrubPhotoImpersonation('拍了一张发你||快夸我', 1).includes('拍了一张'), '"拍了一张发你"命中');

// ── 放行向 ①：人称区分（命门）——用户先发图，她引用"你刚拍的"绝不能拦 ──
const refUser = '哇你刚拍的？||[STICKER:love]||它好乖呀';
ok(scrubPhotoImpersonation(refUser, 1) === refUser, '「你刚拍的？」合法引用 → 原样放行（含表情）');
ok(scrubPhotoImpersonation('这是谁拍的呀 也太好看了', 1) === '这是谁拍的呀 也太好看了', '「谁拍的」疑问 → 放行');
ok(scrubPhotoImpersonation('他拍的照片总是糊的', 1) === '他拍的照片总是糊的', '「他拍的」第三人称 → 放行');

// ── 放行向 ②：纯表情/正常台词零误伤 ──
const plain = '[STICKER:happy]||今天好开心呀';
ok(scrubPhotoImpersonation(plain, 1) === plain, '纯表情+无发图叙事 → 原样放行');
ok(scrubPhotoImpersonation('我拍了拍你的头', 1) === '我拍了拍你的头', '微信拍一拍语义 → 放行');
ok(scrubPhotoImpersonation('', 1) === '' && scrubPhotoImpersonation(null, 1) === null, '空入参 fail-safe');

// ── 放行向 ③：真实照片链路结构性豁免（静态断言）──
const photoSender = readFileSync(new URL('../src/photo_sender.mjs', import.meta.url), 'utf8');
const photoPlanner = readFileSync(new URL('../src/photo_planner.mjs', import.meta.url), 'utf8');
ok(!photoSender.includes('scrubPhotoImpersonation') && !photoPlanner.includes('scrubPhotoImpersonation'),
   '真实照片 caption 路径不经过护栏——"真发图时说刚拍的"天然豁免');

// ── 挂载静态断言：三个文本出口全罩 ──
for (const f of ['bot.mjs', 'proactive.mjs', 'playground.mjs']) {
  const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  ok(src.includes('scrubPhotoImpersonation(reply'), `${f} 文本出口已挂护栏`);
}
// prompt 软约束在位
const stickers = readFileSync(new URL('../src/stickers.mjs', import.meta.url), 'utf8');
ok(stickers.includes('表情包不是照片'), 'sticker hint 含禁令（B 方案在位）');
ok(stickers.includes('用文字描述画面'), 'sticker hint 含正向出口（表达欲有去处）');

console.log(`\nphoto_impersonation_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
