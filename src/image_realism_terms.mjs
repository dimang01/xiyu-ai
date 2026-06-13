/**
 * image_realism_terms.mjs — 出图「真人质感」措辞的【单一来源】（2026-06-13）。
 *
 * ⚠ 铁律（头像链路脱节大半年 + 1:1 自拍「升级漏改」同族的根因）：
 *   **两条出图链——visual_identity（头像候选）/ photo_planner（场景照·自拍）——的
 *   肤质 / 反塑料词表必须共用这一份**。任何真人质感升级只改本文件，杜绝"升级了
 *   photo_planner、漏改 visual_identity"那种半年才被用户负反馈撞出来的脱节。
 *
 *   落地状态：visual_identity 已接入（本批）；photo_planner 仍是内联文本（已是对的、
 *   暂不扰动），其迁移到本常量 = backlog，迁完即"真·单一来源"。
 *
 * 设计原理（v1.18-1.19 实测 + photo_planner 注释）：反恐怖谷/反塑料**不能靠堆完美词**
 * （porcelain/dewy/glossy/8k/flawless 反而催生过度锐化塑料假脸），要靠**真实细节 + 小瑕疵**
 * （raw photo / fine pores / film grain / natural skin texture / 轻微不对称）。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

/** 正向：真实肤质 / 质感锚（拼进出图 imagePrompt）。 */
export const REALISTIC_SKIN_TERMS = [
  'real unretouched smartphone photo with natural skin texture, fine pores and subtle imperfections',
  'natural light and soft shadow on the skin, slight asymmetry in facial features like a real person',
  'film grain, no beauty filter, no airbrushing — a candid real phone snapshot, not an idealized AI render',
];

/**
 * 负向：会催生塑料假脸 / 娃娃脸 / 恐怖谷的禁词【黑名单】——出图 prompt 不许出现。
 * （含本批从头像链路删掉的四个：porcelain / dewy-glossy / baby-faced / doe-eyed）
 */
export const ANTI_PLASTIC_NEGATIVES = [
  'porcelain', 'dewy', 'glossy', 'baby-faced', 'baby faced', 'doe-eyed', 'doll face', 'doll-face',
  'poreless', 'flawless skin', 'airbrushed', 'over-smoothed', 'waxy',
  '3d render', 'cgi', 'hyperreal', 'masterpiece',
];

/** 真实肤质锚拼成 prompt 片段。 */
export function realisticSkinPhrase() {
  return REALISTIC_SKIN_TERMS.join(', ');
}

/** 自检：prompt 是否命中塑料黑名单（返回命中词数组，空=干净）。smoke / 出图前断言用。 */
export function findPlasticTerms(prompt) {
  const p = String(prompt || '').toLowerCase();
  return ANTI_PLASTIC_NEGATIVES.filter(t => p.includes(t));
}
