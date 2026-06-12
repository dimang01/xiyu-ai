/**
 * photo_categories.mjs — 照片品类加权采样（v1.21.6 PR-A）。
 *
 * 背景（审计实锤）：proactive「她主动分享生活照」这条管线 lifetime 只发过 1 张
 * （16 张照片里 15 张是用户索图）。现状不是"品类配比失衡"，是"主动分享通道几乎
 * 没启动、且无品类结构"。本模块把品类权重外置为配置（config/photo_categories.json
 * + env 热调），让 proactive 场景照按权重采样品类——但**默认关**，维护者审完审计
 * 对照表、拍板权重后再 flip on，不打字盲切。
 *
 * 作用域红线：**只作用于 proactive 主动场景照**。用户显式索图（"发张自拍"/"看看你
 * 写的作业"）永远走 decideShotMode 按请求来，绝不被品类采样覆盖——他要看自拍你给
 * 风景照是失能，不是克制。
 *
 * 全程 fail-open：配置读不到/损坏/采样异常 → 返回 null = 退回现状（decideShotMode），
 * 绝不阻断照片链路。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { log } from './logger.mjs';

const DEFAULT_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'photo_categories.json',
);

/** 总开关：默认 false（关）= proactive 照片维持现状。env 显式 true 才激活加权采样。 */
export function isCategorySamplingEnabled(env = process.env) {
  const raw = env.PHOTO_CATEGORY_SAMPLING_ENABLED;
  if (raw == null || raw === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function parseDisableSet(env) {
  return new Set(
    String(env.PHOTO_CAT_DISABLE || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  );
}

/** 单类权重 env 覆盖：PHOTO_CAT_WEIGHT_<ID>（大写），非法/缺省回退配置文件值。 */
function envWeightOverride(id, fileWeight, env) {
  const raw = env[`PHOTO_CAT_WEIGHT_${String(id).toUpperCase()}`];
  if (raw == null || raw === '') return fileWeight;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fileWeight;
}

/**
 * 读取并归一化品类配置（应用 env 覆盖与停用清单）。
 * @returns {{categories: Array}} 失败时返回 { categories: [] }（fail-open）。
 */
export function loadPhotoCategoryConfig({ configPath = DEFAULT_CONFIG_PATH, env = process.env } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    log('warn', `[PhotoCategory] 配置读取失败，退回现状（无品类采样）: ${e.message}`);
    return { categories: [] };
  }
  const disabled = parseDisableSet(env);
  const list = Array.isArray(parsed?.categories) ? parsed.categories : [];
  const categories = list
    .filter(c => c && typeof c === 'object' && c.id)
    .map(c => ({
      id: String(c.id),
      label: String(c.label || c.id),
      weight: envWeightOverride(c.id, Number(c.weight) || 0, env),
      shotMode: String(c.shotMode || 'CANDID'),
      sceneSeed: String(c.sceneSeed || ''),
      weeklyCap: Number.isFinite(Number(c.weeklyCap)) ? Math.max(0, Math.floor(Number(c.weeklyCap))) : 0,
      enabled: c.enabled !== false && !disabled.has(String(c.id).toLowerCase()),
    }));
  return { categories };
}

/**
 * 本周已达 weeklyCap 的品类 id 集合。
 * @param {object} weekCounts {categoryId: 本周已发条数}
 * @param {object} config loadPhotoCategoryConfig 结果（默认现读，沿用 env 覆盖）
 */
export function cappedCategoryIds(weekCounts = {}, config = loadPhotoCategoryConfig()) {
  const out = new Set();
  for (const c of config?.categories || []) {
    if (c.weeklyCap > 0 && Number(weekCounts?.[c.id] || 0) >= c.weeklyCap) out.add(c.id);
  }
  return out;
}

/** 当前生效（enabled 且 weight>0）的品类，权重和。 */
export function effectiveCategories(config = loadPhotoCategoryConfig()) {
  const cats = (config?.categories || []).filter(c => c.enabled && c.weight > 0);
  const total = cats.reduce((s, c) => s + c.weight, 0);
  return { cats, total };
}

/**
 * 加权采样一个品类。
 * @param {object} config loadPhotoCategoryConfig 结果（默认现读）
 * @param {function} rng 0~1 随机源（测试可注入）
 * @returns {object|null} 命中的品类对象；无可用品类时 null（fail-open → 退回现状）
 */
export function sampleCategory(config = loadPhotoCategoryConfig(), rng = Math.random) {
  try {
    const { cats, total } = effectiveCategories(config);
    if (!cats.length || total <= 0) return null;
    let r = rng() * total;
    for (const c of cats) {
      r -= c.weight;
      if (r < 0) return c;
    }
    return cats[cats.length - 1];   // 浮点兜底
  } catch (e) {
    log('warn', `[PhotoCategory] 采样异常，退回现状: ${e.message}`);
    return null;
  }
}

/**
 * proactive 入口：决定本次主动场景照的品类。
 * 总开关关 → null（现状）。开 → 按权重采样（可选 weeklyCap 过滤由调用方注入 usedThisWeek）。
 * @param {Set<string>} cappedIds 本周已达 weeklyCap 的品类 id（调用方算好传入，本模块不碰 IO）
 */
export function pickProactiveCategory({ env = process.env, rng = Math.random, cappedIds = new Set() } = {}) {
  if (!isCategorySamplingEnabled(env)) return null;
  const config = loadPhotoCategoryConfig({ env });
  if (cappedIds instanceof Set && cappedIds.size) {
    config.categories = config.categories.map(c => cappedIds.has(c.id) ? { ...c, enabled: false } : c);
  }
  return sampleCategory(config, rng);
}
