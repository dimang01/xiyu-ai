# 致谢 · Acknowledgments

[中文](#中文) · [English](#english)

---

## 中文

本项目在开发过程中借鉴或直接使用了许多优秀的开源项目和资源，特此致谢。

### 特别致谢

- **Claudecold** — 在项目原型阶段提供了思路、代码评审和 prompt 工程方面的协助。

### 运行时依赖（npm）

| 包 | 用途 | License |
|---|---|---|
| [express](https://github.com/expressjs/express) | Web 服务框架（路由 / 静态文件 / API） | MIT |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | 同步 SQLite 驱动，WAL 模式 | MIT |
| [openai](https://github.com/openai/openai-node) | OpenAI Node SDK，本项目用它统一调用所有 OpenAI-Compatible 厂商（DeepSeek / 智谱 / Kimi / 千问 / xAI / 豆包等） | Apache-2.0 |
| [@google/generative-ai](https://github.com/google-gemini/generative-ai-js) | Google Gemini SDK，用于 embedding 和 ASR | Apache-2.0 |
| [@tencent-weixin/openclaw-weixin-cli](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin-cli) | 腾讯 iLink ClawBot 微信对接 | 商用许可（请遵守腾讯 iLink 协议） |
| [dotenv](https://github.com/motdotla/dotenv) | `.env` 解析 | BSD-2-Clause |
| [form-data](https://github.com/form-data/form-data) | multipart 上传（iLink 媒体上传） | MIT |
| [node-fetch](https://github.com/node-fetch/node-fetch) | Node 端 fetch 兼容 | MIT |
| [qrcode](https://github.com/soldair/node-qrcode) | 生成微信绑定二维码 | MIT |
| [qrcode-terminal](https://github.com/gtanner/qrcode-terminal) | 终端打印二维码 | Apache-2.0 |

### 前端

| 资源 | 用途 | 来源 |
|---|---|---|
| [Tailwind CSS](https://tailwindcss.com) | UI 样式（通过 CDN 引入） | MIT |
| [Lucide Icons](https://lucide.dev) | 图标库 | ISC |
| 系统字体栈 (PingFang / HarmonyOS Sans / Microsoft YaHei) | 中文字体 | 系统自带 |

### 资源 / 素材

| 资源 | 用途 | License |
|---|---|---|
| [ChineseBQB](https://github.com/zhaoolee/ChineseBQB) | 推荐的表情包素材来源（仓库本身 MIT；图片版权归各原作者） | MIT (repo) |
| [Resend](https://resend.com) | 邮件 API（注册 / 找回密码验证码） | 商用 SaaS，免费档可用 |

> ⚠️ 本开源仓库 **不分发任何表情包图片本体**，只保留加载机制（`src/stickers.mjs`）和示例 manifest（`assets/stickers/manifest.example.json`）。
> 单张表情包的版权可能涉及第三方 IP / 影视动漫角色 / 网络梗图等，使用前请自行确认授权并准备你自己的 `assets/stickers/manifest.json`。
> 缺失 manifest 时，表情包功能会自动禁用，应用仍可正常启动。

### AI 服务（运行时按需调用）

本项目把以下 AI 厂商抽象为 provider，用户在 `.env` 中选择：

**文本对话**
- DeepSeek · OpenAI ChatGPT · Anthropic Claude · xAI Grok
- 智谱 GLM · 字节豆包 · 阿里通义千问 · Moonshot Kimi · 百度文心一言

**图像生成**
- 智谱 CogView · 阿里通义万相 · 字节豆包 · 百度文心一格 · OpenAI DALL·E / gpt-image-1

**图片识别**
- 智谱 GLM-4V · OpenAI GPT-4o · 通义千问 VL · 豆包 Vision · Anthropic Claude

**语音识别 (ASR)**
- Google Gemini · OpenAI Whisper · 阿里 paraformer · 讯飞 IAT *(占位)* · 腾讯云 ASR *(占位)*

**文本 Embedding**
- Google Gemini · OpenAI `text-embedding-3` · 智谱 `embedding-3` · 通义 `text-embedding-v3`

### 灵感来源

- 各类微信 AI 陪伴产品在角色一致性、关系演进、主动消息节奏方面的探索
- DeepSeek、智谱开放平台、火山方舟等国产大模型平台的 OpenAI 兼容 API 设计
- "长期记忆 + 长期人设" 这类角色一致性方案在开源项目与论文中的相关讨论，包括但不限于 MemGPT 系列工作

### 报告遗漏

如果发现项目用到了你的代码 / 素材但未在此处致谢，请提 issue 或 PR，我们会立即补充。

---

## English

This project builds on or directly uses many excellent open-source projects and resources. Thanks to everyone involved.

### Special Thanks

- **Claudecold** — for ideas, code review, and prompt-engineering help during the prototype phase.

### Runtime Dependencies (npm)

| Package | Purpose | License |
|---|---|---|
| [express](https://github.com/expressjs/express) | Web framework (routing / static / API) | MIT |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Synchronous SQLite driver, WAL mode | MIT |
| [openai](https://github.com/openai/openai-node) | OpenAI Node SDK — used as a unified client for every OpenAI-compatible vendor (DeepSeek / Zhipu / Kimi / Qwen / xAI / Doubao / …) | Apache-2.0 |
| [@google/generative-ai](https://github.com/google-gemini/generative-ai-js) | Google Gemini SDK for embedding + ASR | Apache-2.0 |
| [@tencent-weixin/openclaw-weixin-cli](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin-cli) | Tencent iLink ClawBot WeChat integration | Commercial license — comply with Tencent iLink ToS |
| [dotenv](https://github.com/motdotla/dotenv) | `.env` parsing | BSD-2-Clause |
| [form-data](https://github.com/form-data/form-data) | multipart upload (iLink media) | MIT |
| [node-fetch](https://github.com/node-fetch/node-fetch) | fetch compatibility on Node | MIT |
| [qrcode](https://github.com/soldair/node-qrcode) | Generating the WeChat binding QR | MIT |
| [qrcode-terminal](https://github.com/gtanner/qrcode-terminal) | Printing QR codes in the terminal | Apache-2.0 |

### Frontend

| Resource | Use | Source |
|---|---|---|
| [Tailwind CSS](https://tailwindcss.com) | UI styling (via CDN) | MIT |
| [Lucide Icons](https://lucide.dev) | Icon set | ISC |
| System font stack (PingFang / HarmonyOS Sans / Microsoft YaHei) | Chinese typeface | OS-provided |

### Assets

| Resource | Use | License |
|---|---|---|
| [ChineseBQB](https://github.com/zhaoolee/ChineseBQB) | Suggested sticker collection (the repo itself is MIT; individual images are owned by their original authors) | MIT (repo) |
| [Resend](https://resend.com) | Transactional email (verification codes for signup / password reset) | Commercial SaaS, free tier available |

> ⚠️ This open-source repository **does not ship any sticker image files**. Only the loading mechanism (`src/stickers.mjs`) and an example manifest (`assets/stickers/manifest.example.json`) are included.
> Individual stickers may involve third-party IP — anime / TV characters, memes, user-contributed art — so verify the licensing of any pack you bring and provide your own `assets/stickers/manifest.json`.
> When the manifest is missing the sticker feature is silently disabled; the app still starts normally.

### AI Services (called at runtime, per user selection)

The project abstracts the following vendors as provider adapters selected via `.env`:

**Chat**
- DeepSeek · OpenAI ChatGPT · Anthropic Claude · xAI Grok
- Zhipu GLM · ByteDance Doubao · Alibaba Qwen · Moonshot Kimi · Baidu Wenxin

**Image generation**
- Zhipu CogView · Alibaba Wanx · ByteDance Doubao · Baidu YiGe · OpenAI DALL·E / gpt-image-1

**Vision**
- Zhipu GLM-4V · OpenAI GPT-4o · Qwen VL · Doubao Vision · Anthropic Claude

**ASR**
- Google Gemini · OpenAI Whisper · Alibaba paraformer · iFlytek IAT *(stub)* · Tencent Cloud ASR *(stub)*

**Embedding**
- Google Gemini · OpenAI `text-embedding-3` · Zhipu `embedding-3` · Qwen `text-embedding-v3`

### Inspiration

- Various commercial WeChat-style AI companion products that explored character consistency, relationship progression and proactive-messaging rhythm
- The OpenAI-compatible API designs published by DeepSeek, Zhipu Open Platform, Volcengine Ark and other Chinese LLM platforms
- The "long-term memory + persistent persona" line of work in open-source projects and papers, including but not limited to the MemGPT series

### Missing Credit?

If you find your work used here without proper credit, please open an issue or PR — we will fix it immediately.
