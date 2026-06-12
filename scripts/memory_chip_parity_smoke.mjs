/**
 * memory_chip_parity_smoke —— 记忆页 chip ↔ layer 双向对账（2026-06-12）。
 *
 * 缘起：核心人设 / 关系规则两个 chip 长期空抽屉——core_persona 全代码零产出路径，
 * relationship_rule 唯一路径(src/reflection.mjs insert)从未开火。删 chip 后立此对账，
 * 防两类回归：「承诺一个没人填的抽屉」与「有数据却没窗口可见」。
 *
 *   方向① 每个 UI 入口(过滤 chip + 新增下拉) 的 data-layer 必须 ∈ 活跃产出层。
 *          否则=空抽屉(core_persona 当年的病)。纯静态，CI 跑。
 *   方向② 任何「有数据」的 memory_layer 必须有对应 chip。
 *          否则=数据存在却无窗口；reflection 复活产出 relationship_rule 时变红，
 *          chip 按警报回归而非凭记忆。需真库，ops 跑(DB_PATH)，无库优雅跳过(退 0)。
 *
 * 活跃产出层的单一事实源在此(每条注明产出处)。改抽取、新增产出层时必须同步本表 + 加 chip，
 * 本 smoke 会逼你对账。导出 parseUiLayers / parityOffenders 供 arc-digest 夜间复用。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEMORIES_HTML = path.join(ROOT, 'public/app/memories.html');

// ── 活跃产出层：单一事实源（一个 layer 进这里的门槛 = 当前管线真有一条会开火的产出路径）──
export const ACTIVE_PRODUCTION_LAYERS = new Set([
  'user_fact',  // src/memory.mjs 主抽取 fact → user_fact
  'preference', // src/memory.mjs 主抽取 preference
  'event',      // src/memory.mjs 主抽取 event（image / inside_joke 亦归并至此）
  'emotion',    // src/memory.mjs 主抽取 emotion（全库 46 行实证活跃）
  'summary',    // 日/周/月总结管线 → summary
  // — 下列 backend MEMORY_LAYERS 仍保留(reflection 复活仍可入库)但无活跃产出，2026-06-12 已删对应 chip —
  // core_persona      : 全代码零产出路径（真死枚举）
  // relationship_rule : 唯一路径 src/reflection.mjs insert，全库零开火；若复活由方向② 报警回归
]);

/**
 * 解析 memories.html 里所有 UI 暴露的 layer（过滤 chip 的 data-layer + 新增下拉 option）。
 * 必须限定在 #layerFilters / #modalLayer 容器内——否则会误捕 renderCard 编辑按钮模板里的
 * `data-layer="${layer}"`（那是渲染产物不是 chip，本 smoke 首跑就被它咬过一次）。
 */
export function parseUiLayers(html) {
  const chipBlock = (html.match(/id="layerFilters"[\s\S]*?<\/div>/) || [''])[0];
  const optBlock = (html.match(/id="modalLayer"[\s\S]*?<\/select>/) || [''])[0];
  const chip = [...chipBlock.matchAll(/data-layer="([^"]*)"/g)].map(m => m[1]).filter(Boolean); // 去掉「全部」空串
  const option = [...optBlock.matchAll(/<option value="([a-z_]+)"/g)].map(m => m[1]);
  return { chip: new Set(chip), option: new Set(option) };
}

/** 方向②：返回「有数据但无对应 chip」的 layer 数组（空数组 = 对账通过）。纯函数，供 smoke 与 digest 共用。 */
export function parityOffenders(chipSet, layersWithData) {
  return [...layersWithData].filter(l => !chipSet.has(l));
}

// ── 仅在被直接执行时跑断言（被 import 时只导出，不产生副作用）──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let pass = 0, fail = 0;
  const ok = (c, n) => { if (c) { pass++; } else { fail++; console.log('  ✗', n); } };

  const html = fs.readFileSync(MEMORIES_HTML, 'utf8');
  const ui = parseUiLayers(html);
  const uiLayers = new Set([...ui.chip, ...ui.option]);
  console.log('  UI chip :', [...ui.chip].join(', ') || '(空)');
  console.log('  UI 下拉 :', [...ui.option].join(', ') || '(空)');
  console.log('  活跃产出层:', [...ACTIVE_PRODUCTION_LAYERS].join(', '));

  // ── 方向① 每个 UI layer 必须有活跃产出路径（静态，CI 主防线）──
  for (const layer of uiLayers) {
    ok(ACTIVE_PRODUCTION_LAYERS.has(layer), `方向①：UI 入口「${layer}」须 ∈ 活跃产出层（否则=空抽屉）`);
  }
  // 死枚举必须确实已无 UI 入口
  ok(!uiLayers.has('core_persona'), '方向①：core_persona 已无 UI 入口（死枚举已删）');
  ok(!uiLayers.has('relationship_rule'), '方向①：relationship_rule 已无 UI 入口（dormant 路径已删）');

  // ── 红验·方向①：人为塞一个无产出层进 UI 集，必须被抓 ──
  {
    const polluted = new Set([...uiLayers, 'core_persona']);
    const caught = [...polluted].some(l => !ACTIVE_PRODUCTION_LAYERS.has(l));
    ok(caught, '红验·方向①：注入 core_persona 假 chip 必被对账抓出');
  }

  // ── 红验·方向②：有数据但无 chip 必被报为 offender ──
  {
    const offenders = parityOffenders(ui.chip, new Set(['emotion', 'relationship_rule']));
    ok(offenders.includes('relationship_rule') && !offenders.includes('emotion'),
      '红验·方向②：relationship_rule 有数据无 chip → 报红；emotion 有 chip → 不报');
  }

  // ── 方向② 真库对账（需 DB_PATH；无库优雅跳过，零命中退 0）──
  const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'data/bot.db');
  if (!fs.existsSync(DB_PATH)) {
    console.log(`  方向②：DB 不存在(${DB_PATH})，跳过（仅 ops 环境跑；CI 静态只验方向①）`);
  } else {
    let db;
    try {
      db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
      const rows = db.prepare(
        "SELECT DISTINCT memory_layer FROM companion_memories WHERE memory_status != 'deleted' AND memory_layer IS NOT NULL"
      ).all();
      const layersWithData = new Set(rows.map(r => r.memory_layer));
      console.log('  有数据的 layer:', [...layersWithData].join(', ') || '(空)');
      const offenders = parityOffenders(ui.chip, layersWithData);
      ok(offenders.length === 0,
        offenders.length
          ? `方向②：有数据却无 chip 的 layer ➜ ${offenders.join(', ')}（按警报给它们加回 chip）`
          : '方向②：所有有数据的 layer 都有 chip');
    } catch (e) {
      console.log(`  方向②：读库失败(${e.message})，跳过（不阻断 CI）`);
    } finally {
      try { db?.close(); } catch { /* noop */ }
    }
  }

  console.log(`\nmemory_chip_parity_smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
