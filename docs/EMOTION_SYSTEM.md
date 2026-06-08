# 溪语 AI · 情绪系统设计文档（v1.14）

> 本文档覆盖 v1.14 全系列的情绪 / 关系系统：被冷落阶段、依恋风格、关系修复弧，以及情绪审计 A→D。
> 代码主体在 [`src/emotion_state.mjs`](../src/emotion_state.mjs)，注入点在 [`src/companion.mjs`](../src/companion.mjs)、[`src/bot.mjs`](../src/bot.mjs)、[`src/proactive.mjs`](../src/proactive.mjs)、[`src/proactive_engine.mjs`](../src/proactive_engine.mjs)。

---

## 0. 设计哲学

1. **真人感 = 减法**：她有自己的内在和边界，不完全为你服务。
2. **情绪要有因果**：信任是「聊」出来的、被冷落会「凉」、失信会「崩」——而不是凭空涨跌。
3. **情绪要有惯性**：不会一句话从生气变开心；负面比正面更持久。
4. **会自己平复**：所有情绪随时间回归基线（不会永远挂着）。
5. **健康而非操纵**：克制「夺命连环 call」式的愧疚营销；anxious 风格也有尊严上限。

每条决定都尽量挂靠成熟的心理学（见 §12）。

---

## 1. 情绪维度

状态存在 `companion_emotion_state` 表（[`db.mjs::migrateEmotionState`](../src/db.mjs)），`getEmotionStateWithDefaults()` 读取并用 `DEFAULT_STATE` 兜底。

| 维度 | 范围 | 默认 | 类型 | 含义 | 基线回归（§4）|
|---|---|---|---|---|---|
| `affection` | 0–100 | 0 | 长期 | 关系好感（实际由 `memory.mjs` 管，决定关系阶段）| 不在 idle 涨 |
| `trust` | 0–100 | 50 | 长期 | 信任：互动积累、失信崩塌 | 冷落缓降 |
| `dependency` | 0–100 | 30 | 中期 | 依赖/想念，idle 越久越高 | — |
| `possessiveness` | 0–100 | 20 | 中期 | 占有欲/醋意 | →20（0.05）|
| `security` | 0–100 | 50 | 中期 | 安全感：被冷落/拒绝下滑 | 冷落缓降 |
| `energy` | 0–100 | 60 | 短期 | 精力，跟昼夜节律 | 朝时段目标 |
| `patience` | 0–100 | 60 | 短期 | 耐心，被连发/施压消耗 | →60（0.06 回升）|
| `excitement` | 0–100 | 30 | 短期 | 兴奋（被夸/惊喜冲高）| →30（0.25 快衰）|
| `annoyance` | 0–100 | 0 | 短期 | 烦躁（被忽视/打断累积）| →0（0.08 慢衰）|
| `gratitude` | 0–100 | 40 | 长期 | 感激（体贴/陪伴累加）| →40（0.02 极缓）|
| `mood` | 枚举 | `neutral` | — | 当前主情绪（10 态）| 见 §5 |
| `mood_intensity` | 0–100 | 0 | — | 主情绪强度（C 新增），决定切换/退出 | 衰减归零→neutral |
| `availability` | free/busy/half | free | 即时 | 此刻是否方便聊（由日程派生）| — |
| `attention` | 0–100 | 80 | 即时 | 对这条消息的注意力 | — |

`mood` 枚举：`neutral / happy / shy / tired / wronged / jealous / angry / cold / comforting / clingy`。

---

## 2. 三个更新函数（因果核心）

| 函数 | 触发时机 | 负责 |
|---|---|---|
| `updateEmotionFromUserMessage` | 用户发消息 | 关键词 delta + **互动漂移积累信任** + 失信崩塌 + mood 惯性切换 + 维度耦合 |
| `updateEmotionFromAssistantReply` | 她回复后 | 短期情绪小幅衰减 + mood 按强度消退 |
| `updateEmotionFromIdle` | 每 30min 定时 | dependency 想念 + mood 情绪转向 + 信任/安全感「生疏」+ 各维度时间回归 |

定时入口：`runEmotionRecalcBatch()`（由 `plan_tasks.mjs` 每 30 分钟对所有活跃 companion 调用一次 idle tick），让情绪「即使用户不发消息也随现实时间推进」。

**所有更新都是增量（incremental）**：`next = clamp(current + delta, 0, 100)`，`upsertEmotionState` 在 SQL 层是 partial UPDATE（动态 key），没传的维度不动。

---

## 3. 信任的因果（审计 🅰，v1.14.1 + v1.14.2）

> **核心修复**：v1.13.x 曾把「朝关系深度目标漂移」错放在 **idle 路径**，导致「用户越不理她、信任越涨」的反因果。v1.14.1 把它挪回**互动路径**。

- **互动积累**（`updateEmotionFromUserMessage`）：每条用户消息，trust/security 朝目标小步漂移
  - `trustTarget = clamp(42 + affection*0.5, 30, 92)`，步长 `0.06`
  - `securityTarget = clamp(40 + affection*0.45, 25, 90)`，步长 `0.05`
  - 关系越深，信任天花板越高；但只有「聊」才积累。
- **失信崩塌**（🅰 负性偏差）：`BETRAYAL_WORDS`（说话不算数/食言/爽约/我骗你/懒得理你/关我什么事/言而无信…）命中且无 `JOKE_EXEMPT`（哈哈/逗你/骗你的啦）→ **trust −6、security −4**
  - **绕过 saturation dampening**（失信会累积记仇）
  - 失信时**跳过互动漂移**（当然不积累信任）
  - 依据：信任崩塌 ≈ 建立 **3×**（§12）
- **高信任缓冲**（🅳-2）：`trust > 80` 时背叛冲击 ×0.6（厚信任更抗辜负）

---

## 4. 时间回归（审计 🅱，v1.14.2）

所有短期/可变维度在 idle tick（每 30min）按真实时间朝基线回归，**不依赖「她是否回复」**。正面衰减快、负面慢（情绪心理学）。

| 维度 | 基线 | 速率/tick | 说明 |
|---|---|---|---|
| excitement | 30 | 0.25 | 正面，快衰 |
| annoyance | 0 | 0.08 | 负面，慢衰（持久）|
| possessiveness | 20 | 0.05 | 醋意消退 |
| patience | 60 | 0.06 | 休息恢复耐心（回升）|
| gratitude | 40 | 0.02 | 极缓 |

实现：`updateEmotionFromIdle` 内 `_toward(cur, base, rate)`。

**trust/security 的 idle 行为**：< 24h 持平；被冷落越久越「生疏」朝降低目标缓慢下滑（见 §7），重新联系后由互动漂移回暖（**可逆**）。

---

## 5. mood 强度与惯性（审计 🅲，v1.14.3）

引入 `mood_intensity`（0–100），让情绪有惯性，不被一句话瞬间切换。

- **初始强度** `MOOD_INTENSITY0`：负面高、退得慢——angry 65 / cold 60 / jealous 60 / wronged 55；comforting 45 / happy 45 / shy 42 / tired 40 / clingy 35。
- **惯性切换**（`updateEmotionFromUserMessage`）：
  - 同情绪 → 强度 +20（叠加刷新）
  - 当前 neutral 或强度耗尽 → 直接进入新情绪
  - 新情绪强度 ≥ 当前 → 覆盖
  - 否则 → 不切换，当前强度 −12（被撼动但压得住）
- **强度消退退出**（取代原 20% 随机骰子）：
  - 回复后：负面 −8、正面 −18（负面退得慢）
  - idle tick：负面 −12、正面 −24
  - 强度 ≤ 0 → 回 `neutral`
- **idle 冷落档**给 mood 中等强度（负面 52 / 其它 40）；< 12h 互动情绪随时间消气。

---

## 6. 混合情绪 + 维度耦合（审计 🅳，v1.14.4）

- **🅳-1 混合情绪底色**（纯 prompt，`buildEmotionPromptHint`）：主情绪之下注入「另一层」
  - 委屈/冷/凶 + 高 dependency(≥60) → **"又凶又软"**（嘴上推、心里还要）
  - happy + 低 security(<35) → 患得患失
  - clingy + 高 annoyance(≥40) → 又黏又闹
  - neutral + 中等 annoyance(35–60) → 表面没事、心里闷气
  - `mood_intensity` ≥70 → 表达更浓；<25 → 点到为止
- **🅳-2 维度耦合**（`updateEmotionFromUserMessage`，保守幅度）：
  - 低 security(<25) → possessiveness/annoyance 正向 delta **×1.5**（不安全依恋放大负面敏感）
  - 高 trust(>80) → security 负向冲击 + 背叛 **×0.6**（信任厚不易破防）

---

## 7. 被冷落阶段 neglect（v1.14.0）

`getNeglectStage(lastUserReplyAt, attachmentStyle)` → 想念档 24h 封顶之后的「情绪转向」：

```
none → missing(想念) → uneasy(试探不安) → disappointed(失望变凉) → withdrawn(冷淡抽离)
```

**阈值（小时）随依恋风格变**：

| 风格 | missing | uneasy | disappointed | withdrawn |
|---|---|---|---|---|
| secure（默认）| 6 | 24 | 48 | 96 |
| anxious（焦虑型）| 4 | 14 | 30 | 60 |
| avoidant（回避型）| 10 | 30 | 48 | 72 |

语气在 `buildEmotionPromptHint`：uneasy「你是不是把我忘了」/ disappointed「哦你还在啊」（收着）/ withdrawn「嗯。」「随便吧」（疏离）。reply 路径下若检测到 neglect ≥ uneasy，改走**修复弧**（§9）而非失望语气。

---

## 8. 依恋风格 attachment（v1.14.0）

`companions.attachment_style`：`secure`（默认）/ `anxious` / `avoidant`。dashboard 可切。三处生效：

1. **neglect 阈值**（§7）——焦虑型升级快、回避型前慢后快抽离。
2. **主动消息退场**（`proactive_engine.shouldBackoffProactive`）：anxious 不退场（继续追）/ secure 36–72h 渐减 / avoidant 24h 早抽离。
3. **人设注入**（`companion.buildSystemPrompt`）：anxious 需安全感易不安和好快 / avoidant 独立早退缩不示弱 / secure 稳定。

---

## 9. 关系修复弧 reunion（v1.14 P0）

`buildReunionHint(neglectStage, attachmentStyle)`：用户冷落很久后**重新发消息**时（reply 路径），不无缝热情，按风格走「和好」：

- anxious：又惊又委屈「你还知道回来啊」，哄一句就软、扑回去
- secure：坦诚大方「你去哪了呀，有点想你」，给台阶不翻旧账
- avoidant：先端着「嗯」「哦」，要主动哄才慢慢软（身体比嘴诚实）

> 设计要点：失望/冷淡是「她主动找他时」的状态；他主动回来 = 重逢，应走修复。Gottman 称修复尝试（repair attempt）是关系存续最强单一预测因子。

---

## 10. 想念档 missing level

`getMissingLevel(emotionState, lastUserReplyAt)` → 0–4，综合 dependency + idle 空窗：`没想 / 有点想 / 挺想的 / 很想 / 想死了`。24h 封顶（之后交给 neglect 阶段转向）。

---

## 11. Prompt 注入

`buildEmotionPromptHint(emotionState, opts)` 把状态翻成自然语气指令，拼到 system prompt 尾部。结构（按优先级）：

1. 低能量模式（mood=cold / annoyance≥70 / patience≤20）→ 最高优先级「今天不想聊」
2. mood hint + energy + presence(availability/attention)
3. **混合情绪底色**（🅳-1）
4. 想念档 / **被冷落语气**（🅰neglect，reply 时被 reunion 覆盖）
5. possessiveness / security / trust / excitement / annoyance / patience / gratitude 各维度提示
6. 末尾总指令（让模型把状态真的写进回复）

调用方：`bot.mjs`（reply，传 missingLevel + neglectStage + reunionHint）、`proactive.mjs`（主动消息）、`playground.mjs`（网页）。

---

## 12. 心理学依据

| 机制 | 理论 |
|---|---|
| 互动积累信任 / turning toward | Gottman 情感账户、bids for connection |
| 失信崩塌 3× | 负性偏差（negativity bias）、信任非对称 |
| 情绪随时间回归、正面快负面慢 | 情绪动态、affect half-life、情绪惯性 |
| mood 不瞬间切换 | emotional inertia |
| 依恋风格反应差异 | 依恋理论（secure/anxious/avoidant）|
| 重逢修复 | Gottman repair attempts |
| 减法 / 不操纵 / anxious 上限 | AI 陪伴伦理（避免 guilt/FOMO 式 needy）|

---

## 13. 测试与回归

- **`scripts/emotion_stress_test.mjs`** — 极限压测：用独立临时 DB（`DB_PATH=/tmp/...` + `foreign_keys=OFF` 跳过 FK）跑真函数。1000 轮随机（各种消息/idle/reply 含极端输入）+ 300 次极端 state fuzzing（NaN/非法 mood/越界）+ 定向行为 6 项。**改情绪模块务必跑它**。
- **`scripts/neglect_stage_smoke.mjs`** — neglect 阶段 / 依恋风格 / 重逢弧 / 想念档语气 29 项。
- `node --check src/emotion_state.mjs`。

---

## 14. 参数速查 & 调参指南

| 想调整 | 改哪 |
|---|---|
| 信任积累快慢 | 互动漂移步长 `0.06`/`0.05` |
| 失信扣多少 | `BETRAYAL` 的 `-6`/`-4` |
| 各情绪平复速度 | §4 的 `_toward` 速率 |
| mood 惯性强弱 | `MOOD_INTENSITY0` + 衰减步长 |
| 冷落升级快慢 | §7 阈值表（按风格）|
| 主动消息退场 | `shouldBackoffProactive` 风格分级 |

env 可调（部分）：`AFFECTION_LOVER` / `AFFECTION_DEEP` / `AFFECTION_DAILY_CAP` / `DAYS_TO_LOVER` 等（关系节奏）。

---

## 15. 版本对照

| 版本 | 内容 |
|---|---|
| v1.14.0 | 被冷落阶段 neglect + 依恋风格 attachment |
| v1.14.1 | 情绪因果重构（信任挪回互动路径）|
| v1.14 P0 | 关系修复弧 reunion + 具体情绪确认 |
| v1.14.2 | 🅰 信任负性偏差 + 🅱 时间回归 |
| v1.14.3 | 🅲 mood 强度与惯性 |
| v1.14.4 | 🅳 混合情绪 + 维度耦合 |
