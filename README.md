# 溪语 AI / Xiyu AI

> 实验性开源项目 · Experimental open-source project
>
> 一个把 AI 当作"有完整人生背景的虚拟个体"的微信 AI 陪伴框架。后端 Node.js + 前端纯静态 HTML，一份 `.env` 即可启动；微信接入是可选的。
>
> An experimental WeChat-based AI companion framework that treats the LLM as a virtual character with a full backstory, daily schedule and a 5-stage relationship arc. Node.js backend, plain-HTML frontend, one `.env` to run; WeChat integration is optional.

[中文说明](#中文说明) · [English](#english)

---

## 中文说明

### 项目简介

「溪语 AI」是一个**实验性的开源 AI 陪伴框架**，不是开箱即用的成品产品。它把大模型当作一个有人生背景的虚拟个体来调度：

- 注册时为角色自动生成 46+ 条具体人生记忆（童年 / 学校 / 家庭 / 朋友 / 价值观 / 小习惯 / 口头禅）
- 每天有自己的日程剧本（学生上学 / 上班族通勤），区分工作日与周末；当天的日程会以"我刚下课""午休时画了点小涂鸦"的方式自然出现在对话里
- 关系从陌生人 → 朋友 → 暧昧 → 恋人 → 深爱 5 阶段演进，每阶段差异化称呼/说话节奏
- 微信节奏：每条消息 ≤15 字、多条连发、剥离常见 AI 味
- 主动消息：早安/晚安、日间随机、主动告白、约 2 天一次的场景照片（需要图像 provider）
- 长期记忆：语义 embedding 召回 + importance 评分 + 日 / 周 / 月归档
- 完整的 web dashboard：好感度进度、关系阶段、"她现在在做什么"、时间轴、CP 卡分享
- 微信接入通过腾讯 iLink ClawBot 协议（**可选**，跳过亦可在浏览器里聊）

⚠️ 本项目是研究与个人使用导向的开源代码，**不要直接当生产服务对外**。请阅读下方"安全提醒"与"生产部署注意事项"。

### 核心功能

- 多 provider 抽象：chat / image / vision / ASR / embedding，五个能力分别可独立切换 provider
- 系统 prompt 18 节动态合成：人设 / 元认知 / 关系阶段 / 今日日程 / 最近上下文 / 长期摘要 / 反 AI 味规则
- 日程系统：每天 00:30 调 cron 生成 8–12 段，按工作日 / 周末派生活动，并写入早 / 中 / 晚三段情绪
- 调度失败自愈：如果日程没生成，proactive tick 会按需补一次（带 30 分钟级 debounce）
- 主动消息防复读：发送前用字符 3-gram Jaccard 与最近 5 条助手消息比相似度，撞车则升温重生，仍撞车直接放弃本次
- 关系阶段差异化：陌生人不会用"宝宝/老婆"，过早亲密词委婉回避；用户主动表白必接住
- 头像系统：预生成头像池 + 美感打分 + persona 匹配；也支持用户上传

### 一键启动

```bash
git clone https://github.com/dimang01/xiyu-ai.git
cd xiyu-ai
npm install
cp .env.example .env
# 编辑 .env：至少设置 CHAT_PROVIDER 与对应的 *_API_KEY
npm start
# 浏览器打开 http://localhost:3000
```

`.env` 的最小示例：

```dotenv
CHAT_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_deepseek_api_key_here
# 或：
# CHAT_PROVIDER=openai
# OPENAI_API_KEY=your_openai_api_key_here
# CHAT_PROVIDER=zhipu
# ZHIPU_API_KEY=your_zhipu_api_key_here
```

启动后页面：

- `/` 落地页
- `/app/auth.html` 邮箱注册 / 登录
- `/app/create.html` 创建 AI 角色（4 步向导）
- `/app/dashboard.html` 控制台
- `/app/admin.html` 管理员后台（首次启动会在 `.admin-credentials` 生成 20 位随机密码）

### 微信 iLink 自动登录

要把这个 AI 接到真实微信号，需要在腾讯 iLink / ClawBot 平台具备相应 bot 资格。脚本会在终端打印二维码，你用微信扫码 + 手机端"允许登录"即可。

```bash
npm run ilink:login
```

成功后会写入 `./.weixin-credentials.json`（已在 `.gitignore` 内，文件权限自动设置为 0600）：

```json
{
  "baseurl": "https://ilinkai.weixin.qq.com",
  "ilink_bot_id": "...",
  "ilink_user_id": "...",
  "bot_token": "...",
  "created_at": "..."
}
```

运行时凭据加载优先级：

1. 环境变量 `ILINK_BOT_TOKEN` + `ILINK_BOT_ID`（可选 `ILINK_BASE_URL` / `ILINK_USER_ID`）
2. 项目根下的 `.weixin-credentials.json`
3. 两者都没有 → 服务正常启动，但微信功能 disabled，`/api/health` 会显示 `"wechat": { "configured": false }`

二维码登录注意：

- 扫码与"允许登录"必须由账号持有人本人完成，脚本不会、也不应该绕过
- 脚本不打印 `bot_token`，不打印完整响应
- `--help` 仅显示用法，不联网

### 多模型 Provider 支持

只改 `.env`，不需要改代码。

| 能力 | 可选 provider |
|------|----------------|
| chat | `deepseek` · `openai` · `anthropic` · `xai` · `zhipu` · `doubao` · `qwen` · `kimi` · `wenxin` |
| image | `zhipu` (CogView-4) · `qwen` (Wanx) · `doubao` · `wenxin` · `openai` (gpt-image-1 / DALL·E) |
| vision | `zhipu` (GLM-4V) · `openai` (gpt-4o-mini) · `qwen` (qwen-vl-plus) · `doubao` · `anthropic` |
| ASR | `gemini` · `openai` (Whisper) · `qwen` (paraformer-v2) · `xunfei` (占位) · `tencent` (占位) |
| embedding | `gemini` · `openai` (text-embedding-3-small) · `zhipu` (embedding-3) · `qwen` (text-embedding-v3) |

切换时只需类似：

```dotenv
CHAT_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_anthropic_api_key_here
CHAT_MODEL=claude-sonnet-4-6
```

字节豆包 (doubao) 需要在火山方舟绑定接入点 ID，对应 `CHAT_MODEL=ep-xxx`。

### 目录结构

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
│   ├── api.mjs              REST 路由（含 /api/health）
│   ├── bot.mjs              微信消息主处理管线
│   ├── companion.mjs        18 节 system prompt 合成
│   ├── memory.mjs           情绪 / 好感度 / 记忆提取
│   ├── proactive.mjs        主动消息（含撞车检测）+ 场景照片
│   ├── plan_tasks.mjs       定时任务（日 / 周 / 月总结、日程、自愈）
│   ├── ilink.mjs            iLink 协议封装
│   └── db.mjs               SQLite + 迁移
├── scripts/
│   ├── setup.sh             一键启动
│   ├── ilink_login.mjs      终端二维码登录
│   ├── check-ilink-status.mjs  iLink 状态自检
│   └── backup-db.sh         SQLite 备份
├── public/                  前端静态文件（落地页 + dashboard + admin）
├── assets/stickers/         表情包加载机制（不分发图片本体）
└── data/                    运行时数据（gitignored）
```

### 表情包与素材说明

仓库**只包含表情包的加载/匹配机制**（按 emotion tag 选包），**不分发任何真实表情包图片**：

- ChineseBQB 或其它第三方表情包归原作者所有；本仓库不打包、不再分发其图片
- 如果你要启用表情包功能，需要自行准备 **有合法授权** 的素材，放进 `assets/stickers/` 并提供 `manifest.json`
- AI 生成图（CogView / Wanx 等）的后处理走的是 `image post-processing pipeline`（裁剪、转 webp、压缩）—— 不要把该机制理解或宣传为"绕过版权"

### 安全提醒

- `.env` / `.admin-credentials` / `.weixin-credentials.json` / `data/bot.db*` / `data/user_memories/` 都已在 `.gitignore`，**永远不要 commit**
- 管理员密码首次启动自动生成 20 位随机字符串，写入 `.admin-credentials`（mode 0600）—— 请妥善保管
- `/api/health` 会显示当前 provider 与微信是否 configured，但**不会**输出 token / botId / 用户数据
- 任何看起来像 `sk-xxx` 的字符都是占位符；上线前请用自己的密钥
- 与未成年人或心理高风险用户场景请额外谨慎，详见 GitHub Issues 中的 safety / moderation tracker

### 生产部署注意事项

如果你打算长期跑（而不只是本地试玩），请额外做：

- 反向代理：建议用 nginx / Caddy 终结 TLS，后端只监听 127.0.0.1
- 数据库：开 WAL（默认已开），定期备份 `data/bot.db*`，参考 `scripts/backup-db.sh`
- 凭据：`AUTH_SECRET` 必须显式设置（留空会自动生成，但每次重启会失效 token）
- 限速：`src/ratelimit.mjs` 默认窗口适合个人用，对外服务请放大或前置 WAF
- 模型成本：注意 chat / image provider 的计费，建议给 `ai_usage_daily` 做监控
- 内容标识：根据当地法规对 AI 生成内容做必要标注

### 已知限制

- TTS 语音回复尚未实现（`voice_reply_enabled` 是占位字段）
- 讯飞 / 腾讯云 ASR provider 仅占位，欢迎 PR
- 消息去重目前是进程内 Set，重启可能短暂重复，已有 issue 跟踪
- 跨进程消息去重 / SQLite 自动备份 / 危机话术 moderation / 生产部署文档：均在 GitHub Issues
- 微信接入依赖腾讯 iLink ClawBot 资格

### 许可证

[MIT](./LICENSE) © 2026 溪语 AI Contributors。致谢见 [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md)。

---

## English

### Overview

**Xiyu AI** is an **experimental open-source framework** for building a WeChat-based AI companion that behaves like a real person rather than a chatbot. It is intended for research, hobbyist and personal use; it is **not** a turnkey production service.

The system treats the underlying LLM as a virtual character with:

- 46+ auto-generated life memories at character creation (childhood / school / family / fears / habits / catchphrases)
- A real daily schedule (student vs. office-worker; weekday vs. weekend) that surfaces naturally in chat ("I just finished class", "I doodled a bit at lunch")
- A 5-stage relationship arc — stranger → friend → flirting → lover → deep love — each stage with its own form of address and pacing
- Real-person texting rhythm: ≤15 chars per message, multi-burst sending, anti-AI-tone post-processing
- Proactive messaging: morning / evening greetings, random daytime check-ins, spontaneous confessions, scene photos roughly every two days (image provider required)
- Long-term memory: semantic-embedding recall + importance scoring + daily / weekly / monthly summaries
- A full web dashboard: affection bar, relationship stage, "what she's doing right now", timeline, shareable CP-card

WeChat integration via Tencent iLink / ClawBot is **optional** — you can use the dashboard locally without it.

### Features

- **Multi-provider abstraction** for chat, image, vision, ASR and embedding — each capability is swappable independently via `.env`.
- **18-section dynamic system prompt** combining persona, meta-cognition, relationship stage, today's schedule, recent context, long-term digest, and anti-AI-tone rules.
- **Daily schedule generator**: at 00:30 a cron task creates 8–12 timed activities with morning / afternoon / evening mood segments, weekday/weekend-aware.
- **Self-healing scheduling**: if the daily cron fails, the proactive ticker regenerates the schedule on demand (with a 30-minute debounce).
- **Anti-repeat for proactive messages**: before sending, a char-3-gram Jaccard check against the last 5 assistant turns triggers a temperature-bumped regeneration, and skips entirely if it still collides.
- **Relationship-stage discipline**: strangers don't get called "babe"; premature endearments from the user are gently deflected.
- **Avatar system**: pre-generated pool + aesthetic scoring + persona matching; user uploads are also supported.

### Quick Start

```bash
git clone https://github.com/dimang01/xiyu-ai.git
cd xiyu-ai
npm install
cp .env.example .env
# edit .env: set CHAT_PROVIDER and the matching *_API_KEY
npm start
# open http://localhost:3000
```

Minimal `.env` example:

```dotenv
CHAT_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_deepseek_api_key_here
# or:
# CHAT_PROVIDER=openai
# OPENAI_API_KEY=your_openai_api_key_here
# CHAT_PROVIDER=zhipu
# ZHIPU_API_KEY=your_zhipu_api_key_here
```

Pages after startup:

- `/` landing page
- `/app/auth.html` email signup / login
- `/app/create.html` 4-step character wizard
- `/app/dashboard.html` user dashboard
- `/app/admin.html` admin panel (a 20-char random password is generated on first start and saved to `.admin-credentials`)

### WeChat iLink Login

To connect this AI to a real WeChat account you need an approved Tencent iLink / ClawBot account. A terminal helper prints a QR code; **you** scan it with WeChat and confirm on your phone.

```bash
npm run ilink:login
```

On success the credentials are written to `./.weixin-credentials.json` (file mode 0600, gitignored):

```json
{
  "baseurl": "https://ilinkai.weixin.qq.com",
  "ilink_bot_id": "...",
  "ilink_user_id": "...",
  "bot_token": "...",
  "created_at": "..."
}
```

Credential load priority at runtime:

1. Environment: `ILINK_BOT_TOKEN` + `ILINK_BOT_ID` (optional `ILINK_BASE_URL` / `ILINK_USER_ID`)
2. `./.weixin-credentials.json`
3. Neither → the service still starts; WeChat features are disabled and `/api/health` reports `"wechat": { "configured": false }`.

Notes:

- The QR scan and the "allow login" tap on your phone **must** be done by the account holder. The helper does not, and should not, automate this.
- The helper never prints `bot_token` or the raw response body.
- `npm run ilink:login -- --help` prints usage without hitting the network.

### Multi-provider AI Support

Edit `.env`, no code changes.

| Capability | Supported providers |
|------------|---------------------|
| chat | `deepseek` · `openai` · `anthropic` · `xai` · `zhipu` · `doubao` · `qwen` · `kimi` · `wenxin` |
| image | `zhipu` (CogView-4) · `qwen` (Wanx) · `doubao` · `wenxin` · `openai` (gpt-image-1 / DALL·E) |
| vision | `zhipu` (GLM-4V) · `openai` (gpt-4o-mini) · `qwen` (qwen-vl-plus) · `doubao` · `anthropic` |
| ASR | `gemini` · `openai` (Whisper) · `qwen` (paraformer-v2) · `xunfei` (stub) · `tencent` (stub) |
| embedding | `gemini` · `openai` (text-embedding-3-small) · `zhipu` (embedding-3) · `qwen` (text-embedding-v3) |

Switching example:

```dotenv
CHAT_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_anthropic_api_key_here
CHAT_MODEL=claude-sonnet-4-6
```

For Doubao (火山方舟) you must bind an endpoint and set `CHAT_MODEL=ep-xxx`.

### Repository Structure

```
.
├── index.mjs                Express entry + iLink multi-tenant polling pool
├── src/
│   ├── ai.mjs               Business-layer AI facade (no vendor SDK leakage)
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
│   ├── setup.sh             One-shot bootstrap
│   ├── ilink_login.mjs      Terminal QR login helper
│   ├── check-ilink-status.mjs  iLink health probe
│   └── backup-db.sh         SQLite backup
├── public/                  Static frontend (landing, dashboard, admin)
├── assets/stickers/         Sticker loading mechanism (no image bundled)
└── data/                    Runtime data (gitignored)
```

### Stickers and Assets

The repository ships **only the sticker loading and tag-matching code**; **no actual sticker images are bundled or redistributed**.

- ChineseBQB and other third-party packs belong to their original authors.
- If you want stickers to work, drop your own **licensed** assets into `assets/stickers/` and provide a `manifest.json`.
- AI-generated images (CogView / Wanx / etc.) are run through an `image post-processing pipeline` (crop, webp, compress). Please don't frame that mechanism as "watermark bypass" — it is post-processing, nothing more.

### Security Notice

- `.env`, `.admin-credentials`, `.weixin-credentials.json`, `data/bot.db*`, `data/user_memories/` are all gitignored — **never commit them**.
- The admin password is a 20-char random string generated on first start; it lives in `.admin-credentials` with mode 0600.
- `/api/health` reports the active providers and a boolean WeChat configured flag. It does **not** expose tokens, bot IDs, or user data.
- Any string that looks like `sk-xxx` in this repo is a placeholder — substitute your real keys.
- Be especially careful with minor-safety and crisis scenarios; see the safety/moderation tracker in GitHub Issues.

### Production Notes

If you intend to run this for more than local experiments:

- Reverse-proxy with nginx / Caddy to terminate TLS; bind the Node process to 127.0.0.1.
- Database: WAL is already on; back up `data/bot.db*` regularly (`scripts/backup-db.sh` is a starting point).
- `AUTH_SECRET` should be set explicitly; leaving it empty means a fresh secret per restart and forced logouts.
- The default rate limiter in `src/ratelimit.mjs` is sized for personal use; widen it or place a WAF in front for public deployments.
- Watch chat/image provider costs; the `ai_usage_daily` table is the right place to wire metrics.
- Label AI-generated content per your local laws and the platform's content policy.

### Known Limitations

- TTS voice reply is not implemented (`voice_reply_enabled` is a stub).
- Xunfei / Tencent Cloud ASR providers are stubs — PRs welcome.
- Message deduplication is currently in-process and may briefly repeat after a restart (tracked in Issues).
- Cross-process dedup, automated SQLite backups, crisis-moderation layer and a full production deployment guide are all open Issues — see the tracker.
- WeChat integration requires Tencent iLink / ClawBot approval.

### License

[MIT](./LICENSE) © 2026 Xiyu AI Contributors. See [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md) for credits.
