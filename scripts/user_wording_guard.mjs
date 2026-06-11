/**
 * 称呼泄漏门禁（v1.21.3 PR-A，进 CI）。
 *
 * 背景：dashboard 专属梗卡片曾显示"用户喜欢逗我玩"——"用户"二字被抽取管线
 * 写进数据；多个 prompt 还在教 LLM 用"用户"指代对方。三层防线：
 *   1. 静态扫描：src prompt 层 + 用户可见页面，非注释行的"用户"必须在豁免清单
 *      （新增泄漏 → CI 红）
 *   2. 写入端功能测：四个写入口（memory/shaping/preference/open_loop）灌入
 *      含"用户"文本，读回必须已重写为称呼/他；保护词（用户名/用户协议）不误伤
 *   3. 红色验证：对改造前的 prompt 样本跑同一判定，必须能抓到
 *
 * 豁免原则（每条要有理由）：
 *   - 注释/日志：不进 LLM、用户不可见
 *   - minor_guard：安全判定 prompt，输出 yes/no 不进台词，措辞不动防判定漂移
 *   - 禁令行自身（"绝不写'用户'"）与检测器/护栏自身定义
 *   - event_graph regex：兼容存量老数据的"用户喜欢X"格式
 *   - admin 系页面：运营者视角，"用户"更清晰
 *   - terms/privacy 正文："用户"是法律文书被定义术语
 */
process.env.DB_PATH = '/tmp/user_wording_guard.db';
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

// ─── 1. 静态扫描 ────────────────────────────────────────────────────────────

// 全文件豁免（写明理由）
const SRC_FILE_EXEMPT = new Set([
  'minor_guard.mjs',    // 安全判定 prompt：输出 yes/no 不进台词，改措辞有判定漂移风险
  'admin.mjs',          // 运营后台
  'privacy_filter.mjs', // 护栏自身（USER_WORD_PROTECTED 定义）
  'ai_taste_guard.mjs', // 检测器自身
]);
// 行级豁免：行内含任一子串即放行（禁令自身 / 兼容 regex / 反例话术）
const SRC_LINE_EXEMPT = [
  "绝不写'用户'", '绝不写"用户"',                  // 提取 prompt 里的禁令
  '不要写"用户/对方/他',                            // backstory 禁忌清单
  '(?:我|用户|他)', '提醒(?:我|用户|他)',           // event_graph 兼容老数据 regex
  '用户需求、技术架构、产品定位',                   // AI 味反例话术（教她别说的）
  "'弱答应 + 用户在要看'",                          // photo_intent 内部 reason（进日志）
];
// 系统层 API 响应（auth/admin 错误消息）：账号语境不是她的台词，不算穿帮路径
const SRC_SYSTEM_CALLS = /authErr\(|err\(res,|ok\(res,|res\.status\(|new Error\(|note:/;

function isCommentOrLogLine(line, idxOfUser) {
  const t = line.trimStart();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return true;
  if (t.startsWith('--')) return true;                       // SQL 模板字符串内注释
  const slashes = line.indexOf('//');
  if (slashes !== -1 && slashes < idxOfUser) return true;    // 行尾注释里
  const sqlComment = line.indexOf('--');
  if (sqlComment !== -1 && sqlComment < idxOfUser) return true;  // SQL 行尾注释
  if (/\blog\s*\(|console\.(log|warn|error)/.test(line)) {
    // 日志行：仅当"用户"出现在日志调用之后才豁免（不进 LLM、用户不可见）
    const logIdx = line.search(/\blog\s*\(|console\./);
    if (logIdx !== -1 && logIdx < idxOfUser) return true;
  }
  return false;
}

function scanSrcFile(file, src) {
  const leaks = [];
  src.split('\n').forEach((line, i) => {
    let l = line;
    for (const w of ['用户协议', '用户名']) l = l.split(w).join('');   // 表单/法律词组
    const idx = l.indexOf('用户');
    if (idx === -1) return;
    if (isCommentOrLogLine(l, idx)) return;
    if (SRC_LINE_EXEMPT.some(e => line.includes(e))) return;
    if (SRC_SYSTEM_CALLS.test(l) && l.search(SRC_SYSTEM_CALLS) < idx) return;
    leaks.push(`${file}:${i + 1}: ${line.trim().slice(0, 80)}`);
  });
  return leaks;
}

const srcLeaks = [];
for (const f of readdirSync(new URL('../src', import.meta.url))) {
  if (!f.endsWith('.mjs') || SRC_FILE_EXEMPT.has(f)) continue;
  srcLeaks.push(...scanSrcFile(`src/${f}`, readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')));
}
if (srcLeaks.length) srcLeaks.forEach(l => console.log('  泄漏:', l));
ok(srcLeaks.length === 0, `src prompt 层零"用户"泄漏（豁免项除外），发现 ${srcLeaks.length} 处`);

// 用户可见页面
const PAGE_EXEMPT_FILES = new Set([
  'admin.html', 'admin-user-profile.html',  // 运营后台
  'emotion-debug.html',                      // 运维 debug 面板
  'terms.html', 'privacy.html',              // 法律文书正文："用户"是被定义术语
]);
const PAGE_PROTECTED = ['用户协议', '用户名'];  // 法律文书名 / 表单术语

function scanPage(file, src) {
  const leaks = [];
  src.split('\n').forEach((line, i) => {
    let l = line;
    for (const w of PAGE_PROTECTED) l = l.split(w).join('');
    const idx = l.indexOf('用户');
    if (idx === -1) return;
    const t = l.trimStart();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('<!--')) return;
    const slashes = l.indexOf('//');
    if (slashes !== -1 && slashes < idx && !/https?:/.test(l.slice(slashes - 6, slashes))) return;
    const blockComment = l.indexOf('/*');
    if (blockComment !== -1 && blockComment < idx) return;   // 行中块注释
    leaks.push(`${file}:${i + 1}: ${line.trim().slice(0, 80)}`);
  });
  return leaks;
}

const pageLeaks = [];
pageLeaks.push(...scanPage('public/index.html', readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')));
for (const f of readdirSync(new URL('../public/app', import.meta.url))) {
  if (!f.endsWith('.html') || PAGE_EXEMPT_FILES.has(f)) continue;
  pageLeaks.push(...scanPage(`public/app/${f}`, readFileSync(new URL(`../public/app/${f}`, import.meta.url), 'utf8')));
}
if (pageLeaks.length) pageLeaks.forEach(l => console.log('  泄漏:', l));
ok(pageLeaks.length === 0, `用户可见页面零"用户"残留（豁免项除外），发现 ${pageLeaks.length} 处`);

// ─── 2. 红色验证：改造前样本必须被抓到 ─────────────────────────────────────
const OLD_SAMPLES = [
  `  "content": "20字内简洁描述（第三人称：'用户...'）",`,      // 旧 MEMORY_SYSTEM_PROMPT
  `  { word: '橘猫', memory: '用户养了一只橘猫', pet: '橘猫' },`, // 旧确定性模板
  '        systemPrompt += `\\n\\n【★★ 用户向你告白，而且你愿意接受！】',  // 旧 bot 注入段
];
const redHits = scanSrcFile('red_check.mjs', OLD_SAMPLES.join('\n'));
ok(redHits.length === OLD_SAMPLES.length, `红色验证：改造前 ${OLD_SAMPLES.length} 条样本全部被扫描抓到（实抓 ${redHits.length}）`);

// ─── 3. 写入端功能测（临时 DB 真函数）──────────────────────────────────────
const { getDb, saveMemory, upsertShaping, upsertPreference, saveOpenLoop, listShaping } =
  await import('../src/db.mjs');
const db = getDb();
db.pragma('foreign_keys = OFF');
db.prepare("INSERT INTO users (id, wechat_user_id) VALUES (1, 'wxu_1')").run();
db.prepare("INSERT INTO companions (id, user_id, bot_id, name) VALUES (7, 1, 'b', '溪')").run();
db.prepare("INSERT INTO companions (id, user_id, bot_id, name) VALUES (8, 1, 'b', '语')").run();

// 7 号无教过的称呼 → 兜底"他"
saveMemory({ companionId: 7, userId: 1, memoryType: 'preference', content: '用户喜欢逗我玩', importance: 5 });
const m7 = db.prepare("SELECT content FROM companion_memories WHERE companion_id = 7").get();
ok(m7?.content === '他喜欢逗我玩', `saveMemory 重写为"他"（实际：${m7?.content}）`);

// 8 号教过称呼"老公" → 用称呼
upsertShaping({ companionId: 8, kind: 'nickname', content: '老公' });
upsertShaping({ companionId: 8, kind: 'lexicon', content: '用户喜欢逗我玩' });
const s8 = listShaping(8, { kind: 'lexicon' })[0];
ok(s8?.content === '老公喜欢逗我玩', `upsertShaping 重写为教过的称呼（实际：${s8?.content}）`);

upsertPreference({ companionId: 7, type: 'like', target: '辣条', reason: '用户说他爱吃' });
const p7 = db.prepare("SELECT reason FROM companion_preferences WHERE companion_id = 7").get();
ok(p7?.reason === '他说他爱吃', `upsertPreference reason 重写（实际：${p7?.reason}）`);

saveOpenLoop({ companionId: 7, title: '用户明天要面试', emotionalWeight: 8 });
const l7 = db.prepare("SELECT title FROM companion_open_loops WHERE companion_id = 7").get();
ok(l7?.title === '他明天要面试', `saveOpenLoop title 重写（实际：${l7?.title}）`);

// 保护词不误伤
saveMemory({ companionId: 7, userId: 1, memoryType: 'fact', content: '他忘了自己的用户名', importance: 5 });
const m7b = db.prepare("SELECT content FROM companion_memories WHERE companion_id = 7 ORDER BY id DESC").get();
ok(m7b?.content === '他忘了自己的用户名', `保护词"用户名"不误伤（实际：${m7b?.content}）`);

// 台词侧检测项（ai_taste_guard）
const { detectAiTaste } = await import('../src/ai_taste_guard.mjs');
ok(detectAiTaste('作为你的专属伴侣，用户你今天开心吗').hits.some(h => h.type === 'user_wording_leak'),
   '台词含"用户"被 ai_taste 标记为 user_wording_leak');
ok(!detectAiTaste('今天有点想你').hits.some(h => h.type === 'user_wording_leak'),
   '正常台词不误报');

console.log(`\nuser_wording_guard: ${pass} passed, ${fail} failed`);
for (const suf of ['', '-wal', '-shm']) { try { unlinkSync(process.env.DB_PATH + suf); } catch {} }
process.exit(fail ? 1 : 0);
