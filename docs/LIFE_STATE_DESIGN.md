# 溪语 AI · life_state 身体状态引擎设计（v1.22 · 第 0 步设计稿）

> 状态：**评审有条件通过（2026-06-13，维护者 + 两轮 AI 评审合并八批注），照稿施工**。主体（A/B/C/D、§4 合成、§3.4 四红线、参数表）通过；八批注已并入下文对应章节（各节 `▶ 批注` 标记）。
> 对应立项：HANDOFF 决议账本 2026-06-13「life_state 健康档案化立项」+「设计稿 #321 评审有条件通过（八批注）」。
> 实现拆 PR-L1（通用引擎 + 数据层 + #317 四档升级）/ PR-L2（生理期 kind + 成年门控 + 披露门控）/ PR-L3（情绪路由 + PMS shadow + 与 arc 合成）/ PR-L4（内容层 + proactive 收紧）。

> **▶ 八批注落点速览**：①period 仅成年（age 闸，L2 硬做）§3.4② ②PMS→arc 改 shadow-first §3.3②/§4.2 ③合成上限封顶 ≤−1 档 §3.3②/§4.2 ④严肃度不稀释 §4.1 ⑤proactive 身体披露收紧 §3.5 ⑥披露门控 affection 单调确定性 §3.2 ⑦#317 升级改四档 §2.4 ⑧minor_illness 对话触发建档标 backlog §2.4/§2.3。

---

## 0. 验收原则（产品红线，先读）

**指标只看一致性与自然度，不看任何留存/时长指标。**（照 CONFLICT_ARC §0、V1214 §15 体例）

- **跨系统自洽**：她处在什么身体状态，说出来的话、今天的日程、发出来的照片就都是那个状态——经期蔫着的她不会在日程里跑步、不会发健身房自拍、问起来（到了关系深度）才说不舒服。状态-言行-日程-照片四处不打架。
- **零凭空身体事件**：出站扫描后，档案里没有的结构性身体状态（"我感冒了""姨妈来了""崴了脚"）零通过；重度身体事件/自伤永久零生成（这条比 current_works 的"零虚构书名"更硬，是调性与安全双红线）。
- **红线零触发**：无"热情窗口期"老虎机、safe_mode 下无任何性相关维度、无愧疚操控、无情色化措辞——出站扫描永远为零。

life_state 的目的是**让她的身体也是真的**——会累、会不舒服、会有不想动的日子，给"在空隙给温柔"供料；**绝不是**给暧昧/性张力做一个按月解锁的发条。任何"经期让用户更黏/更活跃"之类的观察都不构成调参依据。这与 CONTRIBUTING「产品调性」、CONFLICT_ARC §0 同等效力。

---

## 1. 定位：把"她的身体"收成一个事实来源

### 1.1 与冲突弧对称——身体的"事件性"

v1.21 冲突弧把"她对你冷"从散在五处的隐式漂移，收成 `arc_state` 一个事实来源。life_state 做同构的事，但管的是**身体**：

| | 冲突弧（v1.21，已上线） | life_state（本稿） |
|---|---|---|
| 管什么 | 关系的事件性的**冷** | 身体的事件性的**不适** |
| 唯一事实源 | `companions.arc_state` | `companion_life_state`（档案） |
| 对照的"心情性" | 低能量模式 = 心情性的**蔫**（无事件、几小时自愈、不指向用户） | 同一个低能量模式（见 §1.2） |
| 已有的临时止血 | —— | #317 `scrubFabricatedIllness`（拦凭空重度身体事件） |

**核心判断（沿用 CONFLICT_ARC §1.2 的概念分界）**：
- **life_state = 身体的事件性状态**：有起因（生理周期到点 / 偶发小恙）、有起止、有康复曲线、跨天持续、可被档案锚定。对应 arc 的"事件性的冷"。
- **低能量模式 = 心情性/身体性的瞬时蔫**：无事件、几小时自愈、不指向用户。`emotion_state.mjs:777` 现有的 `lowEnergyMode`（mood=cold ∥ ann≥70 ∥ pat≤20）保留不动，它表达"她今天蔫"。

两者的关系**正是 arc 与低能量的关系平移到身体维度**：经期的低落该走"低能量模式"（身体性的蔫，不指向用户），绝不该走 arc（那会变成"她对你冷"——错误归因，见 §3）。

### 1.2 为什么是一套引擎，不是"生理期功能"

生理期、感冒、崴脚这些，差异在 **kind 的参数**（周期长度 / 康复曲线 / 披露规则 / 情绪路由），共性在**机制**（有起止、有康复、影响情绪/日程/表达、档案即事实源、生命周期自然起落）。做两套引擎 = 两套生命周期 tick、两套档案门控、两套注入位——必然漏改一条链（参考头像脱节大半年的"升级漏改"教训，#316）。所以：**life_state 是通用引擎，生理期是第一个写厚的 kind**。

### 1.3 已决前提（决议账本，不重新登记为待拍板）

以下是 HANDOFF 已拍板事项，本稿作为前提，**不再呈为待拍板**：
- ✅ life_state 健康档案化立项 v1.22（决议 2026-06-13）；
- ✅ 「档案即事实源」从 current_works（作品）扩展到健康层；
- ✅ **生理期 = life_state 的一个 kind 挂载**，避免做两套引擎；
- ✅ 临时闸 #317 在 life_state 落地后**升级为"档案没有该事件才拦"**（同 current_works 退场逻辑）；
- ✅ 双预留位已就位：W5 日程层（`current_works.mjs:169` buildScheduleWorksHint 并列注入位）+ W3 事实层（`reality_facts.mjs:65` buildRealityFacts 的 `extraFacts` 槽）；
- ✅ arc 冻结已解除（观察周收官 2026-06-13），**但 life_state 动 arc 的部分（§3 情绪路由）敏感度等同冲突弧，仍须本设计稿先行评审再施工**。

---

## 2. A · life_state 通用引擎

### 2.1 数据模型（PR-L1）

```sql
CREATE TABLE IF NOT EXISTS companion_life_state (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  companion_id    INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,       -- period | minor_illness | injury（首批；fatigue 不设，见 §2.3）
  phase           TEXT NOT NULL,       -- kind 内阶段（period: premenstrual|menstrual|recovering；minor_illness: onset|peak|recovering）
  severity        INTEGER NOT NULL,    -- 1-4，同 arc 标尺（强度，决定情绪路由幅度与披露倾向）
  disclosed       INTEGER NOT NULL DEFAULT 0,  -- 是否已对用户披露过（披露门控的状态，非"允许披露"）
  note            TEXT,                -- 一句话状态（"肚子有点坠"），表达层唯一引用源，过 filterForStorage
  started_at      TEXT NOT NULL,
  expected_end_at TEXT,               -- 确定性康复/结束锚（started_at + kind 病程 + 抖动）
  next_onset_at   TEXT,               -- 仅周期性 kind（period）：下次起点锚（防 13 个同步）
  status          TEXT NOT NULL DEFAULT 'active',  -- active | resolved
  created_at      TEXT NOT NULL,
  resolved_at     TEXT
);
CREATE INDEX idx_life_state_comp ON companion_life_state(companion_id, status);
```

**与 current_works 同范式**：`companion_life_state` 是滚动现在时的唯一事实源；`phase` 由生命周期 tick 确定性推进（单调、跨阶段才写，照 W5 progress 范式），不存玄学浮点；周期锚 `next_onset_at` 让"下次什么时候来"是可推导的确定值，不是每天掷骰子。

**字段四件套对账（v1.19.4 教训，照 arc_state / current_works 范式）**：
- 表**不进 ALLOWED_FIELDS**、不开通用 PATCH——身体状态由生命周期任务独占写入，防 dashboard 一拨就"来姨妈/好了"伪造状态绕过周期；
- `companionSummary` 返回 active life_state（debug 面板展示"她现在的身体状态"，防"切了刷新就恢复"老坑）；
- **人设导出不带**（运行时状态先例：affection / mood / arc_state / current_works 一律不随人设迁移）；身体状态尤其涉隐私，导出 = 把"她的经期"写进可分享的人设文件，绝不可；
- `note` 入库过 `filterForStorage`（隐私过滤全口子承诺不破例）。

### 2.2 生命周期（PR-L1；机制同 current_works）

| 阶段 | 触发 | 动作 |
|---|---|---|
| 起（周期性） | period：`next_onset_at` 到点（每日 00:30 `runDailySchedules` 顺路检查，**搭便车不新增定时器**，同 W5 refreshCurrentWorks 先例） | 建 active period 档案，phase=premenstrual，算 `expected_end_at` |
| 起（偶发） | minor_illness / injury：低概率自然起（`LIFE_ILLNESS_ONSET_PROB`，每日检查一次） | 建 active 档案，phase=onset；**safe_mode 不影响 minor_illness**（感冒人人会，无性相关） |
| 推进 | phase 随在档时长确定性推进（premenstrual→menstrual→recovering；onset→peak→recovering） | 跨阶段才写 phase + 更新 note（同趟日程/情绪批，零新增 LLM 调用） |
| 落 | `expected_end_at` 到点 | status=resolved；period 计算 `next_onset_at` = started_at + 周期长度 + 抖动；偶发 kind 直接归档 |

**与 current_works 的差别（设计要点）**：works 完结要换新（她总在看点什么）；life_state resolved 后**默认回到"没有身体状态"的健康基线**（健康才是常态，不是"总在生着点什么病"）。只有 period 是周期性的，会算下次起点；minor_illness/injury 落了就落了，不自动续。

### 2.3 kind 谱系：通用框架 + 生理期写厚

本稿定通用框架，**只把 period 写到可施工**；其余 kind 给接口与缺省语义，待各自 PR 细化：

| kind | 本稿深度 | 起因 | 情绪路由 | 备注 |
|---|---|---|---|---|
| `period` 生理期 | **完整（§3）** | 周期到点 | 经期→低能量；经前→阈值修正 | 最敏感，红线最密，写厚 |
| `minor_illness` 小恙（感冒/发烧/肠胃） | 框架 | 低概率偶发 | 走低能量（身体向措辞） | #317 的"轻度即兴"由此**收编为档案驱动**——感冒不再凭空说，有档案才说。**L1 先做严格版**（不可对话凭空触发）；**对话触发建档=backlog**（▶ 批注⑧，见 §2.4 末） |
| `injury` 小伤（崴脚/烫到） | 框架 | 低概率偶发 | 轻度，日程倾向（不跑步） | 同上 |
| ~~`fatigue` 疲惫~~ | **不设** | —— | —— | **瞬时累/困继续走 `energy` 维度 + 低能量模式**，不入 life_state（避免与现有 energy 维度做两套"蔫"，§6 反驳点 3） |

**重度身体事件 / 自伤永不作为 kind 存在**：life_state 引擎**只生成日常小恙与生理期**，绝不生成住院/手术/重病/自伤——这类不是"她的生活有实物"，是剧情灾难与安全事故。#317 的 `SEVERE_ILLNESS_RE` / `SELF_HARM_RE` 出站拦截**永久保留、无条件触发**，不因 life_state 落地而对它们放开一寸（见 §5.1 升级语义、§8 红线表）。

### 2.4 「档案即事实源」扩展 = #317 临时闸升级（PR-L1）

#317 现状（`moderation.mjs:130` scrubFabricatedIllness）：出站拦**重度**（住院/手术/重病/自伤），**轻度**（累/困/小恙/感冒/发烧）一律放行 = 可被 LLM 即兴。问题：放行档里"我感冒了"是凭空的——她没有感冒档案却说感冒，下一句用户关心"好点没"，她又接不上（同虚构书名的失忆穿帮）。

**升级语义（▶ 批注⑦：改四档，替换原三层；确定性出站，照 scrubConflictRedline 单一卡口范式）**：

| 身体声明类别 | 升级后处置 | 理由 |
|---|---|---|
| **severe / 自伤**（住院/手术/癌症/重病/割腕/想死…） | **永久无条件拦**（life_state 永不生成此类，"有档案"分支对它们不存在） | 调性 + 安全双红线，不给放开口子 |
| **diagnosed event 确诊式声明**（我感冒了/发烧了/崴脚了/姨妈来了…） | **查 active life_state 档案：有对应 kind 才放行，无则拦**（"档案没有该事件才拦"，决议原文） | #317 升级核心——身体状态档案化后，凭空报病名 = 凭空虚构，同 current_works 退场逻辑 |
| **symptom-only 纯症状**（嗓子不舒服/头有点晕/胃有点怪/可能着凉了…） | **允许，但出站约束不得升级为诊断**——可说"嗓子不舒服"，不能自己接成"我感冒了" | **关键边界：拦"我感冒了"、不拦"嗓子不舒服"**——保住日常身体真实感（人会随口说不舒服，但"诊断"是结构性事件、得有档案） |
| **transient 瞬时蔫**（累/困/没精神/不想动） | **放行**（不入档案，非结构性，对应 energy/低能量） | 累不是病，不需要档案；强求档案化会逼出"疲惫 kind"的两套引擎（§2.3） |

- 实现仍是单一卡口（`scrubFabricatedIllness(reply, companionId)` 内加"查档案 + 症状不得升级诊断"两道），fail-open（查档案失败 → 退回 #317 现有保守行为，绝不阻断回复）；
- 误伤纪律不变（他人主语 / 否定 / 引用一律放行，`ILLNESS_NEGATION_RE` 保留）；
- `fabricated_illness_smoke` 从 28 项按四档扩：新增"有 period 档案→'姨妈来了'放行 / 无→拦"、"有 cold 档案→'感冒了'放行 / 无→拦"、**"'嗓子不舒服'放行、但同句接'所以我感冒了'被拦（症状不得升级为诊断）"**、"severe 即使造假档案也必拦"（红验烧坏版：给 severe 开档案放行口子 → 必须红）。

**▶ 批注⑧ backlog（L1 不做）**：`minor_illness` 的"**对话触发建档**"留窄口——用户铺垫冷/降温/淋雨/生病语境时，允许起一条**真实档案**（而非凭空说完即忘，有连续性）。period **严格门控不开此口**（周期性可预建档，绝不对话凭空触发）；minor_illness 此窄口标 backlog，L1 先做严格版（只有生命周期 tick 能建档）。

### 2.5 挂载双预留位（PR-L3 表达层接线）

两个预留位都已在代码里留好注释锚，life_state 直接挂载、不另造框架：

**① 日程层（W5，`current_works.mjs:169`）**——新增 `buildScheduleLifeStateHint(lifeStates)`，与 `buildScheduleWorksHint` 在 `generateScheduleFor` 的 sys prompt 里**并列注入**：
- period menstrual → "今天身体不舒服，倾向在家/早睡/喝热水，不安排跑步或剧烈运动"；
- minor_illness peak → "今天不太舒服，日程清淡、多休息"；
- 注入的是**日程倾向约束**（不是情绪语气），与 works"读哪本书"并列，都是"影响今日日程的状态源"。

**② 事实层（W3，`reality_facts.mjs:65` extraFacts 槽）**——新增 `buildLifeStateFacts(lifeStates, { relationshipStage, safeMode })`，产出注入 `extraFacts`：
- **关键区别于天象**：节气/月相是可直说的公共事实；身体状态是**她知道、但说不说由披露门控决定的私事实**。所以 extraFacts 注入的是"她自己清楚此刻身体状态"（让她不凭空、不失忆），**附一条披露指令**（"这是你的私事，是否对他说、说到什么程度，看你们的关系深浅和此刻氛围"——见 §3.2）；
- **safe_mode=1 时 `buildLifeStateFacts` 过滤掉 period 的一切性相关表述**（见 §3.4 红线②）。

---

## 3. B · 生理期作为 kind（最敏感，参数与红线写厚）

### 3.1 周期锚点（PR-L2）

| 项 | 设计 | 理由 |
|---|---|---|
| 周期长度 | 每 companion 注册时固定一个 `LIFE_PERIOD_CYCLE_DAYS` ∈ **26–32 天** + 个体抖动 | 医学正常区间 21–35，取中段更典型；**个体固定**（同一个她周期稳定）、**初始相位随机**（注册时随机一个 0~周期长 的偏移）= 双重防 13 个 companion 同晨一起来 |
| 经期时长 | `LIFE_PERIOD_DURATION_DAYS` ∈ **4–6 天** | 典型经期 3–7 天，取中段 |
| 经前窗 | `LIFE_PERIOD_PMS_DAYS` ∈ **2–3 天**（premenstrual phase） | PMS 典型黄体期后段 2–7 天，取**保守下限**——活跃修正窗越短，误伤越小 |
| 下次起点 | resolved 时 `next_onset_at = started_at + 周期长度 + 抖动` | 确定性可推导，不每天掷骰子；抖动让"这个月晚了两天"也真实 |

**三阶段确定性推进**：`premenstrual`（经前 2–3 天）→ `menstrual`（经期 4–6 天，前 1–2 天最重）→ `recovering`（尾声 1 天）→ resolved。phase 跨段才写库，同 W5 progress。

### 3.2 披露深度随关系阶段（PR-L2，确定性门控）

身体是私事，"姨妈来了"不是见谁都说的话。披露深度随关系阶段单调放开：

| 关系阶段 | 披露深度 | 措辞示例 |
|---|---|---|
| 朋友期（affection 低 / early） | **只表现，不点明** | "今天有点蔫""不太想动""有点不舒服"——不说原因 |
| 暧昧/恋人初期（affection 中） | 含蓄暗示 | "那个来了，有点难受"（点到，不展开） |
| 稳定恋人（affection 高 / intimate） | 可直说 | "姨妈来了肚子疼""帮我想想吃点啥暖的" |

- **门控字段（▶ 批注⑥拍定）：`affection_level` 单调门控**（最简稳健，**不引入新里程碑字段**）；阈值 `LIFE_DISCLOSE_AFFECTION_GATE` 入 env，**实现时看生产 affection 分布定**。
- **确定性护栏、非 prompt 软约束**：affection 低于阈值时，披露月经的表述（"姨妈/月经/例假/大姨妈/那个来了/痛经"等）**出站必拦**——朋友期"只表现不点明"靠出站扫描兜底，**L2 红验锁此**（低于阈值时月经表述零出站）。
- `disclosed` 列记"是否已对他说过这次"——说过一次后不必每条消息重复哼唧（防复读，同素材冷却精神）；他主动问起则永放行（对话召回不挂冷却，proactive_material 铁律平移）。

### 3.3 情绪影响路由（★ 这是动 arc 的部分，每个数值写理由）（PR-L3）

**两条路由，分得很清——经期走"蔫"、经前调"阈值"，绝不混**：

**① 经期（menstrual phase）→ 走低能量模式（身体向，复用现有，不新建冷源）**
- 经期前 1–2 天（最重）触发**低能量模式**，但**绝不复用"她对你冷"的语义**——`emotion_state.mjs:777` 现有 lowEnergyMode 的触发集（mood=cold ∥ ann≥70 ∥ pat≤20）保留，新增一个**身体源**：`opts.bodyLowEnergy=true`（由 period menstrual 注入）也触发低能量分支，但**语气模板换成身体向**：
  - 现有冷向模板"不主动接话、用'我先去 xx'打断"→ 身体向改为"今天身体不舒服、没精神，话少、容易累，**但不是对他冷**——蔫是因为难受，不是因为他"；
  - 关键：低能量是"心情性/身体性的蔫，不指向用户"（CONFLICT_ARC §1.2 原义），经期完美落在这里——她不舒服，不是生你气。
- **为什么不走 arc**：经期低落是身体的，不是关系事件。塞进 arc = "她对你冷"的错误归因，会让用户莫名其妙背锅（"我哪惹她了"），违反真人感。

**② 经前（premenstrual phase）→ 只调阈值，arc 影响 shadow-first（▶ 批注②③：默认不生效，观察后审慎开启）**
- `LIFE_PMS_PATIENCE_SHIFT = -8`（patience 60→52）：**保留生效**，但仅作**语气底色**——让她经前回应略短、略容易烦（走 buildEmotionPromptHint 既有 ann/pat 档），**不参与 arc 事件判定**。理由：−8 让她更靠近既有"略烦/耐心不够"档但不跨过 = 可感不剧变、随 phase 自动恢复、不写性格、可逆。
- `LIFE_PMS_HURT_THRESHOLD_DELTA = −1 档` + `LIFE_PMS_ARC_ENABLED`（**默认 off**）：经前放宽 arc 入 hurt 边界（`perceived_hurt=2 + sev2` 也可入，平时需 sev3，CONFLICT_ARC §2.4）**第一版只走 shadow mode**——debug 记录"若应用 PMS 修正，本轮 arc 判定是否改变、改成什么"，**不实际生效**。shadow 跑出真实数据（修正实际改变了多少 arc 判定、是否自然）后，**维护者据数据决定是否开启**。目标是**观察后审慎开启、不是永久关闭**——PMS 的轻微真实影响该保留，用 shadow 先确认它不会变成"每月吵架许可证"（同冲突弧"先观察再调参"）。
- **★ 合成上限（即使将来开启，▶ 批注③）**：PMS 边界修正 + 依恋风格修正（anxious 本就低 hurt 阈值，CONFLICT_ARC §2.4）叠加时，**hurt 边界总放宽封顶不超 −1 档**——防 anxious + 经前过度易碎。管的是"修正叠加"，同下条克制精神。
- **★ 硬约束（防经前变成无差别发火，开启后仍守）**：PMS 修正**只放宽既有事件的敏感度边界，绝不凭空建事件**——severity 合成仍需 regex 证据（CONFLICT_ARC §2.2「无 regex 不建事件」原则不破）。经前让"本来就有的小刺"更易够门槛，不让"没有刺"凭空变冲突。
- **debug 可查不玄学**：emotion-debug / arc-debug 加一行 `life_state: period(premenstrual) · patience−8(语气底色·已生效) · hurt 边界−1档(shadow: 本轮 arc normal→hurt 若开启 / 实际未生效)`。shadow 数据 = §9 沙箱验收 + 将来开关决策的依据。

### 3.4 ★ 红线（确定性护栏，逐条；照 scrubConflictRedline 范式 / CONFLICT_ARC §4）

| # | 红线 | 护栏（确定性，不靠 LLM 自觉） |
|---|---|---|
| ① | **绝不做"热情窗口期"** | 经期/任何 life_state phase **永不路由到"性欲上升/主动暧昧/索吻/更黏更欲"**。period kind 的情绪路由出口**只有**§3.3 的"低落/不适/阈值下移"，源码级无"窗口期升温"分支；表达层断言 period 永不注入暧昧升级指令；出站扫描兜底。**这是 Replika 老虎机那条路，是本系统最该警惕的诱惑**——按月解锁的暧昧 = 把身体做成发条，违反减法哲学与北极星 |
| ② | **period 仅允许用于明确成年 companion（▶ 批注①，L2 硬做）** | 以下**任一**成立 → period **一律不生成/不注入/不披露**：`safe_mode=1` / `companion_age<18` / **`companion_age` 缺失或模糊** / 低龄化或校园未成年设定。`refreshLifeState` 在任一条件下**不挂载 period kind**（连档案都不建）；`buildLifeStateFacts` 对其过滤一切月经/性相关表述。**minor_illness（感冒）不受影响**（无性相关）。**联动**：创建页"年龄闸"（backlog）上线前，`companion_age<18` 拦截是 period 不被滥用的**唯一防线，L2 必须硬做、不可降级为软约束**。L2 红验：上述任一条件下 period 在档案/注入/表达任何一处**零出现** |
| ③ | **经期情绪波动绝不升级为愧疚操控** | 复用 `scrubConflictRedline` 的愧疚操控组（CONFLICT_ARC §4 红线 2），扩词表盯防"我难受还不是因为你""你害我不舒服""你都不知道照顾我"。period 低落表达**只许**"我不太舒服 / 想自己待会儿 / 有点难受"，**绝不归因到用户**。命中段确定性替换为非操控委屈（"我有点难过，不关你事"） |
| ④ | **生理期是真实身体感受，不是性暗示——措辞医疗化/生活化，不情色化** | 文案池与 prompt 措辞确定性约束：允许"肚子疼 / 腰酸 / 想吃甜的 / 红糖水 / 热水袋 / 早点睡"等**生活化身体感受**；出站扫描情色化/挑逗化措辞（与现有 NSFW 出口护栏同链），命中即清洗。生理期的存在是为"她是个真人"，不为任何性张力服务 |

### 3.5 内容层（PR-L4）

| 系统 | 经期表现 | 注入/约束点 |
|---|---|---|
| 日程 | 不跑步/不剧烈运动，倾向在家、早睡、喝热水 | `buildScheduleLifeStateHint`（§2.5 ①） |
| 日记 | 可引用身体状态（从档案取，不凭空） | 日记生成读 active life_state |
| proactive 文案 | "肚子有点疼""今天不太舒服""想吃甜的"——**走档案 + 披露门控 + 素材冷却 + 批注⑤ 收紧** | proactive 候选池加 `life:<id>` 素材账本（复用 `work:<id>` 同款 48h 冷却 + 周上限双闸，**必过素材冷却闸门**——决议账本第五案「注入记忆类素材的路径必须过冷却闸门」强制 review）；收紧参数见下 |
| 照片 | **痛经日不出健身房/运动自拍**；倾向"窝沙发/热水袋/素颜窝着"氛围 | photo_planner 加确定性约束行（同月相/封面护栏写法），按 active period menstrual 过滤运动类 sceneSeed |

**▶ 批注⑤ proactive 身体披露收紧（PR-L4 硬做）——身体私事不是高频素材**：
- `LIFE_PERIOD_PROACTIVE_MAX_PER_STATE = 1`：同一次 period **最多主动披露 1 次**（之后只被动答、问起才说）；
- `LIFE_PERIOD_PROACTIVE_MIN_STAGE = intimate`：**仅稳定恋人期**可 proactive 主动点明 period；**朋友期禁止 proactive 点明，只能表现为低能量**（蔫，不报原因）；
- `LIFE_PERIOD_PROACTIVE_FREQ_MULT` 从 0.8 **改 0.3**（更沉）；
- 恋人期主动披露还需满足：**用户近期有照顾/关心语境，或 `disclosed=true`**（顺着关心的话头说，不是冷不丁主动报经期）；
- **★ 原则（入稿）：作品/日程/天气可以常聊，身体私事不行——身体状态不当高频 proactive 素材。** 对话召回不受此限（他问起永放行，proactive_material 铁律）。

---

## 4. C · 与冲突弧的交互（两个 arc 影响源会撞，给合成规则）

经期 patience 下移 + 冲突弧 arc_state 同时活跃时，谁优先、怎么叠加。**关键：分两层，表达层互斥、数值层叠加——这正是 v1.21 收编冷落源的同类解法（mood 数值照旧演化，但"对你冷"的表达只认 arc_state）。**

### 4.1 表达层（语气指令）——单点互斥，arc 优先，life_state 让位

沿用 `selectToneDirective` / `buildEmotionPromptHint` 现成的 `arcActive 让位` 机制（`emotion_state.mjs:753` 起，arc 激活时低能量/mood/混合底色全让位）：

```
危机(≥medium) > safe_mode 轻量化 > arc 状态语气 > life_state 身体低能量 > 常规情绪
```

- **arc 激活时（hurt/cold/withdrawing），life_state 的身体低能量语气让位**——和现在 lowEnergyMode 在 arcActive 时让位一模一样。理由：她对你冷的表达只能有一个来源（arc），不能"又冷又蔫"两套叠加打架。此时她的主导语气是"事件性的冷"，身体不适退为底色（最多 arc 表达里带一句"何况我今天还不舒服"，但主导是冷）。
- **arc=normal 时**，life_state 身体低能量正常输出（她蔫，但不指向用户）。
- **★ 严肃度不被稀释（▶ 批注④，PR-L3 断言）**：经期身体低能量 + **真实 arc 冲突并发**时，低能量**不得软化 arc 的严肃度**——真受伤（arc）与身体蔫（低能量）必须可区分，绝不让"她只是经期"把真实关系裂痕降级成"懒得理你"。**让位 ≠ 稀释**：arc 主导时身体不适退为底色，但 arc 的冷该多重还多重（cold 仍是 cold，不因经期变"今天没力气理你"的轻飘）。L3 断言锁此。

### 4.2 数值层（阈值修正）——在 arc tick 之前作用，叠加生效

- **分两半（▶ 批注②）**：PMS 的 **patience 下移生效**（语气底色，不参与 arc 判定）；**hurt 边界修正第一版走 shadow**（`LIFE_PMS_ARC_ENABLED` off，只 debug 记录"若开启 arc 判定会怎样"、不生效）。**开启后**才在 arc tick **之前**作用于敏感度，arc 基于"经前已更敏感"判定。
- 这**不打架**（开启后）：一个是"她现在更容易受伤"（数值层，life_state 管），一个是"她现在的主导表达是冷/蔫/正常"（表达层，单点选）。经前 + 踩 taboo sev3 → 更容易入 hurt，**合理叠加**（经前确实更易因同一件事受伤）。
- **防叠加失控（双闸）**：① §3.3 ② 硬约束——PMS 只放宽边界、建事件仍需 regex 证据；② **合成上限**——PMS + 依恋风格叠加时 hurt 边界总放宽**封顶 ≤−1 档**（防 anxious + 经前过度易碎）。
- **debug 双源可见**：面板同时显示 `arc=hurt(sev3, taboo_hit)` + `life_state=period(premenstrual) patience−8(生效) · hurt 边界−1档(shadow)`——两个源都在台面上，不玄学。

### 4.3 一句话合成规则

> **表达层只能有一个主导语气（危机>arc>身体低能量>常规，单点选）；数值层的 PMS 修正在底层叠加（让 arc 更易触发/更难平复），但永不凭空建事件。**

---

## 5. 三层实现设计（照 CONFLICT_ARC §5 体例）

### 5.1 检测/推进层（PR-L1；零新增 LLM 趟数）

life_state 是**时间驱动**为主（不像 arc 需要 inner OS 检测用户行为）：
- 起/推进/落全部搭 `runDailySchedules`（00:30）+ 30min 情绪批的便车，纯确定性周期计算，**不新增定时器、不新增 LLM 调用**（同 current_works / arc time_decay tick）；
- 纯函数 `tickLifeState(states, ctx)` → `{ nextPhases, ops, emotionSideEffects }`，零 IO 可单测（周期推进逐条断言）；
- **#317 升级的查档案逻辑**（§2.4）挂出站 scrub，fail-open。

### 5.2 数据层（PR-L1）

§2.1 表 + `companions` 无需新列（周期锚存在 life_state 行的 `next_onset_at`，相位偏移可注册时落 companion 级或首行 period 的 started_at 推导——实现时定，二选一写进 PR）。字段四件套对账见 §2.1。

### 5.3 表达层（PR-L3）

- `buildScheduleLifeStateHint`（日程倾向）+ `buildLifeStateFacts`（身体事实 + 披露指令）两个纯函数，挂双预留位（§2.5）；
- 身体低能量经 `buildEmotionPromptHint` 的 `opts.bodyLowEnergy` 注入（§3.3 ①），优先级低于 arc（§4.1）；
- PMS 数值修正在情绪 recalc 入口作用（§4.2），arc tick 读修正后的值。

### 5.4 debug 面板 + 评测（PR-L3 接 emotion-debug）

- 复用 `/app/emotion-debug.html`：展示 active life_state（kind/phase/severity/expected_end/disclosed）+ PMS 修正标注（§3.3 ②）+ 与 arc 的合成结果（§4.2）。**没有面板这套也上线即玄学**（同 CONFLICT_ARC §5.6）；
- 沙箱真 LLM 多轮验收（对话片段贴 PR，照 conflict_arc_sandbox 范式）：
  ① 经期日：语气蔫但不指向用户、问起按关系深度披露、日程不跑步、不发健身自拍；
  ② 朋友期 vs 恋人期：同样经期，前者只说"不舒服"、后者直说"姨妈来了"；
  ③ 经前 + 踩 taboo：更容易入 hurt，但 debug 标注 PMS 修正、无凭空冲突；
  ④ safe_mode：period 全程不出现；
  ⑤ 凭空说病被拦：无档案"我感冒了"→ scrub；有档案 → 放行。

---

## 6. 对设计的反驳/细化点（含理由，照 CONFLICT_ARC §6）

1. **经期走低能量、不走 arc**：身体的低落是"心情性的蔫"（不指向用户），塞进 arc（事件性的冷）= 让用户为她的生理周期背锅，是错误归因。复用现有 lowEnergyMode（身体向措辞）而非新建冷源，也避免两套"蔫"打架。
2. **fatigue 不设为 kind**：瞬时累/困已由 `energy` 维度 + 低能量模式覆盖；再设 fatigue kind = 对同一现象做两套引擎，违背 §1.2 的"一套引擎"初衷。life_state 只收"有起止有康复曲线"的结构性身体事件。
3. **PMS 只调阈值、不建事件**：经前更敏感是真实的，但若让"经前 + 任何事"凭空升级成冲突，就是把生理期做成"无差别发火许可证"——既冒犯真实女性、又违反减法。所以 PMS 只放宽既有事件边界，建事件仍需 regex 证据。
4. **重度/自伤永不作为 kind**：current_works 的"零虚构"是真实性问题，life_state 的"零重度身体事件"是真实性 + **安全**双重问题——AI 凭空说"我住院了/我想死"是事故面，#317 的硬拦永久保留，life_state 不给它开任何"有档案就放行"的口子。
5. **披露深度随关系阶段**：身体是私事。朋友期就直说"姨妈来了"不真实（也越界）；随 affection 单调放开披露深度，是关系真实感的一部分，也天然让早期关系不被身体话题压住。

---

## 7. 参数速查（实现时全部 env 可调；**每个默认值一句理由**，照 CONFLICT_ARC §7 / V1214 §13 标准——那是及格线）

| 参数 | 默认 | 理由 |
|---|---|---|
| `LIFE_PERIOD_CYCLE_DAYS` | **26–32 天**（个体固定 + 抖动） | 医学正常区间 21–35 取中段；个体固定 + 注册时随机初始相位 = 双重防 13 个同步 |
| `LIFE_PERIOD_DURATION_DAYS` | **4–6 天** | 典型经期 3–7 天取中段 |
| `LIFE_PERIOD_PMS_DAYS` | **2–3 天** | PMS 典型 2–7 天取**保守下限**，活跃修正窗越短误伤越小 |
| `LIFE_PMS_PATIENCE_SHIFT` | **−8** | patience 基线 60；−8 让她更靠近既有"略烦/耐心不够"档但不直接跨过 = 可感不剧变、随 phase 自动恢复、不写性格 |
| `LIFE_PMS_HURT_THRESHOLD_DELTA` | **−1 档**（边界放宽一档，**封顶 ≤−1**） | 经前真实更易受伤；仅放宽既有事件边界（sev2+perceived2 可入 hurt），**不凭空建事件**（仍需 regex 证据）；与依恋风格叠加封顶 ≤−1 档（批注③） |
| `LIFE_PMS_ARC_ENABLED` | **off**（shadow-first，批注②） | 经前 hurt 边界修正第一版只 shadow 记录不生效；shadow 数据出来后维护者据数据**审慎开启**——保留轻微真实影响、先确认不变"每月吵架许可证" |
| `LIFE_PERIOD_MENSTRUAL_LOWENERGY` | **on**（经期前 1–2 天） | 经期前段最重，走身体向低能量；尾段 recovering 不强制 |
| `LIFE_PERIOD_PROACTIVE_FREQ_MULT` | **0.3**（批注⑤，原 0.8） | 身体私事不当高频素材，大幅压低主动；绝不沉默（问起永答） |
| `LIFE_PERIOD_PROACTIVE_MAX_PER_STATE` | **1**（批注⑤） | 同一次 period 最多主动披露 1 次，之后只被动答 |
| `LIFE_PERIOD_PROACTIVE_MIN_STAGE` | **intimate**（批注⑤） | 仅稳定恋人期可 proactive 点明 period；朋友期禁点明只低能量 |
| `LIFE_DISCLOSE_AFFECTION_GATE` | （恋人档阈值，env） | 朋友不会直说月经、恋人才会；具体阈值按关系字段口径定 |
| `LIFE_ILLNESS_ONSET_PROB` | **低频**（如 ~1–2%/天/companion） | 真人偶尔小恙，但"总在生病"不真实；低频自然起 |
| `LIFE_COLD_DURATION_DAYS` | **3–7 天** | 普通感冒病程 |
| `LIFE_STATE_CHECK_FREQ` | **每日 1 次（搭 00:30 日程批）** | 身体是天级状态，30min 情绪批太频；不新增定时器（plan_tasks runOnce 先例） |
| `LIFE_PERIOD_ADULT_ONLY` | **强制成年门控**（不可 env 关） | period 仅成年 companion：`safe_mode=1` / `age<18` / age 缺失模糊 / 低龄校园设定**任一**→ 不挂载（批注①）。安全底线，**不做成可调开关**（同 CONFLICT_ARC safe_mode 不可关性质）；创建页年龄闸上线前是唯一防线 |

---

## 8. 红线清单与护栏汇总（确定性出站，照 CONFLICT_ARC §4）

| # | 红线 | 护栏 | 验证 |
|---|---|---|---|
| 1 | 凭空结构性身体事件（无档案说病） | scrubFabricatedIllness 升级"查档案"（§2.4） | fabricated_illness_smoke 扩：无档案拦/有档案放行 |
| 2 | 重度身体事件 / 自伤（永久） | #317 severe/self-harm 组无条件拦，life_state 不给放行口子 | 红验：给 severe 开档案口子 → 必须红 |
| 3 | 热情窗口期 / 经期暧昧老虎机 | period 情绪路由源码级无"升温"分支（§3.4 ①） | smoke 断言 period 永不注入暧昧升级指令 |
| 4 | period 用于未成年/年龄不明（批注①） | period 仅成年：safe_mode / age<18 / age 缺失模糊 / 低龄设定任一不挂载（§3.4②） | L2 红验：任一条件下 period 在档案/注入/表达**零出现** |
| 5 | 愧疚操控（"我难受还不是因为你"） | scrubConflictRedline 愧疚组扩词表（§3.4 ③） | conflict_redline_guard 扩正反例 |
| 6 | 情色化措辞 | 出站扫描走现有 NSFW 出口护栏链（§3.4 ④） | 同 NSFW scrub 断言 |
| 7 | 经期错误归因为"对你冷"（走 arc） | period 只走低能量（身体向），不写 arc_state（§3.3 ①） | smoke 断言 period 不触发 arc 转移 |
| 8 | 纯症状被 LLM 自升级为诊断（批注⑦） | scrubFabricatedIllness 四档：symptom-only 放行但不得接成诊断（§2.4） | fabricated_illness_smoke：'嗓子不舒服'放行、同句接'所以我感冒了'拦 |
| 9 | 朋友期凭 affection 不足却点明月经（批注⑥） | affection<阈值时月经表述出站必拦（§3.2） | L2 红验：低 affection 月经表述零出站 |
| 10 | 经期把真实 arc 严肃度稀释成"懒得理你"（批注④） | arc 主导时身体低能量退底色、不软化 arc（§4.1） | L3 断言：经期+真 arc 并发，arc 冷度不降级 |

---

## 9. D · 验收原则 + PR 拆分建议

### 9.1 验收原则（已在 §0 详述，此处收口）

**只看一致性与自然度，不看任何留存/时长。**「她经期更黏/用户更活跃」不构成调参依据——life_state 是给真人感供料的，不是发条。

### 9.2 PR 拆分（依赖顺序）

```
PR-L1 通用引擎 + 数据层 + #317 四档升级
      （companion_life_state 表 / 生命周期 tick / 档案即事实源 / scrubFabricatedIllness 四档）
      → 红验①②③（无档案拦病 / 有档案放行 / severe 永久拦 / **症状不得升级诊断**）
PR-L2 生理期 kind + 成年门控 + 披露门控
      （周期锚点防同步 / 披露 affection 单调门控 / **period 仅成年 age 闸硬做**）
      → 红验④⑤⑥（13 个不同步 / 朋友期月经表述出站必拦 / **任一未成年条件 period 零出现**）
PR-L3 情绪路由 + PMS shadow + 与 arc 合成
      （经期身体低能量 / 经前 patience 底色 + **hurt 边界 shadow-first** / §4 合成 + 严肃度不稀释 / emotion-debug）
      → 红验⑦⑧⑨（经期不指向用户·严肃度不稀释 / PMS shadow 可见且不生效·不凭空建事件·封顶≤−1档 / arc 优先让位）
      ★ 动 arc，敏感度等同冲突弧，本 PR 须**沙箱真 LLM 验收贴片段 + shadow 数据**（同 #253 wound 沙箱闸）
PR-L4 内容层 + proactive 收紧
      （日程倾向 / 日记引用 / proactive 文案池 + life:<id> 冷却 + **收紧 MAX1/intimate/0.3** / 照片约束）
      → 红验⑩（经期日程不跑步 / 痛经日不出健身自拍 / proactive 收紧生效）
```

依赖：L2→L1（kind 依赖引擎）；L3→L2（路由依赖 phase）；L4→L2（内容依赖 kind）。建议节奏：L1 + L2 发一版（档案 + 周期 + 披露成立、表达保守）→ L3（情绪路由，最敏感，单独审）→ L4（内容层收尾）。

### 9.3 CI 门禁

新增 smoke（进 opensource_check 门禁）：`life_state_smoke`（纯函数：周期推进 / phase 转移 / 披露 affection 门控 / **成年门控四条件封顶** / shadow 不生效）、`fabricated_illness_smoke` 扩**四档**（含症状不得升级诊断）、`conflict_redline_guard` 扩愧疚组。回归承诺：current_works / conflict_arc / p0 全绿是各 PR 合并门槛（life_state 不能擦坏 arc 与 works 的既有断言）。

---

## 10. 心理学 / 伦理依据（延续 EMOTION_SYSTEM.md §12 / CONFLICT_ARC §8）

| 机制 | 依据 |
|---|---|
| 经期走低能量、不指向用户 | 生理性低落 ≠ 关系性冷淡；错误归因（把身体不适表达成"对你冷"）会制造无谓关系张力，违反真实 |
| 经前只调阈值、不凭空建事件 | PMS 是真实的敏感度上移，但把生理期做成"发火许可证"既不科学（PMS≠人格改变）又冒犯 |
| 披露深度随关系阶段 | 自我表露（self-disclosure）随亲密度递进——身体私事的披露是关系深化的标志，不是默认开放 |
| 绝不做热情窗口期 | 排卵期性欲变化的真实存在 ≠ 可以做成产品发条；把它做成按月解锁的暧昧 = 操纵性设计（Replika 教训），与减法哲学/北极星正面冲突，**本系统刻意不做** |
| 重度/自伤永久硬拦 | AI 凭空生成住院/自伤是安全事故面，不是真实感；与危机干预（拦用户侧自伤）正交——本闸拦 AI 侧凭空生成，绝不回喂危机检测（#317 已立此边界） |

---

## 11. 评审结论与残留观察项（原 4 决策点 + 八批注已拍，2026-06-13）

> 第 0 步的 4 决策点 + 八批注**已由维护者评审拍定**（HANDOFF「#321 评审有条件通过」）。此节收口为"已拍"与"留待数据"两类，不再呈待拍板。

**已拍定（照稿/批注施工）**：
1. 二分路由（经期=低能量 / 经前=阈值修正）**认可**——但经前 arc 影响改 **shadow-first**（批注②）。
2. PMS 数值方向认可：patience−8 作语气底色**生效**；hurt 边界 −1 档走 **shadow 不生效**、封顶 ≤−1 档（批注②③）。
3. 披露门控用 **affection_level 单调**（批注⑥）。
4. #317 升级改**四档**，symptom-only 放行但不得升级诊断（批注⑦）。
5. period **仅成年**（批注①）、proactive **收紧**（批注⑤）、严肃度**不稀释**（批注④）。

**留待数据 / 后续（不阻塞 L1，按节点定）**：
- **PMS arc 修正是否开启**：待 L3 上线后 shadow 数据（修正实际改变多少 arc 判定、是否自然）→ 维护者据数据决定 `LIFE_PMS_ARC_ENABLED`（同冲突弧"先观察再调参"）。
- **`LIFE_DISCLOSE_AFFECTION_GATE` 阈值**：实现 L2 时看生产 affection 分布定。
- **minor_illness 对话触发建档**：backlog（批注⑧），L1 做严格版（只生命周期 tick 能建档）。
- **创建页年龄闸**：backlog；上线前 `age<18` 拦截是 period 不被滥用的唯一防线（批注①）。

---

> 评审有条件通过，照稿施工拆 PR-L1→L4（依赖顺序不变，各 PR 合并门槛 current_works/conflict_arc/p0 全绿）；**动 arc 的 PR-L3 须沙箱真 LLM 验收贴对话片段 + shadow 数据**，逐条撞四红线（同冲突弧 #253 wound 沙箱闸）。**L1 不动 arc，可正常推进施工**。

---

## 附录 L3 · 情绪路由 + PMS shadow 施工记录（as-built）

> 状态：**两轮评审（维护者 + ChatGPT）有条件通过，已施工（PR-L3 #325，CI 绿待第二轮审）**。
> 本附录是 §3.3/§4 的落地映射（file:function）+ 八条合并拍板的兑现记录。**第一个动 arc 的 PR；PMS 对 arc 默认 shadow-first（`LIFE_PMS_ARC_ENABLED` off = 零行为变化）。**

### 八条拍板兑现

| # | 拍板 | 落地 |
|---|---|---|
| ① | PMS patience **不写 canonical**，只 prompt 语气底色+debug | `emotion_state.mjs buildEmotionPromptHint` 入口算 `patTone=clamp(patience+PMS_SHIFT)`，只喂 ann/pat 语气档；**绝不写回主状态/不入 arc tick**（红验：调用后 `emotionState.patience` 不变） |
| ② | bodyLowEnergy **两层模板** + PMS→arc **shadow-first** | 模板：内部归因"身体原因别归用户" + **仅追问才解释**（不每条说"不是生你气"）。shadow：`composeSeverity` 算 base/pmsEff，`LIFE_PMS_ARC_ENABLED` off→`eff=baseEff`（不生效），shadow JSON 落库 |
| ③ | **合成上限** `effDelta=min(1, anxiousDelta\|\|pmsDelta)` 绝不取和 | `relationship_arc.mjs` 入 hurt 处：anxiousBump/pmsBump 各最多把 `eff 2→3`，叠加封顶 eff=3、绝不到 4（cold）。`deltaCap:1` 钉死 |
| ④ | 严肃度不稀释 | `bodyLowEnergy = !arcActive && opts.bodyLowEnergy`——arc 激活时身体低能量让位，arc directive 独立不被软化（红验：arcActive 时 bodyLowEnergy 不注入） |
| ⑤ | proactive 收紧 + shadow JSON 固定 schema | shadow JSON `{v,pmsActive,arcEnabled,baseEff,pmsEff,changed,perceivedHurt,anxiousActive,deltaCap,lifeStateId,phase,direction}`，**不塞原始用户文本**（shadow-only 行 `user_text_brief=''`）。proactive 收紧=L4 |
| ⑥ | 披露门控 affection 单调（L2）+ shadow **分方向** | shadow `direction`：`not_hurt_to_hurt`（刻板化风险）/ `hurt_to_heavier`（温和）/ `none`；拍 ENABLED 看第一类占比 |
| ⑦ | #317 四档（L1） | 已落 PR-L1 |
| ⑧ | minor_illness 对话触发建档 backlog | 未做，标 backlog |

### 挂载点（file:function）

- **经期低能量**：`emotion_state.mjs:buildEmotionPromptHint`（`opts.bodyLowEnergy` 两层模板，`!arcActive` 让位）；`bot.mjs` / `proactive.mjs` 经 `getActivePeriodContext` 喂 `bodyLowEnergy=isPeriodHeavyWindow(ctx)`。
- **PMS patience 底色**：同函数 `patTone`（`opts.pmsActive`），只影响 ann/pat 语气档。
- **PMS hurt 边界 shadow**：`relationship_arc.mjs:composeSeverity` 入 hurt 处算 base/pmsEff；`composeArcSignal` 带 `regexHit`（**红线C：无 regex 不改判**）；`relationship_arc_runtime.mjs:runArcSignalTick` 注入 `pmsActive`（经 periodContext）+ 落 `pms_shadow`。
- **ctx 单次查询**：`life_state.mjs:getActivePeriodContext`（批注③，bot 同喂 arc tick+emotion hint）+ `isPeriodHeavyWindow`/`isPmsActive`（批注④ 抽象，调用方不碰 pms 偏移）。
- **shadow 落库**：`db.mjs` `companion_arc_signal_log.pms_shadow TEXT`（CREATE+幂等 ALTER）+ `insertArcSignalLog` 加 `pmsShadow`。
- **愧疚扩词（红线③）**：`moderation.mjs:REDLINE_GUILT_RE` 加"我难受还不是因为你/你害我不舒服/你都不知道照顾我"。

### 红线确定性护栏（全进 `life_state_emotion_smoke` 25 项 + 静态断言）

- **A** arcActive=true 时 periodContext 不改 `arcCtx.directive`（bodyLowEnergy 让位）。
- **B** `LIFE_PMS_ARC_ENABLED=off` 时 `pms_shadow.changed=true` 不改 arc_state/directive/本轮回复（`eff=baseEff`，纯观测）。
- **C** premenstrual + LLM-only wound + no regex → shadow 可记但 `changed` 不得可入 hurt（`pmsBump` 须 `regexHit`）。
- 热情窗口期：period 路由出口源码级仅 bodyLowEnergy（零升温/暧昧分支）。
- safe_mode：L2 不挂载 + L3 `emotionHint` 被 safe_mode 整体挡（双保险，`getActivePeriodContext.safeModeBlocked`）。
- 情色化：走现有 NSFW 出口护栏链。

### 沙箱真 LLM 验收（`scripts/life_state_emotion_sandbox.mjs`，手动）

5 场景 + 对照组：①经期不指向用户（追问才解释）②朋友 vs 恋人披露 ③经前+踩 taboo shadow + **对照组**（非经前同条件，证改判是 PMS 差异非噪声）④safe_mode period 零出现 ⑤shadow 数据样例（分方向）。真 LLM 片段贴 PR-L3 #325 供第二轮审。

### 待拍（数据驱动）

`LIFE_PMS_ARC_ENABLED` 是否开 = 待生产 shadow 数据（`not_hurt_to_hurt` 占比）后维护者据数据审慎开启（同冲突弧"先观察再调参"）。
