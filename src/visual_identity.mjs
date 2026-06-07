/**
 * Stable visual identity for companion photos.
 *
 * The identity is private generation context. It must not be sent to users,
 * and it should avoid raw chat history, private user data, or emotion scores.
 */

import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, readdirSync } from 'node:fs';
import { generateImage } from './ai.mjs';
import { getImageProviderCapabilities } from './providers/image.mjs';
import { log } from './logger.mjs';

const DEFAULT_ROOT = path.resolve(process.cwd(), 'data/companion_visuals');
const VISUAL_ROOT = process.env.PHOTO_VISUAL_IDENTITY_DIR || DEFAULT_ROOT;
const BLOCKED_RE = /\b(anime|illustration|poster|app icon|avatar icon|glamour shoot|fantasy girlfriend|nsfw|nude|sexual|minor|celebrity|loneliness|attachment)\b|二次元|插画|海报|未成年|名人|色情|裸露|情绪分数|当前情绪状态|11维|11[-\s]*dimensional\s+emotion/i;
const SAFE_AVOID = [
  'non-photographic styles',
  'studio portrait look',
  'famous-person resemblance',
  'revealing styling',
  'private user details',
  // v1.10.42: 移除 'underage appearance' 和 'polished advertising look' —
  // 它们让模型把人物画成 25-30 plain 阿姨脸。新版用具象视觉描述显小，
  // 安全过滤由 BLOCKED_RE / sanitizer 处理。
];

function envFlag(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

function safeText(text, maxLen = 120) {
  return String(text || '')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(BLOCKED_RE, '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '')
    .replace(/\+?\d[\d\s-]{8,}\d/g, '')
    .trim()
    .slice(0, maxLen);
}

function isImageProviderConfigured(provider = process.env.IMAGE_PROVIDER || 'zhipu') {
  const name = String(provider || '').toLowerCase();
  const keys = {
    zhipu: ['ZHIPU_API_KEY'],
    qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
    doubao: ['DOUBAO_API_KEY'],
    wenxin: ['WENXIN_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'],
    '302ai': ['AI302_API_KEY'],
  }[name] || [];
  return keys.some(k => Boolean(process.env[k]));
}

function companionDir(companionId) {
  return path.join(VISUAL_ROOT, String(companionId));
}

function ensureDirs(companionId) {
  const dir = companionDir(companionId);
  const referencesDir = path.join(dir, 'references');
  const generatedDir = path.join(dir, 'generated');
  const candidatesDir = path.join(dir, 'candidates');
  mkdirSync(referencesDir, { recursive: true });
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(candidatesDir, { recursive: true });
  return { dir, referencesDir, generatedDir, candidatesDir };
}

// v1.10.46: 候选图存磁盘 + 返回相对路径，避免大 base64 在 JSON response 里
// 撑爆前端解析（iOS Safari ~4-12MB JSON 会出 "string did not match expected pattern"）。
export function saveCandidateImage(companionId, base64OrBuf, seed) {
  if (!companionId) return null;
  const { candidatesDir } = ensureDirs(companionId);
  let buf;
  if (Buffer.isBuffer(base64OrBuf)) buf = base64OrBuf;
  else if (typeof base64OrBuf === 'string') {
    const m = base64OrBuf.match(/^data:image\/[a-z+]+;base64,(.+)$/i);
    buf = m ? Buffer.from(m[1], 'base64') : Buffer.from(base64OrBuf, 'base64');
  } else return null;
  if (!buf || buf.length < 256) return null;
  const fname = `cand_${seed || 's0'}_${Date.now()}.png`;
  const dest = path.join(candidatesDir, fname);
  writeFileSync(dest, buf);
  return { absPath: dest, fname };
}

// v1.10.46: GET 端点用 — 由 fname 拿回路径，做安全检查防穿越
export function candidatePath(companionId, fname) {
  if (!companionId || !fname) return null;
  if (!/^cand_[a-z0-9]+_\d+\.(png|jpg|webp)$/i.test(fname)) return null;
  const { candidatesDir } = ensureDirs(companionId);
  const full = path.join(candidatesDir, fname);
  if (!full.startsWith(candidatesDir)) return null;
  return existsSync(full) ? full : null;
}

function identityPath(companionId) {
  return path.join(companionDir(companionId), 'identity.json');
}

function normalizeIdentity(companionId, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const referenceImages = Array.isArray(raw.referenceImages)
    ? raw.referenceImages.filter(Boolean).map(String)
    : [];
  return {
    version: 1,
    companionId: String(raw.companionId || companionId),
    status: 'ready',
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
    identitySpec: raw.identitySpec && typeof raw.identitySpec === 'object'
      ? raw.identitySpec
      : buildVisualIdentitySpec({ companion: { id: companionId } }),
    referenceImages,
    notes: Array.isArray(raw.notes) ? raw.notes.slice(0, 20).map(String) : [],
  };
}

export function getVisualIdentity(companionId) {
  if (!companionId) return null;
  const file = identityPath(companionId);
  if (!existsSync(file)) return null;
  try {
    return normalizeIdentity(companionId, JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    log('warn', `[VisualIdentity] read failed companion=${companionId}: ${e.message}`);
    return null;
  }
}

export function buildVisualIdentitySpec({ companion = {}, persona = {}, emotionState = null, context = {} } = {}) {
  const tags = (() => {
    try { return JSON.parse(companion.personality_tags || '[]').slice(0, 3).join(', '); } catch { return ''; }
  })();
  const hobbies = (() => {
    try { return JSON.parse(companion.hobbies || '[]').slice(0, 3).join(', '); } catch { return ''; }
  })();
  const energy = Number(emotionState?.energy);
  const mood = safeText(emotionState?.mood || '', 24);
  const scene = safeText(context?.scene || companion.current_scene || '', 80);

  const hairColor = safeText(companion.hair_color || persona.hairColor || 'natural dark', 40) || 'natural dark';
  const hairStyle = safeText(companion.hair_style || persona.hairStyle || 'simple medium-length', 60) || 'simple medium-length';
  const clothing = safeText(companion.clothing_style || persona.clothingStyle || 'casual everyday', 80) || 'casual everyday';
  const vibeParts = [
    safeText(tags, 80),
    safeText(hobbies ? `ordinary interests around ${hobbies}` : '', 90),
    Number.isFinite(energy) && energy < 35 ? 'quiet and low-key' : '',
    mood ? `subtle ${mood} mood` : '',
    scene ? 'grounded in ordinary daily life' : '',
  ].filter(Boolean);

  return {
    // v1.10.42: 用具象视觉特征代替"adult mid-20s"硬编码。让模型画"非常
    // 年轻但成年看起来"，跟 photo_planner v1.10.41 prompt 对齐。
    ageLook: 'very youthful first-year university freshman vibe, soft baby-faced look',
    face: 'soft round full cheeks, large warm doe eyes, small delicate chin, dewy clear skin, gentle warm natural smile, fresh makeup-free complexion',
    hair: `${hairColor} ${hairStyle} hair, stable across photos`,
    body: 'slim petite youthful frame, natural proportions, modest casual styling',
    style: `${clothing} clothing style, casual youthful daily wear`,
    vibe: safeText(vibeParts.join(', ') || 'fresh, warm, photogenic, naturally pretty everyday feeling', 180),
    avoid: SAFE_AVOID,
  };
}

export function saveVisualIdentity(companionId, identity) {
  if (!companionId) throw new Error('saveVisualIdentity: missing companionId');
  const { dir } = ensureDirs(companionId);
  const normalized = normalizeIdentity(companionId, {
    ...identity,
    companionId: String(companionId),
    updatedAt: new Date().toISOString(),
  });
  writeFileSync(path.join(dir, 'identity.json'), JSON.stringify(normalized, null, 2));
  return normalized;
}

export function selectReferenceImage(companionId) {
  const identity = getVisualIdentity(companionId);
  if (!identity?.referenceImages?.length) return null;
  for (const rel of identity.referenceImages) {
    const full = path.isAbsolute(rel) ? rel : path.join(companionDir(companionId), rel);
    if (existsSync(full)) return full;
  }
  return null;
}

// v1.10.43: 删 identity.json + 全部 references，让系统下次按当前 spec 重建
export function resetVisualIdentity(companionId) {
  if (!companionId) return false;
  const { referencesDir } = ensureDirs(companionId);
  const idFile = identityPath(companionId);
  let removed = 0;
  try {
    if (existsSync(idFile)) {
      const bak = idFile + '.bak.' + Date.now();
      copyFileSync(idFile, bak);
      unlinkSync(idFile);
      removed++;
    }
  } catch {}
  try {
    for (const f of readdirSync(referencesDir)) {
      if (!/\.bak\./.test(f)) {
        const full = path.join(referencesDir, f);
        try {
          copyFileSync(full, full + '.bak.' + Date.now());
          unlinkSync(full);
          removed++;
        } catch {}
      }
    }
  } catch {}
  return removed > 0;
}

export function saveReferenceImage(companionId, localPath) {
  if (!companionId || !localPath || !existsSync(localPath)) return null;
  const { referencesDir } = ensureDirs(companionId);
  const identity = getVisualIdentity(companionId) || saveVisualIdentity(companionId, {
    version: 1,
    status: 'ready',
    createdAt: new Date().toISOString(),
    identitySpec: buildVisualIdentitySpec({ companion: { id: companionId } }),
    referenceImages: [],
    notes: [],
  });
  const ext = path.extname(localPath) || '.png';
  const next = String((identity.referenceImages?.length || 0) + 1).padStart(3, '0');
  const rel = path.join('references', `ref_${next}${ext}`).replace(/\\/g, '/');
  const dest = path.join(referencesDir, `ref_${next}${ext}`);
  copyFileSync(localPath, dest);
  const updated = {
    ...identity,
    referenceImages: [...new Set([...(identity.referenceImages || []), rel])],
    updatedAt: new Date().toISOString(),
  };
  saveVisualIdentity(companionId, updated);
  return dest;
}

export function saveGeneratedPhoto(companionId, localPath) {
  if (!companionId || !localPath || !existsSync(localPath)) return null;
  const { generatedDir } = ensureDirs(companionId);
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('') + '-' + [
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join('');
  const suffix = Math.random().toString(36).slice(2, 6);
  const ext = path.extname(localPath) || '.webp';
  const dest = path.join(generatedDir, `${stamp}-${suffix}${ext}`);
  copyFileSync(localPath, dest);
  return dest;
}

function dataUrlToBuffer(url) {
  const m = String(url || '').match(/^data:([^;,]+);base64,(.+)$/);
  if (!m) return null;
  return { contentType: m[1], buffer: Buffer.from(m[2], 'base64') };
}

async function downloadGeneratedImage(url, destPath) {
  const data = dataUrlToBuffer(url);
  if (data) {
    writeFileSync(destPath, data.buffer);
    return destPath;
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!r.ok) throw new Error(`reference download HTTP ${r.status}`);
  const chunks = [];
  let total = 0;
  for await (const chunk of r.body) {
    total += chunk.length;
    if (total > 8 * 1024 * 1024) throw new Error('reference image too large');
    chunks.push(chunk);
  }
  writeFileSync(destPath, Buffer.concat(chunks));
  return destPath;
}

export function buildIdentityPrompt(identity) {
  const spec = identity?.identitySpec || identity || null;
  if (!spec) return '';
  const parts = [
    spec.ageLook,
    spec.face,
    spec.hair,
    spec.body,
    spec.style,
    spec.vibe,
    'consistent same adult person across photos',
    'realistic casual phone snapshot style',
  ].map(x => safeText(x, 160)).filter(Boolean);
  const prompt = parts.join(', ');
  return BLOCKED_RE.test(prompt) ? '' : prompt;
}

export function buildReferencePrompt(identity) {
  const identityPrompt = buildIdentityPrompt(identity);
  if (!identityPrompt) return '';
  return [
    identityPrompt,
    'adult woman in an ordinary lived-in room',
    'natural window light',
    'casual expression',
    'not overly polished',
    'not a studio portrait',
    'modest everyday content',
  ].join(', ');
}

export async function ensureVisualIdentity({
  companion,
  persona = {},
  emotionState = null,
  context = {},
  generateReference = envFlag('PHOTO_GENERATE_REFERENCE_ON_DEMAND', true),
} = {}) {
  if (!envFlag('PHOTO_VISUAL_IDENTITY_ENABLED', true)) {
    return { enabled: false, identity: null, referenceImagePath: null, capabilities: getImageProviderCapabilities() };
  }
  if (!companion?.id) {
    return { enabled: true, identity: null, referenceImagePath: null, capabilities: getImageProviderCapabilities(), error: 'missing companion id' };
  }

  let identity = getVisualIdentity(companion.id);
  if (!identity) {
    identity = saveVisualIdentity(companion.id, {
      version: 1,
      status: 'ready',
      createdAt: new Date().toISOString(),
      identitySpec: buildVisualIdentitySpec({ companion, persona, emotionState, context }),
      referenceImages: [],
      notes: [],
    });
  }

  let referenceImagePath = selectReferenceImage(companion.id);
  const capabilities = getImageProviderCapabilities();
  const canGenerateReference = generateReference && capabilities.textToImage && isImageProviderConfigured(capabilities.provider);
  if (!referenceImagePath && canGenerateReference) {
    try {
      const prompt = buildReferencePrompt(identity);
      if (prompt && !BLOCKED_RE.test(prompt)) {
        const url = await generateImage(prompt, { size: '1024x1024' });
        const { referencesDir } = ensureDirs(companion.id);
        const rawPath = path.join(referencesDir, '_ref_001_source.png');
        await downloadGeneratedImage(url, rawPath);
        referenceImagePath = saveReferenceImage(companion.id, rawPath);
        try { unlinkSync(rawPath); } catch {}
      }
    } catch (e) {
      log('warn', `[VisualIdentity] reference generation skipped companion=${companion.id}: ${e.message}`);
    }
  }

  return {
    enabled: true,
    identity: getVisualIdentity(companion.id) || identity,
    referenceImagePath: referenceImagePath || selectReferenceImage(companion.id),
    capabilities,
  };
}

export const VISUAL_IDENTITY_ROOT = VISUAL_ROOT;
