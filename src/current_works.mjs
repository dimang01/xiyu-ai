/**
 * current_works.mjs — current_works「她手头的事」档案 + 真实性验证双闸（v1.21.4 PR-W1）。
 *
 * 设计 docs/V1214_DESIGN.md §5/§6/§7/§13。背景（2026-06-12 生产实锤）：她声称在看
 * 《她总在转角处等我》——用户实搜无此书，纯 LLM 虚构。本模块把"她在看/在做的事"
 * 从 LLM 即兴收成一张表，作品类入档前过 webSearch 真实性验证，搜不到宁可降级
 * "泛读态"（"最近在看一本推理小说"）也绝不带虚构名入档。
 *
 * 验证双闸（评审拍板：字符串级，不加 LLM 判定）：
 *   闸1 kind 兜底——title 含书名号《》→ 强制按作品类验证（防 LLM 自报 craft 绕过）
 *   闸2 webSearch 字符串判定——某结果 title+snippet 同含作品名与作者才 verified
 * 缓存只缓 verified（作品存在性是单调正事实，永不过期）；负结果不缓存、每次重验。
 * 参数全 env 可调（§13，评审拍板为"观察值"）：48h/周3/生命周期天数都是纯推理值。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { webSearch } from './web_search.mjs';
import { extractStructuredInfo } from './ai.mjs';
import { findVerifiedWork, getActiveCurrentWorks, insertCurrentWork, setCurrentWorkStatus, getAppSetting, setAppSetting } from './db.mjs';
import { log } from './logger.mjs';

const VERIFIABLE = new Set(['book', 'series', 'anime', 'game']);   // craft 免验

/** §13 参数速查：全部 env 可调（评审拍板为"观察值"，上线后按手感调、不写死）。 */
export function worksConfig(env = process.env) {
  const num = (k, d) => { const n = Number(env[k]); return Number.isFinite(n) ? n : d; };
  return {
    maxActive: num('WORKS_MAX_ACTIVE', 2),
    verifyRetries: num('WORKS_VERIFY_RETRIES', 2),
    verifyDailyCap: num('WORKS_VERIFY_DAILY_CAP', 50),
    mentionCooldownH: num('WORK_MENTION_COOLDOWN_HOURS', 48),
    weeklyMentionCap: num('WORK_WEEKLY_MENTION_CAP', 3),
    bookDaysMin: num('WORKS_BOOK_DAYS_MIN', 10), bookDaysMax: num('WORKS_BOOK_DAYS_MAX', 21),
    seriesDaysMin: num('WORKS_SERIES_DAYS_MIN', 7), seriesDaysMax: num('WORKS_SERIES_DAYS_MAX', 14),
    craftDaysMin: num('WORKS_CRAFT_DAYS_MIN', 7), craftDaysMax: num('WORKS_CRAFT_DAYS_MAX', 30),
    dropProb: num('WORKS_DROP_PROB', 0.15),
  };
}

function stripBrackets(s) { return String(s || '').replace(/[《》]/g, '').trim(); }

/** 闸1：是否必须按作品类验证。title 含《》→ 强制（确定性兜底，不靠 LLM 自报 kind）。 */
export function requiresVerification(kind, title) {
  if (/《[^》]+》/.test(String(title || ''))) return true;
  return VERIFIABLE.has(String(kind || '').toLowerCase());
}

/** 闸2：搜索结果里有没有"同时含作品名与作者"的证据。返回命中 snippet（≤300）或 null。 */
export function evidenceFromResults(results, title, creator) {
  const t = stripBrackets(title);
  const c = String(creator || '').trim();
  if (!t) return null;
  for (const r of (Array.isArray(results) ? results : [])) {
    const hay = `${r?.title || ''} ${r?.snippet || ''}`;
    if (hay.includes(t) && (!c || hay.includes(c))) {
      return hay.replace(/\s+/g, ' ').trim().slice(0, 300);
    }
  }
  return null;
}

/**
 * 单候选验证（§6 双闸）。
 * @returns {{status:'verified'|'generic'|'retry'|'skip', evidence:string|null}}
 *   verified=入档具体名 / skip=craft 免验 / retry=无证据换一部 / generic=降级泛读态
 * deps（全注入，纯逻辑可测）：{ search, findCached, dailyUsed, dailyCap }
 */
export async function verifyWorkCandidate(candidate, deps = {}) {
  const { kind, title, creator } = candidate || {};
  const search = deps.search || ((q) => webSearch(q));
  const findCached = deps.findCached || findVerifiedWork;
  const dailyCap = deps.dailyCap ?? worksConfig().verifyDailyCap;
  const dailyUsed = deps.dailyUsed ?? 0;

  if (!requiresVerification(kind, title)) return { status: 'skip', evidence: null };

  // 缓存：只缓 verified、永不过期；负结果不缓存
  const cached = findCached(stripBrackets(title), creator || null);
  if (cached) return { status: 'verified', evidence: cached.verify_evidence || null };

  // 日上限：异常循环防烧 Tavily 配额
  if (dailyUsed >= dailyCap) {
    log('warn', `[CurrentWorks] 作品验证日上限 ${dailyCap} 到顶 → 降级 generic`);
    return { status: 'generic', evidence: null };
  }

  let res;
  try {
    const q = `《${stripBrackets(title)}》 ${creator || ''} ${kind === 'book' ? '书' : ''}`.replace(/\s+/g, ' ').trim();
    res = await search(q);
  } catch (e) {
    log('warn', `[CurrentWorks] 作品验证失败（异常 ${e.message}）→ 降级 generic`);
    return { status: 'generic', evidence: null };
  }
  // provider 故障 ≠ 书是假的：降级 generic、不计作品失败、不重试
  if (!res || res.ok === false) {
    log('warn', `[CurrentWorks] 作品验证失败（provider ${res?.error || 'down'}）→ 降级 generic（不判真书为假）`);
    return { status: 'generic', evidence: null };
  }
  const evidence = evidenceFromResults(res.results, title, creator);
  if (evidence) return { status: 'verified', evidence };
  return { status: 'retry', evidence: null };   // ok 但无证据 → 换一部
}

/** kind → 生命周期天数（§13），用 started_at 派生确定性抖动（同一档案每次判定一致）。 */
export function lifecycleDays(kind, startedAt, cfg = worksConfig()) {
  const k = String(kind || '').toLowerCase();
  const [lo, hi] = k === 'book' ? [cfg.bookDaysMin, cfg.bookDaysMax]
    : (k === 'series' || k === 'anime' || k === 'game') ? [cfg.seriesDaysMin, cfg.seriesDaysMax]
      : [cfg.craftDaysMin, cfg.craftDaysMax];
  const seed = Number(new Date(startedAt).getTime()) || 0;
  const span = Math.max(1, hi - lo + 1);
  return lo + (Math.abs(seed) % span);
}

/** 该作品是否到完结点（now - started_at ≥ 生命周期天数）。 */
export function isWorkFinished(work, now = new Date(), cfg = worksConfig()) {
  const days = lifecycleDays(work.kind, work.started_at, cfg);
  return now.getTime() - new Date(work.started_at).getTime() >= days * 86400_000;
}

/**
 * 一个 companion 的档案换档（§7 PR-W1：完结→换新 + 槽位不满→建档）。
 * deps（全注入，可测）：{ generate, search, findCached, dailyUsed, dailyCap, now, rng,
 *   getActive, insert, setStatus, archiveFinished }
 *   generate(companion, existingTitles) → {kind,title,creator,genre,progressNote}
 * @returns 诊断 { finished, dropped, added, statusOfAdded }
 */
export async function ensureCurrentWorks(companion, deps = {}) {
  const cfg = deps.cfg || worksConfig();
  const now = deps.now || new Date();
  const rng = deps.rng || Math.random;
  const getActive = deps.getActive;     // (companionId) => rows
  const insert = deps.insert;           // ({...}) => id
  const setStatus = deps.setStatus;     // (workId, status)
  const out = { finished: 0, dropped: 0, added: 0, statusOfAdded: null };
  if (!getActive || !insert || !setStatus) throw new Error('ensureCurrentWorks 缺 db 注入');

  let active = getActive(companion.id) || [];
  // 1) 完结到点 → finished（小概率 dropped，真人不是每本都看完）
  for (const w of active) {
    if (isWorkFinished(w, now, cfg)) {
      const dropped = rng() < cfg.dropProb;
      setStatus(w.id, dropped ? 'dropped' : 'finished');
      if (deps.archiveFinished) { try { deps.archiveFinished(companion, w, dropped); } catch {} }
      dropped ? out.dropped++ : out.finished++;
    }
  }
  active = getActive(companion.id) || [];

  // 2) 槽位不满 → 生成候选 + 验证 + 入档（验证≤retries 次换候选，仍无→generic）
  if (active.length < cfg.maxActive && typeof deps.generate === 'function') {
    const existing = active.map(w => w.title);
    let chosen = null, evidence = null, statusFinal = 'generic', genre = null;
    for (let attempt = 0; attempt <= cfg.verifyRetries; attempt++) {
      const cand = await deps.generate(companion, existing);
      if (!cand || !cand.title) break;
      genre = cand.genre || genre;
      const v = await verifyWorkCandidate(cand, {
        search: deps.search, findCached: deps.findCached,
        dailyUsed: deps.dailyUsed, dailyCap: cfg.verifyDailyCap,
      });
      if (v.status === 'verified' || v.status === 'skip') {
        chosen = cand; evidence = v.evidence; statusFinal = v.status; break;
      }
      if (v.status === 'generic') { statusFinal = 'generic'; break; }   // provider 故障/日上限：止损
      existing.push(cand.title);   // retry：换一部
    }
    if (chosen) {
      insert(companion.id, {
        kind: chosen.kind, title: chosen.title, creator: chosen.creator,
        verifyStatus: statusFinal, verifyEvidence: evidence,
        progressNote: chosen.progressNote || null, startedAt: now.toISOString(),
      });
      out.statusOfAdded = statusFinal;
    } else {
      // 重试耗尽或生成器没出 → 降级泛读态入档（不指名，绝不虚构）
      const g = genre || '推理小说';
      insert(companion.id, {
        kind: 'book', title: g, creator: null, verifyStatus: 'generic',
        verifyEvidence: null, progressNote: null, startedAt: now.toISOString(),
      });
      out.statusOfAdded = 'generic';
    }
    out.added++;
  }
  return out;
}

// ─── 生产接线：真 LLM 生成候选 + 验证日上限计数 + 单 companion 换档 ───────────
function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/** 真 LLM 生成候选（题材从 hobbies 取）。返回 {kind,title,creator,genre,progressNote} 或 null。 */
export async function generateWorkCandidate(companion, existingTitles = []) {
  let hobbies = '';
  try { hobbies = JSON.parse(companion?.hobbies || '[]').join('、'); } catch {}
  const system = '你给一个 AI 伴侣生成"她最近在看/在做的一件真实存在的事"。只返回合法 JSON，不解释。';
  const prompt = `她的兴趣：${hobbies || '阅读、看剧'}。
已经在看的（别重复）：${(existingTitles || []).join('、') || '无'}。
生成一件她最近在看的**真实存在**的书/剧/番/游戏，或在做的手工(craft)。书优先填作者，剧/番填出品方。
返回 {"kind":"book|series|anime|game|craft","title":"真实存在的作品名(不要编)","creator":"作者或出品方(craft 填 null)","genre":"题材如 推理/科幻/治愈","progressNote":"进度一句话如 看到第三章"}`;
  try {
    const raw = await extractStructuredInfo(system, prompt, { accountId: companion?.user_id || null, maxTokens: 200, temperature: 0.8 });
    return extractJson(raw);
  } catch (e) {
    log('warn', `[CurrentWorks] 候选生成失败 companion=${companion?.id}: ${e.message}`);
    return null;
  }
}

// 验证日上限计数（app_settings，按上海日期 key；防异常循环烧 Tavily 配额）
function worksDailyKey(now) { return `works_verify_${new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)}`; }
function worksDailyUsed(now) { try { return Number(getAppSetting(worksDailyKey(now))) || 0; } catch { return 0; } }
function bumpWorksDaily(now) { try { setAppSetting(worksDailyKey(now), String(worksDailyUsed(now) + 1)); } catch {} }

/** 单 companion 换档（00:30 日程批顺路调；全程 fail-open，绝不阻断日程生成）。 */
export async function refreshCurrentWorks(companion, { now = new Date() } = {}) {
  const out = await ensureCurrentWorks(companion, {
    now,
    getActive: getActiveCurrentWorks, insert: insertCurrentWork, setStatus: setCurrentWorkStatus,
    generate: generateWorkCandidate,
    search: (q) => webSearch(q),
    findCached: findVerifiedWork,
    dailyUsed: worksDailyUsed(now),
  });
  if (out.added && out.statusOfAdded !== 'skip') bumpWorksDaily(now);   // 计一次验证额度（上限语义）
  return out;
}
