/**
 * reality_facts.mjs — 统一「★真实世界」事实层（v1.21.4 PR-W3，零 API、零依赖）。
 *
 * 设计 §9：把零散的月相/日落 + 新增节气/节日收编成**一段统一注入**——"她的世界经得起
 * 现实查证"的统一地基。注入口 = proactive + photo_planner（月相原已踩好的位置）。
 *
 * 核心红线（与 current_works「档案即事实源」同纪律）：**prompt 只引用真实事实层，字段
 * 拿不到就不提，绝不让 LLM 补位编造**——无节日的日子绝不凭空说"今天是 XX 节"。
 *
 * ★ life_state 预留位（v1.22）：buildRealityFacts 的 extraFacts 槽即未来「身体事实」注入点
 *   （生病/疲惫/生理期作为同类"经得起查证的事实"挂此）——W5 在日程层留位、W3 在事实层
 *   留位，两位齐备后 life_state 落地直接挂载，不另造框架。本任务只收编 works 无关的天象/
 *   历法事实，不写 life_state 代码。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { solarTermOnDate, nextSolarTerm } from './solar_terms.mjs';
import { lunarFestivalOnDate } from './lunar_festivals.mjs';
import { moonFactLine, moonPhase } from './moon_phase.mjs';
import { sunsetFactLine, cityLatLon } from './sun_times.mjs';

// 公历固定节日（与 companion.buildTimeAwarenessBlock 同口径；清明走节气不在此）
const SOLAR_HOLIDAYS = {
  '01-01': '元旦', '02-14': '情人节', '03-08': '妇女节', '05-01': '劳动节',
  '05-20': '520', '06-01': '儿童节', '10-01': '国庆节', '12-24': '平安夜',
  '12-25': '圣诞节', '12-31': '跨年夜',
};

function shanghaiMD(date) {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(5, 10);
}
function shanghaiHour(date) {
  return (new Date(date.getTime() + 8 * 3600_000)).getUTCHours();
}

/** 今天（上海）是不是节日 → 节日名或 ''（公历固定 + 农历 + 清明节气；只报真实存在的）。 */
export function festivalOnDate(date = new Date()) {
  const md = shanghaiMD(date);
  if (SOLAR_HOLIDAYS[md]) return SOLAR_HOLIDAYS[md];
  const lunar = lunarFestivalOnDate(date);                 // 春节/元宵/端午/中秋/重阳
  if (lunar) return lunar;
  const term = solarTermOnDate(date);
  if (term && term.name === '清明') return '清明';          // 清明既是节气也是节日
  return '';
}

/** 今天的节气短语（当日节气 / 临近 ≤2 天 / 否则 ''）——本层自己判，避免 import 循环歧义。 */
function termPhrase(date) {
  const on = solarTermOnDate(date);
  if (on) return on.name;
  const nx = nextSolarTerm(date);
  if (nx && nx.daysUntil <= 2) return `快到${nx.name}`;
  return '';
}

/**
 * 统一「★真实世界」注入段（单一来源）。**只拼真实存在的字段，拿不到的绝不编造。**
 * @param {object} o
 *   includeNightSky 夜间场景才注入月相（白天零开销）
 *   includeSunset   黄昏场景才注入日落
 *   extraFacts      ★ life_state 预留槽：未来「身体事实」字符串数组在此并列注入（本任务为空）
 * @returns {string} 注入段；无任何字段 → ''（不注入空壳）
 */
export function buildRealityFacts(date = new Date(), { includeNightSky = false, includeSunset = false, loc, extraFacts = [] } = {}) {
  const today = [];
  const term = termPhrase(date);
  const festival = festivalOnDate(date);
  if (term) today.push(term);
  if (festival && festival !== term) today.push(festival);   // 清明可能两边都中，去重

  const segs = [];
  if (today.length) segs.push(`今天：${today.join('，')}`);
  if (includeNightSky) {
    const m = moonPhase(date);
    if (m) segs.push(moonFactLine(date).replace(/^今晚/, '今晚'));   // moonFactLine 自带"今晚月相："
  }
  if (includeSunset) {
    const s = sunsetFactLine(date, loc || cityLatLon());
    if (s) segs.push(s.trim());
  }
  // ★ life_state 预留位：未来「身体事实」（生病/疲惫/生理期）在此并列——本任务 extraFacts 恒空
  for (const f of (Array.isArray(extraFacts) ? extraFacts : [])) if (f) segs.push(String(f));

  if (!segs.length) return '';
  // 节日（非仅节气）当天：温和倾向应个景（北极星"在空隙给温柔"），但不喊口号不硬塞。
  const festNudge = festival
    ? `\n今天是${festival}——主动找他时**适合自然应个景**（一句节日的温柔/应景小事，如"冬至记得喝碗热的""中秋月亮真圆"），但别喊口号、别硬塞、别像群发祝福。`
    : '';
  return `【★ 真实世界（经得起查证，绝不编造；没有的字段就不提）】${segs.join('；')}。`
    + festNudge
    + `\n这些是真实历法/天象事实，可自然带入；但**绝不要在没有节日/节气的日子凭空说"今天是 XX 节"**——没写的就当没有。`;
}

/** 简洁版：今天的节气+节日名（去重，'冬至' / '中秋' / '冬至，中秋' / ''）——photo caption 等只要名。 */
export function realityDateFacts(date = new Date()) {
  const out = [];
  const term = termPhrase(date);
  const festival = festivalOnDate(date);
  if (term) out.push(term);
  if (festival && festival !== term) out.push(festival);
  return out.join('，');
}

/** 便捷：当前是否夜间（19:00-05:00 上海）——注入端决定要不要带月相。 */
export function isNightShanghai(date = new Date()) {
  const h = shanghaiHour(date);
  return h >= 19 || h < 5;
}
