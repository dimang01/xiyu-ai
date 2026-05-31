/**
 * 照片请求意图检测。
 *
 * 只做轻量规则识别：强请求会进入真实发图路径，弱上下文仅供后续低频主动策略参考。
 */

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？!?、,.~～…"'“”‘’：:；;（）()【】[\]{}<>《》]/g, '');
}

const STRONG_PATTERNS = [
  { re: /发(?:张|个|一张)?照片/, reason: '要求发送照片' },
  { re: /发(?:张|个|一张)?自拍/, reason: '要求发送自拍' },
  { re: /自拍(?:看看|看一下|给我|一张)?/, reason: '要求自拍' },
  { re: /拍(?:一张|张)(?:给我|看看|看一下)?/, reason: '要求拍一张' },
  { re: /让我看看你/, reason: '要求看你' },
  { re: /想看你/, reason: '表达想看你' },
  { re: /看看你在干嘛/, reason: '要求看当前状态' },
  { re: /你在干嘛给我看看/, reason: '要求看当前状态' },
  { re: /给我看(?:一下|看)?你/, reason: '要求看你' },
  { re: /爆照/, reason: '要求爆照' },
  { re: /发图(?:看看|看一下)?/, reason: '要求发图' },
  { re: /来(?:张|个)图/, reason: '要求发图' },
];

const WEAK_PATTERNS = [
  { re: /^(你)?在干嘛(呢|呀|啊)?$/, reason: '询问当前状态' },
  { re: /睡了吗/, reason: '夜间关心' },
  { re: /到家了吗/, reason: '到家关心' },
  { re: /今天好累/, reason: '情绪分享' },
  { re: /想你了/, reason: '想念表达' },
];

const UNSAFE_PHOTO_RE = /(裸|露点|色情|黄片|做爱|性爱|床照|内衣|胸|屁股|性|血腥|自残|杀人|未成年|萝莉|正太)/;

export function detectPhotoIntent(text) {
  const normalized = normalizeText(text);
  if (!normalized) return { type: 'none', reason: '' };

  for (const rule of STRONG_PATTERNS) {
    if (rule.re.test(normalized)) {
      return { type: 'strong_photo_request', reason: rule.reason };
    }
  }

  for (const rule of WEAK_PATTERNS) {
    if (rule.re.test(normalized)) {
      return { type: 'weak_photo_context', reason: rule.reason };
    }
  }

  return { type: 'none', reason: '' };
}

export function hasUnsafePhotoContent(text) {
  return UNSAFE_PHOTO_RE.test(normalizeText(text));
}
