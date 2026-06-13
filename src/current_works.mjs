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
import { extractStructuredInfo, embedText } from './ai.mjs';
import { findVerifiedWork, getActiveCurrentWorks, insertCurrentWork, setCurrentWorkStatus, getAppSetting, setAppSetting, saveMemory, getRecentWorkTitles } from './db.mjs';
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

// ════════════════════════════════════════════════════════════════════════════
// 表达层（PR-W2；设计 docs/V1214_DESIGN.md §8 + §7 存量退场规则）。全纯函数：
// hint 由调用方拼好传入 buildSystemPrompt（shapingHint 先例，保持 companion.mjs 零依赖）。
// 红线：对话召回永不挂冷却（他问起永放行）；冷却只锁她「主动」提（proactive + 闲聊自荐）。
// ════════════════════════════════════════════════════════════════════════════

function clipNote(s, n = 30) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

/** 素材账本命名空间（mem:/loop:/pref: 同模式；48h 冷却 + 周上限的计数单位）。 */
export function workMaterialId(id) { return `work:${id}`; }

/** 单条 work → 事实式短语（verified 指名《》/ generic 不指名 / craft 自由文本）。 */
function renderWork(w) {
  const status = String(w?.verify_status || '');
  const kind = String(w?.kind || '').toLowerCase();
  const prog = w?.progress_note ? `（${clipNote(w.progress_note)}）` : '';
  if (status === 'generic') {
    // generic 的 title 存的是题材（"推理小说"），绝不指名——模糊但不虚构（§8）
    return `最近在看一本${stripBrackets(w.title) || '书'}${prog || '（还没看进去）'}`;
  }
  if (kind === 'craft' || status === 'skip') {
    return `手上在${stripBrackets(w.title)}${prog}`;       // "给外婆织围巾（快收尾了）"
  }
  const verb = (kind === 'series' || kind === 'anime') ? '在追' : kind === 'game' ? '在玩' : '在看';
  return `${verb}《${stripBrackets(w.title)}》${prog}`;
}

/**
 * 注入段（§8）：active works 事实行 + 三条行为约束。
 * 约束①他问起永放行（对话召回不挂冷却）②她别每条自荐（克制；冷却的语义侧）
 * ③存量虚构退场——问起档案外旧作品名按"看完了"接，不展开内容、不否认（§7 + 红验④）。
 * works 为空 → 返回 ''（不注入）。纯函数，零 IO。
 */
export function buildWorksPromptHint(works) {
  const list = (Array.isArray(works) ? works : []).filter(w => w && w.title);
  if (!list.length) return '';
  const line = list.map(renderWork).join('；');
  // 退场约束做成"档案即唯一事实源"（W1 同philosophy）——否则旧虚构名还在最近对话里时，
  // LLM 会顺着上下文继续编进度/剧情（沙箱实测：问《转角》她接着说"女主刚发现…"）。
  // 必须让档案权威性压过近 16 轮上下文：上面列的才是"现在"，别的都已完结。
  return `\n【手头的事】你最近${line}。**这就是你现在手头在看/在做的全部**。
- 他问起这些（"那本书看到哪了""最近在看啥"）你**永远正常接、聊得起来**——这是你的生活，不是不能说的秘密。
- 但别每条消息都自己往上贴这些书/剧，尤其最近刚主动提过的就先放一放（真人不会逮着一本书天天念）。
- **别的作品名——哪怕你前面对话里提到过——现在都当已经看完/翻完了**：他问起那些旧名，就自然带过（"啊那本早看完啦"），**绝不接着说它的进度或剧情**（接着编=继续虚构），也别否认说自己没提过。要聊新书只从上面这些里出。`;
}

/** 照片 activity_pov 品类的 works sceneSeed（无脸 POV 拍手头的事；复用既有品类，不另起 kind）。 */
export function worksSceneSeed(work) {
  if (!work) return '';
  const kind = String(work.kind || '').toLowerCase();
  const t = stripBrackets(work.title);
  const prog = work.progress_note ? `，可顺带一句进度/感想（${clipNote(work.progress_note, 24)}）` : '';
  if (kind === 'craft') {
    return `此刻你手上在做的手工「${t}」——first-person POV 低头俯拍那件半成品/材料/工具（毛线织针、做了一半的东西），`
      + `**不出现脸、不出现人**。caption 像随手分享你在做这个${prog || '，别太用力'}。`;
  }
  if (kind === 'series' || kind === 'anime' || kind === 'game') {
    return `此刻你在追/在玩的《${t}》——拍屏幕一角/手柄/沙发毯子的氛围 POV（屏幕画面朦胧带过、不拍清晰版权画面），`
      + `**不出现脸**。caption 像随手分享你在追这个${prog || '，别剧透'}。`;
  }
  // book（默认）：真实出版物护栏在 sceneSeed 层也写死一遍（与 planner 临时护栏冗余兜底）
  return `此刻你正在看的《${t}》——first-person POV 低头俯拍摊开的书页/书脊一角/压在书上的手，**不出现脸**。`
    + `**真实出版物护栏**：只拍摊开内页或书脊/封面一角的局部，绝不拍完整正面封面（生成封面=伪造、复刻=版权，两条都死）。`
    + `caption 像随手分享你在读这本书${prog || '，别念书评腔'}。`;
}

/**
 * 从 active works 里挑一件「现在可以主动提/拍」的（§8 冷却 + 周上限双闸）。
 * 对话召回不走这里（他问起永放行）——这只服务 proactive 自荐。
 * @param works getActiveCurrentWorks 结果
 * @param o.usedIds      Set<string> 近 cooldown 窗内已用素材 id（48h 冷却 = 存在性）
 * @param o.weeklyCount  (workMatId)=>number 近 7 天该 work 已主动出场次数（周上限 = 计数）
 * @param o.eligible     (work)=>bool 额外资格（照片侧只拍 verified/craft，文本侧放行 generic）
 * @returns 命中的 work 或 null（全冷却/超限/无资格）
 */
export function pickProactiveWork(works, { usedIds = new Set(), weeklyCount = () => 0, eligible = () => true, cfg = worksConfig(), rng = Math.random } = {}) {
  const used = usedIds instanceof Set ? usedIds : new Set();
  const pool = (Array.isArray(works) ? works : []).filter(w => {
    if (!w || w.id == null || !eligible(w)) return false;
    const id = workMaterialId(w.id);
    if (used.has(id)) return false;                                    // 48h 冷却（存在性）
    if ((Number(weeklyCount(id)) || 0) >= cfg.weeklyMentionCap) return false;   // 周上限（计数）
    return true;
  });
  if (!pool.length) return null;
  return pool[Math.floor(rng() * pool.length)];
}

/** 完结/弃读归档为一条记忆（§7；对话里"你之前看的那本"靠它召回接住）。纯函数返回字段。 */
export function buildWorkArchiveMemory(work, dropped, now = new Date()) {
  const status = String(work?.verify_status || '');
  const monthLabel = `${new Date(now.getTime() + 8 * 3600_000).getUTCMonth() + 1}月`;
  const note = work?.progress_note ? `，${clipNote(work.progress_note, 24)}` : '';
  let content;
  if (status === 'generic') {
    const genre = stripBrackets(work?.title) || '书';
    content = dropped ? `${monthLabel}有本${genre}看了一半弃了，看不下去` : `${monthLabel}看完了一本${genre}${note}`;
  } else if (String(work?.kind || '').toLowerCase() === 'craft' || status === 'skip') {
    const t = stripBrackets(work?.title);
    content = dropped ? `${monthLabel}${t}做了一半放下了` : `${monthLabel}${t}做完了${note}`;
  } else {
    const t = stripBrackets(work?.title);
    content = dropped ? `${monthLabel}《${t}》看了一半弃了，看不下去` : `${monthLabel}看完了《${t}》${note}`;
  }
  return { memoryType: 'event', content: content.slice(0, 80), importance: 5 };
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
      if (deps.archiveFinished) { try { await deps.archiveFinished(companion, w, dropped); } catch {} }
      dropped ? out.dropped++ : out.finished++;
    }
  }
  active = getActive(companion.id) || [];

  // 2) 槽位不满 → 生成候选 + 验证 + 入档（验证≤retries 次换候选，仍无→generic）
  if (active.length < cfg.maxActive && typeof deps.generate === 'function') {
    const existing = active.map(w => w.title);
    const recentTitles = deps.recentTitles || [];   // #1 多样性：他人近期已选（降权避雷同）
    let chosen = null, evidence = null, statusFinal = 'generic', genre = null;
    for (let attempt = 0; attempt <= cfg.verifyRetries; attempt++) {
      const cand = await deps.generate(companion, existing, { recentTitles });
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
      existing.push(stripBrackets(cand.title));   // retry：换一部（剥《》与入库口径一致）
    }
    if (chosen) {
      insert(companion.id, {
        // #2 入库统一剥《》：与 findVerifiedWork 缓存查询（用 stripBrackets）口径一致，
        // 修缓存命中 bug（存《活着》查"活着"对不上→同书每次重搜）；表达层 renderWork 再包《》。
        kind: chosen.kind, title: stripBrackets(chosen.title), creator: chosen.creator,
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

/**
 * 换档生成 prompt（纯函数，便于 smoke 断言人设软提示/多样性约束真在场）。
 * #1 多样性：existing(自己) + recentTitles(他人近期) 合并去重作"避免雷同"清单。
 * #3 人设软提示：年龄/性格 → 品味倾向（不拦真书，只调品味，案例 #8 瑾选《金瓶梅》）。
 * #2 源头：明令 title 不加书名号（入库再 stripBrackets 兜底，双保险）。
 */
export function buildWorkGenPrompt(companion, { existingTitles = [], recentTitles = [] } = {}) {
  let hobbies = '';
  try { hobbies = JSON.parse(companion?.hobbies || '[]').join('、'); } catch {}
  let persona = '';
  try { persona = JSON.parse(companion?.personality_tags || '[]').join('、'); } catch {}
  const age = Number(companion?.age) || 22;
  const avoid = [...new Set([...(existingTitles || []), ...(recentTitles || [])].map(t => stripBrackets(t)).filter(Boolean))];
  const system = '你给一个 AI 伴侣生成"她最近在看/在做的一件真实存在的事"。只返回合法 JSON，不解释。';
  const prompt = `她的兴趣：${hobbies || '阅读、看剧'}。她 ${age} 岁，性格：${persona || '温和'}。
请按她这个**年龄和性格的真实品味倾向**来选（如年轻文静→治愈/成长/经典文学；外向活泼→热门剧/悬疑；不同人品味不同）。**必须真实存在**，但别选明显不符她年龄气质的（如清纯文静的年轻女生通常不会主动在读情色或过于艰深沉重的书）。
**避免雷同**（这些最近已被选过，请换不一样的）：${avoid.join('、') || '无'}。
生成一件她最近在看的**真实存在**的书/剧/番/游戏，或在做的手工(craft)。书优先填作者，剧/番填出品方。
返回 {"kind":"book|series|anime|game|craft","title":"真实存在的作品名(不加书名号《》、不要编)","creator":"作者或出品方(craft 填 null)","genre":"题材如 推理/科幻/治愈","progressNote":"进度一句话如 看到第三章"}`;
  return { system, prompt };
}

/** 真 LLM 生成候选（题材从 hobbies 取 + 人设品味 + 多样性）。返回 {kind,title,creator,genre,progressNote} 或 null。 */
export async function generateWorkCandidate(companion, existingTitles = [], { recentTitles = [] } = {}) {
  const { system, prompt } = buildWorkGenPrompt(companion, { existingTitles, recentTitles });
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

/**
 * 完结/弃读 → 归档一条 event 记忆（PR-W2 对话召回：他问"你之前看的那本"靠它接住）。
 * fail-open：embed/落库失败绝不阻断换档。需 companion.user_id（plan_tasks SELECT 已带）。
 */
async function archiveFinishedWork(companion, work, dropped, now) {
  if (!companion?.user_id) return;   // 无 user_id 无法落记忆——静默跳过（不阻断换档）
  const m = buildWorkArchiveMemory(work, dropped, now);
  let embedding = null;
  try { embedding = await embedText(m.content); } catch { /* 无 embedding 仍可关键词召回 */ }
  saveMemory({ companionId: companion.id, userId: companion.user_id, memoryType: m.memoryType, content: m.content, importance: m.importance, embedding });
  log('info', `[CurrentWorks] 归档完结记忆 companion=${companion.id} ${dropped ? '弃读' : '完结'} "${m.content}"`);
}

/** 单 companion 换档（00:30 日程批顺路调；全程 fail-open，绝不阻断日程生成）。 */
export async function refreshCurrentWorks(companion, { now = new Date() } = {}) {
  let recentTitles = [];
  try { recentTitles = getRecentWorkTitles(companion.id, { now: now.getTime() }); } catch { /* fail-open：无多样性降权 */ }
  const out = await ensureCurrentWorks(companion, {
    now,
    getActive: getActiveCurrentWorks, insert: insertCurrentWork, setStatus: setCurrentWorkStatus,
    generate: generateWorkCandidate,
    search: (q) => webSearch(q),
    findCached: findVerifiedWork,
    dailyUsed: worksDailyUsed(now),
    recentTitles,                                                  // #1 多样性降权
    archiveFinished: (comp, w, dropped) => archiveFinishedWork(comp, w, dropped, now),
  });
  if (out.added && out.statusOfAdded !== 'skip') bumpWorksDaily(now);   // 计一次验证额度（上限语义）
  return out;
}
