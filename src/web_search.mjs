/**
 * 联网搜索提供商抽象
 *
 * 支持的 provider：
 *   - tavily   AI 友好，1000/月免费，返回直接可用 JSON（推荐）
 *   - serpapi  老牌，100/月免费
 *   - brave    Brave Search，2000/月免费
 *   - searxng  自托管元搜索（无 API key，需 base URL）
 *
 * 配置优先级：
 *   1. process.env.SEARCH_PROVIDER / <PROVIDER>_API_KEY / SEARXNG_BASE_URL
 *   2. app_settings 同名 key（由 /app/setup.html 写入）
 *   3. 未配置时 enabled=false，对话流程跳过搜索
 *
 * 使用：
 *   - shouldSearch(query) -> 纯规则判断是否需要联网
 *   - webSearch(query)    -> 触发实际搜索，返回 [{title, url, snippet}]
 *   - testSearchProvider(name) -> 给 Setup Wizard 测试连通
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { getAppSetting } from './db.mjs';

// ─── Provider 注册表 ───────────────────────────────────────────────────────
export const REGISTRY = {
  tavily: {
    apiKeyEnv: 'TAVILY_API_KEY',
    label: 'Tavily（推荐，AI 友好）',
    link: 'https://app.tavily.com/',
    note: '注册送 1000 次/月',
  },
  serpapi: {
    apiKeyEnv: 'SERPAPI_API_KEY',
    label: 'SerpAPI',
    link: 'https://serpapi.com/',
    note: '免费 100 次/月',
  },
  brave: {
    apiKeyEnv: 'BRAVE_SEARCH_API_KEY',
    label: 'Brave Search',
    link: 'https://api-dashboard.search.brave.com/',
    note: '免费 2000 次/月',
  },
  searxng: {
    apiKeyEnv: '',  // 无 key
    baseURLEnv: 'SEARXNG_BASE_URL',
    label: 'SearXNG（自托管）',
    link: 'https://docs.searxng.org/',
    note: '自托管元搜索，填写实例 URL 即可',
    custom: true,
  },
};

// ─── 动态读取 env / app_settings ──────────────────────────────────────────
function readSetting(key) {
  if (!key) return '';
  if (process.env[key]) return process.env[key];
  try {
    const v = getAppSetting(key);
    if (v) return v;
  } catch {}
  return '';
}

function getActiveProviderName() {
  return (readSetting('SEARCH_PROVIDER') || '').toLowerCase();
}
function getApiKeyForEntry(entry) {
  return entry?.apiKeyEnv ? readSetting(entry.apiKeyEnv) || null : null;
}
function getBaseURLForEntry(entry) {
  return entry?.baseURLEnv ? readSetting(entry.baseURLEnv) || null : null;
}

export function getActiveSearchProvider() {
  const name = getActiveProviderName();
  if (!name) return { id: '', label: '', configured: false };
  const entry = REGISTRY[name];
  if (!entry) return { id: name, label: '(未知)', configured: false };
  const apiKey = getApiKeyForEntry(entry);
  const baseURL = getBaseURLForEntry(entry);
  const configured = entry.custom ? Boolean(baseURL) : Boolean(apiKey);
  return { id: name, label: entry.label, configured };
}

// ─── 触发判定（纯规则，不消耗 LLM token） ──────────────────────────────────
// 同时命中「时效词 / 实时信息词」+「询问语气」才认为需要搜。
// 闲聊场景（"今天好累 / 今天天气真好"）不会误触。
const TIME_SENSITIVE = [
  '今天','明天','昨天','现在','刚刚','刚才','最近','目前','此刻','当前',
  '今年','明年','今晚','今早','今晨','这几天','这周','本周','上周','本月','最新',
  'today','tomorrow','now','currently','latest','recent','breaking',
];
const FRESH_TOPICS = [
  '新闻','消息','发生','宣布','发布','上线','开播','直播','开赛','获奖',
  '股价','汇率','票价','比分','赛果','排行','榜单','票房','排名',
  '天气','气温','下雨','晴','阴','风力','空气质量','aqi',
  '机票','航班','车票','高铁','地铁','延误','取消','停运',
  '热搜','热议','热点','热门','最火',
  'news','breaking','price','score','weather','forecast',
];
const QUESTIONY = [
  '什么','啥','怎么','咋','怎样','为啥','为何','多少','几个','几点','谁','哪','吗','呢',
  '?', '？',
  'what','how','when','where','who','why','which',
];

/**
 * 判断 query 是否值得发起一次联网搜索。
 * 返回 { search: boolean, reason: string }（reason 仅用于日志）。
 */
export function shouldSearch(query) {
  if (!query || typeof query !== 'string') return { search: false, reason: 'empty' };
  if (query.length < 3 || query.length > 400) return { search: false, reason: 'length' };

  const provider = getActiveSearchProvider();
  if (!provider.configured) return { search: false, reason: 'not_configured' };

  const lc = query.toLowerCase();
  const hasTime    = TIME_SENSITIVE.some(w => lc.includes(w));
  const hasFresh   = FRESH_TOPICS.some(w => lc.includes(w));
  const hasQuery   = QUESTIONY.some(w => lc.includes(w));

  // 同时命中时效 + 询问，或同时命中实时主题 + 询问，才搜。
  if ((hasTime || hasFresh) && hasQuery) {
    return { search: true, reason: hasTime ? 'time+query' : 'fresh+query' };
  }
  return { search: false, reason: 'no_match' };
}

// ─── 各 provider 抓取实现 ─────────────────────────────────────────────────
async function tavilySearch(apiKey, query, { maxResults = 5, signal } = {}) {
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: 'basic',
    }),
    signal,
  });
  if (!resp.ok) throw new Error(`Tavily HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return (data.results || []).map((r) => ({
    title:   String(r.title   || '').slice(0, 200),
    url:     String(r.url     || ''),
    snippet: String(r.content || '').slice(0, 500),
  }));
}

async function serpapiSearch(apiKey, query, { maxResults = 5, signal } = {}) {
  const url = `https://serpapi.com/search?engine=google&q=${encodeURIComponent(query)}&num=${maxResults}&api_key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`SerpAPI HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return (data.organic_results || []).slice(0, maxResults).map((r) => ({
    title:   String(r.title   || '').slice(0, 200),
    url:     String(r.link    || ''),
    snippet: String(r.snippet || '').slice(0, 500),
  }));
}

async function braveSearch(apiKey, query, { maxResults = 5, signal } = {}) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const resp = await fetch(url, {
    headers: { 'X-Subscription-Token': apiKey, accept: 'application/json' },
    signal,
  });
  if (!resp.ok) throw new Error(`Brave HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return (data.web?.results || []).slice(0, maxResults).map((r) => ({
    title:   String(r.title       || '').slice(0, 200),
    url:     String(r.url         || ''),
    snippet: String(r.description || '').slice(0, 500),
  }));
}

async function searxngSearch(baseURL, query, { maxResults = 5, signal } = {}) {
  const trimmed = baseURL.replace(/\/$/, '');
  const url = `${trimmed}/search?q=${encodeURIComponent(query)}&format=json`;
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`SearXNG HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return (data.results || []).slice(0, maxResults).map((r) => ({
    title:   String(r.title   || '').slice(0, 200),
    url:     String(r.url     || ''),
    snippet: String(r.content || '').slice(0, 500),
  }));
}

// ─── 统一入口 ──────────────────────────────────────────────────────────────
/**
 * 触发实际网络搜索。如果未配置或失败，返回 { ok:false, results:[] }，调用方
 * 自行决定是否回退到无搜索的回复（一般直接忽略，对用户透明）。
 *
 * @param {string} query
 * @param {{ maxResults?: number, timeoutMs?: number }} opts
 * @returns {Promise<{ok:boolean, results:Array<{title:string,url:string,snippet:string}>, provider:string, latency_ms:number, error?:string}>}
 */
export async function webSearch(query, { maxResults = 5, timeoutMs = 8000 } = {}) {
  const name = getActiveProviderName();
  if (!name) return { ok: false, results: [], provider: '', latency_ms: 0, error: 'no_provider' };
  const entry = REGISTRY[name];
  if (!entry) return { ok: false, results: [], provider: name, latency_ms: 0, error: 'unknown_provider' };
  const apiKey  = getApiKeyForEntry(entry);
  const baseURL = getBaseURLForEntry(entry);
  if (entry.custom && !baseURL) return { ok: false, results: [], provider: name, latency_ms: 0, error: 'missing_base_url' };
  if (!entry.custom && !apiKey) return { ok: false, results: [], provider: name, latency_ms: 0, error: 'missing_api_key' };

  const t0 = Date.now();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let results = [];
    if (name === 'tavily')        results = await tavilySearch(apiKey, query, { maxResults, signal: controller.signal });
    else if (name === 'serpapi')  results = await serpapiSearch(apiKey, query, { maxResults, signal: controller.signal });
    else if (name === 'brave')    results = await braveSearch(apiKey, query, { maxResults, signal: controller.signal });
    else if (name === 'searxng')  results = await searxngSearch(baseURL, query, { maxResults, signal: controller.signal });
    else throw new Error(`unknown provider: ${name}`);

    log('info', `[web_search] provider=${name} query="${query.slice(0,60)}" hits=${results.length} latency=${Date.now()-t0}ms`);
    return { ok: true, results, provider: name, latency_ms: Date.now() - t0 };
  } catch (e) {
    log('warn', `[web_search] provider=${name} failed: ${e.message}`);
    return { ok: false, results: [], provider: name, latency_ms: Date.now() - t0, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

/**
 * 把搜索结果格式化为可以塞进 system prompt 的简短段落。
 * 控制长度防止挤爆 prompt 预算。
 */
export function formatSearchContext(query, results, { maxChars = 1500 } = {}) {
  if (!results || results.length === 0) return '';
  let body = `## 联网搜索辅助信息\n用户提到时效相关话题。系统刚抓了一次搜索结果，供你参考（不是必须用）。\n查询：${query}\n\n`;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const block = `[${i+1}] ${r.title}\n${r.snippet}\n${r.url ? '来源：' + r.url + '\n' : ''}\n`;
    if (body.length + block.length > maxChars) break;
    body += block;
  }
  body += '请把以上信息自然地融进口语化的回复，不要照搬链接，不要说"我搜了一下"。';
  return body;
}

/**
 * Setup Wizard 测试用：发一次极短查询，验证 provider 通。
 */
export async function testSearchProvider(name) {
  const entry = REGISTRY[name];
  if (!entry) throw new Error(`未知 search provider: ${name}`);
  const apiKey = getApiKeyForEntry(entry);
  const baseURL = getBaseURLForEntry(entry);
  if (entry.custom && !baseURL) throw new Error(`${entry.label} 的 ${entry.baseURLEnv} 未配置`);
  if (!entry.custom && !apiKey) throw new Error(`${entry.label} 的 ${entry.apiKeyEnv} 未配置`);

  const t0 = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    let results = [];
    if (name === 'tavily')        results = await tavilySearch(apiKey, 'hello world', { maxResults: 1, signal: controller.signal });
    else if (name === 'serpapi')  results = await serpapiSearch(apiKey, 'hello world', { maxResults: 1, signal: controller.signal });
    else if (name === 'brave')    results = await braveSearch(apiKey, 'hello world', { maxResults: 1, signal: controller.signal });
    else if (name === 'searxng')  results = await searxngSearch(baseURL, 'hello world', { maxResults: 1, signal: controller.signal });
    else throw new Error(`unknown provider: ${name}`);
    return { ok: true, provider: name, label: entry.label, latency_ms: Date.now() - t0, hits: results.length };
  } finally {
    clearTimeout(timeout);
  }
}
