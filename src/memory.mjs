/**
 * memory.mjs
 * 长期记忆 / 情绪状态 / 好感度 / 用户画像 自动处理
 *
 * 所有 extract* 函数调用 DeepSeek，应在回复发送后异步执行（非阻塞）。
 * 所有 update* 规则函数是同步的，可直接调用。
  *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import {
  saveMemories, recallMemories as dbRecall,
  patchCompanion, getUserProfile, upsertUserProfile,
  saveStageMilestone,
} from './db.mjs';
import { extractStructuredInfo, embedText } from './ai.mjs';

// ─── 关系阶段阈值 ─────────────────────────────────────────────────────────────
export function computeRelationshipStage(affection) {
  if (affection >= 80) return '深爱';
  if (affection >= 55) return '恋人';
  if (affection >= 30) return '暧昧';
  if (affection >= 15) return '朋友';
  return '陌生人';
}

// ─── 心情关键词 ──────────────────────────────────────────────────────────────
const MOOD_MAP = [
  { mood: '兴奋', words: ['哇', '不会吧', '真的吗', '天啊', '居然', '牛', '超厉害', '！！', '!!', '🎉', '🤩', '😱'] },
  { mood: '开心', words: ['哈哈', '嘻嘻', '好耶', '太好了', '棒', '开心', '高兴', '喜欢', '爱', '可爱', '😊', '😁', '😄', '❤', '🥰'] },
  { mood: '想念', words: ['想你', '好想', '想念', '思念', '好久不见', '许久'] },
  { mood: '委屈', words: ['委屈', '难过', '伤心', '哭', '不开心', '难受', '😢', '😭', '🥺', '呜呜'] },
  { mood: '平静', words: [] }, // 默认
];

/**
 * 规则：根据对话内容推断新心情
 */
export function detectMood(userMsg, botReply) {
  const text = (userMsg + botReply).toLowerCase();
  for (const { mood, words } of MOOD_MAP) {
    if (words.length === 0) continue;
    if (words.some(w => text.includes(w))) return mood;
  }
  return null; // 无变化
}

/**
 * 规则：根据消息计算好感度增量
 */
export function calcAffectionDelta(userMsg) {
  if (!userMsg) return 1;
  let delta = 1; // 基础 +1（维持联系）

  if (userMsg.length > 50)  delta += 1; // 认真在聊
  if (userMsg.length > 150) delta += 1; // 说了很多

  const strong = ['很喜欢', '超喜欢', '爱你', '最爱', '太可爱了', '喜欢你', '爱死你'];
  const positive = ['喜欢', '谢谢', '感谢', '棒', '开心', '可爱', '好'];
  const negative = ['讨厌', '烦死', '滚', '差劲', '垃圾', '无聊', '笨'];

  for (const w of strong)    if (userMsg.includes(w)) { delta += 3; break; }
  for (const w of positive)  if (userMsg.includes(w)) { delta += 1; break; }
  for (const w of negative)  if (userMsg.includes(w)) { delta -= 2; break; }

  return Math.max(delta, -3);
}

/**
 * 同步更新好感度 + 心情 + 关系阶段
 * 关系阶段升级时记录里程碑（用于"我们的故事"展示 + CP 卡片）
 */
export function syncUpdateCompanionState(companion, userMsg, botReply) {
  const fields = {};

  // 好感度（上限 100）
  const raw    = (companion.affection_level ?? 0) + calcAffectionDelta(userMsg);
  const newAff = Math.min(Math.max(raw, 0), 100);
  const oldStage = companion.relationship_stage || '陌生人';
  const newStage = computeRelationshipStage(newAff);
  fields.affection_level   = newAff;
  fields.relationship_stage = newStage;

  // 心情（有变化才更新）
  const newMood = detectMood(userMsg, botReply);
  if (newMood && newMood !== companion.current_mood) {
    fields.current_mood    = newMood;
    fields.mood_updated_at = new Date().toISOString();
  }

  patchCompanion(companion.id, fields);

  // 阶段升级 → 记里程碑
  if (newStage !== oldStage) {
    try {
      // 算"认识"天数：用 companion.created_at 距今
      let daysSinceMeet = 0;
      if (companion.created_at) {
        const created = new Date(String(companion.created_at).replace(' ', 'T') + (String(companion.created_at).includes('Z') ? '' : 'Z'));
        daysSinceMeet = Math.max(0, Math.floor((Date.now() - created.getTime()) / 86400_000));
      }
      saveStageMilestone({
        companionId: companion.id,
        fromStage: oldStage,
        toStage: newStage,
        affection: newAff,
        daysSinceMeet,
      });
      // 通知 bot 下条 reply 时带个庆祝
      pendingCelebration.set(companion.id, { from: oldStage, to: newStage, ts: Date.now() });
    } catch (e) { /* 不阻断主流程 */ }
  }
  return fields;
}

// ─── 表白意图检测 ─────────────────────────────────────────────────────────
const CONFESSION_PATTERNS = [
  // 直接告白（中文）
  /我(?:好|超|很|真的)?(?:喜欢|爱|心动|动心|想)(?:你|妳)/,
  /(?:做|当|是)我(?:的)?(?:女朋友|男朋友|对象|女友|男友|老婆|老公)/,
  /(?:和|跟)我在一起/,
  /我们(?:在一起|交往|谈恋爱)(?:吧|好不好|可以吗|怎么样)?/,
  // 暗示性表白
  /(?:我对你|对你)有(?:感觉|意思|好感)/,
  /(?:我)?喜欢上(?:你|妳)了?/,
  /(?:我)?爱上(?:你|妳)了?/,
  /我心(?:动|跳|里只有你)/,                              // 我心动了/我心跳了/我心里只有你
  /我离不开你/,
  /(?:可不可以|可以)做我(?:女朋友|对象|女友|男朋友|男友)/,
  /我爱你/, /愛你/,
  // 英文（不去空格保留单词边界）
  /\b(?:i\s*love\s*(?:you|u))\b/i,
];

/**
 * 检测用户消息是否是"表白"。返回 boolean。
 */
export function detectUserConfession(userMsg) {
  if (!userMsg || typeof userMsg !== 'string' || userMsg.length < 2) return false;
  const original = userMsg;
  const compact = userMsg.replace(/\s+/g, '');
  // 排除"我喜欢你画的画/你的猫/这个歌"这种非告白
  if (/喜欢你(?:发|画|说|做|的|那|这|@|分享)/.test(compact)) return false;
  for (const re of CONFESSION_PATTERNS) {
    if (re.test(compact) || re.test(original)) return true;
  }
  return false;
}

// ─── 亲密称呼检测（用户使用过早的亲密词）──────────────────────────────────
const INTIMATE_TERMS_RE = /(?:^|[^a-zA-Z])(宝宝|宝贝|宝儿|亲爱的|老婆|老公|baby|honey|sweetie|心肝|小可爱|乖乖)(?:[^a-zA-Z]|$)/i;
const FLIRT_PHRASES_RE = /(?:抱抱|抱一下|亲亲|亲一口|蹭蹭|摸摸头|想睡你|想亲你|想抱你|抱回家|带你回家)/;

/**
 * 检测用户消息中是否含 "过早的亲密词"。
 * 返回 { has, kind } 其中 kind = 'address'(称呼) | 'flirt'(肢体亲密) | null
 */
export function detectIntimacyOvereach(userMsg) {
  if (!userMsg || typeof userMsg !== 'string') return { has: false, kind: null };
  // 排除"我宝宝"作为反问/玩笑——简化先不处理 corner case
  if (INTIMATE_TERMS_RE.test(userMsg)) return { has: true, kind: 'address' };
  if (FLIRT_PHRASES_RE.test(userMsg)) return { has: true, kind: 'flirt' };
  return { has: false, kind: null };
}

// 阶段升级临时挂起的"庆祝"标记。bot.mjs 检查这个 map 决定要不要在 prompt 里加一句
// "你们刚刚升级了关系阶段，可以在这条回复里自然地体现这种变化"
const pendingCelebration = new Map();
export function consumePendingCelebration(companionId) {
  const v = pendingCelebration.get(companionId);
  if (!v) return null;
  // 30 分钟内才有效
  if (Date.now() - v.ts > 30 * 60_000) {
    pendingCelebration.delete(companionId);
    return null;
  }
  pendingCelebration.delete(companionId);
  return v;
}

// ─── 图片描述记忆提取（同步规则，不依赖视觉模型）──────────────────────────────
const PET_PATTERNS = [
  { word: '橘猫', memory: '用户养了一只橘猫', pet: '橘猫' },
  { word: '猫', memory: '用户家里有猫', pet: '猫' },
  { word: '小猫', memory: '用户家里有猫', pet: '小猫' },
  { word: '狗', memory: '用户家里有狗', pet: '狗' },
  { word: '小狗', memory: '用户家里有狗', pet: '小狗' },
  { word: '宠物', memory: '用户家里有宠物', pet: '宠物' },
];

const FOOD_WORDS = ['饭', '面', '火锅', '烧烤', '甜点', '蛋糕', '奶茶', '咖啡', '披萨', '寿司', '食物', '早餐', '午餐', '晚餐'];
const ROOM_WORDS = ['房间', '卧室', '客厅', '书桌', '阳台', '厨房', '家里'];

export function extractImageMemories(imageDescription, userMessage = '') {
  const desc = String(imageDescription || '').trim();
  const msg = String(userMessage || '').trim();
  const text = `${desc} ${msg}`;
  const memories = [];

  const add = (memoryType, content, importance) => {
    if (!content || memories.some(m => m.content === content)) return;
    memories.push({ memory_type: memoryType, content, importance });
  };

  const ownershipHint = /(我家|我的|家里|养了|养的|我养|这是我|我们家)/.test(msg);
  for (const pet of PET_PATTERNS) {
    if (!text.includes(pet.word)) continue;
    add('image', ownershipHint ? pet.memory : `用户分享过${pet.pet}的照片`, ownershipHint ? 8 : 5);
    if (/(拍|照片|看看|分享|发你|给你看)/.test(msg)) {
      add('preference', `用户喜欢拍${pet.pet}`, 6);
    }
    break;
  }

  const food = FOOD_WORDS.find(w => text.includes(w));
  if (food) {
    if (/(我做|自己做|我煮|我烤|我买|我点|我吃|想吃|爱吃|喜欢)/.test(msg)) {
      add('preference', `用户对${food}感兴趣`, 5);
    } else {
      add('image', `用户分享过${food}照片`, 4);
    }
  }

  const room = ROOM_WORDS.find(w => text.includes(w));
  if (room) {
    if (/(我家|我的|家里|房间|卧室|客厅)/.test(text)) {
      add('image', `用户分享过自己的${room}`, 5);
    }
  }

  if (/(生日|聚会|旅行|约会|毕业|搬家|纪念日)/.test(text)) {
    add('event', `用户分享过照片事件：${desc.slice(0, 30)}`, 6);
  }

  return memories.slice(0, 5);
}

export function buildImageReactionText(memories, imageDescription) {
  const first = memories[0];
  if (first?.content.includes('橘猫')) return '它看起来好乖呀，我记住啦，你家有一只橘猫。';
  if (first?.content.includes('猫')) return '这只猫看起来好可爱呀，我记住啦，你家里有猫。';
  if (first?.content.includes('狗')) return '它看起来很亲人呢，我记住啦，你家里有狗。';
  if (first?.content.includes('食') || first?.content.includes('饭') || first?.content.includes('奶茶')) {
    return '看起来很好吃呀，我记住啦，你也会把这些好吃的分享给我。';
  }
  if (first?.content.includes('房间') || first?.content.includes('客厅') || first?.content.includes('卧室')) {
    return '这个画面很有生活感，我记住啦，这是和你生活空间有关的小细节。';
  }
  return `我看到啦：${String(imageDescription || '').slice(0, 40)}。我会把这次照片里的重要信息记住。`;
}

// ─── 记忆提取（异步，调用 AI）────────────────────────────────────────────────
const MEMORY_SYSTEM_PROMPT = `你是记忆提取助手。分析用户说的话，提取关于用户本人的明确信息。
只提取用户主动透露的真实信息，不要推测或虚构。

输出 JSON 数组，每条结构：
{
  "memory_type": "fact" | "preference" | "event" | "emotion",
  "content": "20字内简洁描述（第三人称：'用户...'）",
  "importance": 1-10,
  "keywords": ["核心词1","核心词2","核心词3"]
}

importance 评分细则：
- 9-10：身份核心信息（生日 / 全名 / 家乡 / 重大病史 / 重要日期如纪念日）
- 7-8：稳定偏好或重要承诺（职业 / 家庭成员 / 长期爱好 / 答应的事 / 重大决定）
- 5-6：日常喜好（喜欢吃 / 常去的地方 / 看过的剧）
- 3-4：临时情绪 / 一次性事件（今天累 / 刚刚吃了什么）
- 1-2：闲聊噪音

只输出 JSON 数组。没有可记的就 []。`;

// 阈值：< MEMORY_MIN_IMPORTANCE 直接丢弃（避免噪音）。importance >= 7 自动 pin
const MEMORY_MIN_IMPORTANCE = 4;

export async function extractAndSaveMemories(companionId, userId, userMsg, botReply) {
  if (!userMsg || userMsg.length < 8) return 0;

  const userContent = `用户说："${userMsg}"\nAI回复："${botReply?.slice(0, 100)}"`;

  try {
    const raw = await extractStructuredInfo(MEMORY_SYSTEM_PROMPT, userContent);
    const list = safeParseArray(raw);
    if (list.length === 0) return 0;

    const candidates = list
      .filter(m => m.content && m.content.length >= 2 && m.memory_type)
      .map(m => ({
        companionId,
        userId,
        memoryType: ['fact','preference','event','emotion'].includes(m.memory_type) ? m.memory_type : 'fact',
        content:    m.content.slice(0, 50),
        importance: Math.min(Math.max(Number(m.importance) || 5, 1), 10),
        keywords:   Array.isArray(m.keywords) ? m.keywords.slice(0, 5).map(k => String(k).slice(0, 12)) : [],
      }))
      .filter(m => m.importance >= MEMORY_MIN_IMPORTANCE);

    if (candidates.length === 0) {
      log('debug', `[Memory] 提取到 ${list.length} 条但都低于阈值 importance>=${MEMORY_MIN_IMPORTANCE}`);
      return 0;
    }

    // 给每条记忆生成 embedding（并发但限制）
    await Promise.all(candidates.map(async m => {
      try {
        m.embedding = await embedText(m.content);
      } catch { m.embedding = null; }
    }));

    saveMemories(candidates);
    const pinnedCount = candidates.filter(m => m.importance >= 7).length;
    log('info', `[Memory] +${candidates.length} 记忆 (pinned=${pinnedCount}, with_embedding=${candidates.filter(m=>m.embedding).length}) companion=${companionId}`);
    return candidates.length;
  } catch (e) {
    log('warn', `[Memory] 记忆提取失败: ${e.message}`);
    return 0;
  }
}

// ─── 用户画像提取（异步，调用 AI）───────────────────────────────────────────
const PROFILE_SYSTEM_PROMPT = `你是用户信息提取助手。从用户的发言中提取用户自身的个人信息。
只提取用户明确说出的信息，不要推测。
以JSON对象返回（只包含能提取到的字段）：
{
  "user_name": "用户名字或昵称（如有）",
  "user_occupation": "职业或学生身份（如有）",
  "user_birthday": "生日，格式MM-DD或YYYY-MM-DD（如有）",
  "hobbies_to_add": ["新提到的爱好（如有）"],
  "important_date": {"label":"事件名","date":"日期"} 或null,
  "notes": "其他值得记录的重要信息（如有）"
}
没有任何用户个人信息时返回{}。只输出JSON，无其他内容。`;

export async function extractAndUpdateUserProfile(companionId, userId, userMsg) {
  if (!userMsg || userMsg.length < 5) return;

  try {
    const raw  = await extractStructuredInfo(PROFILE_SYSTEM_PROMPT, `用户说："${userMsg}"`);
    const info = safeParseObject(raw);
    if (Object.keys(info).length === 0) return;

    const existing   = getUserProfile(userId, companionId);
    const patchData  = {};

    if (info.user_name)       patchData.user_name = info.user_name;
    if (info.user_occupation) patchData.user_occupation = info.user_occupation;
    if (info.user_birthday)   patchData.user_birthday = info.user_birthday;
    if (info.notes)           patchData.notes = info.notes;

    if (info.hobbies_to_add?.length > 0) {
      const cur = existing?.user_hobbies || [];
      patchData.user_hobbies = [...new Set([...cur, ...info.hobbies_to_add])];
    }

    if (info.important_date?.label && info.important_date?.date) {
      const cur = existing?.important_dates || [];
      const dup = cur.some(d => d.label === info.important_date.label);
      if (!dup) patchData.important_dates = [...cur, info.important_date];
    }

    if (Object.keys(patchData).length > 0) {
      upsertUserProfile(userId, companionId, patchData);
      log('info', `[Memory] 用户画像更新 user=${userId} keys=${Object.keys(patchData).join(',')}`);
    }
  } catch (e) {
    log('warn', `[Memory] 用户画像提取失败: ${e.message}`);
  }
}

// ─── 召回记忆（同步） ─────────────────────────────────────────────────────────
export { recallMemories } from './db.mjs';

// ─── 工具 ────────────────────────────────────────────────────────────────────
function safeParseArray(text) {
  if (!text) return [];
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { const v = JSON.parse(m[0]); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

function safeParseObject(text) {
  if (!text) return {};
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try { const v = JSON.parse(m[0]); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
  catch { return {}; }
}
