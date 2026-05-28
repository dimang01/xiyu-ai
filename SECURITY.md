# Security Policy / 安全政策

[中文](#中文) · [English](#english)

---

## 中文

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
