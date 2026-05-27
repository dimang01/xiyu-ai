# 溪语 AI · Xiyu AI Companion

> 一个有完整人生背景、自带日程、随关系阶段进化的微信 AI 陪伴系统。
> **后端 Node.js + 前端纯静态 HTML，一份 `.env` 即可一键启动。**

A WeChat-based AI companion system with a full backstory, daily schedule, and 5-stage relationship progression. Backend is Node.js + Express + SQLite; frontend is plain HTML. MIT licensed.

[English](#english) | 中文 ↓

---

## 项目简介

「溪语 AI」不是一个普通的"对话机器人"，而是把 AI 当作**有完整人生的虚拟个体**：

- ✅ 注册时自动生成 **46+ 条具体人生记忆**（童年 / 学校 / 家庭 / 朋友 / 价值观 / 小秘密 / 口头禅）
- ✅ 每天有自己的**日程剧本**（学生上学 / 上班族通勤），区分工作日和周末，会在聊天中自然带出来（"我刚下课"）
- ✅ 关系从**陌生人 → 朋友 → 暧昧 → 恋人 → 深爱** 5 阶段自然进化，每阶段差异化称呼/说话方式
- ✅ 像真人微信节奏聊天：每条 ≤15 字，多条连发，自动去 AI 味
- ✅ **主动消息**：早安/晚安 / 日间随机 / 主动表白 / 每 2 天主动发场景照片
- ✅ **长期记忆**：embedding 语义检索 + importance 评分 + 日/周/月归档
- ✅ 完整的网页 Dashboard（关系进度 / 时间轴 / 头像管理 / CP 卡片）
- ✅ 微信通过腾讯 iLink ClawBot 协议接入（无需用户下载 App）

## 一键启动 (本地体验，不接微信)

```bash
# 1. 克隆
git clone <this-repo-url> xiyu-ai && cd xiyu-ai

# 2. 安装依赖
npm install

# 3. 配置 API Key（至少填一个 chat provider 的 key）
cp .env.example .env
# 用编辑器打开 .env，填入：
#   CHAT_PROVIDER=deepseek           # 或 openai / anthropic / xai / zhipu / doubao / qwen / kimi / wenxin
#   DEEPSEEK_API_KEY=your_deepseek_api_key_here          # 对应 provider 的 key
#   AUTH_SECRET=                     # 留空会自动生成

# 4. 启动
npm start

# 5. 浏览器打开 http://localhost:3000
```

服务起来后：
- `/` 落地页
- `/app/auth.html` 注册/登录
- `/app/create.html` 创建 AI 角色（4 步向导）
- `/app/dashboard.html` 控制台
- `/app/admin.html` 管理员后台（管理员账密在首次启动时自动生成到 `.admin-credentials`）

## 支持的 AI Provider

切换 provider 完全不需要改代码，只改 `.env`：

### 文本对话
| ID | 厂商 | 默认模型 | 备注 |
|---|---|---|---|
| `deepseek` | DeepSeek | deepseek-chat | 推荐：性价比之王 |
| `openai`   | OpenAI ChatGPT | gpt-4o-mini | |
| `anthropic`| Anthropic Claude | claude-sonnet-4-6 | 走原生 messages API |
| `xai`      | xAI Grok | grok-2-latest | |
| `zhipu`    | 智谱 GLM | glm-4-flash | 国内免备案可用 |
| `doubao`   | 字节豆包 (火山方舟) | （必填接入点 ID） | `CHAT_MODEL` 必须填 `ep-xxx` |
| `qwen`     | 阿里通义千问 | qwen-plus | DashScope OpenAI 兼容端点 |
| `kimi`     | Moonshot Kimi | moonshot-v1-8k | 长上下文 |
| `wenxin`   | 百度文心 (千帆) | ernie-4.0-8k | |

### 图像生成
| ID | 厂商 | 默认模型 |
|---|---|---|
| `zhipu` | 智谱 CogView-4 | cogview-4 |
| `qwen` | 阿里通义万相 | wanx-v1 |
| `doubao` | 字节豆包 | （必填接入点 ID） |
| `wenxin` | 百度文心一格 | irag-1.0 |
| `openai` | OpenAI gpt-image-1 / DALL-E | gpt-image-1 |

### 图片识别 (Vision)
`zhipu` (GLM-4V) · `openai` (gpt-4o-mini) · `qwen` (qwen-vl-plus) · `doubao` · `anthropic` (Claude)

### 语音识别 (ASR)
`gemini` · `openai` (Whisper) · `qwen` (paraformer-v2) · `xunfei`（占位）· `tencent`（占位）

### 文本 Embedding
`gemini` (gemini-embedding-001) · `openai` (text-embedding-3-small) · `zhipu` (embedding-3) · `qwen` (text-embedding-v3)

## 接入微信（可选）

如需把这个 AI 接到真实微信号，需要在腾讯 iLink ClawBot 平台申请 bot 资格并填入 `.env`：

```dotenv
ILINK_BASE_URL=https://ilinkai.weixin.qq.com
ILINK_BOT_TOKEN=...
ILINK_BOT_ID=...
ILINK_USER_ID=...
WECHAT_TOKEN_ENC_KEY=...
```

详情参见腾讯 iLink ClawBot 官方文档。

## 技术架构

```
┌──────────────────────────────────────────────────────────────┐
│  浏览器 (落地页 + Dashboard)        微信用户                  │
└────────┬───────────────────────────────┬─────────────────────┘
         │                               │
         ▼                               ▼
   ┌───────────────────────────────────────────────────────┐
   │     Express (index.mjs)                               │
   │  ┌─────────┬──────────┬────────────────────────────┐  │
   │  │ api.mjs │ auth.mjs │  iLink polling pool        │  │
   │  └─────────┴──────────┴────────────────────────────┘  │
   │  ┌────────────────────────────────────────────────┐   │
   │  │  bot.mjs  消息处理主管线                        │   │
   │  │    ↓                                            │   │
   │  │  ai.mjs ─→ providers/ ─→ DeepSeek/智谱/...    │   │
   │  │    ↓                                            │   │
   │  │  memory.mjs / companion.mjs / proactive.mjs    │   │
   │  └────────────────────────────────────────────────┘   │
   │  ┌────────────────────────────────────────────────┐   │
   │  │  db.mjs (better-sqlite3, WAL)                  │   │
   │  └────────────────────────────────────────────────┘   │
   └───────────────────────────────────────────────────────┘
```

## 目录结构

```
.
├── index.mjs                        Express 入口 + 多租户 iLink 轮询
├── src/
│   ├── ai.mjs                       业务层 AI 接口（thin facade）
│   ├── providers/
│   │   ├── chat.mjs                 9 个 chat provider 抽象
│   │   ├── image.mjs                5 个图像 provider
│   │   ├── vision.mjs               5 个 vision provider
│   │   ├── asr.mjs                  5 个 ASR provider
│   │   └── embedding.mjs            4 个 embedding provider
│   ├── api.mjs                      80+ REST 路由
│   ├── bot.mjs                      微信消息主处理
│   ├── companion.mjs                System prompt 合成
│   ├── memory.mjs                   记忆提取/检索
│   ├── proactive.mjs                主动消息 / 场景照片
│   ├── plan_tasks.mjs               定时任务（日/周/月总结、日程生成）
│   ├── ilink.mjs                    腾讯 iLink 协议封装
│   ├── db.mjs                       SQLite 全部操作 + 迁移
│   └── ...
├── scripts/                         辅助脚本（生成头像预设池等）
├── assets/stickers/                 表情包加载机制（图片本体不分发，自备 manifest.json）
├── public/                          前端静态文件
│   ├── index.html                   落地页
│   └── app/                         登录/注册/创建/控制台/管理员
└── data/                            运行时数据（gitignored）
```

## 已知限制

- 微信对接依赖腾讯 iLink ClawBot，需自行申请 bot 资格
- TTS（合成语音回复）暂未实现
- 讯飞 / 腾讯云 ASR provider 仅占位，欢迎 PR

## 开发者指南

```bash
# 启动 watch 模式（修改自动重启）
npm run dev

# 查看活跃的 provider
curl http://localhost:3000/api/health

# 数据库备份
bash scripts/backup-db.sh
```

## License

[MIT](./LICENSE) © 2026 溪语 AI Contributors

## 致谢

详见 [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md)。特别感谢 **Claudecold** 在 prompt 工程和原型阶段的贡献，以及 ChineseBQB、DeepSeek、智谱、阿里 DashScope、火山方舟等开放平台的支持。

---

## English

**Xiyu AI** is an open-source WeChat AI companion system. It treats the AI not as a chatbot but as a **virtual person** with a complete past:

- Auto-generated **46+ specific life memories** at registration (childhood / school / family / fears / habits)
- Daily **schedule scripts** (student vs. office-worker, weekday vs. weekend) that naturally surface in chat
- 5-stage **relationship progression** (stranger → friend → flirting → lover → deep love), each with distinct nicknames and speech patterns
- Real-person texting cadence (≤15 chars per message, multi-burst sending, anti-AI tone)
- **Proactive messages**: morning/night greetings, random daytime pings, spontaneous confessions, scene photos every ~2 days
- **Long-term memory** with semantic embedding retrieval + importance scoring + daily/weekly/monthly archives
- Full web dashboard, admin panel, CP-card sharing

### One-line philosophy

Switch any of the 9 chat models, 5 image models, 5 ASR engines just by editing `.env` — no code changes.

### Quick start

```bash
git clone <repo>
cd xiyu-ai
npm install
cp .env.example .env   # set CHAT_PROVIDER + one API key
npm start              # http://localhost:3000
```

MIT licensed. Contributions welcome.
