import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = mkdtempSync(path.join(os.tmpdir(), 'xiyu-visual-identity-'));
process.env.PHOTO_VISUAL_IDENTITY_DIR = root;
process.env.PHOTO_GENERATE_REFERENCE_ON_DEMAND = 'false';

const visual = await import(`../src/visual_identity.mjs?check=${Date.now()}`);
const imageProvider = await import('../src/providers/image.mjs');

const companion = {
  id: 424242,
  name: '溪语',
  age: 24,
  hair_color: 'dark brown',
  hair_style: 'shoulder-length straight',
  clothing_style: 'soft casual sweater and jeans',
  personality_tags: JSON.stringify(['温柔', '有点害羞']),
  hobbies: JSON.stringify(['写字', '喝茶']),
  current_scene: '在桌边写东西',
};

try {
  const ensured = await visual.ensureVisualIdentity({
    companion,
    emotionState: {
      affection: 70,
      trust: 80,
      dependency: 50,
      possessiveness: 10,
      security: 65,
      energy: 35,
      patience: 60,
      excitement: 40,
      annoyance: 0,
      gratitude: 50,
      mood: 'tired',
    },
    context: { scene: companion.current_scene },
  });

  assert.equal(ensured.enabled, true);
  assert.equal(ensured.identity.status, 'ready');
  const identityPath = path.join(root, String(companion.id), 'identity.json');
  assert.equal(existsSync(identityPath), true);

  const specText = JSON.stringify(ensured.identity.identitySpec);
  assert.equal(/anime|二次元|illustration|poster|app icon|avatar icon|NSFW|nude|sexual|minor|celebrity|情绪分数|当前情绪状态|11维/i.test(specText), false);
  assert.match(ensured.identity.identitySpec.ageLook, /adult/i);
  assert.equal(ensured.referenceImagePath, null);

  const prompt = visual.buildIdentityPrompt(ensured.identity);
  assert.match(prompt, /consistent same adult person/i);
  assert.equal(/anime|illustration|poster|app icon|NSFW|nude|sexual|minor|celebrity|11-dimensional|11维/i.test(prompt), false);

  const sourceRef = path.join(root, 'source-ref.png');
  writeFileSync(sourceRef, Buffer.from('fake-png-for-copy'));
  const savedRef = visual.saveReferenceImage(companion.id, sourceRef);
  assert.equal(existsSync(savedRef), true);
  assert.equal(visual.selectReferenceImage(companion.id), savedRef);

  const generatedSource = path.join(root, 'generated-source.webp');
  writeFileSync(generatedSource, Buffer.from('fake-webp-for-copy'));
  const savedGenerated = visual.saveGeneratedPhoto(companion.id, generatedSource);
  assert.equal(existsSync(savedGenerated), true);
  assert.match(savedGenerated, new RegExp(`data[\\\\/]companion_visuals|${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(savedGenerated, new RegExp(`${companion.id}[\\\\/]generated`));

  const capabilities = imageProvider.getImageProviderCapabilities();
  assert.equal(capabilities.textToImage, true);
  assert.equal(capabilities.referenceImage, false);
  assert.equal(capabilities.imageToImage, false);

  const ensuredAgain = await visual.ensureVisualIdentity({ companion });
  assert.equal(ensuredAgain.referenceImagePath, savedRef);
  assert.equal(ensuredAgain.capabilities.referenceImage, false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('[visual_identity_check] ok');
