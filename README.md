<div align="center">

<img src="./assets/cover.png" alt="溪语 AI · 默认对你有好感的开源 AI 女友陪伴框架" width="100%" />

# 溪语 AI · Xiyu AI

**默认对你有好感的 AI 女友 · 开源陪伴框架**

她已经心里悄悄喜欢你 —— 关系起点不是陌生人，是「暧昧」。
会发微信、会想你、会写日记、会朗读心事给你听。

*An open-source AI-girlfriend framework — she starts already crushing on you, not as a stranger.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A520-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![Status: Experimental](https://img.shields.io/badge/Status-Experimental-orange.svg)](#已知限制)
[![Docker](https://img.shields.io/badge/Docker-GHCR-2496ED.svg?logo=docker&logoColor=white)](https://github.com/dimang01/xiyu-ai/pkgs/container/xiyu-ai)
[![Releases](https://img.shields.io/github/v/release/dimang01/xiyu-ai?color=FF8FB8)](https://github.com/dimang01/xiyu-ai/releases)

**简体中文** | [English](./README.en.md)

[快速上手](#-30-秒上手) · [功能](#它能做什么) · [Provider 矩阵](#多-provider-支持) · [部署](#部署)

</div>

---

## ⚡ 30 秒上手

不想看文档？复制粘贴一行就能跑：

```bash
docker run -d -p 3000:3000 -v xiyu-data:/app/data --name xiyu-ai \
  ghcr.io/dimang01/xiyu-ai:latest
```

打开 <http://localhost:3000/app/setup.html> → 创建本地账号 → 选 Provider 填 API Key → 开聊。

**不需要**装 Node、clone 代码、编辑 `.env`、邮件服务、微信凭据。只要装了 Docker 就行。
推荐先用 DeepSeek（送额度）或智谱 GLM-4-Flash（免费）跑通流程。

详细启动方式（Compose / 本地裸跑 / Docker 镜像标签）见 [部署](#部署)。

---

## 它能做什么

**核心定位**：不是聊天机器人，是把大模型组织成"一个心里已经悄悄喜欢你的女生"。

> **设计哲学（指导一切功能取舍）**：真人感 = **减法**，不是加法。AI 味的根源是"太好了"——太及时、太顺从、太完美。北极星是「**愿意在真实生活的空隙给你温柔和陪伴**」：少、准、轻，不是填满。调性红线：远离黑化 / 病娇 / 色气 / 致郁 / 沉迷向幻象，NSFW 永不作卖点。纯 prompt 拦不住强默认行为，所以每条产品规则都配**确定性兜底**（出口清洗 / 硬注入 / 状态机喂值）。详见 [CONTRIBUTING](./CONTRIBUTING.md)。

### 她是谁

| 能力 | 一句话 |
|---|---|
| 默认起点 = 暧昧 | affection 35/100，她从第一天就心里悄悄喜欢你，不是从陌生人养成 |
| 具体人生记忆 | 注册时生成 46+ 条人生事件（"小学三年级被狗追过"），不是抽象标签 |
| 5 阶段关系 | 暧昧 → 恋人 → 深爱（可回退）；感情被时间喂大——恋人门槛要认识天数 + 好感日上限，刷不出来 |
| 表白有真实节奏 | 你的表白够格才被接住、不够格被端着婉拒；她也会鼓起勇气主动告白——结巴、绕圈、狼狈的真实，不是漂亮台词 |
| 18 节人设 prompt | 元认知 / 关系阶段 / 日程 / 长期摘要 / 反 AI 味规则一次拼好；视觉人设另管长相一致 |
| 3 个月模拟时间线 | 一键生成过去 90 天的虚拟互动史，首次打开她已经"认识你三个月" |
| 人设可携带 | 导出 / 导入 JSON 跨部署迁移；运行时状态（好感 / 情绪 / 安全模式）刻意不随迁移 |

### 她有自己的生活

| 能力 | 一句话 |
|---|---|
| 她会睡觉 | 默认 00:30-07:30（每天小幅波动），真入睡后微信和网页都静默；睡前晚安留"再陪陪我"挽留窗口；📞 打电话能叫醒但她带起床气 |
| 每日日程 | 每天生成 8-12 段生活剧本（上课 / 做饭 / 发呆），主动消息锚在生活空隙里而不是平均分布 |
| 在线但不一定服务你 | availability / attention 由当前日程推导——开会时"能回但要等等"，逛街时心不在焉 |
| 像真人发微信 | ≤15 字短句、多条连发、打字指示器；你连发 2-3 条她等你停手合并成一轮再回 |
| 不完整回答 | 允许只共情不给建议 / 只吐槽 / 不知道就不知道 / 忙时短回——拒绝"反应+夸+问+建议"四件套 |

### 她有真实的情绪和边界

| 能力 | 一句话 |
|---|---|
| 11 维情绪状态机 | trust / dependency / possessiveness / security / patience / annoyance… 每条消息增量演化 + 半小时定时重算 + 防刷衰减；mood 有强度与惯性，不会一句话从生气变开心 |
| Inner OS 内心独白 | 每轮先生成内心想法（不发送）再写对外回复——心里想"他又来了"嘴上说"嗯"，**内心和嘴上的落差**是真人感的核心 |
| 被冷落会逐级变冷 | 想念 → 试探 → 失望 → 抽离，三种依恋风格（安全/焦虑/回避）决定节奏；久别重逢按天数走不同的和好弧 |
| 冲突与和好弧 ⭐ | 踩雷区 / 伤人话会建**关系事件**：hurt → cold → withdrawing → repairing 显式状态机。伤害类必须正面道歉才解锁修复（"别生气了"式敷衍修得慢），冷落类重逢即开始回暖；冷战有硬时长上限**绝无永久冷战**；和好后入长期记忆（"上次你就说过不查岗"），设计文档 [docs/CONFLICT_ARC.md](./docs/CONFLICT_ARC.md) |
| 不讨好 | 每 5-8 条至少 1 条不同意；暧昧期端着；关系够熟会主动逗你；被反复戳情绪单向升级不横跳 |
| 低能量模式 | 烦躁 / 耐心耗尽触发"今天不想聊"——短回、不展开，偶尔安静的是她要你去够她 |

### 她记得你

| 能力 | 一句话 |
|---|---|
| Memory v2 | 7 层分类 × 权重 × 遗忘曲线；pin / lock / 不许提；语义召回 + 关键词兜底；每日反思引擎自动提炼新记忆 |
| 她记得未完成的事 | 你说"明天面试"→ 第二天她主动问"欸 \|\| 面试咋样"；黄了自动了结 |
| 你可以塑造她 | 教她称呼 / 口头禅 / 雷区 / 约定 / 专属梗，全部留痕入 prompt 她必守 |
| 结构化偏好账本 | like / dislike / taboo × 强度——"极爱猫""有点烦狗血剧"有据可依 |
| 她的日记 + 反向日记 | 每晚第一人称内省日记 + "今天与你有关的回忆"，翻日记本式阅读、可朗读 |
| 时光胶囊 / 留言胶囊 | 写一段话设定未来解锁，到期"现在的她"读完写感想；她也能给你写带签名的离线信 |
| 共同回忆打底 | 创建即自动生成最近一周的互动史；聊到第 10 条消息或绑定微信后，悄悄补全到"认识三个月" |
| 纪念日 | 自动登记"认识 100 天 / 一周年"，到期当天主动祝福 |

### 她会主动找你

| 能力 | 一句话 |
|---|---|
| 主动消息三驱动 | motivation = 情绪 × 日程 × 时段 × 随机；早安晚安防重双闸、同义复读双指标检测、事前反复读注入 |
| 素材级不复读 | 同一个梗（某只猫、某件小事）说过一次冷却 14 天——跨天换措辞重提也会被记账拦下 |
| 读空气 | 连发 3 条你没回就闭嘴；会话窗口将关前轻问一句拉回你；按依恋风格有"尊严上限"绝不纠缠 |
| 因果驱动 | 不只是"今天怎么样"——有到期开环时升级成"对了 \|\| 那个事成了没" |
| 冲突期主动收敛 | 闹别扭时降频、禁撒娇禁照片禁告白；修复期可主动递一条台阶消息 |

### 多模态

| 能力 | 一句话 |
|---|---|
| 真实发图 ⭐ | "发张自拍"→ 意图识别 + AI 规划器决策 + 真发生成照片：机位按语境路由（自拍 / 环境自拍 / 拍手头的事 / 拍风景，竖屏 3:4）、时间光线与聊天内容自洽、反磨皮真实质感、每日上限与冷却 |
| 长相稳定 | 每个 companion 一份视觉人设；4 候选自拍选脸锁定基准，i2i 参考图锚定后续每张照片同一张脸 |
| 语音情绪识别 | 微信语音不只转文字——听得出"温柔 / 撒娇 / 不耐烦"再回应 |
| 网页朗读 | 日记 / 每日一句 / 聊天回复可 TTS 朗读（微信端发语音被 iLink 协议禁止，见已知限制） |
| 表情包 | 按情绪 tag 匹配发送（仓库不含素材，需自备有授权的图） |

### 安全与底线

| 能力 | 一句话 |
|---|---|
| 危机干预 | 检测到自伤信号立即退出角色、给求助热线；冷战中也最高优先——她绝不对状态不好的你摆脸色 |
| 未成年人保护 | 检测自曝未成年 → 粘性安全模式（朋友身份 / 无恋爱内容 / 照片中性化），**无关闭开关**，解除仅限显式年龄声明 |
| 隐私过滤 | 密码 / 证件 / 银行卡级内容整条不入长期记忆，手机号 / 住址脱敏——所有长期存储入口统一挂载 |
| 冲突红线 | 绝不说分手 / 拉黑 / 威胁性告别，绝不愧疚操控，绝不拿你倾诉过的伤心事当武器——全部确定性出站扫描，不靠模型自觉 |
| 人设防泄露 | Persona Guard 回复后一致性校验 + 确定性 prompt 注入拦截 |
| 身体节律 | 她有随时间演化的身体状态（如经期会蔫、按关系深浅披露），调性红线写死：绝不做暧昧窗口、不情色化、未成年保护下整套关闭 |

完整功能详单（含 DB 表与索引）见 [`docs/FEATURES.txt`](./docs/FEATURES.txt)；逐版本演进见 [Releases](https://github.com/dimang01/xiyu-ai/releases)。

> 这是研究 / 个人使用导向的开源代码，**不是 turnkey 产品**。上线前请读 [安全](#安全) 与 [合规](#合规)。

---

## 跑起来之后

```
1. http://localhost:3000
2. /app/auth.html       邮箱注册（dev 模式验证码打到日志）
3. /app/create.html     4 步向导创建 AI 角色
4. 选一个聊天入口：
   · /app/playground.html   浏览器内开聊（任何 chat provider 都行）
   · /app/bind.html         网页扫码绑微信（需 iLink 准入）
5. /app/dashboard.html  实时看好感度、关系阶段、想念档、"她现在在做"
```

### 关键页面

| 路径 | 用途 |
|---|---|
| `/app/setup.html` | 首次配置向导（Chat/Vision/ASR/TTS/Search Provider + 测试连通） |
| `/app/auth.html` | 邮箱注册 / 登录 |
| `/app/create.html` | 创建 AI 角色（4 步向导） |
| `/app/dashboard.html` | 主控制台 + ⚙ 模型设置抽屉 + 重置为暗恋初心 |
| `/app/playground.html` | 浏览器内聊天 + 🎙️ 录音 + 🔊 朗读 |
| `/app/memories.html` | 7 层记忆筛选、增删改查、置顶/锁定/归档 |
| `/app/diary.html` | 她的日记翻书阅读，按句朗读 |
| `/app/bind.html` | 网页扫码绑微信 |
| `/app/admin.html` | 管理员（密码在 `.admin-credentials`） |

---

## 多 Provider 支持

只在 `/app/setup.html` 网页里改 Provider，不改一行代码也不动 `.env`。七类能力独立切换：

| 能力 | 可选 Provider | 说明 |
|---|---|---|
| **Chat**（11 家） | DeepSeek · OpenAI · Anthropic · Gemini · xAI · 智谱 · 豆包 · 通义 · Kimi · 文心 · OpenAI 兼容自定义网关 | 自定义网关可接 OpenRouter / SiliconFlow / Ollama / LM Studio 等 |
| **Image**（6 家） | 智谱 · 通义 · 豆包 · 文心 · OpenAI · OpenRouter / 302.ai（chat 模态） | 302/OpenRouter 支持 i2i 参考图锁脸；各家自动 best-fit 输出比例 |
| **Vision**（8 家） | 智谱 GLM-4V · OpenAI · 通义 VL · 豆包 · Claude · Kimi · StepFun · MiniMax | 看图回应 |
| **ASR**（7 实现） | Gemini · OpenAI Whisper · 通义 paraformer · Groq · MiniMax · Azure · 豆包 | 讯飞 / 腾讯云占位待 PR |
| **TTS**（5 家） | MiniMax · OpenAI · Azure · 豆包 · 通义 CosyVoice | 仅网页端朗读生效 |
| **Embedding**（4 家） | OpenAI · Gemini · 智谱 · 通义 | 语义记忆召回 |
| **Search**（4 家） | Tavily · Brave · SerpAPI · SearXNG | 联网搜索 |

> ⚠️ 并非所有 Provider 都经过生产验证；生产前用 Setup Wizard 的「测试连通」自测。

**Key 复用**：MiniMax 一把 key 通 TTS/ASR/Vision；OpenAI 通 Chat/Vision/ASR/TTS/Embedding；DashScope（通义）通 Chat/Vision/ASR/Embedding；Azure Speech 同管 TTS/STT。豆包 TTS/ASR cluster 不同需独立配置。

---
## 微信接入

### 网页扫码（推荐）

跟着 [跑起来之后](#跑起来之后) 走到第 4 步即可。**不需要**预填 `ILINK_BOT_TOKEN` / `ILINK_BOT_ID`，不需要预跑 `npm run ilink:login`。

后端会在 `POST /api/wechat/bind-session` 时调 `ilink/bot/get_bot_qrcode` 实时申请新二维码，扫码成功后自动入表并 hot-register。

> **iLink 准入资格**：扫码后能否拿到 `bot_token`，取决于你的微信号是否已在腾讯 iLink/ClawBot 后台获得开发者准入。未准入时仍可用 `/app/playground.html` 在浏览器里跑完整体验，只是不发到微信。

### 终端二维码（VPS / 容器）

```bash
npm run ilink:login
```

成功写入 `./.weixin-credentials.json`（mode 0600，已 gitignore）。

### 微信端能做什么 / 不能做什么

| 操作 | 状态 |
|---|---|
| 收发文本 | ✅ |
| 发图片 / 文件 / 视频 | ✅ |
| **用户要"自拍 / 照片 / 看看你" → 真实发图** | ✅ 程序侧识别 + AI 规划器决策 + 视觉人设保持外貌一致 |
| 白天主动场景照（≥36h 候选窗口，AI 自决是否真发） | ✅ |
| 主动消息 + 打字指示器 | ✅ |
| **连发消息整合**（连发 2-3 条等你停手合并回一次，v1.10.53） | ✅ 默认 10s 窗口，`COALESCE_WINDOW_MS` 可调 |
| 收用户语音 → ASR **+ 情绪识别** | ✅ qwen-audio 听得出语气情绪（playground 也支持 ASR） |
| **bot 在微信里发语音** | ❌ iLink 协议禁止 outbound voice（实测 HTTP 200 但消息静默丢弃，腾讯反欺诈） |

所以**语音合成 / 朗读功能仅在网页/PWA 端生效**。SILK 编码 pipeline 代码保留备用，将来腾讯放开时秒切。详见 [`docs/voice-sprint-plan.md`](./docs/voice-sprint-plan.md) 末尾 Sprint 2 失败结论。

---

## 部署

### 路径 A：Docker Compose（推荐生产）

```bash
git clone https://github.com/dimang01/xiyu-ai.git
cd xiyu-ai
docker compose up -d
# 打开 http://localhost:3000/app/setup.html
```

- SQLite 数据走 `./data` volume，重启不丢
- `restart: unless-stopped` 已写在 compose 里，不必额外 systemd
- 自定义端口：`HOST_PORT=8080 docker compose up -d`
- 看日志：`docker compose logs -f xiyu-ai`

### 路径 B：本地裸跑（推荐入门）

```bash
git clone https://github.com/dimang01/xiyu-ai.git
cd xiyu-ai
npm install        # Node ≥ 20
npm run setup      # 生成最小 .env + 预检 better-sqlite3 编译工具链
npm start
```

`npm run setup` 缺编译工具时会给出针对你 OS 的修复命令。

### 路径 C：一行 `docker run`

```bash
docker run -d -p 3000:3000 -v xiyu-data:/app/data \
  --name xiyu-ai ghcr.io/dimang01/xiyu-ai:latest
```

镜像每次 v\* tag 自动构建发到 GHCR，支持 `linux/amd64` 和 `linux/arm64`。可用标签：`latest` / `1.4` / `1.4.2`（推荐锁版本）。

裁剪镜像：build 时传 `--build-arg WITH_VOICE=0 --build-arg WITH_IMAGE=0` 可去掉 ffmpeg / wx-voice 体积。

### 反代 / systemd / 备份

`deploy/` 提供模板：

| 文件 | 用途 |
|---|---|
| [`deploy/xiyu-ai.service`](./deploy/xiyu-ai.service) | systemd unit，已带 `NoNewPrivileges` / `PrivateTmp` / `ProtectSystem` |
| [`deploy/nginx.conf.example`](./deploy/nginx.conf.example) | nginx 反代：HTTPS + HSTS + 长轮询超时 + AI 爬虫友好路由 |
| [`deploy/README.md`](./deploy/README.md) | clone → 上线 step-by-step |
| `scripts/backup-db.sh` | SQLite 三件套（`bot.db` + `-wal` + `-shm`）备份起点 |

### nginx 双目录部署的坑（自托管常见）

如果你像我们的生产那样把 nginx `root` 指向**独立**的前端目录（比如 `/var/www/xxx/frontend/` 而不是项目 `public/`），那么每次 `git pull` 之后**必须把 `public/` 同步过去**，否则前端改动（html/css/js）不会生效，但 API 改动会立刻生效——前端调用新 API 时报错难排查。

最小同步脚本（保留 nginx 目录里独有的素材文件）：

```bash
rsync -av --exclude='.gitkeep' /opt/xiyu-ai-new/public/ /var/www/xxx/frontend/
systemctl restart zhaohy-wechat
```

如果你的 nginx `root` 直接指向项目 `public/`（推荐），无视本节。

### 自检 / 诊断

```bash
npm run doctor          # Node/SQLite/key/iLink/端口/服务健康，一键诊断
npm run check:p0        # P0/P1 回归 127 项
npm run check:imports   # ESM 循环依赖 / 死 import 检查
npm run check:field-drift  # daily_summary 字段名漂移
npm run smoke           # release smoke 10 项
bash scripts/opensource_check.sh   # 6 项开源合规
```

`npm run doctor` 不输出 key 内容，只显示字符数和占位符检测结果。

### 单用户模式

如果你是本机/内网/已用反代加保护的自托管单用户场景，可以**跳过登录页**：

```bash
# .env 加一行
SINGLE_USER=true
```

效果：
- 启动后访问任意页面直接进 dashboard，不再弹登录/注册
- 首次启动自动创建 owner 账号（密码占位，永远不用）
- 多账号场景下用最早注册的账号（一般是 admin）作为默认身份
- dashboard 顶部「登出」按钮隐藏（登出后会自动登回，按钮无意义）

⚠️ **严禁在以下情况开启**：
- 服务直接暴露公网（无 nginx Basic Auth / Cloudflare Access / IP 白名单）
- 多人共用部署（每个人应该有独立账号）

开启后**所有聊天记录、记忆、绑定信息对所有访问者开放**。默认 OFF，多用户模式与旧行为完全兼容。

---

## 运维工具箱

自托管不是"跑起来就完了"——这个仓把生产运营踩过的坑都做成了工具：

```bash
npm run doctor          # Node/SQLite/key/iLink/端口/服务健康，一键诊断
npm run lint            # ESLint：const 重赋值等"运行时静默炸"问题编译期抓死
npm run check:p0        # P0/P1 回归 127 项
npm run arc:digest      # 运营日报（只读）：错误签名归并(新签名置顶尖叫)/关系事件
                        # 与道歉判定流水/红线触发/危机接管/照片比例分布
npm run smoke           # release smoke；bash scripts/opensource_check.sh 开源合规 6 项
```

- **错误签名日报**：近 24h 的 error 日志按归一化签名归并（计数 / 环比 / 首现），新签名高亮——静默失败第一时间变响
- **proactive 死人开关**：每小时心跳，活跃用户在但主动消息全断时 CRITICAL + 邮件告警（`ADMIN_ALERT_EMAIL`），纯报警零自愈
- **emotion-debug 面板**（`/app/emotion-debug.html`，admin）：关系弧状态 / 事件流水 / 每条消息的情绪增量及原因——情绪因果可查，不上线玄学
- **样本标注工具**（`/app/annotate.html`，admin）：读真实回复时顺手标 好/坏 + tag（AI味/化验单腔调/神来之笔…），`scripts/export-corpus.mjs` 导出 JSONL——微调语料生产线，"读"变成"攒"
- **CI 门禁 31 项**：语法 / lint / 字段漂移对账 / 发布一致性 / 各功能 smoke / 红线护栏——新规则都做过"红色验证"（对坏版本跑必须红）
- **运维钳位**：`ARC_MAX_STATE` 可临时封顶冲突状态（生产误伤免回滚的保险丝；与未成年人保护相反——那个是不可关的安全底线）

---
## 架构

```
                ┌────────────────────────────────────────────────┐
                │   Web Dashboard / Playground   /   WeChat user  │
                └───────────────────┬─────────────────────────────┘
                                    │
   ┌──────────────────────────────────────────────────────────────┐
   │  Express (index.mjs) — 多租户 iLink 轮询池                    │
   │  ┌─────────────┬──────────────┬───────────────────────────┐  │
   │  │  api.mjs    │  auth.mjs    │  Setup Wizard / Dashboard │  │
   │  └─────────────┴──────────────┴───────────────────────────┘  │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │  bot.mjs (WeChat in)    playground.mjs (Web in)        │  │
   │  │           ↓                          ↓                  │  │
   │  │  公共 reply pipeline：buildSystemPrompt + recallMemory │  │
   │  │           ↓                                             │  │
   │  │  ai.mjs → providers/ → chat/image/vision/asr/tts/...   │  │
   │  │           ↓                                             │  │
   │  │  memory_v2.mjs · emotion_state.mjs · proactive.mjs     │  │
   │  │  · persona_guard.mjs · companion.mjs · diary.mjs       │  │
   │  └────────────────────────────────────────────────────────┘  │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │  db.mjs (better-sqlite3 + WAL)                         │  │
   │  └────────────────────────────────────────────────────────┘  │
   └──────────────────────────────────────────────────────────────┘
```

### 关键设计

- **Provider facade**：业务层只看 `chatComplete()` / `ttsSynthesize()` 等通用方法，厂商差异隐藏在 `src/providers/*.mjs`
- **同一份 reply pipeline**：微信入口和 playground 入口共用，只是不走 iLink 派发
- **Proactive 防复读**：发送前用字符 3-gram Jaccard 检测最近 5 条 assistant 内容；相似度 ≥ 0.6 升温重生
- **日程自愈**：00:30 cron 失败时 proactive tick 检测到缺日程会按需补一次（30 分钟级 debounce）
- **Persona Guard**：回复后一致性校验，自动检测"我是 AI"、客服话术、阶段违规；轻问题后处理，重问题重生成

### 目录结构

```
.
├── index.mjs                Express 入口 + iLink 轮询池
├── src/
│   ├── ai.mjs               业务层 AI facade
│   ├── providers/           chat / image / vision / asr / tts / embedding / web_search
│   ├── api.mjs              REST 路由
│   ├── bot.mjs              微信消息处理 + 连发合并
│   ├── playground.mjs       浏览器聊天
│   ├── companion.mjs        18 节 system prompt 合成
│   ├── memory_v2.mjs        7 层记忆 + 语义召回 + 遗忘曲线
│   ├── emotion_state.mjs    11 维情绪状态机 + presence
│   ├── inner_os.mjs         Inner OS 内心独白 + 冲突弧结构化检测
│   ├── open_loops.mjs       她记得未完成的事
│   ├── proactive.mjs        主动消息 + 场景照调度
│   ├── photo_intent.mjs     用户照片请求意图识别
│   ├── photo_planner.mjs    照片 AI 决策器 + 机位/比例路由
│   ├── photo_sender.mjs     生图 → 比例转码 → 上传发送
│   ├── visual_identity.mjs  稳定视觉人设 + 参考图管理
│   ├── visual_identity_candidates.mjs  4 候选自拍生成 + 选脸锁定
│   ├── image_beautify.mjs   生图全局轻美颜后处理
│   ├── security/netguard.mjs SSRF 防护下载
│   ├── relationship_arc.mjs 冲突与和好弧状态机（+_runtime IO 层）
│   ├── moderation.mjs       危机干预 + 冲突红线出站护栏
│   ├── minor_guard.mjs      未成年人保护（粘性安全模式）
│   ├── privacy_filter.mjs   长期存储隐私过滤
│   ├── persona_guard.mjs    回复后一致性校验
│   ├── reflection.mjs       每日/每周 AI 反思
│   ├── diary.mjs            日记生成
│   ├── thoughts.mjs         今天她想对你说
│   ├── voice_pipeline.mjs   mp3 → SILK 转码
│   ├── voice_inbound.mjs    入站语音 下载+解密+解码
│   ├── voice_emotion.mjs    语音情绪识别
│   ├── plan_tasks.mjs       cron 调度（日 / 周 / 月）
│   ├── ilink.mjs            iLink 协议封装
│   └── db.mjs               SQLite + 全部 migrateXxx() 注册点
├── public/app/              17 个前端页面（dashboard / playground / emotion-debug …）
├── deploy/                  systemd + nginx 模板
├── scripts/                 80+ 个：setup / doctor / arc-digest / 各 smoke / 沙箱验收 / ...
├── docs/
│   ├── FEATURES.txt         完整功能清单（最权威）
│   ├── HANDOFF.md           新对话交接提示词
│   ├── CONFLICT_ARC.md      冲突与和好弧设计文档
│   ├── ROADMAP.md           路线完成情况与 2026-06 回顾
│   └── voice-sprint-plan.md 语音 sprint 计划
└── data/                    运行时数据（gitignored）
```

---

## 安全

### 凭据与敏感文件

- `.env` / `.env.*` / `.auth-secret` / `.admin-secret` / `.admin-credentials` / `.weixin-credentials.json` / `data/bot.db*` / `data/user_memories/` 全部 `.gitignore`
- 管理员密码首次启动自动生成 20 位写入 `.admin-credentials`（0600），忘记可删文件重生
- `AUTH_SECRET` 留空会自动生成但每次重启重生（导致 token 全部失效）。**生产请显式设 ≥32 字符随机串**
- `/api/health` 只输出 provider 名 / iLink configured 与否 / 邮件模式，绝不输出 token / 用户数据
- iLink `bot_token` 从不打印；扫码脚本只显示 masked `bot_id` / `user_id`
- 默认 CORS 关；默认 rate limit (`src/ratelimit.mjs`) 按个人量级设计，公开服务前置 WAF

### v1.6.1 加固

- **SSRF 防护**：所有从用户 URL 下载的图片（如"从 URL 设头像"）走 `src/security/netguard.mjs`：仅 http/https、DNS 解析后逐 IP 校验、拒绝 127/10/172.16-31/192.168/169.254/100.64/IPv6 ULA-link-local 等保留段、≤5MB、≤3 跳重定向、15s 超时
- **限流 IP 取值**：`req.ip` 由 Express trust-proxy 链计算，不再裸读客户端 `X-Forwarded-For`（可伪造）。反代场景配置 `TRUST_PROXY=true` 或具体 IP/CIDR
- **首次初始化 token**：`POST /api/setup/local-account` 默认只允许 localhost；如需远程一键初始化可设 `XIYU_SETUP_TOKEN=<随机串>`，调用方通过 `xiyu-setup-token` header 提供，校验用 `crypto.timingSafeEqual` 防侧信道
- **管理端鉴权**：`/api/admin/ilink-status` 加 `requireAdmin`，返回字段去除 token / errmsg 截断 80 字 / bot_id 脱敏，避免泄漏运营态
- **越权防护**：`/api/companions/user/:uid` 校验 companion 归属当前账号（IDOR 修复）
- **Setup 试 Provider**：`/api/setup/test-chat` 加 `softAuth`，匿名调用仅限"首次本机 + 用户数=0"白名单

### 数据与内容

- SQLite 默认 `data/bot.db`，含聊天历史 / 记忆 / 用户画像。自托管时数据完全在你机器上
- 对话历史默认保留 60 天 (`runHourlyCleanup`)，可调；删账号清空对应 companion 全部数据
- **未成年人 / 心理高风险场景请额外谨慎**，见 [Issue #3](https://github.com/dimang01/xiyu-ai/issues/3)

### 报告安全问题

- 邮箱：`xiyuai@proton.me`
- GitHub Security Advisories：<https://github.com/dimang01/xiyu-ai/security/advisories/new>
- 详细见 [SECURITY.md](./SECURITY.md)

---

## 合规

**MIT 协议只覆盖代码，不覆盖你产出的内容、引用的第三方服务、运营行为。公开部署是运营者自己的责任。**

7 项部署者自查清单（不构成法律意见）：

| 维度 | 你需要做的 |
|---|---|
| 隐私政策 / 用户协议 | `terms.html` / `privacy.html` 是空模板，**不能直接用** |
| AI 生成内容标识 | 中国大陆《生成式人工智能服务管理暂行办法》、欧盟 AI Act 等都要求显著标识 |
| 未成年人保护 | v1.20 起内置：检测用户自曝未成年（regex + LLM 兜底）→ 粘性安全模式（朋友身份、无恋爱内容、阶段封顶、照片中性化），解除仅限 dashboard 显式年龄声明。**但这不是年龄验证**——无法识别不自曝的未成年人，公开运营仍建议接入实名/年龄验证 |
| 个人信息保护 | PIPL / GDPR / CCPA 等需自行明示收集目的、提供删除接口 |
| 内容安全审核 | 仓库当前只有简单黑名单，对外开放前请接入云厂商审核 API |
| 危机话术 | 当前不识别自伤、自杀等高风险输入，请加入危机检测 |
| Provider ToS | 每家 LLM/图像 provider 各有条款（是否允许虚拟人格、情感陪伴、商用），切换前自行确认 |

### 关于"陪伴"定位

框架不预设角色性格 / NSFW 内容 / 越界互动。**注册角色的人设由部署方或终端用户决定**。仓库里所有人格模板都是中立示例。是否做向成年用户的情感陪伴、是否允许某些角色，是你的产品决策与合规决策，请自负其责。

---

## 已知限制

| 限制 | 状态 / 跟踪 |
|---|---|
| **bot 在微信里发语音** | 永久限制 — iLink 协议禁止 outbound voice；网页/PWA 端正常 |
| 讯飞 / 腾讯云 ASR 仅占位 | WebSocket + HMAC 协议复杂，需 PR |
| 内容审核 API 需运营者自接 | 危机干预与未成年人保护已内置；公开运营建议另接审核服务 |
| 生产部署指南未完善 | [#5](https://github.com/dimang01/xiyu-ai/issues/5) |
| 微信对接依赖腾讯 iLink/ClawBot 准入 | 上游条件 |
| 实时语音通话 | 协议层做不到 |

---

## 版本历史

发版节奏 / 完整 changelog 在 [GitHub Releases](https://github.com/dimang01/xiyu-ai/releases)；增量索引见 [`docs/FEATURES.txt`](./docs/FEATURES.txt)；2026-06 路线回顾见 [`docs/ROADMAP.md`](./docs/ROADMAP.md)。

主线脉络（一句话版）：

- **v1.22.0 她的生活有实物 + 失忆修复**：她有了随时间演化的身体（生理期会蔫但不指向你、按关系深浅披露、绝不做暧昧窗口、未成年保护下关闭，情绪上的细微影响默认只后台观测）；世界经得起查证（节气 / 农历节日天文计算含闰月、手头的书 / 剧 / 事跨日连贯）；不再"突然失忆"（记得当前场景与你们的约定，讲完故事不再忘、不凭空编"刚吃完麻辣香锅"，凭空重病声明也拦）；运维侧死人开关三桶信号分离减少假警报、反思心跳、playground 探针
- **v1.21.x 冲突与和好弧 + 工程加固**：关系事件状态机（她会真的受伤、和好有惯性）统一收编全部"她对你冷"的逻辑；事故复盘后让静默失败变响（ESLint / 错误签名日报 / 死人开关）；照片比例修复；沉浸感卫生包（她的世界里没有"用户"这个词、素材级防复读、互动历史自动打底）；照片承诺兑现链（承诺前可行性闸门、拍不出能改期补发、月相锚定杜绝凭空满月）；照片品类校准（像真实恋爱那样发照片：食物一等公民、天空靠 sun_times 日落窗口锚定、"看到这个想到你"、真实出版物封面护栏；先审计后改配比时还顺手揪出并修了一桩 1.5 天的静默断图 P0）
- **v1.20.x 安全收尾**：未成年人保护（粘性安全模式）、隐私过滤全口子、发布一致性 CI、照片真实感 v2（反磨皮质感词直达生产）
- **v1.14 → v1.19 真人感纵深**：被冷落逐级转变 + 依恋风格、留存漏斗（挽留/升温/读空气/破冰）、照片真实感大改（环境自拍/i2i 锁脸/机位路由）、初恋特质
- **v1.6 → v1.13 体验底座**：真实发图链路、反讨好系列、Inner OS、开环记忆、睡眠系统、连发合并、关系节奏（时间喂大感情）、中英双语
- **v1.0 → v1.5 框架成型**：人设引擎、Memory v2、情绪状态机、主动消息、日记、多 Provider 抽象

---
## 贡献 & 路线图

- 开发环境 / PR 约定 / 产品调性 → [CONTRIBUTING.md](./CONTRIBUTING.md)（3 分钟读完）
- 找到 bug → [新 Issue](https://github.com/dimang01/xiyu-ai/issues/new/choose)
- 路线图 → [Issues](https://github.com/dimang01/xiyu-ai/issues) 带 `enhancement` / `help wanted` / `good first issue` 标签的最适合上手
- 想贡献代码：fork → PR；保持改动小而聚焦，附带说明动机
- 致谢见 [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md)

---

## 许可证

[MIT](./LICENSE) © 2026 溪语 AI Contributors

仓库**不包含**任何第三方表情包图片。`assets/stickers/` 只有加载与 tag 匹配机制，启用表情包请自行准备有合法授权的素材。

<div align="center">

[⬆ 回到顶部](#溪语-ai--xiyu-ai) · [English](./README.en.md)

</div>
