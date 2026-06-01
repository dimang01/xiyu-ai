import assert from 'node:assert/strict';

import { detectPhotoIntent } from '../src/photo_intent.mjs';
import {
  buildEmotionPhotoContext,
  getPhotoGateState,
  planPhotoMessage,
  sanitizePhotoCaption,
  sanitizePhotoPrompt,
} from '../src/photo_planner.mjs';

const companion = { id: 999999, name: '溪语', wechat_user_id: 'test-user', current_scene: '在桌边写东西' };

const approved = await planPhotoMessage({
  companion,
  userText: '发个自拍看看',
  recentMessages: [],
  trigger: 'user_request',
  imageProviderAvailable: true,
}, {
  mockResponse: JSON.stringify({
    shouldSendPhoto: true,
    mode: 'send_photo',
    trigger: 'user_request',
    photoType: 'current_activity',
    realism: 'realistic_daily',
    imagePrompt: 'A quiet desk with a notebook and half-finished tea beside a window',
    caption: '刚坐下来，桌子还有点乱',
    delayImageMs: 800,
    delayCaptionMs: 600,
    reason: 'explicit request and context is natural',
  }),
});

assert.equal(detectPhotoIntent('发个自拍看看').type, 'strong_photo_request');
assert.equal(approved.shouldSendPhoto, true);
assert.equal(approved.mode, 'send_photo');
assert.equal(approved.maintainIdentity, true);
assert.match(approved.imagePrompt, /realistic/i);
assert.match(approved.imagePrompt, /casual/i);
assert.match(approved.imagePrompt, /phone snapshot/i);
assert.match(approved.imagePrompt, /natural lighting/i);
assert.equal(/anime|二次元|illustration|poster|app icon|NSFW|nude|sexual/i.test(approved.imagePrompt), false);
assert.equal(/作为\s*AI|当前情绪状态|生成了?一张图片|\[PHOTO\]/i.test(approved.caption), false);

const cooldownGate = getPhotoGateState({
  companion: { ...companion, last_photo_at: new Date().toISOString() },
  source: 'request',
  trigger: 'user_request',
  imageProviderAvailable: true,
});
assert.equal(cooldownGate.allowed, false);
assert.ok(cooldownGate.reasons.includes('cooldown'));

const declined = await planPhotoMessage({
  companion,
  userText: '想看你',
  trigger: 'user_request',
  imageProviderAvailable: true,
}, {
  mockResponse: JSON.stringify({
    shouldSendPhoto: false,
    mode: 'text_only',
    trigger: 'user_request',
    reason: 'not natural now',
  }),
});
assert.equal(declined.shouldSendPhoto, false);

const invalidJson = await planPhotoMessage({
  companion,
  userText: '让我看看你在干嘛',
  trigger: 'user_request',
  imageProviderAvailable: true,
}, { llm: async () => 'not json at all' });
assert.equal(invalidJson.shouldSendPhoto, false);

assert.equal(sanitizePhotoCaption('作为 AI 我生成了一张图片 [PHOTO]'), '');
assert.equal(sanitizePhotoCaption('根据系统判断当前情绪状态是开心，11维情绪分数很高'), '');
assert.equal(sanitizePhotoPrompt('anime poster NSFW nude'), '');
assert.equal(sanitizePhotoPrompt('realistic phone snapshot with loneliness: 0.8 and attachment: 0.7'), '');
assert.equal(sanitizePhotoPrompt('realistic phone snapshot showing 11-dimensional emotion'), '');

const neutralEmotionContext = buildEmotionPhotoContext(null);
assert.equal(neutralEmotionContext.sendBias, 'neutral');
assert.match(neutralEmotionContext.toneHint, /自然/);

const emotionalContext = buildEmotionPhotoContext({
  affection: 82,
  trust: 78,
  dependency: 76,
  possessiveness: 20,
  security: 62,
  energy: 28,
  patience: 55,
  excitement: 40,
  annoyance: 5,
  gratitude: 72,
  mood: 'tired',
});
const emotionContextText = JSON.stringify(emotionalContext);
assert.equal(/82|78|76|28|11维|情绪分数|当前情绪状态|dependency|affection|trust/i.test(emotionContextText), false);
assert.ok(['neutral', 'higher', 'lower'].includes(emotionalContext.sendBias));

let capturedPrompt = '';
const emotionAwarePlan = await planPhotoMessage({
  companion,
  userText: '让我看看你在干嘛',
  recentMessages: [],
  trigger: 'user_request',
  imageProviderAvailable: true,
  emotionState: {
    affection: 80,
    trust: 80,
    dependency: 75,
    possessiveness: 15,
    security: 55,
    energy: 25,
    patience: 50,
    excitement: 35,
    annoyance: 0,
    gratitude: 65,
    mood: 'tired',
  },
}, {
  llm: async ({ prompt }) => {
    capturedPrompt = prompt;
    return JSON.stringify({
      shouldSendPhoto: true,
      mode: 'send_photo',
      trigger: 'user_request',
      photoType: 'current_activity',
      realism: 'realistic_daily',
      imagePrompt: 'A quiet desk with a notebook and half-finished tea beside a window',
      caption: '刚刚随手拍的，只给你看一眼',
      delayImageMs: 800,
      delayCaptionMs: 600,
      reason: 'explicit request and context is natural',
    });
  },
});
assert.equal(emotionAwarePlan.shouldSendPhoto, true);
assert.match(capturedPrompt, /hidden emotion photo context/);
assert.match(capturedPrompt, /安静|柔和|亲近/);
assert.equal(/"affection"|"dependency"|"trust"|80|75|0\.8|11-dimensional|11维/i.test(capturedPrompt), false);

const noEmotionUserPlan = await planPhotoMessage({
  companion,
  userText: '发张照片',
  trigger: 'user_request',
  imageProviderAvailable: true,
  emotionState: null,
}, {
  mockResponse: JSON.stringify({
    shouldSendPhoto: false,
    mode: 'text_only',
    trigger: 'user_request',
    reason: 'not now',
  }),
});
assert.equal(noEmotionUserPlan.shouldSendPhoto, false);

const noEmotionProactivePlan = await planPhotoMessage({
  companion,
  userText: '',
  trigger: 'proactive',
  imageProviderAvailable: true,
  emotionState: null,
}, {
  mockResponse: JSON.stringify({
    shouldSendPhoto: false,
    mode: 'text_only',
    trigger: 'proactive',
    reason: 'not now',
  }),
});
assert.equal(noEmotionProactivePlan.shouldSendPhoto, false);

const proactiveGate = getPhotoGateState({
  companion: { ...companion, last_photo_at: new Date().toISOString() },
  source: 'proactive',
  trigger: 'proactive',
  imageProviderAvailable: true,
});
assert.equal(proactiveGate.allowed, false);
assert.ok(proactiveGate.reasons.includes('cooldown'));

assert.notEqual(detectPhotoIntent('今天午饭吃什么').type, 'strong_photo_request');

console.log('[photo_planner_check] ok');
