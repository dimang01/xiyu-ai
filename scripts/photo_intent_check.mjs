import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { detectPhotoIntent } from '../src/photo_intent.mjs';

assert.equal(detectPhotoIntent('发个自拍看看').type, 'strong_photo_request');
assert.equal(detectPhotoIntent('让我看看你在干嘛').type, 'strong_photo_request');
assert.equal(detectPhotoIntent('你在干嘛').type, 'weak_photo_context');
assert.notEqual(detectPhotoIntent('今天吃什么比较好').type, 'strong_photo_request');

const promptSource = await readFile(new URL('../src/companion.mjs', import.meta.url), 'utf8');
assert.equal(promptSource.includes('用户主动要照片/自拍——婉拒'), false);
assert.equal(promptSource.includes('婉拒（这是底线规则）'), false);

process.env.PHOTO_SEND_ENABLED = 'false';
const { sendCompanionPhoto } = await import('../src/photo_sender.mjs');
const result = await sendCompanionPhoto({
  companion: { id: 1, wechat_user_id: 'test-user' },
  context: { token: 'test-token', botId: 'test-bot' },
  source: 'request',
});
assert.equal(result.ok, false);
assert.equal(result.code, 'disabled');

process.env.PHOTO_SEND_ENABLED = 'true';
process.env.PHOTO_REQUEST_COOLDOWN_MINUTES = '10';
const cooldownResult = await sendCompanionPhoto({
  companion: { id: 1, wechat_user_id: 'test-user', last_photo_at: new Date().toISOString() },
  context: { token: 'test-token', botId: 'test-bot' },
  source: 'request',
});
assert.equal(cooldownResult.ok, false);
assert.equal(cooldownResult.code, 'cooldown');

console.log('[photo_intent_check] ok');
