<div align="center">

# 溪语 AI · Xiyu AI

**把大模型当作"有完整人生背景的虚拟个体"来调度的开源 AI 陪伴框架**
*An open-source companion framework that treats the LLM as a virtual character with a full backstory.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A520-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![Status: Experimental](https://img.shields.io/badge/Status-Experimental-orange.svg)](#-known-limitations)
[![Providers](https://img.shields.io/badge/AI%20Providers-9%20chat%20%E2%80%A2%205%20image%20%E2%80%A2%205%20vision-blueviolet.svg)](#-multi-provider-ai-support)

[中文说明](#中文说明) · [English](#english) · [GitHub Issues](https://github.com/dimang01/xiyu-ai/issues)

</div>

---

## 中文说明

> 一份 `.env` 即可启动。后端 Node.js，前端纯静态 HTML，9 个文本模型 + 5 个图像模型 + 5 个图像识别 + 5 个 ASR + 4 个 Embedding，全部通过同一套 provider 抽象切换。微信接入可选。

### 目录

- [⚡ 一句话介绍](#-一句话介绍)
- [🎯 项目定位](#-项目定位)
- [✨ 核心特性](#-核心特性)
- [🚀 一键启动](#-一键启动)
- [📱 关于微信接入](#-关于微信接入)
- [🤖 多模型 Provider 支持](#-多模型-provider-支持)
- [🧩 架构概览](#-架构概览)
- [📂 目录结构](#-目录结构)
- [🎨 表情包与素材](#-表情包与素材)
- [🛡️ 安全提醒](#-安全提醒)
- [🌐 生产部署注意事项](#-生产部署注意事项)
- [🧪 已知限制](#-已知限制)
- [🤝 贡献 & 路线图](#-贡献--路线图)
- [📄 许可证](#-许可证)

---

### ⚡ 一句话介绍

「溪语 AI」**不是**一个聊天机器人，而是一个把大模型组织成"虚拟个体"的框架：

- 这个虚拟个体有**人生记忆**（童年 / 学校 / 家庭 / 朋友 / 小习惯 / 口头禅，46+ 条具体事件）
- 有**今日日程**（学生上学 / 上班族通勤，工作日 vs 周末），会在对话里自然带出来
- 有**关系阶段**（陌生人 → 朋友 → 暧昧 → 恋人 → 深爱，每阶段差异化口吻）
- 像真人**发微信**（≤15 字一条、多条连发、剥离 AI 味）

🎬 *"我刚下课，路上买了支抹茶冰淇淋。"*
🎬 *"emm 让我想想"  →  "我也不太懂"  →  "你呢"*

### 🎯 项目定位

> ⚠️ **这是研究 / 个人使用导向的开源代码，不是 turnkey 产品。**
> 在投入生产之前请阅读 [安全提醒](#-安全提醒) 与 [生产部署注意事项](#-生产部署注意事项)。

适合：
- 想研究 AI 角色一致性、长期记忆、主动消息节奏的开发者
- 想自托管一个 AI 陪伴 demo 做实验的爱好者
- 希望了解多 provider 抽象、prompt 工程模板的工程师

不适合：
- 想"装上就能直接对外卖"的产品方
- 期望开箱即用、零运维的用户

---

### ✨ 核心特性

| 维度 | 说明 |
|------|------|
| 🧠 **人设引擎** | 注册时一次性生成 46+ 条**具体**人生记忆（不是"喜欢音乐"，而是"小学三年级被狗追过一次"） |
| 📅 **日程系统** | 每天 00:30 cron 生成 8–12 段日程，区分工作日 / 周末，三段情绪段，调度失败自动自愈 |
| 💞 **5 阶段关系** | 陌生人 → 朋友 → 暧昧 → 恋人 → 深爱，每阶段称呼 / 撒娇 / 话题深度差异化 |
| 🔄 **主动消息** | 早安 / 晚安 / 日间随机 / 主动告白 / 约 2 天 1 张场景照；发送前 char 3-gram Jaccard 撞车检测 |
| 🧬 **长期记忆** | 语义 embedding 召回 + importance 评分 + 日 / 周 / 月归档 |
| 💬 **多 Provider** | chat / image / vision / ASR / embedding 五大能力各自独立可换，零代码改动 |
| 🎛️ **完整 Dashboard** | 好感度进度 / 关系阶段 / "她现在在做什么" / 时间轴 / 头像管理 / CP 卡片 |
| 📱 **微信对接** | 网页扫码即可绑定 — 后端运行时直接向腾讯 iLink 申请二维码，**无需预填 ILINK_* 环境变量**（需要你的微信号在腾讯 iLink/ClawBot 已准入） |

---

### 🚀 一键启动

> **30 秒概念图**：装依赖 → 跑起服务 → 浏览器注册 → 网页扫码绑定微信 → 开聊。
> **完全不需要**手动填 `ILINK_BOT_TOKEN`，**完全不需要**先去腾讯后台找什么 bot ID — 服务运行时会自动向 iLink 申请一个新二维码，跟下面截图里 [xiyuai.cc 那种](https://github.com/dimang01/xiyu-ai) 一样直接显示在你的网页上。

#### 🅰️ 路径 A — 本地裸跑（推荐入门，3 分钟）

```bash
git clone https://github.com/dimang01/xiyu-ai.git
cd xiyu-ai
npm install        # Node ≥ 20
npm run setup      # 交互式：选 chat provider、粘贴 API key、自动写 .env
npm start
# 打开 http://localhost:3000
```

#### 🅱️ 路径 B — Docker Compose（推荐生产 / 不想装 Node）

```bash
git clone https://github.com/dimang01/xiyu-ai.git
cd xiyu-ai
cp .env.example .env                # 编辑 .env：至少填 CHAT_PROVIDER + 对应 *_API_KEY
docker compose up -d
# 打开 http://localhost:3000
```

- SQLite 数据库走 `./data` volume，重启不丢
- `restart: unless-stopped` 已经写在 compose 里；不需要额外 systemd
- 自定义端口：`HOST_PORT=8080 docker compose up -d`
- 看日志：`docker compose logs -f xiyu-ai`

#### 🅲 路径 C — 完全手动

```dotenv
# 最小 .env（任选其一）
CHAT_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_deepseek_api_key_here
```

填好 `.env` 之后 `npm start` 即可。

---

#### 🎬 跑起来之后做什么（新手走查）

服务起来后，做这 4 步就完成全部接入：

```
  1. 浏览器开 http://localhost:3000
        ↓
  2. /app/auth.html → 邮箱注册（验证码会通过 Resend 发，可选）
        ↓
  3. /app/create.html → 4 步向导创建 AI 角色（取名、年龄、性格、背景故事）
        ↓
  4. /app/bind.html → 服务端实时向腾讯申请二维码，前端直接 <img> 显示
        ↓                                            ↑
     微信扫码 → 手机点"允许"           （这一步跟 xiyuai.cc 体验完全一致）
        ↓
  ✅ 后端 confirmed → 写入数据库 + 热注册到 polling pool → 自动跳 dashboard
```

**关键页面**：

| 路径 | 用途 |
|------|------|
| `/` | 落地页（缺 chat provider 时会弹引导条） |
| `/app/setup.html` | 首次配置引导（不写 .env，只指路） |
| `/app/auth.html` | 邮箱注册 / 登录 |
| `/app/create.html` | 创建 AI 角色（4 步向导） |
| `/app/bind.html` | **网页扫码绑定微信** |
| `/app/dashboard.html` | 用户控制台 |
| `/app/admin.html` | 管理员后台（密码在 `.admin-credentials`） |

---

### 📱 关于微信接入

#### 路径 1（默认推荐）— 网页扫码

跟着上面"新手走查"走到第 4 步即可。**不需要**：
- ❌ 不需要预先在 `.env` 里填 `ILINK_BOT_TOKEN` / `ILINK_BOT_ID`
- ❌ 不需要预先跑 `npm run ilink:login`
- ❌ 不需要在腾讯后台找什么 bot 配置

后端会在 `POST /api/wechat/bind-session` 时调 `ilink/bot/get_bot_qrcode?bot_type=3` 实时申请一个全新二维码，扫码成功后自动写入 `wechat_accounts` 表并 hot-register 到 polling pool。

> ⚠️ **关于 iLink 准入资格**：扫码后能否拿到 `bot_token`，取决于你的微信号**是否已在腾讯 iLink / ClawBot 后台获得开发者准入**。
>
> - **已准入**：直接走网页扫码即可，体验跟 xiyuai.cc 一样
> - **未准入**：扫码会显示"需要验证码"或类似失败状态。这种情况下，**服务依然完全可用** — AI 人设引擎、长期记忆、关系阶段、主动消息节奏都能在浏览器 dashboard 里调试，只是不会真的把消息发到微信
> - 申请准入的入口在腾讯 iLink ClawBot 控制台，超出本仓库职责

#### 路径 2（高阶/无浏览器）— 终端二维码登录

如果你跑在没图形界面的 VPS / 容器里，或者想脚本化把凭据持久化下来，可以用：

```bash
npm run ilink:login
```

终端会打印二维码，成功后写入 `./.weixin-credentials.json`（mode 0600，已在 `.gitignore`）。

**运行时凭据加载优先级**：

```
   env (ILINK_BOT_TOKEN + ILINK_BOT_ID)
              ↓ 若缺
       .weixin-credentials.json
              ↓ 若缺
       网页扫码绑定的 wechat_accounts 表
              ↓ 三者都没有
   ✅ 服务正常启动 / 微信功能 disabled
   /api/health → "wechat": { "configured": false }
```

脚本不会打印 `bot_token`，也不会输出完整响应。`npm run ilink:login -- --help` 仅显示用法、不联网。

---

### 🤖 多模型 Provider 支持

> 只改 `.env`，不改一行代码。

**文本对话（chat）**

| Provider ID | 厂商 | 默认模型 | 备注 |
|---|---|---|---|
| `deepseek` | DeepSeek | `deepseek-chat` | 性价比首选 |
| `openai` | OpenAI ChatGPT | `gpt-4o-mini` | |
| `anthropic` | Anthropic Claude | `claude-sonnet-4-6` | 走原生 messages API |
| `xai` | xAI Grok | `grok-2-latest` | |
| `zhipu` | 智谱 GLM | `glm-4-flash` | 国内免备案可用 |
| `doubao` | 字节豆包（火山方舟） | *(必填接入点 ID)* | `CHAT_MODEL=ep-xxx` |
| `qwen` | 阿里通义千问 | `qwen-plus` | DashScope OpenAI 兼容端点 |
| `kimi` | Moonshot Kimi | `moonshot-v1-8k` | 长上下文 |
| `wenxin` | 百度文心（千帆） | `ernie-4.0-8k` | |

**图像生成 · 图像识别 · ASR · Embedding**

| 能力 | 可选 provider |
|------|----------------|
| 🎨 image | `zhipu` (CogView-4) · `qwen` (Wanx) · `doubao` · `wenxin` · `openai` (gpt-image-1 / DALL·E) |
| 👁️ vision | `zhipu` (GLM-4V) · `openai` (gpt-4o-mini) · `qwen` (qwen-vl-plus) · `doubao` · `anthropic` |
| 🎙️ ASR | `gemini` · `openai` (Whisper) · `qwen` (paraformer-v2) · `xunfei` *(stub)* · `tencent` *(stub)* |
| 🧮 embedding | `gemini` · `openai` (text-embedding-3-small) · `zhipu` (embedding-3) · `qwen` (text-embedding-v3) |

**切换示例**：

```dotenv
CHAT_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_anthropic_api_key_here
CHAT_MODEL=claude-sonnet-4-6
```

---

### 🧩 架构概览

```
                ┌────────────────────────────────────────────────┐
                │        浏览器 Dashboard       /     微信用户        │
                └───────────────────┬────────────────────────────┘
                                    │
                                    ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Express (index.mjs)                                         │
   │  ┌─────────────┬──────────────┬───────────────────────────┐  │
   │  │  api.mjs    │  auth.mjs    │  iLink 多租户轮询池        │  │
   │  └─────────────┴──────────────┴───────────────────────────┘  │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │  bot.mjs  消息主管线                                     │  │
   │  │       │                                                │  │
   │  │       ▼                                                │  │
   │  │  ai.mjs ──→ providers/ ──→ DeepSeek / 智谱 / 千问 / …  │  │
   │  │       │                                                │  │
   │  │       ▼                                                │  │
   │  │  memory.mjs  ·  companion.mjs  ·  proactive.mjs        │  │
   │  └────────────────────────────────────────────────────────┘  │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │  db.mjs (better-sqlite3, WAL)                          │  │
   │  └────────────────────────────────────────────────────────┘  │
   └──────────────────────────────────────────────────────────────┘
```

**关键设计**：
- **provider facade**：业务层只看到 `chatComplete()` / `generateImage()` 等通用方法，底下哪家厂商对它透明
- **system prompt 18 节合成**：人设 / 元认知 / 关系阶段 / 今日日程 / 最近上下文 / 长期摘要 / 反 AI 味规则
- **proactive 防复读**：发送前用字符 3-gram Jaccard 检测最近 5 条 assistant 内容，相似度 ≥ 0.6 升温重生，仍撞车则放弃
- **日程自愈**：如果 00:30 cron 失败，proactive tick 检测到缺日程时按需补一次（30 分钟级 debounce）

---

### 📂 目录结构

```
.
├── index.mjs                Express 入口 + iLink 多租户轮询池
├── src/
│   ├── ai.mjs               业务层 AI facade（不依赖任何厂商 SDK 直接调用）
│   ├── providers/
│   │   ├── chat.mjs         9 个 chat provider
│   │   ├── image.mjs        5 个图像 provider
│   │   ├── vision.mjs       5 个 vision provider
│   │   ├── asr.mjs          5 个 ASR provider
│   │   └── embedding.mjs    4 个 embedding provider
│   ├── api.mjs              REST 路由（含 /api/health）
│   ├── bot.mjs              微信消息主处理管线
│   ├── companion.mjs        18 节 system prompt 合成
│   ├── memory.mjs           情绪 / 好感度 / 记忆提取
│   ├── proactive.mjs        主动消息（含撞车检测）+ 场景照片
│   ├── plan_tasks.mjs       定时任务（日 / 周 / 月总结、日程、自愈）
│   ├── ilink.mjs            iLink 协议封装
│   └── db.mjs               SQLite + 迁移
├── scripts/
│   ├── setup.sh                 一键启动
│   ├── ilink_login.mjs          终端二维码登录
│   ├── check-ilink-status.mjs   iLink 状态自检
│   └── backup-db.sh             SQLite 备份脚本
├── public/                  前端静态文件（落地页 + dashboard + admin）
├── assets/stickers/         表情包加载机制（不分发图片本体）
└── data/                    运行时数据（gitignored）
```

---

### 🎨 表情包与素材

仓库 **只包含表情包的加载与 tag 匹配机制**，**不分发任何真实表情包图片**：

- ChineseBQB 及其它第三方表情包归原作者所有；本仓库不打包、不再分发
- 若要启用表情包，请自行准备**有合法授权**的素材放进 `assets/stickers/` 并提供 `manifest.json`
- 缺失 manifest 时表情包功能自动禁用，应用仍正常启动

**关于 AI 图像后处理**：CogView / Wanx 等生成图会走一个 `image post-processing pipeline`（裁剪、转 webp、压缩）以适配前端展示。这是常规的图像后处理，不要把它理解或宣传为"绕过版权"。

---

### 🛡️ 安全提醒

- `.env` / `.admin-credentials` / `.weixin-credentials.json` / `data/bot.db*` / `data/user_memories/` 都已在 `.gitignore`，**永远不要 commit**
- 管理员密码首次启动自动生成 20 位随机字符串，写入 `.admin-credentials`（mode 0600）—— 妥善保管
- `/api/health` 输出当前 provider + 微信是否 configured，但**不**输出 token / botId / 用户数据
- 仓库里所有看起来像 `sk-xxx` / `your_xxx_api_key_here` 的字符都是占位符
- 涉及未成年人或心理高风险用户场景请额外谨慎，见 [Issue #3 safety tracker](https://github.com/dimang01/xiyu-ai/issues/3)

---

### 🌐 生产部署注意事项

如果不只是本地试玩：

| 项 | 建议 |
|---|---|
| 反向代理 | nginx / Caddy 终结 TLS；Node 进程只监听 `127.0.0.1` |
| 数据库 | WAL 已开；定期备份 `data/bot.db*`（参考 `scripts/backup-db.sh`） |
| `AUTH_SECRET` | 显式设置；留空会每次重启重生 token 强制登出 |
| 限速 | `src/ratelimit.mjs` 默认面向个人，对外服务请放大或前置 WAF |
| 成本监控 | chat / image provider 都有费用；`ai_usage_daily` 表是接监控的天然入口 |
| 内容标识 | 按当地法规对 AI 生成内容做标注 |

**模板**：仓库里 `deploy/` 目录提供了开箱即用的部署模板：

| 文件 | 用途 |
|---|---|
| [`deploy/xiyu-ai.service`](./deploy/xiyu-ai.service) | systemd unit；服务自启动 + 崩溃自动重启 + 安全加固 |
| [`deploy/nginx.conf.example`](./deploy/nginx.conf.example) | nginx 反代示例：80 → 443 跳转、HSTS、长轮询超时 |
| [`deploy/README.md`](./deploy/README.md) | 一份从 0 → 上线的 step-by-step（裸跑路径） |

如果走 Docker，`compose.yml` 自带 `restart: unless-stopped`，systemd 那份就不必要了；nginx 模板继续适用。

更完整的部署 walkthrough（备份策略 / 监控接入 / 日志切割）跟踪 [Issue #5](https://github.com/dimang01/xiyu-ai/issues/5)。

---

### 🧪 已知限制

| 限制 | 跟踪 |
|---|---|
| TTS 语音回复未实现（`voice_reply_enabled` 是占位） | [#4](https://github.com/dimang01/xiyu-ai/issues/4) |
| 讯飞 / 腾讯云 ASR provider 仅占位 | — |
| 消息去重目前是进程内 Set，重启可能短暂重复 | [#1](https://github.com/dimang01/xiyu-ai/issues/1) |
| SQLite 备份 / 恢复脚本不完整 | [#2](https://github.com/dimang01/xiyu-ai/issues/2) |
| 缺少危机 / 未成年人安全审核层 | [#3](https://github.com/dimang01/xiyu-ai/issues/3) |
| 生产部署指南未完善 | [#5](https://github.com/dimang01/xiyu-ai/issues/5) |
| 微信对接依赖腾讯 iLink / ClawBot 准入 | — |

---

### 🤝 贡献 & 路线图

- 🐛 找到 bug → 提 [Issue](https://github.com/dimang01/xiyu-ai/issues/new)
- 💡 路线图 → 见 [Issues](https://github.com/dimang01/xiyu-ai/issues)（带 `enhancement` / `help wanted` 标签的最适合上手）
- 🛠️ 想直接贡献代码：fork → PR；保持改动小而聚焦，附带说明动机
- 致谢见 [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md)

---

### 📄 许可证

[MIT](./LICENSE) © 2026 溪语 AI Contributors

---

## English

> One `.env` to run. Node.js backend, plain-HTML frontend, 9 chat models + 5 image + 5 vision + 5 ASR + 4 embedding — all swappable through a single provider abstraction. WeChat integration is optional.

### Table of Contents

- [⚡ TL;DR](#-tldr)
- [🎯 Project Scope](#-project-scope)
- [✨ Features](#-features)
- [🚀 Quick Start](#-quick-start)
- [📱 About WeChat Integration](#-about-wechat-integration)
- [🤖 Multi-provider AI Support](#-multi-provider-ai-support)
- [🧩 Architecture](#-architecture)
- [📂 Repository Structure](#-repository-structure)
- [🎨 Stickers and Assets](#-stickers-and-assets)
- [🛡️ Security Notice](#-security-notice)
- [🌐 Production Notes](#-production-notes)
- [🧪 Known Limitations](#-known-limitations)
- [🤝 Contributing & Roadmap](#-contributing--roadmap)
- [📄 License](#-license)

---

### ⚡ TL;DR

**Xiyu AI is not a chatbot**. It is a framework that organizes an LLM into a *virtual person*:

- A character with **life memories** (childhood / school / family / habits / catchphrases — 46+ concrete items)
- A real **daily schedule** (student vs. office-worker; weekday vs. weekend) that surfaces naturally in chat
- A **5-stage relationship arc** (stranger → friend → flirting → lover → deep love), each with its own form of address
- Real-person **texting cadence** (≤15 chars per message, multi-burst sending, anti-AI-tone post-processing)

🎬 *"I just got out of class — picked up a matcha ice cream on the way."*
🎬 *"emm let me think"  →  "I don't really know"  →  "you?"*

### 🎯 Project Scope

> ⚠️ **This is research / hobbyist open-source code — not a turnkey product.**
> Read [Security Notice](#-security-notice) and [Production Notes](#-production-notes) before deploying anywhere serious.

**A good fit for**:
- Developers exploring character consistency, long-term memory and proactive-messaging rhythm
- Hobbyists who want to self-host an AI companion demo
- Engineers studying multi-provider abstraction and prompt-engineering templates

**Not a good fit for**:
- Teams looking for an out-of-the-box commercial product
- Users who expect zero ops

---

### ✨ Features

| Area | Description |
|------|-------------|
| 🧠 **Persona engine** | 46+ **specific** life memories generated once at registration (not "likes music", but "got chased by a dog in third grade") |
| 📅 **Schedule system** | 8–12 timed activities generated every day at 00:30, weekday/weekend aware, three mood segments, self-healing on failure |
| 💞 **5-stage relationship** | Stranger → friend → flirting → lover → deep love, with distinct forms of address and conversational depth |
| 🔄 **Proactive messaging** | Morning / evening greetings, random daytime check-ins, spontaneous confessions, a scene photo roughly every two days; collision-detected before sending |
| 🧬 **Long-term memory** | Semantic embedding recall + importance scoring + daily/weekly/monthly summaries |
| 💬 **Multi-provider** | chat / image / vision / ASR / embedding — each capability independently swappable, no code changes |
| 🎛️ **Full dashboard** | Affection progress, relationship stage, "what she's doing right now", timeline, avatar manager, shareable CP-card |
| 📱 **WeChat integration** | In-browser QR binding — backend requests the QR from iLink at runtime; **no `ILINK_*` env vars to pre-configure** (requires Tencent iLink/ClawBot approval on your WeChat account) |

---

### 🚀 Quick Start

> **30-second mental model**: install → run → register in browser → scan a QR to connect WeChat → start chatting.
> You do **not** have to put `ILINK_BOT_TOKEN` in `.env`. You do **not** have to dig through any vendor console for a bot ID. The server requests a fresh QR from iLink at runtime and shows it on your dashboard, exactly like a hosted demo would.

#### 🅰️ Path A — Local (recommended for first try, 3 min)

```bash
git clone https://github.com/dimang01/xiyu-ai.git
cd xiyu-ai
npm install        # Node ≥ 20
npm run setup      # Interactive: pick provider, paste API key, .env written for you
npm start
# Open http://localhost:3000
```

#### 🅱️ Path B — Docker Compose (recommended for self-hosting)

```bash
git clone https://github.com/dimang01/xiyu-ai.git
cd xiyu-ai
cp .env.example .env                # edit .env: set CHAT_PROVIDER + matching *_API_KEY
docker compose up -d
# Open http://localhost:3000
```

- SQLite database lives in the `./data` volume — survives restarts.
- `restart: unless-stopped` is already set in compose; no systemd needed.
- Custom port: `HOST_PORT=8080 docker compose up -d`
- Logs: `docker compose logs -f xiyu-ai`

#### 🅲 Path C — Fully manual

```dotenv
# Minimal .env (pick one)
CHAT_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_deepseek_api_key_here
```

Then `npm start`.

---

#### 🎬 What to do after it starts (new-user walkthrough)

Once the server is up, four browser steps and you are done:

```
  1. Open http://localhost:3000
        ↓
  2. /app/auth.html → email signup (verification code via Resend, optional)
        ↓
  3. /app/create.html → 4-step character wizard (name, age, personality, backstory)
        ↓
  4. /app/bind.html → server live-requests a QR from iLink and renders it in <img>
        ↓                                                          ↑
     scan with WeChat → tap "Allow" on phone           (same UX as a hosted demo)
        ↓
  ✅ Server confirms → DB write + hot-register to polling pool → auto-redirect to dashboard
```

**Key pages**:

| Path | Purpose |
|------|---------|
| `/` | Landing page (shows a setup banner if no chat provider is configured) |
| `/app/setup.html` | First-run guide (does NOT write .env from browser — only points you at the CLI) |
| `/app/auth.html` | Email signup / login |
| `/app/create.html` | 4-step character wizard |
| `/app/bind.html` | **In-browser WeChat QR binding** |
| `/app/dashboard.html` | User dashboard |
| `/app/admin.html` | Admin panel (password in `.admin-credentials`) |

---

### 📱 About WeChat Integration

#### Path 1 (default, recommended) — In-browser QR

Just follow step 4 of the walkthrough above. You do **not** need any of:
- ❌ Pre-set `ILINK_BOT_TOKEN` / `ILINK_BOT_ID` in `.env`
- ❌ Running `npm run ilink:login` ahead of time
- ❌ Any pre-configured bot ID in a vendor console

When the user clicks "Bind WeChat", the backend hits `ilink/bot/get_bot_qrcode?bot_type=3` to request a fresh QR; on `confirmed`, the credentials are written to the `wechat_accounts` table and the new bot is hot-registered into the polling pool.

> ⚠️ **About iLink access**: whether the scan actually yields a `bot_token` depends on **whether your WeChat account has been approved for Tencent iLink / ClawBot developer access**.
>
> - **Approved**: web QR binding works end-to-end, same UX as a hosted demo.
> - **Not approved**: the scan will return a verify-code or failure state. In that case, **the service is still fully usable** — you can develop, debug and exercise the persona engine, long-term memory, relationship stages and proactive-messaging cadence entirely through the browser dashboard; messages just won't reach WeChat.
> - Applying for access happens inside the Tencent iLink / ClawBot console, which is out of scope for this repo.

#### Path 2 (advanced / headless) — Terminal QR login

If you're on a VPS without a browser, or want to persist credentials to a file before bringing the server up, you can use:

```bash
npm run ilink:login
```

A QR is printed in the terminal; on success, credentials are written to `./.weixin-credentials.json` (mode 0600, gitignored).

**Credential load priority at runtime**:

```
   env (ILINK_BOT_TOKEN + ILINK_BOT_ID)
              ↓ missing
       .weixin-credentials.json
              ↓ missing
       wechat_accounts table (populated by in-browser QR)
              ↓ all three missing
   ✅ Service still starts / WeChat disabled
   /api/health → "wechat": { "configured": false }
```

The helper never prints `bot_token` or the raw response. `npm run ilink:login -- --help` prints usage without touching the network.

---

### 🤖 Multi-provider AI Support

> Edit `.env`, no code changes.

**Chat**

| Provider ID | Vendor | Default model | Notes |
|---|---|---|---|
| `deepseek` | DeepSeek | `deepseek-chat` | Best price/quality for hobby use |
| `openai` | OpenAI ChatGPT | `gpt-4o-mini` | |
| `anthropic` | Anthropic Claude | `claude-sonnet-4-6` | Native messages API |
| `xai` | xAI Grok | `grok-2-latest` | |
| `zhipu` | Zhipu GLM | `glm-4-flash` | Mainland China friendly |
| `doubao` | ByteDance Doubao (Ark) | *(endpoint ID required)* | `CHAT_MODEL=ep-xxx` |
| `qwen` | Alibaba Qwen | `qwen-plus` | DashScope OpenAI-compatible |
| `kimi` | Moonshot Kimi | `moonshot-v1-8k` | Long context |
| `wenxin` | Baidu Wenxin (Qianfan) | `ernie-4.0-8k` | |

**Image · Vision · ASR · Embedding**

| Capability | Providers |
|------------|-----------|
| 🎨 image | `zhipu` (CogView-4) · `qwen` (Wanx) · `doubao` · `wenxin` · `openai` (gpt-image-1 / DALL·E) |
| 👁️ vision | `zhipu` (GLM-4V) · `openai` (gpt-4o-mini) · `qwen` (qwen-vl-plus) · `doubao` · `anthropic` |
| 🎙️ ASR | `gemini` · `openai` (Whisper) · `qwen` (paraformer-v2) · `xunfei` *(stub)* · `tencent` *(stub)* |
| 🧮 embedding | `gemini` · `openai` (text-embedding-3-small) · `zhipu` (embedding-3) · `qwen` (text-embedding-v3) |

**Switching example**:

```dotenv
CHAT_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_anthropic_api_key_here
CHAT_MODEL=claude-sonnet-4-6
```

---

### 🧩 Architecture

```
                ┌────────────────────────────────────────────────┐
                │     Web Dashboard          /      WeChat user   │
                └───────────────────┬────────────────────────────┘
                                    │
                                    ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Express (index.mjs)                                         │
   │  ┌─────────────┬──────────────┬───────────────────────────┐  │
   │  │  api.mjs    │  auth.mjs    │  iLink polling pool       │  │
   │  └─────────────┴──────────────┴───────────────────────────┘  │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │  bot.mjs  (message pipeline)                           │  │
   │  │       │                                                │  │
   │  │       ▼                                                │  │
   │  │  ai.mjs ──→ providers/ ──→ DeepSeek / Zhipu / Qwen…    │  │
   │  │       │                                                │  │
   │  │       ▼                                                │  │
   │  │  memory.mjs  ·  companion.mjs  ·  proactive.mjs        │  │
   │  └────────────────────────────────────────────────────────┘  │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │  db.mjs (better-sqlite3, WAL)                          │  │
   │  └────────────────────────────────────────────────────────┘  │
   └──────────────────────────────────────────────────────────────┘
```

**Design highlights**:
- **Provider façade**: business code only sees `chatComplete()` / `generateImage()`. Which vendor runs underneath is opaque to it.
- **18-section system-prompt composer**: persona, meta-cognition, relationship stage, today's schedule, recent context, long-term digest, anti-AI-tone rules — all composed dynamically per call.
- **Anti-repeat for proactive messages**: before sending, a char 3-gram Jaccard check against the last 5 assistant turns triggers a temperature-bumped regeneration; if it still collides the message is dropped to avoid spam.
- **Self-healing schedules**: if the 00:30 cron failed, the proactive ticker regenerates the day on demand (30-minute debounce).

---

### 📂 Repository Structure

```
.
├── index.mjs                Express entry + iLink multi-tenant polling pool
├── src/
│   ├── ai.mjs               Business-layer AI façade (no direct vendor SDK use)
│   ├── providers/           Per-capability provider adapters
│   ├── api.mjs              REST routes (including /api/health)
│   ├── bot.mjs              WeChat message pipeline
│   ├── companion.mjs        System-prompt composer (18 sections)
│   ├── memory.mjs           Mood / affection / memory extraction
│   ├── proactive.mjs        Proactive messaging with collision detection + scene photos
│   ├── plan_tasks.mjs       Cron jobs (daily/weekly/monthly summaries, schedule generation, self-heal)
│   ├── ilink.mjs            iLink protocol wrapper
│   └── db.mjs               SQLite + migrations
├── scripts/
│   ├── setup.sh                 One-shot bootstrap
│   ├── ilink_login.mjs          Terminal QR login helper
│   ├── check-ilink-status.mjs   iLink health probe
│   └── backup-db.sh             SQLite backup
├── public/                  Static frontend (landing, dashboard, admin)
├── assets/stickers/         Sticker loading mechanism (no image bundled)
└── data/                    Runtime data (gitignored)
```

---

### 🎨 Stickers and Assets

The repository ships **only the sticker loading and tag-matching code** — **no actual sticker images are bundled or redistributed**.

- ChineseBQB and other third-party packs belong to their original authors.
- To enable stickers, drop your own **licensed** assets into `assets/stickers/` and provide a `manifest.json`.
- When the manifest is missing, the sticker feature is silently disabled — the app still starts normally.

**On AI image post-processing**: generated images (CogView / Wanx / etc.) go through an `image post-processing pipeline` (crop, webp, compress) for frontend display. This is ordinary post-processing — please don't frame it as "watermark bypass."

---

### 🛡️ Security Notice

- `.env`, `.admin-credentials`, `.weixin-credentials.json`, `data/bot.db*`, `data/user_memories/` are all gitignored — **never commit them**.
- The admin password is a 20-char random string generated on first start; it lives in `.admin-credentials` with mode 0600.
- `/api/health` reports the active providers and a boolean WeChat configured flag. It does **not** expose tokens, bot IDs or user data.
- Anything that looks like `sk-xxx` or `your_xxx_api_key_here` is a placeholder.
- Be especially careful with minor-safety and crisis scenarios; see the safety tracker in [Issue #3](https://github.com/dimang01/xiyu-ai/issues/3).

---

### 🌐 Production Notes

If you plan to run this for more than local experiments:

| Concern | Recommendation |
|---|---|
| Reverse proxy | nginx / Caddy for TLS termination; bind Node to `127.0.0.1` |
| Database | WAL is already on; back up `data/bot.db*` regularly (`scripts/backup-db.sh` is a starting point) |
| `AUTH_SECRET` | Set explicitly; leaving it empty regenerates the secret on every restart and forces logouts |
| Rate limiting | Defaults in `src/ratelimit.mjs` are sized for personal use; widen or place a WAF in front for public deployments |
| Cost monitoring | Chat / image providers cost money; the `ai_usage_daily` table is the natural place to wire metrics |
| Content labeling | Label AI-generated content per local laws and platform policy |

**Templates**: the `deploy/` directory ships drop-in deployment templates:

| File | Purpose |
|---|---|
| [`deploy/xiyu-ai.service`](./deploy/xiyu-ai.service) | systemd unit — auto-start, auto-restart, hardening |
| [`deploy/nginx.conf.example`](./deploy/nginx.conf.example) | nginx reverse proxy: HTTPS, HSTS, long-poll timeouts |
| [`deploy/README.md`](./deploy/README.md) | Step-by-step from 0 → live VPS (bare-metal path) |

For the Docker path, `compose.yml` already sets `restart: unless-stopped`, so the systemd unit is unnecessary; the nginx template is still useful for TLS termination on the host.

A fuller deployment walkthrough (backups, monitoring, log rotation) is tracked in [Issue #5](https://github.com/dimang01/xiyu-ai/issues/5).

---

### 🧪 Known Limitations

| Limitation | Tracker |
|---|---|
| TTS voice reply not implemented (`voice_reply_enabled` is a stub) | [#4](https://github.com/dimang01/xiyu-ai/issues/4) |
| Xunfei / Tencent Cloud ASR providers are stubs | — |
| Message deduplication is currently in-process and may briefly repeat after a restart | [#1](https://github.com/dimang01/xiyu-ai/issues/1) |
| Automated SQLite backup/recovery script incomplete | [#2](https://github.com/dimang01/xiyu-ai/issues/2) |
| No dedicated crisis / minor-safety moderation layer | [#3](https://github.com/dimang01/xiyu-ai/issues/3) |
| Production deployment guide is in progress | [#5](https://github.com/dimang01/xiyu-ai/issues/5) |
| WeChat integration requires Tencent iLink / ClawBot approval | — |

---

### 🤝 Contributing & Roadmap

- 🐛 Found a bug → open an [Issue](https://github.com/dimang01/xiyu-ai/issues/new)
- 💡 Roadmap → browse [Issues](https://github.com/dimang01/xiyu-ai/issues); the `good first issue` and `help wanted` labels are the easiest to pick up
- 🛠️ Want to contribute code → fork → PR; keep diffs small and focused, include a short rationale
- Credits in [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md)

---

### 📄 License

[MIT](./LICENSE) © 2026 Xiyu AI Contributors
