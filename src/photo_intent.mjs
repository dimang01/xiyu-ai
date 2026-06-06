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
  { re: /让我看(?:看|一下)你/, reason: '要求看你' },
  { re: /想看(?:看|一下)?你/, reason: '表达想看你' },
  { re: /看(?:看|一下)你在干嘛/, reason: '要求看当前状态' },
  { re: /你在干嘛给我看看/, reason: '要求看当前状态' },
  { re: /给我看(?:一下|下|看)?你/, reason: '要求看你' },
  { re: /爆照/, reason: '要求爆照' },
  { re: /发图(?:看看|看一下)?/, reason: '要求发图' },
  { re: /来(?:张|个)图/, reason: '要求发图' },
  { re: /再(?:发|来)(?:张|一张|个)/, reason: '要求再发一张' },
  { re: /再拍(?:张|一张|个)/, reason: '要求再拍一张' },
  { re: /照片再发(?:张|一张)?/, reason: '要求再发照片' },
  { re: /秀(?:一下|下)?(?:你|自己)/, reason: '要求秀一下' },
  // v1.10.35: "再给我看看 / 再看一张 / 再来一张看看" 类隐式 follow-up
  // 用户上一条已收到 photo，自然延续上下文要再来一张。原 STRONG L23 要求
  // 结尾必带"你"，但口语对话很少完整说"你"。
  { re: /再(?:给我)?看(?:看|一下|一张)/, reason: '要求再看一张' },
  { re: /再来一张/, reason: '要求再来一张' },
  { re: /多发(?:张|一张|几张|两张)/, reason: '要求多发几张' },
  { re: /换(?:个角度|个姿势)?(?:拍|再拍|发)/, reason: '要求换姿势再拍' },
  // 也补 "给我看看" 不带"你"的常见口语写法
  { re: /^(?:再)?给我看(?:看|一下|一张)?[嘛吧呀啊呢]?$/, reason: '要求再看一张（短口语）' },
  // v1.10.37: "看看你 / 看一下你 / 看你..." 无前缀的看你请求
  // （原 STRONG 都要求 "再/给我/让我/想" 等前缀，遗漏了赤裸 "看你"）
  { re: /^看(?:看|一下|一眼|一张)?你/, reason: '要求看你（无前缀短口语）' },
  { re: /看(?:看|一下)你(?:呀|嘛|呢|啊|吧|呗|好不|长什么|漂不|美不|帅不)/, reason: '要求看你（含语气词或追问）' },
  // "你长什么样" / "你什么样子" 类问外貌
  { re: /你长什么(?:样|模样)/, reason: '问外貌' },
  { re: /你(?:是)?什么样(?:子)?/, reason: '问外貌' },
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
