<div align="center">

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
| **默认起点 = 暧昧** | affection 35/100、stage 暧昧。她从一开始就喜欢你，不是从零培养 |
| **具体人生记忆** | 注册时一次性生成 46+ 条人生事件（"小学三年级被狗追过一次"），不是抽象标签 |
| **18 节人设 prompt** | 元认知 / 关系阶段 / 今日日程 / 最近上下文 / 长期摘要 / 反 AI 味规则一次拼好 |
| **5 阶段关系** | 暧昧 → 恋人 → 深爱（可回退朋友/陌生人）。每阶段称呼、撒娇、话题深度差异化 |
| **真人发微信** | ≤15 字一条、多条 \|\| 连发、剥离 AI 味；Persona Guard 回复后一致性校验 |
| **真实发图 (v1.6.1)** ⭐ | 用户说"发个自拍""让我看看你"——程序侧识别意图、AI 规划器决策、真的发生成的照片到微信，不是文字编"我现在在拍"。每日上限、冷却、敏感词拦截、Provider 缺失自动兜底"刚拍糊了" |
| **稳定的"她长什么样"(v1.6.1)** ⭐ | 每个 companion 生成一份 visual identity（发色/发型/穿搭/气质 → 永久 spec），每次发图都按这份 spec 生成，避免每次发图都换脸。可上传参考图；provider 支持 image-to-image 时优先用 ref 图 |
| **主动场景照** | 白天 36h 候选窗口 + AI 规划器决策，像"刚坐下来想给你看"那样低频自然发图，附自然配文 |
| **主动消息（三驱动 v1.6）** | 早安/晚安/日间/纪念日/告白；motivation = 情绪 × 日程 × 时间 × 随机；段内 + 历史双重 dedup；重启持久化防重发 |
| **想念档 0-4** | 综合 dependency + idle 算"她想你的程度"，30m/3h/6h/12h/24h 五档，回复口吻自然带出来 |
| **3 个月模拟时间线 (v1.6)** ⭐ | dashboard 按钮触发，LLM 一次性生成 35 个虚拟互动事件 + 关键事件入记忆 + 好感度演化 5→30；用户首次打开聊天她已经"认识 3 个月" |
| **今天她想对你说** | 每天 02:35 cron 生成独立于聊天的一句话，dashboard 气泡卡 + 🔊 朗读 |
| **她的日记** | 每晚第一人称日记 + 每周合并；翻日记本式阅读页，按句切段连续朗读 |
| **Memory v2** | 7 层分类 × 权重 × 遗忘曲线；pin/lock/archive/do-not-mention；语义召回 + 关键词 fallback |
| **情绪状态机 (v1.6 升级 11 维)** | affection / trust / dependency / possessiveness / security / energy / mood + **patience（耐心）/ excitement（兴奋短期）/ annoyance（烦躁短期）/ gratitude（感激）**；每条消息增量演化 + 半小时定时重算 + saturation 防刷（连发"谢谢"涨幅衰减） |
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

### Image（5 家）

`zhipu` CogView-4 · `qwen` Wanx · `doubao` · `wenxin` · `openai` gpt-image-1 / DALL·E

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
| 收用户语音 → ASR | ✅（playground 也支持） |
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

### 自检 / 诊断

```bash
npm run doctor          # Node/SQLite/key/iLink/端口/服务健康，一键诊断
npm run check:p0        # P0/P1 回归 124 项
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
│   ├── bot.mjs              微信消息处理
│   ├── playground.mjs       浏览器聊天
│   ├── companion.mjs        18 节 system prompt 合成
│   ├── memory_v2.mjs        7 层记忆 + 语义召回 + 遗忘曲线
│   ├── emotion_state.mjs    7 维情绪状态机（v1.4.1 升级）
│   ├── proactive.mjs        主动消息 + 场景照调度
│   ├── photo_intent.mjs     用户照片请求意图识别（v1.6.1）
│   ├── photo_planner.mjs    照片 AI 决策器 + 安全清洗（v1.6.1）
│   ├── photo_sender.mjs     生图 → 转码 → 上传 → 发送 helper（v1.6.1）
│   ├── visual_identity.mjs  稳定视觉人设 + 参考图管理（v1.6.1）
│   ├── security/netguard.mjs SSRF 防护下载（v1.6.1）
│   ├── persona_guard.mjs    回复后一致性校验
│   ├── reflection.mjs       每日/每周 AI 反思
│   ├── diary.mjs            日记生成
│   ├── thoughts.mjs         今天她想对你说
│   ├── voice_pipeline.mjs   mp3 → SILK 转码
│   ├── plan_tasks.mjs       cron 调度（日 / 周 / 月）
│   ├── ilink.mjs            iLink 协议封装
│   └── db.mjs               SQLite + 全部 migrateXxx() 注册点
├── public/app/              15 个前端页面（dashboard 1800+ 行，含 ⚙ 模型抽屉）
├── deploy/                  systemd + nginx 模板
├── scripts/                 16 个：setup / doctor / check:p0 / backup / smoke / ...
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
