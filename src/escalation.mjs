// v1.13.x 真人感#5：被反复戳 → 情绪单向升级 + 不横跳
// 检测"同一条 pushy 消息连发 / 反复同一索求"，输出升级档位 0-3 与对应硬指令。
// 纯 "在吗/人呢" 归 #3b(bot.mjs)处理，这里专管索求/命令/催促/情感施压。
import { isSemanticallySimilar } from './text_similarity.mjs';

const PUSHY_RE  = /(自拍|照片|发图|发张|发个|发一|再发|再拍|拍张|拍个|拍一|给我看|让我看|看看你|想看你|生成|理我|回我|搭理|睬|别不理|不理我|怎么不回|回复我|快回|快发|快点|赶紧|马上回|催|说话呀|说话啊|倒是)/;
const RESIST_RE = /(不(拍|要|想拍|想|行|发)|别(闹|急|催|这样)|烦|说了|多少遍|急啥|自己玩|不想理|不理你|累了|待会|不发了|玩去|够了)/;

/**
 * @param {string} userText 当前用户消息
 * @param {Array<{role?:string,direction?:string,content?:string}>} recentTurns 最近对话(含本条之前)
 * @returns {{level:number, repeatN:number, pushy:boolean, sheResisted:boolean}}
 */
export function escalationLevel(userText, recentTurns = []) {
  const cur = String(userText || '').trim();
  const out = { level: 0, repeatN: 0, pushy: false, sheResisted: false };
  if (!cur || cur.length > 60) return out;       // 长消息 = 认真表达，不升级
  if (!PUSHY_RE.test(cur)) return out;           // 非索求/施压，不升级
  out.pushy = true;

  const users = [], assists = [];
  for (const t of recentTurns) {
    const c = String(t?.content || '');
    if (t?.role === 'user' || t?.direction === 'in') users.push(c);
    else if (t?.role === 'assistant' || t?.direction === 'out') assists.push(c);
  }
  // 从最近往前数"连续的 pushy 用户消息"(按意图持续施压，对换皮稳健) + 雷同兜底
  let consec = 0;
  for (let i = users.length - 1; i >= 0; i--) {
    const u = users[i].trim();
    // 意图持续(PUSHY)或长串雷同(≥5字才查相似度，避免短串误判) → 算一次持续施压
    if (u.length <= 60 && (PUSHY_RE.test(u) || (u.length >= 5 && cur.length >= 5 && isSemanticallySimilar(cur, u)))) consec++;
    else break;
  }
  const persist = consec + 1;            // 含当前这条
  out.repeatN = persist;
  out.sheResisted = assists.slice(-3).some(s => RESIST_RE.test(s));

  let level = persist >= 4 ? 3 : persist >= 3 ? 2 : persist >= 2 ? 1 : 0;
  // ★ 没有"她已回绝/不耐烦"信号时封顶 L1：纯黏人/撒娇连发不该被升级到撤退，只有
  //   "她已经表态、他还在反复戳"才是真挑衅，才放开升到 L2/L3。
  if (!out.sheResisted) level = Math.min(level, 1);
  out.level = level;
  return out;
}

/** 按档位返回注入到 systemPrompt 的硬指令（含反横跳约束）。level 0 返回空串。 */
export function escalationDirective(level) {
  if (!level || level <= 0) return '';
  const lock = `\n\n【★ 情绪连续性·硬约束】他在反复戳同一件事 / 反复同样的要求。**你的情绪只能往一个方向走，绝不许这一条又突然乖乖配合、服软、或热回来**——除非他真的停下 / 服软 / 道歉，你才慢慢缓。`;
  if (level === 1) return lock + `\n现在：你**开始有点不耐烦**了，语气收一点、敷衍一点，但还能忍（"嗯""知道啦""又来了哦"）。`;
  if (level === 2) return lock + `\n现在：你**明显烦了**——回得短、冲，可以怼回去（"说了多少遍了""你怎么老这样""烦不烦呀"）。别再解释、别再配合他的要求。`;
  return lock + `\n现在：你**真的被惹毛了**——撂挑子 / 冷处理："我不想理你了""你自己玩吧""行，你开心就好"，然后接下来就短、冷、不接茬。但别彻底消失，偶尔蹦一两个字让他知道你是在生气、不是没了。`;
}
