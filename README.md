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

| 能力 | 简介 |
|---|---|
| **🖤 被冷落会变 + 依恋风格 (v1.14)** ⭐⭐ | 长时间不回，她从想念→试探→失望→冷淡抽离**逐级转变**（不再一直撒娇等你）；可选三种**依恋风格**（安全/焦虑/回避）决定升级快慢与黏度，dashboard 一键切；安全感随冷落下滑、重新联系回暖 |
| **🌐 中英双语 (v1.13)** ⭐⭐ | 默认中文，右下角「中/EN」一键切英文：界面全译 + AI 回复随之说英文（`companions.locale`）；AI 生成的日记/记忆等动态内容走**浏览器本地翻译**（不出浏览器、不外泄）。老用户无感 |
| **她会睡觉 (v1.10.x)** ⭐⭐ | 默认 00:30 睡 / 07:30 起（每天不对称小幅波动：睡 -15/+45、起 ±10 分钟），dashboard 用 **iOS 风格圆形拨盘**拖 🌙☀️ 双把手调节。睡前发"我睡了"晚安 → 留**挽留窗口**（你说"再陪陪我"她延后 20min 陪聊）→ 真入睡后**微信和网页都静默不回**（进 missed 队列），起床发早安 + "昨晚睡着了"概括补回。睡熟了挽留无效，**📞 打电话叫醒她**（脉冲发光）立刻叫醒但她带起床气。可在作息卡片关闭 |
| **默认起点 = 暧昧** | affection 35/100、stage 暧昧。她从一开始就喜欢你，不是从零培养 |
| **具体人生记忆** | 注册时一次性生成 46+ 条人生事件（"小学三年级被狗追过一次"），不是抽象标签 |
| **18 节人设 prompt** | 元认知 / 关系阶段 / 今日日程 / 最近上下文 / 长期摘要 / 反 AI 味规则一次拼好 |
| **5 阶段关系** | 暧昧 → 恋人 → 深爱（可回退朋友/陌生人）。每阶段称呼、撒娇、话题深度差异化 |
| **真人发微信** | ≤15 字一条、多条 \|\| 连发、剥离 AI 味；Persona Guard 回复后一致性校验 |
| **连发不打断 (v1.10.53)** ⭐⭐ | 你一次连发 2-3 条消息/图片，她不再每条回一遍——等你停手（默认 10s 安静窗口，可调）把这一串整合成「一轮」只回一次，像真人那样"看完再回"。文本 + 图片 + 语音都进同一轮合并 |
| **她记得未完成的事 (v1.8.0)** ⭐⭐ | 用户说"明天去面试" → LLM 抽取存 `companion_open_loops` 表 → 第二天主动问"欸 \|\| 你今天面试完没"。`due_at` + `emotional_weight` + `expected_followup`。用户说"黄了"自动 resolve，7+ 天没下文自动 stale。这是真人陪伴最强信任来源之一 |
| **Inner OS 内心独白 (v1.8.0)** ⭐⭐ | Double-pass reply：每次先生成"内心 OS"（不发送）→ 注入到 outer prompt → 基于内心写对外回复。内心想"他又来了"嘴上说"嗯"，内心想"挺心动"嘴上端着——内心和嘴上之间的**落差**是真人感的核心。`INNER_OS_ENABLED=false` 可关，短消息 < 8 字自动跳过 |
| **因果驱动的主动消息 (v1.8.0)** | proactive 不再只是"今天怎么样"。当 `companion_open_loops` 有到期事 → kind 升级为 `recall`，注入 `hidden_reason`（"用户昨天说要面试"），prompt 让她"对了 \|\| 你今天 XX 咋样"；`followed_up_at` 防 6h 内重复打扰 |
| **结构化偏好账本 (v1.8.0)** | `companion_preferences` 表：`type` (like/dislike/taboo/neutral) × `intensity` 1-5 × `reason` × `source` (system/user_observed/generated/legacy/user)。prompt 按强度修饰"极猫""很爹味""有点狗血剧"。3 个 REST 端点。启动自动 backfill 老 `hobbies/dislikes` 到本表 |
| **Presence: 在线但不一定服务你 (v1.8.0)** | `availability` (free/busy/half) + `attention` (0-100) 字段，从今天 dailySchedule 当前活动派生：睡/开会=busy / 吃/逛=half / 其它=free。prompt 注入"能回但分心，边做别的事边回"——用户问"在干嘛"不再是完整回答 |
| **不完整回答 (v1.7~v1.8)** | 7 种允许：只共情不给建议 / 只吐槽一句 / 先敷衍后补充 / 不知道就不知道 / 不想聊就转移 / 忙时只回很短 / 可以"没意见"。彻底拒绝"反应+夸+问+建议"四件套 AI 味 |
| **不讨好 + 暧昧端着 + 逗他 + 不想聊 (v1.7.0)** | 反 sycophancy 五连：每 5-8 条 ≥1 条带不同意 / 暧昧期不催不全收装平静 / 关系够熟主动逗你 / 烦躁阈值触发"低能量模式"覆盖讨好指令 / `dislikes` 字段让"我不行"有据可依 |
| **真实发图 (v1.6.1+)** ⭐ | 用户说"发个自拍""让我看看你"——程序侧识别意图（regex + LLM 二分类兜底）、AI 规划器决策、真的发生成的照片到微信。**异步生图**（立即"等下哦"+ 后台跑，不阻塞对话）、每日上限、冷却、敏感词拦截、**全局轻美颜**后处理、Provider 缺失自动兜底"刚拍糊了" |
| **稳定长相 + 4 候选选脸 (v1.6.1 / v1.10.43+)** ⭐⭐ | 每个 companion 一份 visual identity（发色/发型/穿搭/气质 spec），每次发图按它生成避免换脸。dashboard 可**一次生成 4 张候选自拍、挑最满意的锁定为基准**；OpenRouter 生图走 **image-to-image**，锁定/上传的参考图真正锚定后续每张照片的长相（不再只靠文字描述） |
| **主动场景照** | 白天 36h 候选窗口 + AI 规划器决策，像"刚坐下来想给你看"那样低频自然发图，附自然配文 |
| **主动消息（三驱动 v1.6）** | 早安/晚安/日间/纪念日/告白；motivation = 情绪 × 日程 × 时间 × 随机；段内 + 历史双重 dedup；重启持久化防重发 |
| **想念档 0-4** | 综合 dependency + idle 算"她想你的程度"，30m/3h/6h/12h/24h 五档，回复口吻自然带出来 |
| **3 个月模拟时间线 (v1.6)** ⭐ | dashboard 按钮触发，LLM 一次性生成 35 个虚拟互动事件 + 关键事件入记忆 + 好感度演化 5→30；用户首次打开聊天她已经"认识 3 个月" |
| **今天她想对你说** | 每天 02:35 cron 生成独立于聊天的一句话，dashboard 气泡卡 + 🔊 朗读 |
| **她的日记** | 每晚第一人称日记 + 每周合并；翻日记本式阅读页，按句切段连续朗读 |
| **Memory v2** | 7 层分类 × 权重 × 遗忘曲线；pin/lock/archive/do-not-mention；语义召回 + 关键词 fallback |
| **情绪状态机 (v1.6 升级 11 维)** | affection / trust / dependency / possessiveness / security / energy / mood + **patience（耐心）/ excitement（兴奋短期）/ annoyance（烦躁短期）/ gratitude（感激）**；每条消息增量演化 + 半小时定时重算 + saturation 防刷（连发"谢谢"涨幅衰减） |
| **听得出情绪的语音 (v1.10.17)** ⭐ | 微信入站语音不只是转文字——下载 + AES 解密 + silk 解码后过 **qwen-audio 情绪识别**，听得出"温柔/撒娇/不耐烦"的语气情绪再回应；任一步失败自动降级到纯转写 |
| **网页 Playground** | 不接微信也能在浏览器里跑同款人设管线；可录音 ASR 输入、每条回复 🔊 朗读 |
| **Setup Wizard** | `/app/setup.html` 网页填 Provider Key + 测试连通，不用碰 `.env` |
| **多 Provider 抽象** | chat/image/vision/asr/embedding/tts/search 七大能力独立切换 |
| **PWA** | 手机加桌面图标当原生 app；API/用户数据不被 SW 缓存 |

完整功能清单（含 DB 表、最近 PR、12 维度分类）见 [`docs/FEATURES.txt`](./docs/FEATURES.txt)。

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

只在 `/app/setup.html` 网页里改 Provider，不改一行代码也不动 `.env`。

> ⚠️ 并非所有 Provider 都经过生产验证；部分是兼容性骨架。生产前请用 Setup Wizard Step 3 的「测试连通」自测。

### Chat（11 家）

| Provider | 默认模型 | 备注 |
|---|---|---|
| DeepSeek | `deepseek-chat` | 性价比首选 |
| OpenAI | `gpt-4o-mini` | |
| Anthropic | `claude-sonnet-4-6` | 原生 messages API |
| Google Gemini | `gemini-2.5-flash` | 有免费额度 |
| xAI Grok | `grok-2-latest` | |
| 智谱 GLM | `glm-4-flash` | |
| 字节豆包（火山方舟） | *(必填 ep-xxx 接入点)* | |
| 阿里通义 | `qwen-plus` | DashScope OpenAI 兼容 |
| Moonshot Kimi | `moonshot-v1-8k` | 长上下文 |
| 百度文心 | `ernie-4.0-8k` | |
| **OpenAI 兼容自定义网关** | *(必填)* | OpenRouter / SiliconFlow / Ollama / LM Studio / LiteLLM 等 |

### Vision（8 家）

`zhipu` GLM-4V · `openai` gpt-4o-mini · `qwen` qwen-vl-plus · `doubao` ep-xxx · `anthropic` Claude · `kimi` moonshot-v1-vision · `stepfun` step-1v · `minimax` abab vision

### ASR · 语音识别（7 实现 + 2 占位）

`gemini` · `openai` whisper-1 / gpt-4o-transcribe · `qwen` paraformer-v2 · **`groq`** whisper-large-v3 · **`minimax`** · **`azure`** STT · **`doubao`** 一句话识别 · `xunfei` / `tencent` *(占位)*

### TTS · 语音合成（5 家）

`minimax` speech-02 · **`openai`** tts-1 / tts-1-hd · **`azure`** Speech（SSML）· **`doubao`** 火山引擎 · **`qwen`** CosyVoice / Qwen-TTS

### Image（6 家）

`zhipu` CogView-4 · `qwen` Wanx · `doubao` · `wenxin` · `openai` gpt-image-1 / DALL·E · `openrouter` 聚合（gpt-image / gemini-2.5-flash-image，**支持参考图 image-to-image**）

### Embedding（4 家）· Search（4 家）

Embedding：`gemini` · `openai` · `zhipu` · `qwen`
Search：`tavily` · `brave` · `serpapi` · `searxng`

### Key 复用

部分 Provider 在多能力间共用 key，省掉重复填：

- **MiniMax key**（`MINIMAX_API_KEY`）一把通 TTS / ASR / Vision
- **Azure Speech key + region** 同时管 TTS 和 STT
- **OpenAI key** 同时管 Chat / Vision / ASR / TTS / Embedding
- **DashScope key**（通义 `QWEN_API_KEY`）同时管 Chat / Vision / ASR / Embedding；CosyVoice 用 `DASHSCOPE_API_KEY`

豆包 TTS/ASR 的 cluster 不同（`volcano_tts` vs `volcengine_input_common`），所以独立配置。

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
| **用户要"自拍 / 照片 / 看看你" → 真实发图 (v1.6.1)** | ✅ 程序侧识别 + AI 规划器决策 + 视觉人设保持外貌一致 |
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
npm run check:p0        # P0/P1 回归 125 项（v1.10.0 起含 proactive 防回归）
npm run check:imports   # ESM 循环依赖 / 死 import 检查
npm run check:field-drift  # daily_summary 字段名漂移
npm run smoke           # release smoke 10 项
bash scripts/opensource_check.sh   # 6 项开源合规
```

`npm run doctor` 不输出 key 内容，只显示字符数和占位符检测结果。

### 单用户模式（v1.5.1）

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
│   ├── api.mjs              REST 路由 (3000+ 行)
│   ├── bot.mjs              微信消息处理 + 连发合并（v1.10.53）
│   ├── playground.mjs       浏览器聊天
│   ├── companion.mjs        18 节 system prompt 合成
│   ├── memory_v2.mjs        7 层记忆 + 语义召回 + 遗忘曲线
│   ├── emotion_state.mjs    11 维情绪状态机 + presence (v1.8.0 加 availability/attention)
│   ├── inner_os.mjs         Inner OS 内心独白 double-pass reply (v1.8.0)
│   ├── open_loops.mjs       她记得未完成的事 — LLM 抽取 + auto-resolve (v1.8.0)
│   ├── proactive.mjs        主动消息 + 场景照调度 (v1.8.0 加 recall + hidden_reason)
│   ├── photo_intent.mjs     用户照片请求意图识别（v1.6.1）
│   ├── photo_planner.mjs    照片 AI 决策器 + 安全清洗（v1.6.1）
│   ├── photo_sender.mjs     生图 → 转码 → 上传 → 发送 helper（v1.6.1）
│   ├── visual_identity.mjs  稳定视觉人设 + 参考图管理（v1.6.1）
│   ├── visual_identity_candidates.mjs  4 候选自拍生成 + 选脸锁定（v1.10.43）
│   ├── image_beautify.mjs   生图全局轻美颜后处理（v1.10.52）
│   ├── security/netguard.mjs SSRF 防护下载（v1.6.1）
│   ├── persona_guard.mjs    回复后一致性校验
│   ├── reflection.mjs       每日/每周 AI 反思
│   ├── diary.mjs            日记生成
│   ├── thoughts.mjs         今天她想对你说
│   ├── voice_pipeline.mjs   mp3 → SILK 转码
│   ├── voice_inbound.mjs    入站语音 下载+AES解密+silk解码（v1.10.17）
│   ├── voice_emotion.mjs    qwen-audio 语音情绪识别（v1.10.17）
│   ├── plan_tasks.mjs       cron 调度（日 / 周 / 月）
│   ├── ilink.mjs            iLink 协议封装
│   └── db.mjs               SQLite + 全部 migrateXxx() 注册点
├── public/app/              15 个前端页面（dashboard 1800+ 行，含 ⚙ 模型抽屉）
├── deploy/                  systemd + nginx 模板
├── scripts/                 26 个：setup / doctor / check:p0 / backup / smoke / ...
├── docs/
│   ├── FEATURES.txt         完整功能清单（最权威）
│   ├── HANDOFF.md           新对话交接提示词
│   ├── ROADMAP.md           P0/P1/P2A/P2B/P2C 完成情况
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
| 未成年人保护 | 当前版本不内置年龄验证 / 内容分级 |
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
| 消息去重是进程内 Set | 重启可能短暂重复，[#1](https://github.com/dimang01/xiyu-ai/issues/1) |
| SQLite 备份 / 恢复脚本不完整 | [#2](https://github.com/dimang01/xiyu-ai/issues/2) |
| 缺少危机 / 未成年人安全审核层 | [#3](https://github.com/dimang01/xiyu-ai/issues/3) |
| 生产部署指南未完善 | [#5](https://github.com/dimang01/xiyu-ai/issues/5) |
| 微信对接依赖腾讯 iLink/ClawBot 准入 | 上游条件 |
| 实时语音通话 | 协议层做不到 |

---

## 版本历史

发版节奏 / 完整 changelog 在 [GitHub Releases](https://github.com/dimang01/xiyu-ai/releases)。

最近主线：

- **v1.10.43 → v1.10.53「会挑脸的她 + 连发合并 + 真·image-to-image」** ⭐⭐ · **连发消息合并**（真人常连发 2-3 条消息/图片 → 改成等用户停手 ~10s 把这一串整合成「一轮」只回一次，文本+图片+语音都合并；debounce 缓冲 + 硬上限防永不回，`COALESCE_WINDOW_MS` 可调）· **4 候选自拍选脸**（一次并发生成 4 张不同光线/视角/表情的候选，dashboard 挑最满意的锁定为基准，不再被第一张丑图永久指挥；candidate prompt 年龄动态化 + 不露齿 + 清纯锚点 + 2 校服 2 便服）· **参考图 image-to-image 真正接通**（OpenRouter 走多模态把锁定/上传的 ref 图作为 input image 喂进 gpt-image / gemini-2.5-flash-image，锁定的脸真正锚定后续每张照片——此前 `referenceImage` 一直硬编码 false、参考图链空转）· **全局轻美颜**（sharp 后处理接到 imageGenerate 层，微提亮/增饱和/柔肤/极轻磨皮，刻意不到塑料感）· 候选图磁盘返回 fname + 独立 GET（避开 iOS Safari 大 JSON）+ rate limit 防刷
- **v1.10.11 → v1.10.42「语音情绪 + 照片美学大修 + HOSTED_MODE + 一批救火」** · **入站语音情绪识别**（不只转文字：下载 + AES 解密 + silk 解码 → qwen-audio 听出语气/情绪/声音强度再回应，失败降级纯转写）· **照片美学大修**（photo_planner 颜值/表情/自拍 POV/反写真感重写 + 注入时间感与完整人设外观；photo_intent regex + LLM 二分类兜底终结漏识别；photo **异步化**立即回应不阻塞 polling）· **OpenRouter image provider**（默认 gpt-image-1，5.4→5-mini→gemini-2.5 fallback chain）· **HOSTED_MODE**（部署版隐藏 dashboard 后端 provider/model、锁 setup 写端点）· **救火**：QR 扫码绑定 companion 孤儿化、iLink 限速入队不吞消息、拆段腰斩、goodnight/morning 漏发兜底、关系升「恋人」必须有表白检测、sticker 支持 disabled 跳过不合人设表情
- **v1.10.1 → v1.10.9「睡眠拟人化 + 体验打磨」** 在 v1.10.0 基础上快速迭代：proactive 审计修 sleep 集成 3 个回归（morning 误判 / 晚睡不发晚安 / 节流吞配额）· sleep **默认 00:30 睡**（避开晚间活跃；曾因默认 23:00 全网静默被当"微信坏了"）· **网页端(playground)也接 sleep 拦截**（之前只微信端）· **不对称抖动**（睡 -15/+45、起 ±10）· **挽留延后**（刚入睡说"再陪陪我"延后 20min 陪聊）· 睡前晚安与入睡解耦留挽留窗口 · **iOS 风格圆形作息拨盘**（拖 🌙☀️ 双把手 + 睡眠时长，松手自动保存）· 叫醒按钮脉冲发光 · dark mode 覆盖加固（属性选择器兜底 + 引导气泡）· Turnstile 改成仅失败 reset（修"重复验证"）+ **找回密码页也加 Turnstile** · 登录页插图迭代到精致 pixiv 风二次元
- **v1.10.0「她会睡觉 / 注册防刷 / 夜间模式 / proactive bug 修」** ⭐⭐ 五件套：**#1 作息与睡眠系统** — 新表 `companion_sleep_schedule`（入睡/起床 + ±N min 抖动 + 学习状态）+ `companion_missed_messages`（睡眠期消息队列）。新模块 `src/sleep.mjs`：bot 入口睡眠时段静默拦截 + 入队 missed；proactive 早晚安基准从 sleep 表读，morning kind 自动拼"昨晚发了好多 \|\| 我刚醒"摘要 prompt；前 7 天观察用户首末消息时间→第 8 天按中位数固化；dashboard 加 📞 打电话叫醒她（按下立刻 exitSleep + annoyance/anger 上升，AI 立刻发"被吵醒"短消息）· **#2 proactive 不发消息 bug 修** — root cause：tick 循环 `item.sent = true` 在 `evaluateProactive` 之前，v2 因 90min backoff 拒发时 item 被永久标 sent，后续永不重试，用户感知"主动消息明显比设置的少"。修法：item.sent 移到真正进 send wrapper 时才标；v2 拒发写 `_v2_deny_until = now + 15min` 防抖；加 p0_regression_check 2 条 source-level 防回归 · **#3 Cloudflare Turnstile** — auth.html 注册 tab 加 widget，send-code 接口前先 `verifyTurnstile(token, remoteIp)`→走官方 siteverify；secret 仅 .env，site key 前端硬编码；未配置 secret 跳过校验（dev 友好），网络故障保守拦截 · **#4 全站夜间模式** — `public/app/theme.js` localStorage `xiyu_theme`=auto/light/dark；auto 跟随 `prefers-color-scheme` mediaquery；浮动按钮 🌓→☀️→🌙 循环；17 个 html 头部 inline pre-script 避免渲染闪烁；glass.css 扩 dark 骨架覆盖 Tailwind 常用 utility · **#5 minimax/Tavily/Qwen 三家 key** — .env 接好即用，已有 provider 代码（chat/tts/asr/vision/web_search/embedding）自动识别
- **v1.8.0「她真的记得 + 她有内心 OS」** ⭐⭐ 真实感升级 v2。6 块改动：**#7** 加 "incomplete-reply" prompt（7 种允许：只共情不给建议/只吐槽/敷衍补充/不知道就不知道/转移/忙时短回/没意见）· **#1** emotion_state 加 `availability` + `attention` 字段，从今日 dailySchedule 当前活动派生（睡/开会=busy、吃/逛=half），prompt 注入"现在能回但分心" · **#3** 新表 `companion_preferences` 结构化偏好账本（like/dislike/taboo/neutral × intensity 1-5），启动 backfill 把现有 `hobbies/dislikes` 同步过去，patch 时同步；prompt 按强度修饰"极/很/有点"；新增 3 个 REST 端点 · **#4** 新表 `companion_open_loops` "她记得未完成的事"（"明天去招聘会" + due_at + emotional_weight + expected_followup + status），LLM 抽取 + 启发式 auto-resolve（"招聘会黄了" → 自动 resolve），03:30 cron 清 stale · **#5** proactive 主动消息**因果重塑**：normal 时查 `listDueOpenLoops`，命中则升级为 `recall` kind，注入 hidden_reason，让她"对了 || 你今天面试完没"而不是"今天怎么样" · **#6** **内心 OS** double-pass reply pipeline：每次回复前先生成"内心独白"（短小、不发送），注入到 outer system prompt 让模型基于内心写对外回复——内心和嘴上之间的落差就是真人感来源。可关（`INNER_OS_ENABLED=false`）、短消息 < 8 字自动 skip
- **v1.7.0「真实感升级：不讨好、会逗你、会端着、会不想聊」** ⭐ 解决 LLM sycophancy 在陪伴场景下的具体表现。5 块改动：**A** 加 200 字"她不是来讨好你的"prompt（每 5-8 条 ≥1 条带不同意/不喜欢/直球批评，带熟人轻松感）· **B** 加 200 字"你也会逗他"prompt（拆台/假吐槽/玩梗/自黑撒娇，依赖 `can_joke`，stage≠陌生人时注入，朋友~暧昧 1/6-8 频率、恋人~深爱 1/3-4 频率）· **C** 暗恋期"端着"具体话术示范（180 字+6 反例，仅陌生人/朋友/暧昧 stage）· **D** emotion_state 低能量模式（mood=cold 或 annoyance≥70 或 patience≤20 时触发"今天不想聊"最高优先级 hint：单字/不接话/可以"我先去 xx"打断；覆盖讨好/逗他等）· **E** 新增 `companion.dislikes` JSON 字段（与 forbidden_topics 区分："不喜欢但会聊"，prompt 注入"这个我不行"等指令；create.html 加 8 预设 chip：听抱怨/吃辣/狗血剧/网络梗/夜店/说教/爹味/算计的人）
- **v1.6.3「撤掉不合调的人物插图」** v1.6.2 的 hero-girl 插图（OpenRouter gpt-5-image-mini 生成）实际效果是粉发二次元少女正脸，与产品"她像真实的人"的调性冲突；首页把它做成 logo 背后衬底太抢戏。本版撤掉 hero-girl 引用、删 .webp 文件、从重生脚本里移除，首页回到干净的 logo + 文案，auth 左栏换成 feature-persona（日记本）
- **v1.6.2「打磨与刷新」** v1.6.1 一波收尾修复：visual_identity 死代码三元、photo_planner `numberEnv` 空字符串被吞为 0、netguard 重定向未排空响应、photo_sender 下载图片缺大小防御、强请求识别扩展（`想看看你 / 再来一张 / 看下你 / 秀一下你/自己` 等）、gate 拦截/planner 拒绝时给固定兜底而不退到普通 AI 文本 · **前端美化**：glass.css 升级（3 层背景光晕、多层阴影、三色 focus ring、新工具类 `.hero-blob / .floating-card / .glass-chip / .glass-stagger` + 暗色骨架）· 5 张 landing 插图全量重生（OpenRouter `openai/gpt-5-image-mini`，统一 soft pastel + flat vector）· 4 个入口页结构升级（首页 hero 衬底、auth 桌面两栏 split、create / setup 接入插图）
- **v1.6.1「会拍照的她」** ⭐ **真实发图链路**（用户说"自拍/发张照片/想看你"——程序侧识别意图、AI 规划器决策、image provider 真的生图、转码 1024×1024 webp、iLink 上传发送，不是文字假装拍；冷却 10min / 每日 3 张 / 敏感词拦截 / Provider 缺失自然兜底）· **视觉人设规划器**（每个 companion 一份 identity spec：外貌/气质/风格，所有照片按 spec 生成，避免次次换脸；可上传参考图，provider 支持 image-to-image 时优先用 ref）· **安全加固**（SSRF 防护 netguard.mjs · X-Forwarded-For 信任策略 · setup token · admin 鉴权 · companions IDOR 修复，详见 [安全](#安全)）
- **v1.6.x「拟人化深化」** ⭐ **3 个月模拟时间线**（一次性生成 35 个虚拟互动事件 + 关键事件入记忆 + 好感度演化曲线 5→30，从"刚认识"变"已经认识 3 个月"）· **11 维情绪**（原 7 维 + 耐心 / 兴奋 / 烦躁 / 感激；半小时定时重算；saturation 防刷）· **主动消息三驱动 motivation**（情绪 × 日程 × 时间 × 随机；重启持久化防重发；三道闸门防 race；段内 bigram+LCS dedup）· 人生记忆 prompt 12 → 19 类目（带名字 + 感官细节 + 世界观）· Playground 与 bot 情绪路径对齐
- **v1.5.x「长期陪伴维度」** 离线留言胶囊（HMAC 签名 .txt 永久托管）· 时光胶囊（解封时她写"现在的我"感想）· 沉默陪伴模式（赛博距离，呼吸光点）· 反向日记「我们之间」（每晚她记录你们的互动，可编辑/导出）· SINGLE_USER 单用户模式（自托管跳过登录）
- **v1.4.x** TTS 5 家（MiniMax/OpenAI/Azure/豆包/通义）+ ASR 7 实现（Gemini/OpenAI/Qwen/Groq/MiniMax/Azure/豆包）+ Vision 8 家（智谱/OpenAI/Qwen/豆包/Claude/Kimi/StepFun/MiniMax）；默认起步=暗恋；想念档 + 今天她想对你说；网页录音 + 朗读
- **v1.3.x** 液态玻璃 UI · 她的日记 · 纪念日主动祝福 · 全面去 Pro/Free 分级
- **v1.2.x** 联网搜索 · 主动告白 · Memory Reflection
- **v1.1.x** Persona Guard · 情绪状态机 · 主动消息 v2

---

## 贡献 & 路线图

- 找到 bug → [新 Issue](https://github.com/dimang01/xiyu-ai/issues/new)
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
