/**
 * 人设导出字段对账（纯静态，零 LLM，接 CI）。
 *
 * 背景：v1.7~v1.19.3 期间 PATCH 白名单（db.mjs ALLOWED_FIELDS）持续加人格字段
 * （dislikes / attachment_style / locale / first_love…），但导出白名单
 * （persona_export.mjs PERSONA_FIELDS）没人同步——导出人设再导入会静默丢设定。
 * 本脚本对账两份白名单 + 导入类型覆盖，新字段忘同步时 CI 直接红。
 *
 * 规则：
 *   1) ALLOWED_FIELDS − PERSONA_FIELDS − EXPORT_EXEMPT = ∅
 *      （PATCH 能写的人格字段，要么导出、要么显式豁免并写明理由）
 *   2) PERSONA_FIELDS ⊆ (STRING ∪ INT ∪ FLOAT ∪ JSON ∪ ENUM)
 *      （导出了但导入侧没有类型处理 = 导入时静默丢，同样算漂移）
 *   3) DDL 布尔风格列（INTEGER DEFAULT 0|1）∩ ALLOWED_FIELDS ⊆ BOOL_FIELDS ∪ 豁免
 *      （布尔字段漏 BOOL_FIELDS → REST PUT 传 JSON 布尔直接 SQLite 绑定 500，
 *       v1.19.3 first_love 踩过）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ALLOWED_FIELDS, BOOL_FIELDS } from '../src/db.mjs';
import {
  PERSONA_FIELDS, IMPORT_STRING_FIELDS, IMPORT_INT_FIELDS,
  IMPORT_FLOAT_FIELDS, IMPORT_JSON_FIELDS, IMPORT_ENUM_VALUES,
} from '../src/persona_export.mjs';

// 豁免 = 故意不导出的字段。加新豁免必须写理由。
const EXPORT_EXEMPT = new Map([
  ['avatar_url',      '隐私：URL 可能含部署主机/用户路径'],
  ['secrets',         '敏感：永不出库'],
  ['voice_id',        'provider 绑定的音色资源 ID，跨部署不通用'],
  ['silent_mode',     '运行时状态：沉默陪伴开关，导入后应重新开始'],
  ['current_mood',    '运行时状态：情绪不随人设迁移'],
  ['affection_level', '运行时状态：好感度不随人设迁移（stage 导出仅作起点参考）'],
  ['scene_history',   '运行时状态：场景流水'],
]);

let fail = 0;
const personaSet = new Set(PERSONA_FIELDS);

// 规则 1：PATCH 白名单里的字段都要么导出要么豁免
for (const f of ALLOWED_FIELDS) {
  if (!personaSet.has(f) && !EXPORT_EXEMPT.has(f)) {
    fail++;
    console.log(`  ✗ '${f}' 在 ALLOWED_FIELDS 但不在 PERSONA_FIELDS——导出会丢它。`);
    console.log(`    修法：加进 persona_export.mjs PERSONA_FIELDS + IMPORT_*_FIELDS + DEFAULTS；`);
    console.log(`    或确属运行时/敏感字段则加进本脚本 EXPORT_EXEMPT 并写理由。`);
  }
}

// 顺手提醒：豁免了实际不存在的字段（防豁免表自己烂掉）
for (const f of EXPORT_EXEMPT.keys()) {
  if (!ALLOWED_FIELDS.has(f)) {
    console.log(`  ℹ 豁免表里的 '${f}' 不在 ALLOWED_FIELDS（可能已删除，可清理豁免）`);
  }
}

// 规则 2：每个导出字段导入侧都有类型处理
for (const f of PERSONA_FIELDS) {
  const covered = IMPORT_STRING_FIELDS.has(f) || IMPORT_INT_FIELDS.has(f)
    || IMPORT_FLOAT_FIELDS.has(f) || IMPORT_JSON_FIELDS.has(f) || IMPORT_ENUM_VALUES.has(f);
  if (!covered) {
    fail++;
    console.log(`  ✗ '${f}' 在 PERSONA_FIELDS 但没有任何 IMPORT_*_FIELDS 处理——导入会静默丢。`);
  }
}

// ── 规则 3：布尔风格列必须在 BOOL_FIELDS（防 REST 传布尔 500）─────────────
// 从 db.mjs 源码扫所有 INTEGER DEFAULT 0|1 的列名（含建表 DDL 和 addColIfMissing），
// 与 ALLOWED_FIELDS 取交集后剔除其它表的同名列；语义上是数值档位而非开关的进豁免。
const BOOL_EXEMPT = new Map([
  ['nsfw_level', '0-3 数值档位，不是开关'],
]);
const dbSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/db.mjs'), 'utf8');
const boolStyleCols = new Set();
for (const m of dbSrc.matchAll(/^\s*(\w+) INTEGER DEFAULT [01]\s*,?\s*(--.*)?$/gm)) boolStyleCols.add(m[1]);
for (const m of dbSrc.matchAll(/addColIfMissing\('companions',\s*'(\w+)',\s*['"`]INTEGER DEFAULT [01]['"`]\)/g)) boolStyleCols.add(m[1]);
for (const col of boolStyleCols) {
  if (!ALLOWED_FIELDS.has(col)) continue;       // 非 companions PATCH 字段（或其它表撞名）
  if (BOOL_FIELDS.has(col) || BOOL_EXEMPT.has(col)) continue;
  fail++;
  console.log(`  ✗ '${col}' 是布尔风格列(INTEGER DEFAULT 0/1)且可 PATCH，但不在 BOOL_FIELDS——`);
  console.log(`    REST PUT 传 JSON 布尔会 SQLite 绑定 500。加进 db.mjs BOOL_FIELDS，`);
  console.log(`    或确属数值档位则加进本脚本 BOOL_EXEMPT 并写理由。`);
}

if (fail) {
  console.log(`persona_export_drift_check: 失败 ${fail} 项`);
  process.exit(1);
}
console.log(`persona_export_drift_check: 通过（ALLOWED ${ALLOWED_FIELDS.size} / 导出 ${PERSONA_FIELDS.length} / 豁免 ${EXPORT_EXEMPT.size} / 布尔列 ${boolStyleCols.size} 扫描）`);
