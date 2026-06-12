# 照片品类校准（v1.21.6）

> 像真实恋爱那样发照片：文案承载的亲密多过图片本身；互拍是邀请不是广播。
> 本文档 = PR-A 审计结论 + 品类权重配置基建说明。后续 PR-B（想到你品类）/
> PR-C（食物·天空·caption）落地各品类的素材源与生成约束。

## 一、现状审计（2026-06-12，生产 `/opt/xiyu-ai-new/data/bot.db`，聚合只读）

**审计窗口受限**：proper 品类仪表 `companion_photo_log.shot_mode` 自 v1.21.2
（2026-06-11 06:54）才上线，且**0 行**——因为同次部署引入了 P0 静默断图
（见下），自那以后一张照片都没发出去。故只能从全量历史消息侧反推。

### 1. 照片是极低频功能，且主动分享通道近乎休眠

| 指标 | 值 |
|---|---|
| 全生命周期已发照片 | **16 张**（2026-06-05 ~ 06-10） |
| 其中 user 显式索图 | 15 |
| 其中 proactive 主动分享 | **1** |
| 近 2 天（v1.21.2 部署后） | **0**（P0 断图） |
| 活动标签可辨品类 | 15「其他」+ 1 食物（标签是场景名如「在家」，无品类信号） |

**结论改写了任务前提**：这不是"品类配比失衡"，是**主动分享通道从零都还没建起来**。
proactive 场景照 lifetime 只成功发过 1 张——planner 对空 userText 的主动请求高度保守
（设计如此："不要每次暗示都发"），加上 36h 冷却 + 日限额，再叠加 P0 断图，
通道实际处于休眠。研究里说的"自拍疑似过配"，数据侧的真相是：**user 一索图就是自拍
（15/16），而 she 主动分享几乎不发生**。

### 2. P0：照片功能静默断供 ~1.5 天（审计副产物，已单独 hotfix #289）

`d22bf73`（v1.21.2）把 `buildPlannerPrompt` 改成返回 `{prompt, shotMode}` 对象，
但 `planPhotoMessage` 仍当字符串接收 → 整个对象当 message content 传 LLM →
`400 content should be a string` → 自 06-11 06:54 起 **user 索图 + proactive 场景照
全链静默失败**，被 fail-open 吞成 WARN。部署前后对照：发图 8→0、planner 400/declined 0→7。
已在 hotfix PR #289 修复（解构 + plan 挂 shotMode/aspect + 回归 smoke 锁）。

## 二、现状 vs 调研目标对照（作用于 proactive 主动分享通道）

| 品类 | 现状（可测 / 结构） | 调研目标 % |
|---|---|---|
| 食物 | 几乎无（无专门品类，仅泛标签偶含） | 30 |
| 天空·路遇 | SCENERY 机位存在但无天象/日落锚定；路遇靠 current_scene 偶发 | 25 |
| 此刻证明照（POV） | ACTIVITY_POV 机位存在，但几乎只在 user 索图时触发 | 20 |
| 看到这个想到你 | **完全缺失** | 10 |
| 自拍 | user 索图侧 ~全部；proactive 侧几乎不发 | 10 |
| 战利品等 | 缺失 | 5 |

> ⚠ 权重**只作用于 proactive 主动分享**（她自己想发什么）。**user 显式索图**
> （"发张自拍"/"看看你写的作业"）永远走 `decideShotMode` 按请求来，不被采样覆盖——
> 他要看自拍你给风景照是失能，不是克制。所以"自拍降到 10%"= 她主动分享时少发自拍，
> 不是拒绝用户的自拍请求。

## 三、配置基建（本 PR 落地，**默认不改现状**）

- **配置文件** `config/photo_categories.json`：6 品类 × {weight, shotMode, sceneSeed,
  weeklyCap, enabled}。权重为研究目标初始值。
- **总开关** `PHOTO_CATEGORY_SAMPLING_ENABLED`：**默认 false（关）**。关时 proactive 照片
  维持现状（`decideShotMode` 决定机位）。维护者审完本对照表、拍板权重后设 true 才激活。
- **热调不发版**：`PHOTO_CAT_WEIGHT_<ID>`（如 `PHOTO_CAT_WEIGHT_FOOD=40`）覆盖单类权重；
  `PHOTO_CAT_DISABLE=selfie,trophy` 临时停用。改 env + 重启即可，无需发 release。
- **weeklyCap**：`companion_photo_log.category` 落库 → `getCategorySendCounts` 读近 7 天
  → 达上限品类本周排除（如「想到你」每周 ≤2）。
- **全程 fail-open**：配置坏/采样异常 → 退回现状，绝不阻断照片链路。

采样命中后：把品类的 `shotMode` 覆盖给 planner、`sceneSeed` 注入 prompt（"优先围绕这个
品类拍，但与此刻时段/场景不自洽则宁可不发"），planner 仍保留 send/no-send 决策权。

## 四、待维护者拍板（两处停板点）

1. **权重切换值**：上表初始值是否照用？看完审计后给最终权重，再把开关设 true 切换。
2. **candid 实验默认值**（PR-C）：随手拍质感 flag 的 20 张评估出图后定默认开/关。

## 五、与 current_works / 「她的物」的衔接（PR-D 跨文档备注锚点）

品类权重配置（`config/photo_categories.json` + `photo_categories.mjs`）是"她主动分享
什么"的统一旋钮。V1214_DESIGN 的 current_works 与「她的世界视觉一致性」物件 registry
届时**接入同一套品类配置与 sceneSeed 机制，不另起炉灶**。
