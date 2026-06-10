/**
 * 隐私过滤回归 guard（纯函数，零 LLM，确定性，接 CI）。
 *
 * 契约（先写测试后写实现）：
 *   shouldStoreMemory(text) → false = 绝不入库（密码句式/API key/身份证/银行卡）
 *   redactSensitiveInfo(text) → 脱敏后文本（手机号/精确住址/学校+班级 → [已脱敏:类型]）
 *   filterForStorage(text) → { store, text } 组合（挂载点一行调用）
 *
 * 哲学：长期记忆层的过滤——原始聊天有 60 天保留策略兜底，这里管的是
 * "永远记住"的那一层。误伤普通对话（iPhone 15 / 301 教室）比漏脱敏更影响产品。
 */
import { shouldStoreMemory, redactSensitiveInfo, filterForStorage } from '../src/privacy_filter.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// ── 1) 密码句式：绝不入库 ─────────────────────────────────────
const PWD_BLOCK = [
  '我的密码是 abc12345',
  'password: hunter22',
  '支付密码是998877',
  'wifi密码：TP-LINK_5G_pass',
  '登录密码=qwe123!@#',
];
for (const t of PWD_BLOCK) ok(!shouldStoreMemory(t), `密码拦截:「${t}」`);
const PWD_PASS = [
  '我忘记密码了',
  '密码学这门课好难',
  '他总是记不住自己的密码',
  '改密码真麻烦',
  '密码不能告诉别人哦',
];
for (const t of PWD_PASS) ok(shouldStoreMemory(t), `密码不误伤:「${t}」`);

// ── 2) API key / token：绝不入库 ──────────────────────────────
// 假 key 用运行时拼接——opensource_check 的静态 secret 扫描不应把测试素材当真 key
const KEY_BLOCK = [
  '我的key是sk' + '-abcdefghij1234567890klmn',
  'ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789',
  'AKIA' + 'IOSFODNN7EXAMPLE 这是亚马逊的',
  'xoxb' + '-123456789012-abcdefghijklmnop',
  'token: eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123def456',
];
for (const t of KEY_BLOCK) ok(!shouldStoreMemory(t), `key拦截:「${t.slice(0, 30)}…」`);
const KEY_PASS = [
  'sk 后面是什么来着我忘了',
  '我买了新键盘',
  'token 过期了重新登一下就行',
  '今天学了 JWT 的原理',
  'github 上有个好项目',
];
for (const t of KEY_PASS) ok(shouldStoreMemory(t), `key不误伤:「${t}」`);

// ── 3) 身份证（18 位 + 末位校验）：绝不入库 ───────────────────
// 11010519491231002X 是 GB11643 文档示例号（校验位合法）
const ID_BLOCK = [
  '我身份证号11010519491231002X',
  '身份证：11010519491231002x 帮我记一下',
  '号码是 110105194912310021 吗',  // 合法校验的变体（最后一位按算法）
];
// 至少前两条（标准示例号）必须拦
ok(!shouldStoreMemory(ID_BLOCK[0]), `身份证拦截:「…002X」`);
ok(!shouldStoreMemory(ID_BLOCK[1]), `身份证拦截(小写x)`);
const ID_PASS = [
  '我身份证丢了好烦',
  '110105194912310029 这串号码是错的吧',  // 校验位不合法 → 不算身份证
  '11010519491231 还差几位来着',           // 14 位
  '订单号 202606101234567890 查一下',      // 20 位非身份证
  '快递单号是 7530218842',
];
for (const t of ID_PASS) ok(shouldStoreMemory(t), `身份证不误伤:「${t.slice(0, 24)}…」`);

// ── 4) 银行卡（Luhn）：绝不入库 ───────────────────────────────
const CARD_BLOCK = [
  '我卡号4111111111111111',          // Visa 测试号，Luhn 合法
  '银行卡 6222021234567890123 转这张', // 19 位若 Luhn 合法则拦（按实现生成）
  '5500005555555559 是我的卡',        // MasterCard 测试号
];
ok(!shouldStoreMemory(CARD_BLOCK[0]), '银行卡拦截: Visa 测试号');
ok(!shouldStoreMemory(CARD_BLOCK[2]), '银行卡拦截: MC 测试号');
const CARD_PASS = [
  '4111111111111112 这号不对吧',      // Luhn 不过
  '我办了张新银行卡',
  '卡里没钱了',
  '订单 1234567890123456 帮我看看',   // Luhn 不过的 16 位
  '手机号后四位 1111',
];
for (const t of CARD_PASS) ok(shouldStoreMemory(t), `银行卡不误伤:「${t.slice(0, 20)}…」`);

// ── 5) 手机号：脱敏入库 ───────────────────────────────────────
ok(redactSensitiveInfo('我手机号13800138000有空打给我').includes('[已脱敏:手机号]'), '手机号脱敏');
ok(!redactSensitiveInfo('我手机号13800138000').includes('13800138000'), '手机号原文消失');
const PHONE_PASS = [
  'iPhone 15 真好用',
  '这个月花了15869元',
  '13点 8000 米跑完了',
  '快递单号 1380013800', // 10 位
  '我换了新手机',
];
for (const t of PHONE_PASS) ok(redactSensitiveInfo(t) === t, `手机号不误伤:「${t}」`);

// ── 6) 精确住址：脱敏入库 ─────────────────────────────────────
ok(redactSensitiveInfo('我住幸福路88号3栋2单元501室').includes('[已脱敏:住址]'), '楼栋门牌脱敏');
ok(redactSensitiveInfo('家住阳光小区6栋1202').includes('[已脱敏:住址]'), '小区楼栋脱敏');
const ADDR_PASS = [
  '在301教室上课',
  '我家在杭州',          // 城市级粗粒度不脱
  '我住学校宿舍',
  '去3号楼开会',          // 办公场景单独楼号不脱
  '88号公路电影不错',
];
for (const t of ADDR_PASS) ok(redactSensitiveInfo(t) === t, `住址不误伤:「${t}」`);

// ── 7) 学校+班级组合：脱敏入库 ────────────────────────────────
ok(redactSensitiveInfo('我在实验中学初二3班').includes('[已脱敏:学校班级]'), '学校+班级脱敏');
ok(redactSensitiveInfo('阳光小学五年级(2)班的').includes('[已脱敏:学校班级]'), '学校+年级班脱敏');
const SCHOOL_PASS = [
  '我们学校食堂超难吃',
  '中学时代真怀念',
  '三班的人都挺好',       // 只有班级没学校
  '实验中学就在我家附近', // 只有学校没班级
  '上班好累',
];
for (const t of SCHOOL_PASS) ok(redactSensitiveInfo(t) === t, `学校不误伤:「${t}」`);

// ── 8) filterForStorage 组合行为 ──────────────────────────────
{
  const r1 = filterForStorage('我的密码是 abc12345');
  ok(r1.store === false, 'filter: 密码 → 不入库');
  const r2 = filterForStorage('我手机号13800138000，記得找我');
  ok(r2.store === true && r2.text.includes('[已脱敏:手机号]'), 'filter: 手机号 → 脱敏入库');
  const r3 = filterForStorage('今天吃了火锅好开心');
  ok(r3.store === true && r3.text === '今天吃了火锅好开心', 'filter: 普通内容原样');
  const r4 = filterForStorage('');
  ok(r4.store === true && r4.text === '', 'filter: 空串健壮');
  ok(filterForStorage(null).store === true, 'filter: null 健壮');
}

console.log(`privacy_filter_guard: 通过 ${pass} 失败 ${fail}`);
process.exit(fail ? 1 : 0);
