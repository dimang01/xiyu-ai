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
 */
import { ALLOWED_FIELDS } from '../src/db.mjs';
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

if (fail) {
  console.log(`persona_export_drift_check: 失败 ${fail} 项`);
  process.exit(1);
}
console.log(`persona_export_drift_check: 通过（ALLOWED ${ALLOWED_FIELDS.size} / 导出 ${PERSONA_FIELDS.length} / 豁免 ${EXPORT_EXEMPT.size}）`);
