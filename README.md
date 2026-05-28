<div align="center">

# 溪语 AI · Xiyu AI

**把大模型当作"有完整人生背景的虚拟个体"来调度的开源 AI 陪伴框架**
*An open-source companion framework that treats the LLM as a virtual character with a full backstory.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A520-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![Status: Experimental](https://img.shields.io/badge/Status-Experimental-orange.svg)](#-known-limitations)
[![Providers](https://img.shields.io/badge/AI%20Providers-9%20chat%20%E2%80%A2%205%20image%20%E2%80%A2%205%20vision-blueviolet.svg)](#-multi-provider-ai-support)
[![Docker](https://img.shields.io/badge/Docker-GHCR-2496ED.svg?logo=docker&logoColor=white)](https://github.com/dimang01/xiyu-ai/pkgs/container/xiyu-ai)

[中文说明](#中文说明) · [English](#english) · [GitHub Issues](https://github.com/dimang01/xiyu-ai/issues)

</div>

---

## 中文说明

> 一份 `.env` 即可启动。后端 Node.js，前端纯静态 HTML，9 个文本模型 + 5 个图像模型 + 5 个图像识别 + 5 个 ASR + 4 个 Embedding，全部通过同一套 provider 抽象切换。**网页里就能扫码绑微信、就能和 AI 真聊**，不需要 iLink 准入也能完整体验。

### 目录

- [⚡ 一句话介绍](#-一句话介绍)
- [🎯 项目定位](#-项目定位)
- [✨ 核心特性](#-核心特性)
- [🚀 一键启动](#-一键启动)
- [🎬 跑起来之后做什么](#-跑起来之后做什么新手走查)
- [📱 关于微信接入](#-关于微信接入)
- [🤖 多模型 Provider 支持](#-多模型-provider-支持)
- [🧩 架构概览](#-架构概览)
- [📂 目录结构](#-目录结构)
- [🎨 表情包与素材](#-表情包与素材)
- [🛡️ 安全提醒](#-安全提醒)
- [⚖️ 合规说明](#-合规说明)
- [🌐 生产部署注意事项](#-生产部署注意事项)
- [🧪 已知限制](#-已知限制)
- [🤝 贡献 & 路线图](#-贡献--路线图)
- [📬 联系方式](#-联系方式)
- [📄 许可证](#-许可证)

---

### ⚡ 一句话介绍

「溪语 AI」**不是**一个聊天机器人，而是一个把大模型组织成"虚拟个体"的框架：

- 这个虚拟个体有**人生记忆**（童年 / 学校 / 家庭 / 朋友 / 小习惯 / 口头禅，46+ 条具体事件）
- 有**今日日程**（学生上学 / 上班族通勤，工作日 vs 周末），会在对话里自然带出来
- 有**关系阶段**（陌生人 → 朋友 → 暧昧 → 恋人 → 深爱 5 阶段演进，每阶段差异化口吻）
- 像真人**发微信**（≤15 字一条、多条连发、剥离 AI 味）

🎬 *"我刚下课，路上买了支抹茶冰淇淋。"*
🎬 *"emm 让我想想"  →  "我也不太懂"  →  "你呢"*

### 🎯 项目定位

> ⚠️ **这是研究 / 个人使用导向的开源代码，不是 turnkey 产品。**
> 在投入生产之前请阅读 [安全提醒](#-安全提醒)、[合规说明](#-合规说明) 与 [生产部署注意事项](#-生产部署注意事项)。

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
| 🔄 **主动消息 v2** | 早安 / 晚安 / 日间随机 / 主动告白 / 场景照；基于 motivation score 动态触发；支持 quiet/normal/clingy 强度；防骚扰冷却 |
| 🧬 **记忆 v2** | 7 层分类 × 0–5 权重 × 遗忘曲线；pin / lock / archive / do-not-mention；敏感内容过滤；去重 |
| 🛡️ **Persona Guard** | 回复后一致性校验 — 自动检测"我是 AI"、客服话术、阶段违规；轻问题后处理，重问题重生成 |
| 🎭 **情绪状态机** | 7 维度：affection / trust / dependency / possessiveness / security / energy / mood；规则驱动实时更新 |
| 💬 **多 Provider** | chat / image / vision / ASR / embedding 五大能力各自独立可换，零代码改动 |
| 🎛️ **完整 Dashboard** | 好感度进度 / 关系阶段 / "她现在在做什么" / 时间轴 / 头像管理 / CP 卡片 / **记忆管理入口** |
| 🗂️ **记忆管理面板** | `/app/memories.html` — 可视化查看、筛选、新增、编辑、置顶、锁定、归档、删除所有记忆 |
| 🧪 **网页 Playground** | 不接微信也能在浏览器里跟 AI 真聊 — 跑的是和微信入站完全相同的人设 / 记忆 / 情绪管线 |
| 📱 **微信对接** | 网页扫码即可绑定 — 后端运行时直接向腾讯 iLink 申请二维码，**无需预填 ILINK_\* 环境变量**（需要你的微信号在腾讯 iLink/ClawBot 已准入） |
| 📬 **邮件 dev 模式** | 未配 Resend 时验证码自动打到服务日志 — 首次注册无需任何邮件服务 |
| 🩺 **npm run doctor** | 一键诊断自托管环境：Node 版本 / SQLite 可写 / API key / iLink / 端口 / 服务健康 |

---

### 🚀 一键启动

> **30 秒概念图**：装依赖 → 跑起服务 → 浏览器注册 → 立即聊天（playground 或扫码绑微信）。
>
> **完全不需要**：邮件服务（dev 模式自动）、`ILINK_BOT_TOKEN`、腾讯后台找 bot ID、手工编辑 `.env` 之外的任何文件。

#### 🅰️ 路径 A — 本地裸跑（推荐入门，3 分钟）

```bash
git clone https://github.com/dimang01/xiyu-ai.git
cd xiyu-ai
npm install        # Node ≥ 20
npm run setup      # 交互式：选 chat provider、粘贴 API key、自动写 .env
npm start
# 打开 http://localhost:3000
```

`npm run setup` 会在启动前做原生模块预检（better-sqlite3 编译环境检测），缺东西时给出针对你 OS 的具体修复命令而不是让 npm install 一坨红字。

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

#### 🅲 路径 C — 一行 `docker run`（试一下，不克隆代码）

```bash
docker run -d --name xiyu-ai \
  -p 3000:3000 \
  -e CHAT_PROVIDER=deepseek \
  -e DEEPSEEK_API_KEY=your_deepseek_api_key_here \
  -v xiyu-data:/app/data \
  ghcr.io/dimang01/xiyu-ai:latest
# 打开 http://localhost:3000
```

镜像由 GitHub Actions 在每次发版（v* tag）时自动构建并发布到 GHCR，支持 `linux/amd64` 和 `linux/arm64`。

---

### 🎬 跑起来之后做什么（新手走查）

服务起来后，做这几步就完成全部接入：

```
  1. 浏览器开 http://localhost:3000
        ↓
  2. /app/auth.html → 邮箱注册
        · 默认邮件 dev 模式 — 验证码直接打到 npm start 的终端
        · 想用真实邮件就在 .env 配 RESEND_API_KEY + RESEND_FROM
        ↓
  3. /app/create.html → 4 步向导创建 AI 角色（取名、年龄、性格、背景故事）
        ↓
  4. 选一个聊天入口：
        · /app/playground.html → 浏览器直接开聊（任何 provider 都行）
        · /app/bind.html       → 网页扫码绑微信（需要 iLink 准入）
        ↓
  ✅ 开聊。dashboard 实时显示好感度、关系阶段、"她现在在做什么"
```

**关键页面**：

| 路径 | 用途 |
|------|------|
| `/` | 落地页（缺 chat provider 时会弹引导条） |
| `/app/setup.html` | 首次配置引导（含 "测试 chat provider 连通性" 按钮） |
| `/app/auth.html` | 邮箱注册 / 登录 |
| `/app/create.html` | 创建 AI 角色（4 步向导） |
| `/app/playground.html` | **浏览器内聊天** — 跑同款 AI 管线，不依赖微信 |
| `/app/bind.html` | 网页扫码绑定微信 |
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
> - **已准入**：直接走网页扫码即可
> - **未准入**：扫码会显示需验证码或失败状态。这种情况下**完全可以用 `/app/playground.html` 在浏览器里直接和 AI 聊天**，体验完整人设引擎 / 长期记忆 / 关系阶段 / 主动消息节奏，只是不发到微信
> - 申请准入的入口在腾讯 iLink ClawBot 控制台，超出本仓库职责

#### 路径 2（高阶/无浏览器）— 终端二维码登录

如果你跑在没图形界面的 VPS / 容器里，或想脚本化把凭据持久化下来：

```bash
npm run ilink:login
```

终端会打印二维码，成功后写入 `./.weixin-credentials.json`（mode 0600，已 gitignore）。

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

脚本不会打印 `bot_token`，也不会输出完整响应。

---

### 🩺 npm run doctor

自托管环境一键诊断（无需服务运行也可执行）：

```bash
npm run doctor
```

输出示例：
```
✅ Node.js v22.0.0 (>= 20)
✅ npm 10.x.x
✅ better-sqlite3 可加载
✅ .env 文件存在
✅ SQLite 可写 (data/bot.db)
✅ CHAT_PROVIDER = deepseek
✅ DEEPSEEK_API_KEY 已配置 (64 字符，内容已隐藏)
⚠️  .weixin-credentials.json 不存在 — 请运行 npm run ilink:login 绑定微信
✅ /api/health 响应正常 (端口 3000)
```

本工具**不输出 API key 内容**，只显示字符数和占位符检测结果。

---

### 🤖 多模型 Provider 支持

> 只改 `.env`，不改一行代码。
>
> ⚠️ **注意**：并非所有 Provider 都经过生产环境验证；部分适配器是占位或兼容性骨架。生产使用前请自行测试对应 Provider、模型名、计费方式和返回格式。

**文本对话（chat）**

| Provider ID | 厂商 | 默认模型 | 备注 |
|---|---|---|---|
| `deepseek` | DeepSeek | `deepseek-chat` | 性价比首选 |
| `openai` | OpenAI ChatGPT | `gpt-4o-mini` | |
| `anthropic` | Anthropic Claude | `claude-sonnet-4-6` | 走原生 messages API |
| `xai` | xAI Grok | `grok-2-latest` | |
| `zhipu` | 智谱 GLM | `glm-4-flash` | 国内开发者常用 |
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

> 模型名仅为示例，实际可用模型请以各 Provider 当前官方文档和你的账号权限为准。

**切换示例**：

```dotenv
CHAT_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_anthropic_api_key_here
CHAT_MODEL=claude-sonnet-4-6
```

填好之后可以打开 `/app/setup.html` 点 **"🔌 测试 chat provider 连通性"** 按钮 — 用最低 token 数发一次 ping 立刻验证 key 是否有效。

---

### 🧩 架构概览

```
                ┌────────────────────────────────────────────────┐
                │   Web Dashboard / Playground    /   WeChat user │
                └───────────────────┬────────────────────────────┘
                                    │
                                    ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Express (index.mjs)                                         │
   │  ┌─────────────┬──────────────┬───────────────────────────┐  │
   │  │  api.mjs    │  auth.mjs    │  iLink 多租户轮询池        │  │
   │  └─────────────┴──────────────┴───────────────────────────┘  │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │  bot.mjs (WeChat 入口)     playground.mjs (Web 入口)   │  │
   │  │              ↓                            ↓             │  │
   │  │   公共 reply pipeline：buildSystemPrompt + recallMemory │  │
   │  │              ↓                                          │  │
   │  │   ai.mjs ──→ providers/ ──→ DeepSeek / 智谱 / 千问 / …  │  │
   │  │              ↓                                          │  │
   │  │   memory.mjs · companion.mjs · proactive.mjs            │  │
   │  └────────────────────────────────────────────────────────┘  │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │  db.mjs (better-sqlite3, WAL)                          │  │
   │  └────────────────────────────────────────────────────────┘  │
   └──────────────────────────────────────────────────────────────┘
```

**关键设计**：
- **provider facade**：业务层只看到 `chatComplete()` / `generateImage()` 等通用方法，底下哪家厂商对它透明
- **18 节 system prompt 合成**：人设 / 元认知 / 关系阶段 / 今日日程 / 最近上下文 / 长期摘要 / 反 AI 味规则
- **proactive 防复读**：发送前用字符 3-gram Jaccard 检测最近 5 条 assistant 内容，相似度 ≥ 0.6 升温重生，仍撞车则放弃
- **日程自愈**：如果 00:30 cron 失败，proactive tick 检测到缺日程时按需补一次（30 分钟级 debounce）
- **bot 入口 vs playground 入口**：两个入口共用同一份 reply pipeline；playground 只是不走 iLink 派发

---

### 📂 目录结构

```
.
├── index.mjs                Express 入口 + iLink 多租户轮询池
├── src/
│   ├── ai.mjs               业务层 AI facade（不直接依赖任何厂商 SDK）
│   ├── providers/
│   │   ├── chat.mjs         9 个 chat provider
│   │   ├── image.mjs        5 个图像 provider
│   │   ├── vision.mjs       5 个 vision provider
│   │   ├── asr.mjs          5 个 ASR provider
│   │   └── embedding.mjs    4 个 embedding provider
│   ├── api.mjs              REST 路由（含 /api/health、/api/setup/test-chat）
│   ├── bot.mjs              微信消息主处理管线
│   ├── playground.mjs       浏览器聊天管线（与 bot.mjs 同 reply pipeline）
│   ├── companion.mjs        18 节 system prompt 合成
│   ├── memory.mjs           情绪 / 好感度 / 记忆提取
│   ├── proactive.mjs        主动消息（含撞车检测）+ 场景照片
│   ├── plan_tasks.mjs       定时任务（日 / 周 / 月总结、日程、自愈）
│   ├── ilink.mjs            iLink 协议封装
│   ├── email.mjs            验证码邮件（resend / dev_stdout 双模式）
│   └── db.mjs               SQLite + 迁移
├── scripts/
│   ├── setup.sh                 一键启动
│   ├── setup-wizard.mjs         交互式 .env 向导 + 原生模块预检
│   ├── ilink_login.mjs          终端二维码登录
│   ├── check-ilink-status.mjs   iLink 状态自检
│   └── backup-db.sh             SQLite 备份脚本
├── deploy/                  systemd unit + nginx 反代模板
├── public/                  前端（落地页 + dashboard + admin + playground + setup）
├── assets/stickers/         表情包加载机制（不分发图片本体）
├── .github/workflows/       CI/CD：tag push 自动构建并发布 GHCR 镜像
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

#### 凭据与敏感文件

- `.env` / `.env.*` / `.auth-secret` / `.admin-secret` / `.admin-credentials` / `.weixin-credentials.json` / `data/bot.db*` / `data/user_memories/` 都已在 `.gitignore`。**永远不要 commit**；clone 后 `git status` 习惯性检查一遍
- 管理员密码首次启动自动生成 20 位随机字符串，写入 `.admin-credentials`（mode 0600）。请妥善保管；忘记可删文件让服务重生
- `AUTH_SECRET` 留空会自动生成到 `.auth-secret`，但**每次重启都会重生**导致 token 全部失效。生产请显式设置（≥32 字符随机串）
- 任何形如 `sk-xxx` / `your_xxx_api_key_here` 的字符都是占位符，不是真实 key；上线前请用自己的密钥替换

#### 服务行为

- `/api/health` 只输出当前 provider 名称、微信是否 configured、邮件模式，**绝不输出** token / botId / 用户数据
- iLink `bot_token` 不会被任何日志打印；扫码登录脚本也只显示 masked `bot_id` / `user_id`
- 默认 CORS 关闭跨域；如需开放请在反代或代码里显式加白名单
- 默认 rate limit（`src/ratelimit.mjs`）按个人用量设计，公开服务请放大或前置 WAF

#### 数据与内容

- SQLite 默认存在 `data/bot.db`，含**聊天历史、长期记忆、用户画像**。**自托管时这些数据完全在你机器上**；备份时记得加密或限定访问
- 对话历史默认保留 60 天（`runHourlyCleanup`），可按需调整；删账号会清空对应 companion 全部数据
- 涉及未成年人 / 心理高风险用户场景请额外谨慎，见 [Issue #3 safety tracker](https://github.com/dimang01/xiyu-ai/issues/3)

#### 报告安全问题

- 邮箱：`xiyuai@proton.me`
- GitHub Security Advisories：https://github.com/dimang01/xiyu-ai/security/advisories/new
- 详细见 [SECURITY.md](./SECURITY.md)

---

### ⚖️ 合规说明

**本项目不提供任何法律、隐私或内容安全合规保证**。MIT 协议只覆盖代码本身，**不**等同于代码所产出内容、所引用的第三方服务、或运营行为的合规性。**公开部署是运营者自己的责任**。下面是常见维度的提示（不构成法律意见）：

#### 你需要自己处理的事项

| 维度 | 说明 |
|---|---|
| **隐私政策 / 用户协议** | 自行起草。仓库里的 `terms.html` / `privacy.html` 是空模板，**不能直接用**于真实运营 |
| **AI 生成内容标识** | 中国大陆按《生成式人工智能服务管理暂行办法》要求对 AI 生成内容做显著标识；欧盟 AI Act / 各国相应法规也有标识要求 |
| **未成年人保护** | 当前版本不内置年龄验证 / 内容分级，**不建议**面向未成年人开放。如需做，请自行加入年龄门控 + 未成年模式内容审核 |
| **个人信息保护** | 涉及 PIPL（中国）/ GDPR（欧盟）/ CCPA（加州）等，需要明示收集目的、提供删除接口（仓库自带 `DELETE /api/me/account`，但口径、保存期限、跨境传输都要自定义） |
| **内容安全审核** | 仓库当前没有 inbound / outbound 内容审核层（仅有简单黑名单）。对外开放前请接入云厂商的内容审核 API 或自建 moderation pipeline |
| **危机话术 / 自伤倾向** | 当前不识别自伤、自杀等高风险输入。如要做面向真实用户的部署，请加入危机检测 + 提供专业救助渠道引导（建议参考各国心理援助热线） |
| **第三方 provider ToS** | 每一家 LLM/图像 provider 都有自己的使用条款，包括是否允许虚拟人格、是否允许情感陪伴场景、商用授权范围。**切换 provider 前自行确认** |
| **微信 / iLink 准入** | 接入腾讯 iLink ClawBot 需要其平台准入资格。其使用条款超出本仓库范围，请遵守腾讯方面的具体协议 |
| **商业使用** | MIT 协议允许商用、修改、再分发，但**不豁免**上面任何一项合规义务；也不豁免你与第三方 provider 之间的协议 |

#### 安全 / 合规的 baseline 建议

- 在公开部署前给整个产品做一次内容安全红队（让人故意诱发高风险输出，看会不会破防）
- 部署后留 logs，但对用户消息做脱敏 / 短期保留 / 限定访问
- 在 UI 显眼位置标识"AI 生成"
- 对未登录或匿名访客限制功能，鼓励实名 / 邮箱验证
- 把"删除我的数据"做成一个浏览器里能点的按钮，而不是要发邮件申请

#### 关于本仓库的"陪伴"定位

本框架不预设角色性格 / NSFW 内容 / 越界互动。**注册角色的人设由部署方或终端用户决定**。仓库里所有人格模板（同班同学、心理咨询师等）都是中立示例。是否做向成年用户的情感陪伴 / 是否允许某些类型的角色，是你的产品决策与合规决策，请自负其责。

---

### 🌐 生产部署注意事项

如果不只是本地试玩：

#### 网络与边界

| 项 | 建议 |
|---|---|
| 反向代理 | nginx / Caddy 终结 TLS；Node 进程只监听 `127.0.0.1`，不直接暴露公网 |
| HTTP 头 | HSTS、X-Frame-Options、X-Content-Type-Options、Referrer-Policy 等在 nginx 里加上（`deploy/nginx.conf.example` 已带示例）|
| DDoS / 异常流量 | 公开服务建议前置 Cloudflare / 阿里云 WAF，至少开 rate-limit；`src/ratelimit.mjs` 是 app 层的最后兜底，不能当 WAF 用 |
| 凭据传输 | iLink / 邮件 / LLM provider 的 key 不要明文出现在 systemd 命令行；用 `EnvironmentFile` 指向 `chmod 600` 的 `.env` |

#### 数据持久化

| 项 | 建议 |
|---|---|
| SQLite WAL | 默认已开，写性能 OK；不要在多个进程同时写同一个 db 文件 |
| 备份 | 定期备份 `data/bot.db*` 整套三文件；`scripts/backup-db.sh` 是起点，生产建议接 restic / borgbackup 之类异地备份 |
| 用户数据 | `data/user_memories/` 是 markdown 形式的人类可读归档，备份策略同上 |
| 恢复 | 替换 `bot.db` 三件套需要先停服务（systemd `stop`），避免 WAL 不一致 |

#### 凭据 / 邮件 / 限速

| 项 | 建议 |
|---|---|
| `AUTH_SECRET` | 必须显式设置（≥32 字符随机串）；留空会每次重启重生 token 强制登出 |
| 邮件 | 公开部署把 `EMAIL_DEV_MODE` 关掉，配真实 `RESEND_API_KEY` + 通过 DKIM/SPF 验证过的 `RESEND_FROM` |
| 限速 | `src/ratelimit.mjs` 默认面向个人；对外服务请按"注册 / 验证码 / 聊天 / 图像生成"分别放大，并叠加 WAF |
| 管理员后台 | `/app/admin.html` 建议放在反代后 + IP 白名单，或额外加 HTTP Basic Auth 二次保护 |

#### 成本 / 监控 / 内容

| 项 | 建议 |
|---|---|
| 成本监控 | chat / image / vision / ASR / embedding provider 都按 token 或张计费；`ai_usage_daily` 表是接监控的天然入口 |
| 日志切割 | systemd 默认接 journald；如果直接 `>> server.log` 请用 logrotate |
| 健康检查 | `/api/health` 适合接入 Uptime Kuma / Prometheus blackbox exporter |
| AI 内容标识 | 按当地法规对所有 AI 生成内容（文字、图片）做显著标识 |

#### 模板

仓库里 `deploy/` 目录提供了开箱即用的部署模板：

| 文件 | 用途 |
|---|---|
| [`deploy/xiyu-ai.service`](./deploy/xiyu-ai.service) | systemd unit（已带安全加固：`NoNewPrivileges` / `PrivateTmp` / `ProtectSystem` / `ReadWritePaths`）|
| [`deploy/nginx.conf.example`](./deploy/nginx.conf.example) | nginx 反代示例（HTTPS + HSTS + 长轮询超时 + AI 爬虫友好路由）|
| [`deploy/README.md`](./deploy/README.md) | 从 `git clone` → 上线的 step-by-step 走查 |

走 Docker 路径时，`compose.yml` 已自带 `restart: unless-stopped`，systemd 不必要；nginx 模板继续适用于宿主机做 TLS 终结。

更完整的部署 walkthrough（备份策略 / 监控接入 / 多实例 / 日志切割）跟踪 [Issue #5](https://github.com/dimang01/xiyu-ai/issues/5)。

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
- 💡 路线图 → 见 [Issues](https://github.com/dimang01/xiyu-ai/issues)（带 `enhancement` / `help wanted` / `good first issue` 标签的最适合上手）
- 🛠️ 想直接贡献代码：fork → PR；保持改动小而聚焦，附带说明动机
- 致谢见 [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md)

---

### 📬 联系方式

如需反馈问题、安全报告或项目交流，可以通过：
- GitHub Issues: https://github.com/dimang01/xiyu-ai/issues
- Email: xiyuai@proton.me

---

### 📄 许可证

[MIT](./LICENSE) © 2026 溪语 AI Contributors

---

## English

> One `.env` to run. Node.js backend, plain-HTML frontend, 9 chat models + 5 image + 5 vision + 5 ASR + 4 embedding — all swappable through a single provider abstraction. **In-browser WeChat QR binding and a full in-browser chat playground** — no Tencent iLink approval needed to fully exercise the AI.

### Table of Contents

- [⚡ TL;DR](#-tldr)
- [🎯 Project Scope](#-project-scope)
- [✨ Features](#-features)
- [🚀 Quick Start](#-quick-start)
- [🎬 What to do after it starts](#-what-to-do-after-it-starts-new-user-walkthrough)
- [📱 About WeChat Integration](#-about-wechat-integration)
- [🤖 Multi-provider AI Support](#-multi-provider-ai-support)
- [🧩 Architecture](#-architecture)
- [📂 Repository Structure](#-repository-structure)
- [🎨 Stickers and Assets](#-stickers-and-assets)
- [🛡️ Security Notice](#-security-notice)
- [⚖️ Legal / Compliance Disclaimer](#-legal--compliance-disclaimer)
- [🌐 Production Notes](#-production-notes)
- [🧪 Known Limitations](#-known-limitations)
- [🤝 Contributing & Roadmap](#-contributing--roadmap)
- [📬 Contact](#-contact)
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
> Read [Security Notice](#-security-notice), [Legal / Compliance Disclaimer](#-legal--compliance-disclaimer) and [Production Notes](#-production-notes) before deploying anywhere serious.

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
| 🔄 **Proactive engine v2** | Motivation-score-driven triggers (missing / emotion / time); quiet/normal/clingy intensity; anti-spam backoff |
| 🧬 **Memory v2** | 7-layer taxonomy × 0–5 weight × forgetting curve; pin / lock / archive / do-not-mention; sensitive-content filter; deduplication |
| 🛡️ **Persona Guard** | Post-generation consistency check — catches AI self-disclosure, customer-service phrases, stage violations; auto-repairs minor issues, regenerates on major ones |
| 🎭 **Emotion state machine** | 7 dimensions: affection / trust / dependency / possessiveness / security / energy / mood; rule-driven real-time updates |
| 💬 **Multi-provider** | chat / image / vision / ASR / embedding — each capability independently swappable, no code changes |
| 🎛️ **Full dashboard** | Affection progress, relationship stage, "what she's doing right now", timeline, avatar manager, shareable CP-card, **memory panel entry** |
| 🗂️ **Memory Control Panel** | `/app/memories.html` — visual memory browser: filter by layer/status, add, edit, pin, lock, archive, delete |
| 🧪 **Browser playground** | Chat with the AI in the browser without WeChat — runs the same persona/memory/emotion pipeline as inbound WeChat messages |
| 📱 **WeChat integration** | In-browser QR binding — backend requests the QR from iLink at runtime; **no `ILINK_*` env vars to pre-configure** (requires Tencent iLink/ClawBot approval on your WeChat account) |
| 📬 **Email dev mode** | When Resend is not configured, verification codes are printed to the service log — first-time signup needs no email service |
| 🩺 **`npm run doctor`** | One-command diagnostics for self-hosters: Node version, SQLite writability, API keys, iLink config, port, service health |

---

### 🚀 Quick Start

> **30-second mental model**: install → run → register in browser → chat right away (playground or WeChat QR).
>
> **You do NOT need**: an email service (dev mode is automatic), `ILINK_BOT_TOKEN`, a vendor console for bot IDs, or any hand-editing beyond `.env`.

#### 🅰️ Path A — Local (recommended for first try, 3 min)

```bash
git clone https://github.com/dimang01/xiyu-ai.git
cd xiyu-ai
npm install        # Node ≥ 20
npm run setup      # Interactive: pick provider, paste API key, .env written for you
npm start
# Open http://localhost:3000
```

`npm run setup` also runs a native-module preflight (better-sqlite3 build environment). If python/build-tools are missing it prints actionable fix commands for your OS instead of letting `npm install` fail with a wall of red.

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

#### 🅲 Path C — One-line `docker run` (try without cloning)

```bash
docker run -d --name xiyu-ai \
  -p 3000:3000 \
  -e CHAT_PROVIDER=deepseek \
  -e DEEPSEEK_API_KEY=your_deepseek_api_key_here \
  -v xiyu-data:/app/data \
  ghcr.io/dimang01/xiyu-ai:latest
# Open http://localhost:3000
```

Images are built and published to GHCR by GitHub Actions on every version tag (`v*`), with `linux/amd64` and `linux/arm64` support.

---

### 🎬 What to do after it starts (new-user walkthrough)

Once the server is up:

```
  1. Open http://localhost:3000
        ↓
  2. /app/auth.html → email signup
        · Default email-dev mode — verification code is printed in the npm start terminal
        · For real email: set RESEND_API_KEY + RESEND_FROM in .env
        ↓
  3. /app/create.html → 4-step character wizard (name, age, personality, backstory)
        ↓
  4. Pick a chat entry:
        · /app/playground.html → chat right in the browser (works with any provider)
        · /app/bind.html       → WeChat QR binding (requires iLink approval)
        ↓
  ✅ Start chatting. The dashboard shows affection, relationship stage, "what she's doing now" in real time.
```

**Key pages**:

| Path | Purpose |
|------|---------|
| `/` | Landing page (shows a setup banner if no chat provider is configured) |
| `/app/setup.html` | First-run guide (with a "Test chat provider connectivity" button) |
| `/app/auth.html` | Email signup / login |
| `/app/create.html` | 4-step character wizard |
| `/app/playground.html` | **In-browser chat** — same AI pipeline, no WeChat dependency |
| `/app/bind.html` | In-browser WeChat QR binding |
| `/app/dashboard.html` | User dashboard |
| `/app/admin.html` | Admin panel (password in `.admin-credentials`) |

---

### 📱 About WeChat Integration

#### Path 1 (default, recommended) — In-browser QR

Just follow step 4 of the walkthrough above. You do **not** need any of:
- ❌ Pre-set `ILINK_BOT_TOKEN` / `ILINK_BOT_ID` in `.env`
- ❌ Running `npm run ilink:login` ahead of time
- ❌ Any pre-configured bot ID in a vendor console

When the user clicks "Bind WeChat", the backend hits `ilink/bot/get_bot_qrcode?bot_type=3` to request a fresh QR; on `confirmed`, the credentials are written to `wechat_accounts` and the new bot is hot-registered into the polling pool.

> ⚠️ **About iLink access**: whether the scan actually yields a `bot_token` depends on **whether your WeChat account has been approved for Tencent iLink / ClawBot developer access**.
>
> - **Approved**: web QR binding works end-to-end.
> - **Not approved**: the scan will return a verify-code or failure state. In that case, **you can use `/app/playground.html`** to chat with the AI directly in the browser — the full persona engine, long-term memory, relationship stages and proactive cadence still apply; messages just don't reach WeChat.
> - Applying for access happens inside the Tencent iLink / ClawBot console, which is out of scope for this repo.

#### Path 2 (advanced / headless) — Terminal QR login

If you're on a VPS without a browser, or want to persist credentials to a file before bringing the server up:

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

The helper never prints `bot_token` or the raw response.

---

### 🤖 Multi-provider AI Support

> Edit `.env`, no code changes.
>
> ⚠️ **Note**: Not every provider is production-tested. Some adapters are placeholders or compatibility stubs. Test the selected provider, model name, billing behavior, and response format before using it in production.

**Chat**

| Provider ID | Vendor | Default model | Notes |
|---|---|---|---|
| `deepseek` | DeepSeek | `deepseek-chat` | Best price/quality for hobby use |
| `openai` | OpenAI ChatGPT | `gpt-4o-mini` | |
| `anthropic` | Anthropic Claude | `claude-sonnet-4-6` | Native messages API |
| `xai` | xAI Grok | `grok-2-latest` | |
| `zhipu` | Zhipu GLM | `glm-4-flash` | Common option for Chinese developers |
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

> Model names are examples. Check the provider's current documentation and your account permissions before use.

**Switching example**:

```dotenv
CHAT_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_anthropic_api_key_here
CHAT_MODEL=claude-sonnet-4-6
```

After setting it, open `/app/setup.html` and click **"🔌 Test chat provider connectivity"** to verify the key with a minimal-token ping.

---

### 🧩 Architecture

```
                ┌────────────────────────────────────────────────┐
                │ Web Dashboard / Playground   /   WeChat user    │
                └───────────────────┬────────────────────────────┘
                                    │
                                    ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Express (index.mjs)                                         │
   │  ┌─────────────┬──────────────┬───────────────────────────┐  │
   │  │  api.mjs    │  auth.mjs    │  iLink polling pool       │  │
   │  └─────────────┴──────────────┴───────────────────────────┘  │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │  bot.mjs (WeChat entry)     playground.mjs (Web entry) │  │
   │  │              ↓                              ↓           │  │
   │  │   shared reply pipeline: buildSystemPrompt + recallMem  │  │
   │  │              ↓                                          │  │
   │  │   ai.mjs ──→ providers/ ──→ DeepSeek / Zhipu / Qwen…    │  │
   │  │              ↓                                          │  │
   │  │   memory.mjs · companion.mjs · proactive.mjs            │  │
   │  └────────────────────────────────────────────────────────┘  │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │  db.mjs (better-sqlite3, WAL)                          │  │
   │  └────────────────────────────────────────────────────────┘  │
   └──────────────────────────────────────────────────────────────┘
```

**Design highlights**:
- **Provider façade**: business code only sees `chatComplete()` / `generateImage()`. Which vendor runs underneath is opaque to it.
- **18-section system-prompt composer**: persona, meta-cognition, relationship stage, today's schedule, recent context, long-term digest, anti-AI-tone rules.
- **Anti-repeat for proactive messages**: char 3-gram Jaccard check against the last 5 assistant turns; collision triggers a temperature-bumped regeneration, and the message is dropped if it still collides.
- **Self-healing schedules**: if the 00:30 cron failed, the proactive ticker regenerates the day on demand (30-minute debounce).
- **WeChat vs. playground entry points** share the same reply pipeline — playground simply skips iLink dispatch.

---

### 📂 Repository Structure

```
.
├── index.mjs                Express entry + iLink multi-tenant polling pool
├── src/
│   ├── ai.mjs               Business-layer AI façade (no direct vendor SDK use)
│   ├── providers/           Per-capability provider adapters
│   ├── api.mjs              REST routes (incl. /api/health, /api/setup/test-chat)
│   ├── bot.mjs              WeChat message pipeline
│   ├── playground.mjs       Browser chat pipeline (shares reply logic with bot.mjs)
│   ├── companion.mjs        System-prompt composer (18 sections)
│   ├── memory.mjs           Mood / affection / memory extraction
│   ├── proactive.mjs        Proactive messaging with collision detection + scene photos
│   ├── plan_tasks.mjs       Cron jobs (daily/weekly/monthly summaries, schedule, self-heal)
│   ├── ilink.mjs            iLink protocol wrapper
│   ├── email.mjs            Verification mail (resend / dev_stdout dual mode)
│   └── db.mjs               SQLite + migrations
├── scripts/
│   ├── setup.sh                 One-shot bootstrap
│   ├── setup-wizard.mjs         Interactive .env wizard + native-module preflight
│   ├── ilink_login.mjs          Terminal QR login helper
│   ├── check-ilink-status.mjs   iLink health probe
│   └── backup-db.sh             SQLite backup
├── deploy/                  systemd unit + nginx reverse-proxy templates
├── public/                  Static frontend (landing, dashboard, admin, playground, setup)
├── assets/stickers/         Sticker loading mechanism (no image bundled)
├── .github/workflows/       CI/CD: tag push → build & publish multi-arch image to GHCR
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

#### Credentials & sensitive files

- `.env`, `.env.*`, `.auth-secret`, `.admin-secret`, `.admin-credentials`, `.weixin-credentials.json`, `data/bot.db*`, `data/user_memories/` are all gitignored. **Never commit them.** After cloning, get into the habit of checking `git status` before each commit.
- The admin password is a 20-char random string generated on first start and saved to `.admin-credentials` with mode 0600. Keep it safe; if you lose it, delete the file and let the service regenerate one.
- Leaving `AUTH_SECRET` empty causes a fresh secret to be generated into `.auth-secret` on every restart — invalidating all existing JWTs. For production, set an explicit value (≥32 random characters).
- Anything that looks like `sk-xxx` or `your_xxx_api_key_here` is a placeholder, not a live key. Replace before deployment.

#### Service behavior

- `/api/health` only reports active provider names, WeChat configured flag, and email mode. It **never** exposes tokens, bot IDs, or user data.
- The iLink `bot_token` is never printed by any log line; the QR login helper only shows masked `bot_id` / `user_id`.
- CORS is off by default; if you need cross-origin access, add an explicit allow-list in the reverse proxy or in code.
- The default rate limiter in `src/ratelimit.mjs` is sized for personal use; widen it or place a WAF in front for public deployments.

#### Data & content

- SQLite lives at `data/bot.db` and holds **chat history, long-term memory, and user profiles**. When self-hosting, this data stays entirely on your machine — encrypt or restrict access to your backups.
- Chat history is retained for 60 days by default (`runHourlyCleanup`) and can be adjusted. Account deletion wipes the corresponding companion's data.
- Be especially careful with minor-safety and crisis scenarios — see [Issue #3 safety tracker](https://github.com/dimang01/xiyu-ai/issues/3).

#### Reporting security issues

- Email: `xiyuai@proton.me`
- GitHub Security Advisories: https://github.com/dimang01/xiyu-ai/security/advisories/new
- Full policy in [SECURITY.md](./SECURITY.md)

---

### ⚖️ Legal / Compliance Disclaimer

**This project does not provide any legal, privacy, or content-safety compliance guarantees.** The MIT license covers the code itself; it does **not** extend to the content the code produces, the third-party services it calls, or how you choose to operate it. **Public deployment is the operator's own responsibility.** The list below highlights common dimensions (this is not legal advice):

#### What you need to handle yourself

| Area | Notes |
|---|---|
| **Privacy policy / Terms of Service** | Draft your own. The shipped `terms.html` / `privacy.html` are empty templates and **must not** be used as-is for a real product. |
| **AI-generated content labeling** | Mainland China requires clear labeling per the *Provisional Measures for Generative AI Services*. The EU AI Act and several national laws have analogous labeling rules. |
| **Minor-safety** | This release does not ship age-gating or content rating. **Not recommended** for deployments targeting minors. If you do, add your own age gate and minor-mode content moderation. |
| **Personal data protection** | PIPL (China), GDPR (EU), CCPA (California) and similar regimes require explicit purpose disclosure, deletion endpoints (the repo provides `DELETE /api/me/account`, but the policy, retention period, and cross-border transfer rules are yours to define), and more. |
| **Content moderation** | The repo currently has only a simple blacklist for inbound/outbound. For public deployment, integrate a cloud moderation API or build your own pipeline. |
| **Crisis / self-harm language** | The current build does not detect self-harm or suicidal ideation in user input. If you ship to real users, add a crisis-detection layer and route to professional helplines appropriate to your jurisdiction. |
| **Third-party provider ToS** | Every LLM / image provider has its own terms covering virtual personas, emotional-companionship use cases, and commercial scope. **Check before switching providers.** |
| **WeChat / iLink approval** | Tencent iLink / ClawBot access requires the platform's own approval. Its terms are out of scope of this repository — comply with Tencent's specific agreements. |
| **Commercial use** | MIT allows commercial use, modification, and redistribution — but does **not** waive any of the obligations above, nor any third-party provider agreement you may have. |

#### Baseline safety / compliance recommendations

- Run an internal red-team pass on the full product before going public (try to elicit high-risk outputs and verify the moderation holds).
- Keep operational logs but redact user content, retain only as long as needed, and restrict access.
- Make the "AI-generated" label prominent in the UI.
- Restrict functionality for unauthenticated visitors; require email or stronger verification.
- Expose a one-click "delete my data" action in the user UI — not an email request.

#### About this repo's "companion" framing

The framework does not presuppose a specific character personality, NSFW content, or boundary-crossing interaction. **The persona is chosen by the deployer or end user at registration time.** All personality templates shipped in the repo (classmate, therapist, etc.) are neutral examples. Whether you deploy an emotional-companionship product for adults, or restrict certain character types, is your product and compliance decision — at your own risk.

---

### 🌐 Production Notes

If you plan to run this for more than local experiments:

#### Network & boundary

| Concern | Recommendation |
|---|---|
| Reverse proxy | nginx / Caddy for TLS termination; bind the Node process to `127.0.0.1` rather than exposing it publicly |
| HTTP headers | Add HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy at the proxy level (`deploy/nginx.conf.example` already has them) |
| DDoS / abusive traffic | For public services put Cloudflare / a cloud WAF in front, with rate limiting enabled. `src/ratelimit.mjs` is an app-level fallback, not a substitute for a WAF |
| Credential transport | Don't pass iLink / email / LLM provider keys on a systemd command line. Use `EnvironmentFile` pointing at a `chmod 600` `.env` |

#### Data persistence

| Concern | Recommendation |
|---|---|
| SQLite WAL | Already on; do **not** have multiple processes write the same `bot.db` file |
| Backups | Regularly back up the full three-file set of `data/bot.db*`. `scripts/backup-db.sh` is a starting point; production should pipe through restic / borgbackup or equivalent off-site |
| User data | `data/user_memories/` is a human-readable markdown archive — same backup policy applies |
| Restore | Stop the service (`systemctl stop`) before replacing the `bot.db` triplet, or you'll get a WAL inconsistency |

#### Secrets / email / rate limits

| Concern | Recommendation |
|---|---|
| `AUTH_SECRET` | Must be set explicitly (≥32 random characters); leaving it empty regenerates the secret on every restart and forces logouts |
| Email | For public deployment, disable `EMAIL_DEV_MODE` and configure a real `RESEND_API_KEY` + a DKIM/SPF-verified `RESEND_FROM` |
| Rate limits | Defaults in `src/ratelimit.mjs` are sized for personal use. For public services, widen per scope (register / verify-code / chat / image-gen) and layer a WAF |
| Admin panel | `/app/admin.html` should sit behind the reverse proxy with an IP allow-list, and ideally an extra HTTP Basic Auth |

#### Cost / monitoring / content

| Concern | Recommendation |
|---|---|
| Cost monitoring | Chat / image / vision / ASR / embedding providers all bill per token or per image. The `ai_usage_daily` table is the natural place to wire metrics |
| Log rotation | systemd uses journald by default; if you redirect to a file with `>> server.log`, run `logrotate` |
| Health checks | `/api/health` is suitable for Uptime Kuma / Prometheus blackbox exporter |
| Content labeling | Label all AI-generated content (text and images) per local laws and platform policy |

#### Templates

The `deploy/` directory ships drop-in templates:

| File | Purpose |
|---|---|
| [`deploy/xiyu-ai.service`](./deploy/xiyu-ai.service) | systemd unit (hardened: `NoNewPrivileges` / `PrivateTmp` / `ProtectSystem` / `ReadWritePaths`) |
| [`deploy/nginx.conf.example`](./deploy/nginx.conf.example) | nginx reverse proxy (HTTPS, HSTS, long-poll timeouts, AI-crawler-friendly routes) |
| [`deploy/README.md`](./deploy/README.md) | Step-by-step from `git clone` → live VPS |

For the Docker path, `compose.yml` already sets `restart: unless-stopped`, so systemd is unnecessary; the nginx template is still useful for host-side TLS termination.

A fuller deployment walkthrough (backup strategy, monitoring, multi-instance, log rotation) is tracked in [Issue #5](https://github.com/dimang01/xiyu-ai/issues/5).

---

### 🧪 Known Limitations

**P0 Core Companion Experience** — implementation started. See [`docs/ROADMAP.md`](./docs/ROADMAP.md) for full status.

| Limitation | Tracker |
|---|---|
| Emotion state machine is rule-based (not AI-driven) — nuance limited | docs/ROADMAP.md |
| Memory decay score is computed on-read, not written back on a schedule | docs/ROADMAP.md |
| Persona Guard regeneration uses the same system prompt — may not fix deep misalignment | docs/ROADMAP.md |
| Proactive engine v2 logic is additive — old time-window scheduler still drives actual sends | docs/ROADMAP.md |
| TTS voice reply not implemented (`voice_reply_enabled` is a stub) | [#4](https://github.com/dimang01/xiyu-ai/issues/4) |
| Xunfei / Tencent Cloud ASR providers are stubs | — |
| Message deduplication is currently in-process; may briefly repeat after a restart | [#1](https://github.com/dimang01/xiyu-ai/issues/1) |
| Automated SQLite backup/recovery script incomplete | [#2](https://github.com/dimang01/xiyu-ai/issues/2) |
| No dedicated crisis / minor-safety moderation layer | [#3](https://github.com/dimang01/xiyu-ai/issues/3) |
| Production deployment guide is in progress | [#5](https://github.com/dimang01/xiyu-ai/issues/5) |
| WeChat integration requires Tencent iLink / ClawBot approval | — |

---

### 🤝 Contributing & Roadmap

- 🐛 Found a bug → open an [Issue](https://github.com/dimang01/xiyu-ai/issues/new)
- 💡 Roadmap → browse [Issues](https://github.com/dimang01/xiyu-ai/issues); `good first issue` and `help wanted` labels are easiest to pick up
- 🛠️ Want to contribute code → fork → PR; keep diffs small and focused, include a short rationale
- Credits in [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md)

---

### 📬 Contact

For feedback, security reports, or project discussion:
- GitHub Issues: https://github.com/dimang01/xiyu-ai/issues
- Email: xiyuai@proton.me

---

### 📄 License

[MIT](./LICENSE) © 2026 Xiyu AI Contributors
