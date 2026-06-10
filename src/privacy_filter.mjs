/**
 * 隐私过滤（v1.20 安全收尾 PR2，Issue #3 的"敏感信息不入长期记忆"半边）。
 *
 * 单一真源：吸收并取代 memory_v2 的 SENSITIVE_PATTERNS / sanitizeMemoryContent
 * （memory_v2 改为 re-export 以兼容既有调用方）。挂载在 db.mjs 各长期存储写入
 * 函数的入口（最窄腰部，所有调用方自动覆盖）：saveMemory / upsertPreference /
 * upsertShaping / saveOpenLoop / upsertUserProfile，外加 diary 喂入侧 redact。
 *
 * 两档策略：
 * - 绝不入库（shouldStoreMemory → false）：密码句式、API key、身份证（18 位 +
 *   GB11643 末位校验）、银行卡（13-19 位 + Luhn 校验）——带校验避免误杀订单号
 * - 脱敏入库（redactSensitiveInfo）：手机号、楼栋门牌级住址、学校+班级组合
 *   → 替换为 [已脱敏:类型]
 *
 * 范围注意：本过滤只管**长期记忆层**。原始聊天记录有 60 天保留策略另行兜底。
 * 零依赖纯函数（不 import db/ai），可被任何层引用无环。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

// ── 绝不入库：密码句式 / API key / token ───────────────────────────────────
const BLOCK_PATTERNS = [
  // 密码句式：「密码 + 分隔 + 具体值」才拦；"我忘记密码了"不拦
  /(?:密码|password|pwd|passwd)\s*(?:是|为|[:：=])\s*\S{4,}/i,
  // API key 常见前缀
  /\bsk-[a-zA-Z0-9_-]{16,}/,
  /\bghp_[a-zA-Z0-9]{30,}/,
  /\bgho_[a-zA-Z0-9]{30,}/,
  /\bAKIA[A-Z0-9]{12,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,   // Google API key（继承自 memory_v2 原清单）
  /\bxox[bpars]-[a-zA-Z0-9-]{10,}/,
  /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}/,   // JWT
  /(?:token|secret|api[_-]?key)\s*[:：=]\s*[a-zA-Z0-9_-]{16,}/i,
  // 验证码句式
  /(?:验证码|captcha|otp)\s*(?:是|为|[:：=])\s*\d{4,8}/i,
  // 自伤方法寻求 / 未成年+性（继承自 memory_v2 原清单）
  /(?:想自杀|去死|了结生命|结束生命).*(?:方法|怎么|如何|用什么)/,
  /(?:未成年|小学生|初中生|高中生|\d{1,2}岁).*(?:性|裸|色情)/,
];

// 身份证 GB11643 末位校验（避免把 18 位订单号误杀）
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
function isValidChineseId(s) {
  if (!/^\d{17}[\dXx]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(s[i]) * ID_WEIGHTS[i];
  return ID_CHECK[sum % 11] === s[17].toUpperCase();
}

// 银行卡 Luhn 校验（13-19 位；同样避免误杀长数字串）
function passesLuhn(s) {
  let sum = 0, dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

function containsValidId(text) {
  for (const m of String(text).matchAll(/(?<![0-9Xx])\d{17}[\dXx](?![0-9Xx])/g)) {
    if (isValidChineseId(m[0])) return true;
  }
  return false;
}

function containsValidCard(text) {
  for (const m of String(text).matchAll(/(?<!\d)\d{13,19}(?!\d)/g)) {
    // 18 位且身份证校验通过的归身份证管；其余 13-19 位过 Luhn
    if (m[0].length === 18 && isValidChineseId(m[0])) continue;
    if (passesLuhn(m[0])) return true;
  }
  return false;
}

/**
 * false = 该文本含绝不入库级敏感信息，调用方应整条放弃存储。
 */
export function shouldStoreMemory(text) {
  const t = String(text || '');
  if (!t) return true;
  if (BLOCK_PATTERNS.some(re => re.test(t))) return false;
  if (containsValidId(t)) return false;
  if (containsValidCard(t)) return false;
  return true;
}

// ── 脱敏入库 ───────────────────────────────────────────────────────────────
const REDACT_RULES = [
  // 手机号：11 位 1[3-9] 开头，前后无数字（防订单号/金额误伤）
  { re: /(?<!\d)1[3-9]\d{9}(?!\d)/g, label: '手机号' },
  // 楼栋门牌级住址：路/街/巷/小区 + 栋/号楼/单元/室 组合（两级以上才算精确）
  { re: /[一-龥A-Za-z0-9]{2,12}(?:路|街|巷|大道|小区|苑|府|湾|城)\s*\d{1,5}号?[一-龥A-Za-z0-9\s]{0,8}?(?:\d{1,3}\s*(?:栋|幢|号楼|单元|座))[一-龥A-Za-z0-9\s]{0,10}?(?:\d{1,5}\s*(?:室|房)?)?/g, label: '住址' },
  { re: /(?:家住|住在|我住)[一-龥A-Za-z0-9]{2,12}\d{0,4}\s*(?:栋|幢|号楼|单元|座)\s*\d{1,5}/g, label: '住址' },
  // 学校 + 班级组合（单独学校名或单独班级不脱）
  { re: /[一-龥A-Za-z0-9]{2,12}(?:中学|小学|学校|一中|二中|三中|附中|实验学校|外国语学校)[一-龥（()）\d]{0,8}?[（(]?\d{1,2}[)）]?班/g, label: '学校班级' },
];

export function redactSensitiveInfo(text) {
  let out = String(text || '');
  if (!out) return out;
  for (const { re, label } of REDACT_RULES) {
    out = out.replace(re, `[已脱敏:${label}]`);
  }
  return out;
}

/**
 * 挂载点一行调用：const { store, text } = filterForStorage(raw);
 * store=false → 整条放弃；否则用返回的 text（可能已脱敏）入库。
 */
export function filterForStorage(text) {
  const raw = String(text ?? '');
  if (!raw) return { store: true, text: raw };
  if (!shouldStoreMemory(raw)) return { store: false, text: '' };
  return { store: true, text: redactSensitiveInfo(raw) };
}

// ── memory_v2 兼容层（原 API 语义保持） ────────────────────────────────────
/** 原 isSensitiveMemoryContent 语义：true = 含敏感内容（= !shouldStoreMemory） */
export function isSensitiveMemoryContent(text) {
  return !shouldStoreMemory(text);
}

/** 原 sanitizeMemoryContent 语义：返回清洗后文本，或 null = 整条拦截 */
export function sanitizeMemoryContent(text) {
  if (!text) return text;
  const { store, text: out } = filterForStorage(text);
  return store ? out : null;
}
