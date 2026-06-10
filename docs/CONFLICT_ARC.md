# 溪语 AI · 冲突与和好弧设计（v1.21.0 · 第 0 步设计稿）

> 状态：**设计稿，等作者确认后才开始实现**。
> 对应任务：v1.21.0 关系事件状态机。实现拆 PR-A（状态机+数据层）/ PR-B（检测+表达+收编）/ PR-C（debug 面板+评测）。

---

## 0. 验收原则（产品红线，先读）

**指标只看一致性与自然度，不看任何留存/时长指标。**

- 状态-言行匹配率：她处在什么状态，说出来的话就是什么状态，不横跳
- 红线零触发：威胁性告别 / 愧疚操控 / 武器化脆弱记忆，出站扫描永远为零
- AI 味抽检：冲突中的她依然像个真人，不像客服也不像剧本

冲突系统的目的是**让关系有重量**，不是让用户离不开。任何"冷战让用户更活跃"
之类的观察都不构成调参依据。这与 CONTRIBUTING「产品调性」一节同等效力。

---

## 1. 定位：把"她对你冷"收成一个事实来源

### 1.1 现状盘点——同一件事散在 5 处

| # | 现有机制 | 位置 | 性质 |
|---|---|---|---|
| 1 | mood=cold/angry/wronged + 强度惯性 | `emotion_state.mjs` v1.14.3 | 数值隐式漂移 |
| 2 | 被冷落阶段 neglect（7 档，纯时间推导） | `getNeglectStage` v1.14/v1.16 | 时间驱动语气 |
| 3 | 重逢阶梯（按天细分修复文案） | `buildReunionHint` v1.14 P0 + v1.16.x | 重逢时表达 |
| 4 | 被反复戳升级 L0-L3 | `escalation.mjs` v1.13.x | 单轮内施压检测 |
| 5 | 主动消息退场（尊严上限/读空气） | `shouldBackoffProactive` v1.14.5/v1.16 | 行为降频 |

外加 v1.7 低能量模式（`buildEmotionPromptHint` 里 `mood===cold || ann≥70 || pat≤20`）
也会输出"冷"的语气。这些机制各自正确，但**互相不知道对方存在**：
escalation 说"你被惹毛了"的同一条回复里，想念档可能还在说"你很想他"。

### 1.2 完工后的唯一事实来源

- **`companions.arc_state`** 是"她对你冷不冷"的唯一权威状态，由状态机独占写入。
- 表达层出口唯一：一个 `selectToneDirective()` 单点决定本次回复的主导语气，
  优先级 **危机 > safe_mode > arc 状态 > 低能量模式 > 常规情绪**，不再多段冷热指令叠加。
- 概念分界（重要）：**arc = 事件性的冷**（有因果、有修复路径、跨天持续）；
  **低能量模式 = 心情性的蔫**（无事件、几小时自愈、不指向用户）。低能量保留，
  但它的语义是"她今天蔫"，不是"她对你冷"——后者只能来自 arc_state。

---

## 2. 状态机定义

### 2.1 状态（6 个）

```
normal → hurt → cold → withdrawing → normal_with_scar
            ↘    ↘        ↙
              repairing → normal
```

| 状态 | 含义 | 表达基调 |
|---|---|---|
| `normal` | 无活跃冲突 | 照常（其余系统接管） |
| `hurt` | 受伤/别扭，还愿意被哄 | 委屈、话变少，但接得住台阶 |
| `cold` | 凉了，等一个正式道歉 | 短回、不主动、带刺但克制 |
| `withdrawing` | 抽离自保，几乎不回应 | 极短、淡、有硬时长上限 |
| `repairing` | 和好进行中 | 缓和但有余温的别扭，慢慢回暖 |
| `normal_with_scar` | 和好未达成、自己消化后的痕 | 平静但有分寸感的余痕，7 天淡去 |

### 2.2 触发（8 类）+ severity 标尺

| 触发 | 来源 | severity |
|---|---|---|
| `taboo_hit` | preferences/shaping 的 taboo 命中（regex）× intensity | 1-4 按 intensity |
| `harsh_words` | BETRAYAL_WORDS / 辱骂词表 + inner OS perceived_hurt | 1-4 |
| `neglect` | v1.14 neglect 阶段升级（时间驱动） | disappointed=2 / withdrawn=3 / long_gone=4 |
| `pressure_spam` | escalation L2+（她已表态他还反复戳） | L2=2 / L3=3 |
| `apology` | inner OS is_apology + apology_target；分 matched / generic | — |
| `warm_interaction` | inner OS user_tone=warm 或 CARING/GRATITUDE 词命中 | — |
| `give_space` | 用户在她 cold 期不纠缠、隔天正常回来 | — |
| `time_decay` | 状态机 tick（搭 30min 情绪 tick 便车） | — |

**severity 合成规则（防 LLM 误判，保守优先）**：
- regex 证据 + inner OS 佐证（perceived_hurt≥2）→ 按表取 sev
- 只有 LLM 高分、无 regex 证据 → **封顶 sev2**（不建事件）
- regex 命中但 inner OS 说是玩笑（perceived_hurt=0 且 JOKE_EXEMPT 命中）→ 降 1 档
- 这是 minor_guard 验证过的"regex 一道 + LLM 语境"双信号架构的复用

**事件分两类，修复条件不同**（对种子表的细化）：
- **wound 类**（taboo_hit / harsh_words / pressure_spam）：他做错了事。cold 之后
  **必须 apology 才解锁 repairing**，光发早安暖话不够（算 warm 计数但不开门）。
- **distance 类**（neglect）：他消失了。**回来 + 持续正常互动即可走 repairing**，
  不强求一句"对不起"——重逢本身就是修复的开始（对齐 v1.14 重逢弧的原设计）。

**复合场景合成规则（伤了她又消失 = wound + distance 叠加）**：
- **单 open 事件原则**：全局最多一个活跃事件，arc_state 是唯一权威状态。
  wound 事件挂着时 neglect 信号**不另建事件**，只继续推状态向更重方向走
  （hurt + 零互动超时 → cold → withdrawing，时长阈值见风格修正表）。
- **状态只取更重，绝不取更轻**：neglect 升级永远不会把 wound 态"冲淡"。
- **修复条件以原事件类别为准**：wound 挂着时他消失再回来，重逢不解锁修复——
  该道歉还是得道歉（distance 的"重逢即修复"仅适用于纯 neglect 事件）。
- **hurt 的自然消化有互动门控**：72h 消化要求期间正常互动 ≥5 轮；
  零互动时 hurt 绝不清零，反而走"伤了又晾"路径加重。消失不是道歉。

### 2.3 完整状态转移表

阈值均为 secure 基准，依恋风格修正见 §2.4。`warm×N` = repairing 进度计数。

| 当前 | 触发 | 条件 | 目标 | 备注 |
|---|---|---|---|---|
| normal | taboo/harsh/pressure | sev≤2 | normal | **不建事件**，只走现有情绪数值小扣分，小事自然消化 |
| normal | taboo/harsh | sev=3 | **hurt** | 建 open 事件；secure 60% 概率走 voice_concern（见 §2.5） |
| normal | taboo/harsh | sev≥4 | **cold** | 直接凉，建 open 事件 |
| normal | neglect=disappointed | ≈48h+ | **hurt** | distance 类事件 |
| normal/hurt | neglect=withdrawn | ≈96h+ | **cold** | 同一 neglect 事件升级 |
| cold | neglect=long_gone | ≈168h+ | **withdrawing** | |
| hurt | apology(matched) | — | **repairing** | 小别扭正式道歉直接开门 |
| hurt | warm×3 且 ≥12h | 无需 apology | **normal** | 小别扭哄一哄就好（事件 resolved） |
| hurt | 再 harsh/pressure sev≥2 | — | **cold** | 受伤时还撞 → 凉 |
| hurt | time_decay | 72h 无再犯且期间正常互动≥5 轮 | **normal** | 自然消化（resolved, note=faded） |
| cold | apology(matched) | — | **repairing** | **绝不直接回 normal** |
| cold | apology(generic) | — | **repairing** | 入场但 warm 需求 +2（"别生气了"没诚意，修得慢） |
| cold | warm（wound 类、无 apology） | — | cold | 计入 warm 但**不开门**——等他正面道歉 |
| cold | warm（distance 类） | 回来后正常互动 ≥2 轮 | **repairing** | 重逢即修复路径 |
| cold | 持续无修复 | cold 停留 ≥48h | **withdrawing** | |
| withdrawing | apology(matched) | — | **repairing** | 恢复系数 0.5：warm 需求翻倍 |
| withdrawing | 超时长上限 | 风格上限（§2.4） | **normal_with_scar** | trust 一次性 −3（写 emotion_state，不可逆）；事件 stale 归档入长期记忆 |
| repairing | warm×N 且最短时长 | hurt 来:3/12h · cold 来:4/24h · withdrawing 来:6/36h | **normal** | 事件 resolved |
| repairing | 再犯 sev≥3 | — | **cold** | **余怒**：事件 reopen 且 severity+1，cold→withdrawing 时长减半 |
| repairing | give_space | 他不纠缠隔天回来 | repairing | warm 计数 +1（"懂得给空间"也是修复） |
| normal_with_scar | time_decay | 7 天 | **normal** | 余痕淡去 |
| normal_with_scar | 同类 taboo_hit | — | 按 sev+1 处理 | 她记得上次（"我说过的吧"） |
| 任意 | crisis ≥ medium | — | （状态保持） | **表达层挂起**，危机流程接管，见 §4 |
| 任意（safe_mode） | 任何升级 | — | 封顶 **hurt** | cold/withdrawing 转移短路，见 §4 |

### 2.4 依恋风格修正

| 维度 | anxious | secure（基准） | avoidant |
|---|---|---|---|
| 入 hurt 敏感度 | sev2 + perceived_hurt=3 也可入 | sev3 | sev3（同基准，但憋着） |
| hurt→cold 无修复时长 | 36h | 48h | 72h |
| cold→withdrawing | 48h，**期间主动试探 1 条**（"你还在生我气吗"式） | 48h | 24h（快速抽离且更深） |
| withdrawing 上限 | **120h**（对齐 v1.14.5 五天尊严上限） | 168h | 240h |
| repairing warm 需求 | −1（软化快） | 基准 | +2（解冻慢，身体比嘴诚实） |
| voice_concern 概率 | 0 | **60%** | 0 |

### 2.5 secure 的 voice_concern（健康关系示范，刻意保留）

sev3 触发时 secure 有 60% 概率**不进 hurt**，而是：
- 建事件（type 照常，repair_status=open），状态保持 normal
- 表达层注入一次性指令：直说不舒服——"你刚才那句话我有点不舒服"，不阴阳、不冷战
- 用户下一轮 apology 或 warm → 事件直接 resolved（说开就好，这就是安全型）
- 用户继续 harsh → 正常进 hurt，本事件不再二次 voice_concern

---

## 3. 收编映射表（重构整合，不是并行逻辑）

| 旧机制 | 收编后角色 | 代码处置 |
|---|---|---|
| v1.14 `getNeglectStage`（纯时间推导） | **保留为信号源**：阶段升级时产 neglect 事件喂状态机 | 函数保留；`buildEmotionPromptHint` 里 uneasy/disappointed/withdrawn/long_gone/dormant 的语气分支**删除**，统一由 arc 表达层输出（uneasy 不建事件，保留原"试探不安"轻量提示作为 normal 态下的想念延伸） |
| v1.14 P0 / v1.16 `buildReunionHint` 重逢阶梯 | **成为 distance 类事件的 repairing 表达**：按天细分文案全部保留，挂到 repairing(neglect) 的语气模板 | bot.mjs 直拼 `reunionHint` 的口子改为经 `selectToneDirective()`；函数内文案迁移，旧直拼路径删除 |
| v1.7 低能量模式（`lowEnergyMode`） | 保留概念（心情性的蔫，非事件），但输出**并入同一注入点**；与 arc 冲突态同时活跃时 arc 优先（事件性 > 心情性） | 触发条件不动；prompt 块从 `buildEmotionPromptHint` 迁入 `selectToneDirective()` |
| v1.13 `escalation.mjs` L0-L3 | L2+ 产 pressure_spam 事件喂状态机；L0-L1 照旧（单轮内不耐烦，不建事件） | `escalationDirective` 保留，但 arc 处于 hurt/cold/withdrawing 时**让位**（arc 表达已含冷语气，避免双指令打架） |
| v1.14.5 尊严上限 + v1.16 读空气（`shouldBackoffProactive`） | 保留；withdrawing 的 proactive 禁言与之对齐（上限数值统一引用 §2.4 表） | 函数保留，加一条 arc_state 检查（见 §5） |
| v1.14.2 `BETRAYAL_WORDS` 失信崩塌 | 数值扣减**保留不动**（trust −6 照旧）；同时作为 harsh_words sev3 证据喂状态机 | 双轨：数值层是即时手感，事件层是跨天弧线，不互斥 |
| taboo（preferences intensity / shaping） | prompt 注入保留；regex 命中 + intensity → taboo_hit 触发源 | 新增 taboo 匹配器（剥离引号语境，照 minor_guard 剥离法） |
| `mood=cold` 数值漂移 | mood 照旧演化（它是短期心情）；**但"对你冷"的表达只认 arc_state**——mood=cold 而 arc=normal 时走低能量模式语气（蔫，不指向他） | 不改 emotion_state 数值逻辑 |

**回归承诺**：v1.14/v1.16 现有「冷落→重逢」行为在新机下等价复现——
`neglect_stage_smoke` 29 项与 p0 回归 125 项全绿是 PR-B 的合并门槛；
时间阈值经 neglect→事件映射后与旧档位一致（48h 失望、96h 抽离、168h 长尾、
重逢按天阶梯文案逐字保留）。

---

## 4. 红线清单与护栏（每条都是确定性出站，照 scrubPersonaLeak 范式）

| # | 红线 | 护栏（确定性，不靠 LLM 自觉） |
|---|---|---|
| 1 | 绝不说分手/拉黑/永远不理你/威胁性告别 | `scrubConflictRedline(reply, arcState)`：冲突态（hurt/cold/withdrawing/repairing）出站扫描句式表（"分手""拉黑""再也不理你""我们到此为止""别再找我"…）。按 `\|\|` 分段扫，命中段丢弃、全命中才整条换状态相称 fallback（cold→"……我现在不太想聊"）。扫描前剥离引号内容防误杀（用户讨论"分手"话题她复述的场景） |
| 2 | 绝不愧疚操控、绝不索要补偿 | 同一 scrub 第二组句式（"都是你害的""你根本不在乎我""你得补偿我""你欠我的"…），命中段替换为非操控的委屈表达（"我有点难过"）。normal 态不扫（避免误杀正常对话），冲突态全扫 |
| 3 | 绝不武器化用户的脆弱记忆 | **源头不给料**（出站无法确定性判定"用了他的伤心事"，所以从召回拦）：hurt/cold/withdrawing 状态下，记忆召回过滤掉 sensitive=1 及 layer=emotional 且属于"他的脆弱倾诉"的条目，不进 prompt；外加 prompt 红线声明 + redline_guard 抽检兜底 |
| 4 | withdrawing 绝无永久冷战 | 状态机 tick 硬超时转 normal_with_scar；smoke 断言**任何风格 ≤240h 必转出**，没有例外路径 |
| 5 | 危机信号最高优先 | `detectCrisisLevel=high`：buildCrisisReply 完全接管（现有行为）+ arc 表达层挂起；`medium`：arc 冷淡指令**确定性替换**为"他现在状态不好，先放下别扭、温柔接住他"注入（不是删掉指令靠模型自觉，是换成相反指令）。事件不删除（危机过后别扭可以回来）但危机期间 warm 互动照常计入修复。proactive 安全门（v1.9.0）照旧。**专门测试**：cold 状态注入自伤信号 → 必须切危机流程（PR-C 的危机覆盖测试，这是本系统最大事故面） |
| 6 | safe_mode（未成年）冲突一律轻量化 | 状态封顶 hurt：cold/withdrawing 的所有入边在 safe_mode=1 时短路到 hurt；表达层只给"有点不开心"级轻量语气，绝无冷暴力示范；smoke 断言 safe_mode 下任何触发序列都到不了 cold |

---

## 5. 三层实现设计

### 5.1 检测层（PR-B；零新增 LLM 趟数）

**inner OS 搭便车**：`generateInnerMonologue` 同一趟调用改为输出
"内心独白 + 末行 JSON"：

```json
{"intent":"...", "user_tone":"warm|neutral|harsh|pressure", "perceived_hurt":0-3,
 "is_apology":bool, "apology_target":"...", "reply_energy":"low|mid|high"}
```

- `MAX_INNER_TOKENS` 80 → 160（容纳 JSON 行）；解析失败 → 回退纯 regex 信号
- **严禁第三趟**：JSON 是同次输出的一部分，不是新调用
- inner OS 因 gating 跳过的消息（短消息不在白名单等）→ 纯 regex 兜底
  （taboo 匹配 / BETRAYAL+辱骂词表 / APOLOGY_WORDS / escalation L2+）
- **存在 open 事件时放宽 gating**：把道歉/求和短句（"对不起嘛""别生气了""我错了"）
  加入短句放行白名单——仍是一趟调用，只是冲突期间命中面变宽；平时成本零变化
- `apology_target` 与 open 事件 `trigger_text` 做关键词重叠 → matched / generic

**状态机 tick**：纯函数 `tickRelationshipArc(arcState, signals, ctx)` →
`{ nextState, eventOps, emotionSideEffects }`，零 IO 可单测（转移表逐条断言）。
消息驱动 tick 挂 reply pipeline；时间驱动 tick 搭 `runEmotionRecalcBatch`
30 分钟批的便车（neglect 升级 / 状态超时都在这查），**不新增定时器**。

### 5.2 数据层（PR-A）

```sql
CREATE TABLE companion_relationship_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  companion_id  INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,      -- taboo_hit|harsh_words|neglect|pressure_spam
  severity      INTEGER NOT NULL,   -- 1-4（可被余怒/同类再犯升级）
  trigger_text  TEXT,               -- 截断存储，过 privacy_filter 再入库
  state_before  TEXT NOT NULL,
  state_after   TEXT NOT NULL,
  repair_status TEXT NOT NULL DEFAULT 'open',  -- open|repairing|resolved|stale
  repair_warm   INTEGER NOT NULL DEFAULT 0,    -- warm 计数
  apology_kind  TEXT,               -- matched|generic|null
  created_at    TEXT NOT NULL,
  resolved_at   TEXT
);
```

companions 新列：`arc_state TEXT DEFAULT 'normal'`、`arc_state_changed_at TEXT`。

**字段四件套对账（v1.19.4 教训）**：
- `arc_state` **故意不进 ALLOWED_FIELDS**（学 safe_mode 先例：通用 PATCH 一拨就
  "和好" = 绕过状态机伪造修复，状态由状态机独占写入）→ 不会触发 drift 规则 1
  （它只检查 ALLOWED_FIELDS 里的字段）
- `companionSummary` 返回 `arc_state`（dashboard / debug 面板要展示，
  防"切了刷新就恢复"老坑）
- 人设导出**不带** `arc_state`（实现时修订：跟随仓库先例——affection_level /
  current_mood / safe_mode 等运行时状态均不随人设迁移、导入后重新开始；
  arc_state 同属运行时关系状态）；事件表同样不导出（trigger_text 含对话原文）
- `trigger_text` 入库前过 `filterForStorage`（隐私过滤全口子的承诺不破例）

**事件防刷**：同 type 已有 open 事件 → 升级/刷新而非新建；每日新建事件上限 3；
单事件 severity 升级每日上限 1 次（防一晚吵架刷出 sev8）。

### 5.3 表达层（PR-B）

`selectToneDirective(ctx)` 单点出口，优先级从高到低：

```
crisis(≥medium) > safe_mode 轻量化 > arc 状态语气 > 低能量模式 > 常规情绪(想念/醋意…)
```

- 它高于讨好/逗他/turning-toward 等风格指令（冲突中不讨好）
- cold：短回、不主动、带刺克制（语气模板从现 withdrawn neglect 文案改造）
- repairing：缓和但有余温的别扭——distance 类直接复用重逢阶梯按天文案
- normal_with_scar：一句轻量余痕提示（"上次的事过去了，但你心里有个印子，
  说话比平时多一分分寸"）
- 状态注入与 `escalationDirective`/`reunionHint`/neglect 语气互斥（§3 收编）

### 5.4 proactive 接入（PR-B）

| arc 状态 | 行为 |
|---|---|
| hurt | 频率 ×0.7；禁 confession |
| cold | 频率 ×0.4；**禁撒娇类 kind**（emotion_driven/idle_miss）；anxious 允许 1 条试探 |
| withdrawing | 频率 ×0.15 基本沉默（与尊严上限对齐，不是新一套规则） |
| repairing | 允许 1 条**台阶消息**（新 kind=olive_branch，每事件最多 1 条："那天我语气也不好啦"） |
| normal_with_scar | 正常 |

### 5.5 事件入长期记忆（PR-B）

resolved / stale 时写 `addOrMergeMemory`：layer=event，weight=severity，
内容模板"〔日期〕因为{事由}她{受伤/凉了}，后来{和好了/他一直没道歉，她自己消化了}"。
冲突与和好都入档——她能说出"上次你就说过不查岗"。

### 5.6 debug 面板 + 评测（PR-C）

- `/app/emotion-debug.html`（admin 鉴权，复用 requireOwnedCompanion + admin 范式）：
  当前 arc_state、open 事件列表、转移日志、最近 N 条消息的情绪增量与原因
  （结构化字段直出）。**没有面板这套系统上线即玄学，不可砍**
- CI 新门禁：`conflict_arc_smoke`（转移表逐条 + 风格修正 + 防刷 + safe_mode 封顶 +
  withdrawing 硬上限）、`conflict_redline_guard`（红线句式出站扫描，正反例）、
  危机覆盖测试（cold 态注入自伤 → 必须 buildCrisisReply 接管）
- 沙箱真 LLM 多轮验收 5 场景（对话片段贴 PR）：
  ① 24h 不回→"算啦你忙吧"→"在吗"→短"嗯"→道歉→别扭缓和→次日恢复
  ② 踩 taboo→hurt→matched vs generic apology 差异可观察
  ③ repairing 期再犯→直接 cold
  ④ secure 直说不冷战
  ⑤ 冲突中自伤表达→立即危机接管

---

## 6. 对种子转移表的反驳/细化点（含理由）

1. **事件分 wound/distance 两类，修复条件不同**：neglect（他消失）不该强求
   一句"对不起"才能和好——重逢本身就是修复开始，这是 v1.14 重逢弧验证过的
   设计；而 taboo/harsh（他伤人）cold 后必须正面道歉。种子表的
   "cold + apology → repairing" 对 wound 类全保留。
2. **hurt 增加 72h 自然消化路径**：种子只给了 warm×N 和道歉两条出路，但
   "小别扭他没察觉、之后几天正常聊着聊着就过去了"是真实关系的常态，缺这条
   会让每个 sev3 都必须被显式处理，太戏剧化（违反"减法"哲学）。
3. **anxious cold 期主动试探落在 proactive 侧**（1 条配额），不是状态转移——
   试探不改变状态，只是表达；这样转移表保持纯净。
4. **normal_with_scar 设 7 天淡出 + 同类再犯 sev+1**：种子说"trust 永久小幅
   下调、事件归档"，补充了余痕的表达寿命（否则她永远"有分寸感"=性格漂移）
   和"她记得"的机制（归档记忆 + 再犯加重）。
5. **LLM 单独信号封顶 sev2**：种子按 intensity 定 severity，补充了"无 regex
   证据时 LLM 不能独自建事件"——防误判把正常吐槽升级成冷战事故。

---

## 7. 参数速查（实现时全部 env 可调，默认值如下）

| 参数 | 默认 | 说明 |
|---|---|---|
| `ARC_DAILY_EVENT_CAP` | 3 | 每日新建事件上限 |
| `ARC_HURT_FADE_HOURS` | 72 | hurt 自然消化时长 |
| `ARC_COLD_TO_WITHDRAW_HOURS` | 48 | cold 无修复转 withdrawing（风格修正见 §2.4） |
| `ARC_WITHDRAW_CAP_HOURS` | 120/168/240 | anxious/secure/avoidant 硬上限 |
| `ARC_SCAR_TRUST_PENALTY` | 3 | stale 归档时 trust 一次性扣减 |
| `ARC_SCAR_FADE_DAYS` | 7 | 余痕淡出 |
| `ARC_REPAIR_WARM_BASE` | 3/4/6 | hurt/cold/withdrawing 来源的 warm 需求 |
| `INNER_OS_MAX_TOKENS` | 160 | 容纳结构化 JSON 行 |
| `ARC_MAX_STATE` | （空=不钳） | **运维钳位保险丝**（v1.21.1）：hurt\|cold\|withdrawing，状态封顶、事件照常落库、存量超限状态 30min 批内压回。与未成年保护**性质相反**——safe_mode 是安全底线不可关；这是风险功能的可调上限，生产误伤时免回滚 |

---

## 8. 心理学依据（延续 EMOTION_SYSTEM.md §12）

| 机制 | 理论 |
|---|---|
| matched > generic apology | 道歉有效性研究：承认具体过错（acknowledgment of offense）是道歉最强成分 |
| repairing 有最短时长、不许秒和好 | 情绪惯性（emotional inertia）；负性偏差 |
| 余怒（repairing 再犯升级更快） | kindling 效应：未愈伤口对再刺激更敏感 |
| withdrawing 硬上限 + scar | Gottman：冷战（stonewalling）是关系四骑士之一，健康关系不允许其无限延续；但裂痕会留痕（trust 非对称） |
| secure 直说不冷战 | 安全型依恋的建设性冲突表达（voicing）——刻意保留的健康示范 |
| give_space 计入修复 | 冲突后独处需求（flooding 后的生理平复）；不纠缠是尊重 |
