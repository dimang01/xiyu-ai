/**
 * AI 集成模块（业务层）
 *
 * 注意：本文件不再直接调用任何具体厂商 API。
 * 所有 chat/image/vision/asr/embedding 都委托给 `src/providers/` 下的抽象层，
 * 由用户在 .env 中通过 *_PROVIDER 环境变量切换实际后端。
 *
 * 支持的 provider 全集：
 *   chat:      deepseek / openai / anthropic / xai / zhipu / doubao / qwen / kimi / wenxin
 *   image:     zhipu / qwen / doubao / wenxin / openai
 *   vision:    zhipu / openai / qwen / doubao / anthropic
 *   asr:       gemini / openai / qwen / xunfei / tencent
 *   embedding: gemini / openai / zhipu / qwen
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { recordAiUsage } from './db.mjs';
import { chatComplete } from './providers/chat.mjs';
import { imageGenerate } from './providers/image.mjs';
import { visionRecognize } from './providers/vision.mjs';
import { asrRecognize } from './providers/asr.mjs';
import { embedText as _embedText } from './providers/embedding.mjs';
import { shouldSearch, webSearch, formatSearchContext } from './web_search.mjs';

// ─── 图像生成 ─────────────────────────────────────────────────────────────

export async function generateImage(prompt, { size = '1024x1024' } = {}) {
  return await imageGenerate(prompt, { size });
}

/**
 * 根据 companion 属性自动构造头像 prompt，并发生成 N 张候选。
 */
export async function generateAvatarCandidates(companion, n = 4) {
  const c = companion;
  let personality = '';
  try {
    personality = JSON.parse(c.personality_tags || '[]').slice(0, 3).join(', ');
  } catch {}

  const styleSeeds = [
    'Studio Ghibli soft animation style, warm pastel colors',
    'modern anime portrait style, vibrant colors, pixiv top quality',
    'Kyoto Animation style, gentle lighting, detailed eyes',
    'soft watercolor anime style, dreamy atmosphere',
  ];

  const ageDesc =
    c.age <= 18 ? 'cute teenage girl, school student'
      : c.age <= 25 ? 'young woman in her early twenties'
        : 'young woman';
  const hairDesc = `${c.hair_color || 'black'} ${c.hair_style || 'long'} hair`;
  const eyeDesc = c.eye_color ? `${c.eye_color} eyes` : 'expressive eyes';
  const clothDesc = c.clothing_style ? `wearing ${c.clothing_style} style outfit` : 'wearing casual clothing';

  const basePrompt = `Anime portrait of a ${ageDesc}, ${hairDesc}, ${eyeDesc}, ${clothDesc}, soft gentle smile, ${personality || 'gentle'} personality, half-body portrait facing forward, soft pink and pastel background, professional anime artwork, highly detailed face, no text, no signature, NO REAL HUMANS, illustration only`;

  const promises = [];
  for (let i = 0; i < n; i++) {
    const styled = `${basePrompt}, ${styleSeeds[i % styleSeeds.length]}`;
    promises.push(generateImage(styled).catch((e) => {
      log('warn', `[image] 候选 ${i + 1} 失败: ${e.message}`);
      return null;
    }));
  }
  const urls = (await Promise.all(promises)).filter(Boolean);
  return { prompt: basePrompt, urls };
}

/**
 * 把日常活动文本转写实摄影 prompt。
 */
export async function activityToPhotoPrompt(activity, { timeSlot = 'afternoon', mood = '' } = {}) {
  const sys = `你是手机摄影师，把一段日常活动文字转成一句适合 AI 生图的英文 prompt。
要求：
- 角色是手机随手拍 (smartphone snapshot, casual angle, slightly imperfect framing)
- 第一人称视角或场景特写，**不要正面人脸**，最多远景模糊背影
- 写实风格 (photorealistic, real-world photo, natural lighting)
- 反映时段（morning / afternoon / golden hour / evening / night）的光线氛围
- 突出"我此刻看到的东西"，比如桌面/窗外/路边/天空/食物特写
- 不要 anime / illustration / cartoon / fantasy / makeup tutorial / glamour 等词
- 30-50 词，单句

只输出英文 prompt，无引号无解释。`;
  const userMsg = `活动：${activity}\n时段：${timeSlot}\n${mood ? '心情：' + mood : ''}`;
  try {
    const { text } = await chatComplete({
      system: sys,
      messages: [{ role: 'user', content: userMsg }],
      temperature: 0.7,
      max_tokens: 200,
    });
    return text.replace(/^["'`]+|["'`]+$/g, '');
  } catch (err) {
    log('warn', `[ai] activityToPhotoPrompt 失败: ${err.message}`);
    return null;
  }
}

export async function generateScenePhoto({ activity, timeSlot, mood }) {
  let prompt = await activityToPhotoPrompt(activity, { timeSlot, mood });
  if (!prompt) {
    prompt = `A smartphone snapshot of a peaceful everyday scene, ${timeSlot} natural light, casual angle, no people visible, photorealistic, real-world photo, soft depth of field.`;
  }
  const finalPrompt = `${prompt}. Real photograph, smartphone candid, NOT anime, NOT illustration, NOT digital art.`;
  log('info', `[scene] prompt: ${finalPrompt.slice(0, 120)}`);
  const url = await generateImage(finalPrompt, { size: '1024x1024' });
  return { url, prompt: finalPrompt };
}

/**
 * 给一个 companion 生成完整的"人生背景"元认知。
 */
export async function generatePersonaFacts(companion) {
  const c = companion;
  let hobbies = '';
  try { hobbies = JSON.parse(c.hobbies || '[]').join('、'); } catch {}
  let personality = '';
  try { personality = JSON.parse(c.personality_tags || '[]').join('、'); } catch {}

  const sys = `你帮一个虚拟角色构造"她的完整人生与世界观"——像真实存在的人那样，她的过去是一个**有因果链**的整体，每个回忆有具体的人名、地点、感官细节，不是一堆孤立标签。

【输入人设】
- 姓名：${c.name || '溪语'}
- 年龄：${c.age || 22}
- 身份：${c.role_title || '邻家女孩'}
- 性格：${personality || '温柔'}
- 爱好：${hobbies || '看剧、听音乐'}
- 你们怎么认识的：${c.how_met || '未说明'}
- 用户已填的额外人设：${c.persona_prompt || '无'}

【生成原则——拟人化的核心】
1. **因果链**：童年经历 → 塑造性格 → 形成价值观 → 决定她现在的爱好和怕的东西
2. **具体到名字**：朋友、邻居、老师、宠物都要起名字（如"高中闺蜜林小满"、"小时候邻居王奶奶"、"高三班主任陈老师"、"狸花猫旺财"）；不要写"我的朋友"、"我妈"这种泛指
3. **感官细节**：每条尽量带一个 sensory 元素 — 声音/气味/触感/视觉（"奶奶家厨房的酱油味"、"外婆毛衣袖口磨毛的触感"、"小学操场塑胶跑道夏天烫脚"）
4. **真实而非完美**：要有小挫折、小遗憾、小尴尬、小怯懦（"被同桌当众嘲笑过哭了半节课"）
5. **年龄强约束**：${c.age || 22}岁的人不会有"二十年的工作经验"
6. **不要复述输入字段**

【输出严格 JSON】每条 25-55 字（比以前略长，留空间给细节）。

{
  "childhood":          ["6 条 3-10 岁的回忆，要有具体地点 + 一个感官细节"],
  "school":             ["6 条小学到现在的学生时代经历，至少 1 个同学有名字"],
  "family":             ["5 条家庭情况，父母/兄弟姐妹/祖辈各自的样子，可有具体名字或称呼"],
  "neighbors":          ["3 条邻居/小区/常去店铺的人/事，要带名字（如店主、邻居孩子）"],
  "teachers":           ["3 条印象深的老师，正面和负面各有，带名字"],
  "friends":            ["4 个具体朋友，各自带名字和一句关系特征（如'初中死党林小满，喜欢一起翻篱笆偷青苹果'）"],
  "first_crush":        ["1-2 条第一次心动/暗恋经历，带细节，可以是单恋也可以未告白"],
  "pets":               ["0-2 个宠物，带名字和具体记忆"],
  "important_events":   ["5 件影响她价值观的事件，含日期/年份概念"],
  "values":             ["5 条价值观，每条都要写'来源于...事件/影响'"],
  "love_view":          ["4 条她对感情/恋爱的态度，带具体观察来源"],
  "fears":              ["4 个怕的东西，写为什么怕（事件来源）"],
  "food_taste":         ["3 条饮食偏好与背景（如'怕香菜因为小学吃过一次差点吐'）"],
  "music_taste":        ["3 条音乐/歌单偏好，带具体歌手或风格"],
  "place_attachment":   ["3 条对地方的情感（外婆家/老家/常去咖啡馆等）"],
  "habits":             ["8 个小习惯，至少 3 个带原因"],
  "secrets":            ["3 个小秘密，可以是无伤大雅的（藏过零食、偷看过日记）"],
  "linguistic_quirks":  ["4 个口头禅，写她在什么情境下会说"],
  "worldview":          ["4 条对'大问题'的态度：孤独/自由/死亡/金钱/成功 中挑 4 个，每条带个人化的看法"]
}

【绝对禁忌】
- 不要写"用户/对方/他/和他在一起"
- 不要写恋爱史（first_crush 限于过去的暗恋/初恋经历，不涉及当前对话对方）
- 不要让所有事件都是积极的——至少 3 条带遗憾/伤痛
- **不要写自己名字**：用"她"
- 名字用普通中文人名（林小满 / 陈老师 / 王奶奶 / 旺财），不要奇幻名字

严格只输出 JSON。`;

  try {
    const { text } = await chatComplete({
      system: sys,
      messages: [{ role: 'user', content: '生成她的人生背景 + 世界观 JSON' }],
      temperature: 0.8,
      max_tokens: 2400,
      top_p: 0.92,
    });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON in response');
    return JSON.parse(m[0]);
  } catch (err) {
    log('warn', `[ai] generatePersonaFacts 失败: ${err.message}`);
    return null;
  }
}

// ─── Embedding ────────────────────────────────────────────────────────────
export async function embedText(text) {
  return await _embedText(text);
}

// ─── 对话回复 ─────────────────────────────────────────────────────────────

export async function generateReply(personaPrompt, history, userMessage, params = {}, ctx = {}) {
  // v1.2.10: 兜底默认与 companions 表 DEFAULT 对齐 (0.8 / 3000 / 0.95)，
  // 让回复更有创意、空间更宽、用词更自然。caller 显式传值会优先。
  const { temperature = 0.8, max_tokens = 3000, top_p = 0.95 } = params;
  const { accountId = null } = ctx;

  const messages = [];
  for (const h of history) {
    if (!h.content || h.content === '[图片]' || h.content === '[语音]') continue;
    messages.push({
      role: h.direction === 'in' ? 'user' : 'assistant',
      content: h.content,
    });
  }
  messages.push({ role: 'user', content: userMessage });

  // ─── 可选：联网搜索（对用户透明） ───────────────────────────────────────
  // 仅当用户消息看起来是「时效相关 + 询问语气」时才搜，否则零开销跳过。
  // 搜失败 / 未配置 search provider 时静默继续，不影响主对话。
  let effectiveSystem = personaPrompt;
  try {
    const judge = shouldSearch(userMessage);
    if (judge.search) {
      const sr = await webSearch(userMessage, { maxResults: 5, timeoutMs: 6000 });
      if (sr.ok && sr.results.length > 0) {
        const ctxBlock = formatSearchContext(userMessage, sr.results);
        if (ctxBlock) {
          effectiveSystem = `${personaPrompt}\n\n${ctxBlock}`;
          log('debug', `[ai] web_search injected hits=${sr.results.length} provider=${sr.provider}`);
        }
      }
    }
  } catch (e) {
    log('warn', `[ai] web_search 调用异常: ${e.message}`);
  }

  log('debug', `[ai] chat messages=${messages.length} temp=${temperature}`);
  const FALLBACK = '嗯…我刚刚有点走神，等我一下下，再跟你说～';
  try {
    const { text, usage } = await chatComplete({
      system: effectiveSystem,
      messages,
      temperature,
      max_tokens,
      top_p,
      timeout_ms: 30_000,
    });
    const reply = text || FALLBACK;
    log('info', `[ai] 回复: ${reply.slice(0, 80)}...`);
    if (accountId && usage) {
      try {
        recordAiUsage({
          accountId,
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          messages: 1,
        });
      } catch (e) {
        log('warn', `[ai] recordAiUsage 失败: ${e.message}`);
      }
    }
    return reply;
  } catch (err) {
    log('error', `[ai] chat 错误: ${err.message}`);
    return FALLBACK;
  }
}

export async function extractStructuredInfo(systemPrompt, userContent, ctx = {}) {
  const { accountId = null, maxTokens = 400, temperature = 0.1 } = ctx;
  try {
    const { text, usage } = await chatComplete({
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      temperature,
      max_tokens: maxTokens,
      top_p: 0.9,
    });
    if (accountId && usage) {
      try {
        recordAiUsage({
          accountId,
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          messages: 0,
        });
      } catch {}
    }
    return text || '{}';
  } catch (err) {
    log('warn', `[ai] extractStructuredInfo 失败: ${err.message}`);
    return '{}';
  }
}

// ─── 图片识别 ─────────────────────────────────────────────────────────────
export async function recognizeImage(imageBuffer, mimeType = 'image/jpeg') {
  return await visionRecognize(imageBuffer, mimeType);
}

// ─── 语音识别 ─────────────────────────────────────────────────────────────
export async function recognizeVoice(audioBuffer, mimeType = 'audio/ogg') {
  return await asrRecognize(audioBuffer, mimeType);
}
