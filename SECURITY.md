# Security Policy / 安全政策

[中文](#中文) · [English](#english)

---

## 中文

### 数据敏感性

溪语 AI 不是普通的"配置型"开源软件。它本质是一个**陪伴关系记录器**，长期运行会
在 `data/bot.db` 里积累以下数据，每一类都比 SaaS 后台数据敏感得多：

| 数据类型 | 表 | 敏感度 |
|---|---|---|
| 聊天历史（双方原文） | `companion_conversation_turns`、`wechat_messages` | 极高 |
| 长期记忆（她"记得你"的内容） | `companion_memories`、`memory_v2` | 极高 |
| 她的日记 / 反向日记（私密心理画像） | `companion_diary`、`relational_diary` | 极高 |
| 用户偏好（你的喜好/雷区/禁忌） | `companion_preferences`、`user_profiles` | 高 |
| 未完成事项 | `companion_open_loops` | 中-高（含工作/生活细节） |
| 情绪状态 / 关系阶段 | `companions.*emotion*`、`affection_level` | 中 |
| 安全事件（自伤/绝望信号） | `safety_events`（v1.9.0+） | **极高（含心理危机记录）** |
| 用户上传的照片 / 语音 | `data/uploads/`、`public/avatars/` | 中-高 |

**这意味着**：

- `data/` 目录权限设 700，不要让 Web 目录服务（nginx autoindex）能列到它
- SQLite 文件 `data/bot.db` 当作"病历"对待 —— 不要随便发给别人调试
- 备份文件（`data/backups/*.db`）含全量数据，**外传必须加密**（GPG/age 等）
- 用户陪伴史在某些司法辖区可能受**心理健康记录**或**通信隐私**专门法律保护，
  商业部署前请咨询法律
- 自伤/危机信号记录（`safety_events`）极度敏感，**绝不能**用于商业画像或分析

### 数据加密计划

当前（v1.9.0）所有数据以 SQLite 明文存储。如果需要更强的静态加密：

- **文件系统层**：LUKS / dm-crypt / APFS 加密整个 `data/` 目录所在卷（最简单）
- **SQLite 层**：可选 SQLCipher（需替换 `better-sqlite3` → `@journeyapps/sqlcipher`，
  当前仓库不内置；未来可能通过 `DATA_ENCRYPTION_*` 环境变量提供官方支持）
- **字段层**：高敏字段（diary / safety_events）单独加密 —— 当前不提供，
  在 ROADMAP 候选

### 敏感文件

**永远不要 commit** 以下内容到 Git：

- `.env` 与所有 `.env.*` 变体
- 任何 API key / token
- iLink / WeChat bot token（`.weixin-credentials.json`）
- 管理员凭据（`.admin-credentials`、`.admin-secret`、`.auth-secret`）
- SQLite 数据库文件（`data/bot.db*`、`data/user_memories/`）
- 用户聊天日志 / 上传内容
- AI 生成的私有图片（`public/avatars/scenes/`、`public/generated/`）
- 邮件验证码
- 生产部署路径 / 私有备份

仓库根目录的 `.gitignore` 已经覆盖以上所有项，但请务必在 commit 前检查 `git status`。

### 报告安全问题

如果你发现安全漏洞，请通过下列任一方式报告：

- **邮件**：xiyuai@proton.me
- **GitHub Security Advisories**：https://github.com/dimang01/xiyu-ai/security/advisories/new
- 上述渠道不可用时，可在 GitHub 开 Issue，但**只描述影响**，不暴露可被利用的技术细节

请**不要**在漏洞被审阅与修复前公开披露。

### 生产部署提示

本项目是一个开源 / 实验性的 AI 陪伴框架。投入生产前请自行评估并实施：

- 鉴权强化（启用 `AUTH_SECRET`、提升密码策略）
- 速率限制（`src/ratelimit.mjs` 默认面向个人）
- 数据库备份与恢复
- 管理员访问控制（建议放在反代后 + IP 白名单）
- 内容安全 / 危机话术审核
- 隐私合规（GDPR / 个保法 / 当地法规）
- AI 生成内容标识
- 日志脱敏
- Secret 管理（推荐用环境变量注入 / Vault，不要落盘明文）

---

## English

### Data Sensitivity

Xiyu AI is not a typical "config-only" open-source project. It is fundamentally
a **companion relationship recorder**. Long-running deployments will accumulate
the following data in `data/bot.db`, every category of which is far more sensitive
than a typical SaaS backend:

| Data type | Tables | Sensitivity |
|---|---|---|
| Chat history (both sides, verbatim) | `companion_conversation_turns`, `wechat_messages` | Critical |
| Long-term memory (what "she remembers" about you) | `companion_memories`, `memory_v2` | Critical |
| Her diary / relational diary (intimate psychological profile) | `companion_diary`, `relational_diary` | Critical |
| User preferences (your likes / dislikes / taboos) | `companion_preferences`, `user_profiles` | High |
| Open loops (unfinished things you mentioned) | `companion_open_loops` | Medium-High (work/life detail) |
| Emotion state / relationship stage | `companions.*emotion*`, `affection_level` | Medium |
| Safety events (self-harm / despair signals) | `safety_events` (v1.9.0+) | **Critical (mental health record)** |
| Uploaded photos / voice | `data/uploads/`, `public/avatars/` | Medium-High |

**Implications**:

- Set `data/` directory permissions to 700; do NOT let any web server
  (e.g. nginx autoindex) list its contents
- Treat `data/bot.db` like a **medical record** — do not casually share it for
  "debugging"
- Backup files (`data/backups/*.db`) contain full data; **encrypt before
  off-site transfer** (GPG / age / etc.)
- Companion history may be protected by **mental-health record** or
  **communications privacy** statutes in some jurisdictions; consult legal
  counsel before commercial deployment
- Self-harm / crisis signal records (`safety_events`) are extremely sensitive
  and **MUST NOT** be used for commercial profiling or analytics

### Data Encryption Plans

As of v1.9.0, all data is stored in plaintext SQLite. For stronger at-rest
encryption:

- **Filesystem layer**: LUKS / dm-crypt / APFS encryption on the volume holding
  `data/` (simplest)
- **SQLite layer**: SQLCipher (requires replacing `better-sqlite3` with
  `@journeyapps/sqlcipher`; not bundled today; future support may arrive via
  `DATA_ENCRYPTION_*` env vars)
- **Field-level**: High-sensitivity fields (diary / safety_events) encrypted
  individually — not currently offered; tracked as a ROADMAP candidate

### Sensitive Files

**Never commit** the following to Git:

- `.env` and any `.env.*` variants
- Any API key / token
- iLink / WeChat bot tokens (`.weixin-credentials.json`)
- Admin credentials (`.admin-credentials`, `.admin-secret`, `.auth-secret`)
- SQLite database files (`data/bot.db*`, `data/user_memories/`)
- User chat logs / uploads
- AI-generated private images (`public/avatars/scenes/`, `public/generated/`)
- Email verification codes
- Production deployment paths / private backups

The repo's root `.gitignore` already covers all of the above, but always check `git status` before committing.

### Reporting Security Issues

If you find a security issue, please report it through one of the following channels:

- **Email**: xiyuai@proton.me
- **GitHub Security Advisories**: https://github.com/dimang01/xiyu-ai/security/advisories/new
- If the above are unavailable, open a GitHub issue describing the impact only — do **not** include exploitable technical detail.

Please **do not** publicly disclose vulnerabilities before they have been reviewed and patched.

### Production Notice

This project is an open-source, experimental AI companion framework. Before using it in production, review and implement at minimum:

- Authentication hardening (set `AUTH_SECRET`, tighten password policy)
- Rate limiting (defaults in `src/ratelimit.mjs` are sized for personal use)
- Database backup and recovery
- Admin access control (put it behind a reverse proxy + IP allowlist)
- Safety / crisis-language moderation
- Privacy compliance (GDPR / PIPL / your local regulations)
- AI-generated content labeling
- Log redaction
- Secret management (inject via env vars / a secrets manager — do not store plaintext on disk)
