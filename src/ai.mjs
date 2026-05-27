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

  const sys = `你帮一个虚拟角色构造"她的完整人生"——像真实存在的人那样，她的过去是一个**有因果链**的整体，而不是一堆孤立标签。

【输入人设】
- 姓名：${c.name || '溪语'}
- 年龄：${c.age || 22}
- 身份：${c.role_title || '邻家女孩'}
- 性格：${personality || '温柔'}
- 爱好：${hobbies || '看剧、听音乐'}
- 你们怎么认识的：${c.how_met || '未说明'}
- 用户已填的额外人设：${c.persona_prompt || '无'}

【生成原则——读懂再写】
1. **因果链**：童年经历 → 塑造性格 → 形成价值观 → 决定她现在的爱好和怕的东西
2. **具体到细节**：地点+人物+发生的事+她当时的感受
3. **真实而非完美**：要有小挫折、小遗憾、小尴尬
4. **年龄强约束**
5. **不要复述输入字段**

【输出严格 JSON】每条 20-45 字。

{
  "childhood": ["5 条 3-10 岁的回忆"],
  "school": ["5 条小学到现在的学生时代经历"],
  "family": ["4-5 条家庭情况"],
  "friends": ["3-4 个具体朋友"],
  "pets": ["0-2 个宠物"],
  "important_events": ["4-5 件影响她价值观的事件"],
  "values": ["4-5 条价值观，要写来源"],
  "love_view": ["3-4 条她对感情/恋爱的态度"],
  "fears": ["3-4 个怕的东西，写为什么怕"],
  "habits": ["6-8 个小习惯"],
  "secrets": ["2-3 个小秘密"],
  "linguistic_quirks": ["3-4 个口头禅"]
}

【绝对禁忌】
- 不要写"用户/对方/他/和他在一起"
- 不要写恋爱史（除非 how_met 暗示了）
- 不要让所有事件都是积极的
- **不要写自己名字**：用"她"

严格只输出 JSON。`;

  try {
    const { text } = await chatComplete({
      system: sys,
      messages: [{ role: 'user', content: '生成她的人生背景 JSON' }],
      temperature: 0.7,
      max_tokens: 1500,
      top_p: 0.9,
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
  const { temperature = 0.7, max_tokens = 2000, top_p = 0.9 } = params;
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

  log('debug', `[ai] chat messages=${messages.length} temp=${temperature}`);
  const FALLBACK = '嗯…我刚刚有点走神，等我一下下，再跟你说～';
  try {
    const { text, usage } = await chatComplete({
      system: personaPrompt,
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
  const { accountId = null } = ctx;
  try {
    const { text, usage } = await chatComplete({
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.1,
      max_tokens: 400,
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
