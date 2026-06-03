# 生产部署指南

> 这是把溪语 AI 从"本地 npm start"推到"长期跑在服务器上"的实操指南。
> 默认假设你是 **自托管单用户 / 小规模** 场景（家用 NAS、个人 VPS、小团队内网）。
> 如果你要做"对外公网 + 多用户 + 商业服务"，请额外阅读末尾的 **多用户边界** 一节。

---

## 0. TL;DR · 选一个起点

| 场景 | 推荐方案 | 章节 |
|---|---|---|
| 自己玩 / NAS 单机 | systemd + SQLite | [3 systemd](#3-systemd-自启) |
| 同事/家人共用 | systemd + nginx + HTTPS | [3](#3-systemd-自启) + [2 HTTPS](#2-https-反向代理) |
| Docker 习惯者 | docker compose | [4 Docker](#4-docker-compose) |
| 公网部署 | systemd + Caddy/nginx + 备份计划 | 全文 + [7 备份](#7-备份与恢复) |

---

## 1. 推荐部署结构

```
                       ┌────────────────┐
   公网用户 ───HTTPS──► │  nginx/Caddy   │ ──► Node app :3000
                       │  反向代理       │     (index.mjs)
                       └────────────────┘            │
                                                     ▼
                                              ┌─────────────┐
                                              │  SQLite     │
                                              │ data/bot.db │
                                              └─────────────┘
                                                     │
                                              ┌──────┴───────┐
                                              ▼              ▼
                                          data/backups   data/uploads
                                          (定时备份)      (媒体文件)
```

**关键原则**：
- 应用进程不直接暴露公网，前面必须有一层反向代理负责 HTTPS / 限流 / Basic Auth
- `data/` 目录是**最敏感**的，包含聊天历史/记忆/日记。文件权限 700，目录外人不可读
- `.env` 文件权限 600，包含所有 API key 和 admin 凭据
- 备份直接 `data/bot.db` 即可，不需要导出 SQL

---

## 2. HTTPS 反向代理

### 2.1 Caddy（推荐 · 自动 HTTPS）

`/etc/caddy/Caddyfile`：

```caddy
chat.example.com {
    reverse_proxy 127.0.0.1:3000

    # 上传大小（头像/聊天图片）
    request_body {
        max_size 20MB
    }

    # 日志
    log {
        output file /var/log/caddy/xiyu-ai.log
        format json
    }
}
```

Caddy 自动申请 / 续签 Let's Encrypt 证书。

### 2.2 nginx + Certbot

`/etc/nginx/sites-available/xiyu-ai`：

```nginx
server {
    listen 443 ssl http2;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    client_max_body_size 20M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
    }
}

server {
    listen 80;
    server_name chat.example.com;
    return 301 https://$host$request_uri;
}
```

申请证书：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d chat.example.com
```

### 2.3 Cloudflare 隧道（无公网 IP / NAT 后部署）

```bash
cloudflared tunnel create xiyu-ai
cloudflared tunnel route dns xiyu-ai chat.example.com
cloudflared tunnel run --url http://127.0.0.1:3000 xiyu-ai
```

Cloudflare 自动接管 HTTPS 终端，**强烈推荐**给家用 NAS / 内网部署。

---

## 3. systemd 自启

`/etc/systemd/system/xiyu-ai.service`：

```ini
[Unit]
Description=Xiyu AI · WeChat-style AI companion
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=xiyu                              # 专用 user，不要用 root
WorkingDirectory=/opt/xiyu-ai
ExecStart=/usr/bin/node index.mjs
Restart=on-failure
RestartSec=5

# 资源限制（按需调）
MemoryMax=2G
TasksMax=512

# 安全加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/xiyu-ai/data /opt/xiyu-ai/logs

# 环境变量（也可以放 EnvironmentFile=/opt/xiyu-ai/.env）
EnvironmentFile=/opt/xiyu-ai/.env

# 输出到 journald（用 journalctl -u xiyu-ai -f 查看）
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo useradd -r -s /bin/false xiyu
sudo chown -R xiyu:xiyu /opt/xiyu-ai
sudo chmod 600 /opt/xiyu-ai/.env
sudo systemctl daemon-reload
sudo systemctl enable --now xiyu-ai
sudo systemctl status xiyu-ai
```

常用命令：

```bash
journalctl -u xiyu-ai -f          # 实时查看日志
journalctl -u xiyu-ai --since "1 hour ago" -p err  # 最近一小时的错误
sudo systemctl restart xiyu-ai    # 重启
sudo systemctl reload xiyu-ai     # 优雅重启（如果支持）
```

---

## 4. Docker Compose

仓库根目录已经有 `Dockerfile` 和 `docker-compose.yml`。

最小生产配置：

```yaml
version: '3.8'
services:
  xiyu-ai:
    build: .
    container_name: xiyu-ai
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"   # 只绑 localhost，由前置 nginx/caddy 接管
    volumes:
      - ./data:/app/data         # SQLite + 备份 + 头像 + 上传
      - ./logs:/app/logs
    env_file:
      - .env
    environment:
      - NODE_ENV=production
      - TZ=Asia/Shanghai
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1))"]
      interval: 30s
      timeout: 5s
      retries: 3
```

启动：

```bash
docker compose up -d
docker compose logs -f
docker compose pull && docker compose up -d   # 更新
```

---

## 5. .env 与凭据管理

**最低安全要求**：

```bash
chmod 600 .env
chown xiyu:xiyu .env       # 与运行 user 一致
```

**永远不要**：
- 把 `.env` commit 到 git（仓库 `.gitignore` 已经覆盖）
- 在群聊/Issue 里贴 .env 内容
- 用 root 跑应用，让 .env 在 /root 下

**轮换 API key**：

```bash
# 编辑 .env 后重启即可
sudo systemctl restart xiyu-ai
# 或 docker compose restart
```

---

## 6. 资源估算

| 规模 | CPU | 内存 | 磁盘 | 备注 |
|---|---|---|---|---|
| 单用户 / NAS | 1 vCPU | 512MB – 1GB | 1 – 5GB | SQLite 单文件，备份方便 |
| 5 – 10 用户 | 1 – 2 vCPU | 1 – 2GB | 5 – 20GB | 注意 provider 并发限流 |
| 50+ 用户 | 不推荐用本项目原架构 | — | — | 见末尾"多用户边界" |

**磁盘增长来源**：
- 聊天历史：约 100KB / 用户 / 天（取决于消息频率）
- 长期记忆 + embedding：约 50KB / 用户 / 天
- 头像 + 场景照：每张 100KB – 1MB（按是否启用场景照功能）
- 日志：默认 LOG_LEVEL=info 每天约 10MB（active companion）

**性能调优**：
- WAL 模式已默认启用（`journal_mode=WAL`）
- mmap 256MB / cache 64MB（已设置）
- 高并发时增加 `busy_timeout`（已设 5000ms）

---

## 7. 备份与恢复

### 7.1 备份

仓库自带 `scripts/backup-db.sh`：

```bash
bash scripts/backup-db.sh
```

它会：
- 用 SQLite 的 `.backup` 命令做一致性快照（不会与 WAL 冲突）
- 输出到 `data/backups/bot-YYYYMMDD.db`
- 自动清理 7 天前的旧备份

**定时备份**（cron 每天 4:00）：

```cron
0 4 * * * cd /opt/xiyu-ai && bash scripts/backup-db.sh >> logs/backup.log 2>&1
```

**异地备份**（强烈建议）：

```bash
# 每周把最新备份 rsync 到另一台机器
0 5 * * 0 rsync -avz /opt/xiyu-ai/data/backups/ user@backup-host:/backups/xiyu-ai/
```

**加密备份**（公网部署或第三方备份服务）：

```bash
# 用 GPG 加密后再上传
gpg --symmetric --cipher-algo AES256 data/backups/bot-20260603.db
# 输出 bot-20260603.db.gpg
```

### 7.2 恢复演练（v1.9.0+ 新增）

`scripts/restore-db.sh` 提供完整恢复闭环：

```bash
# 列出可用备份
bash scripts/restore-db.sh --list

# 从最新备份恢复
sudo systemctl stop xiyu-ai
bash scripts/restore-db.sh --latest
sudo systemctl start xiyu-ai

# 从指定文件恢复
bash scripts/restore-db.sh data/backups/bot-20260601.db
```

脚本会：
1. 校验备份文件完整性（`PRAGMA integrity_check`）
2. 验证关键表存在（companions / memories / conversation_turns）
3. **把当前 DB 改名保留**（`bot.db.before-restore-<ts>`），不删除
4. 复制备份替换 DB
5. 跑 `npm run doctor` 验证

**强烈建议**：每月跑一次恢复演练（在测试机），确认备份**真的可用**。"有备份"不等于"能恢复"。

---

## 8. 日志管理

应用日志通过 `LOG_LEVEL` 环境变量控（debug / info / warn / error）。

**systemd 部署**：日志走 journald，自带轮转。查阅：

```bash
journalctl -u xiyu-ai -f
journalctl -u xiyu-ai --vacuum-time=30d   # 清 30 天前
```

**Docker 部署**：建议在 `docker-compose.yml` 限制 log driver 大小：

```yaml
services:
  xiyu-ai:
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
```

**裸 node 部署**：用 `logrotate`：

```
# /etc/logrotate.d/xiyu-ai
/opt/xiyu-ai/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 600 xiyu xiyu
}
```

---

## 9. 健康检查与监控

应用暴露 `GET /healthz`（返回 200 = 进程活着）和 `GET /api/admin/health`（带认证，返回 DB 连接 / provider 状态）。

**外部探活**（Uptime Kuma / 自建）：每分钟探一次 `/healthz`。

**provider 健康**：v1.9.0 在 `ai.mjs` 加了 retry，瞬时 429/5xx 自动重试。如果想观察失败率：

```bash
journalctl -u xiyu-ai -p warn --since "1 hour ago" | grep -E '\[ai\] retry|\[Proactive\]\[fail\]'
```

`[Proactive][fail]` 是标准化字段（companion / kind / error_type / latency_ms），方便 grep 汇总。

---

## 10. 升级流程

```bash
# 1. 备份
bash scripts/backup-db.sh

# 2. 拉新代码
cd /opt/xiyu-ai
git fetch
git checkout v1.9.0       # 或者 main

# 3. 更新依赖
npm ci --production

# 4. 跑发版 smoke
bash scripts/release_smoke_test.sh

# 5. 重启
sudo systemctl restart xiyu-ai

# 6. 验证
journalctl -u xiyu-ai -f
# 等到看到 "polling started" 之类的启动日志再关
```

DB schema 迁移是**自动**的（`src/db.mjs::initSchema()` + 各 `migrateXxx()` 在启动时跑）。不需要手动 `alembic upgrade` 之类的命令。

**回滚**：

```bash
sudo systemctl stop xiyu-ai
bash scripts/restore-db.sh --latest    # 如果新版本动了 schema
git checkout v1.8.3                    # 回旧版本
npm ci --production
sudo systemctl start xiyu-ai
```

---

## 11. 多用户边界

**本项目默认更适合**：
- 单用户 / 家庭共用 / 小团队（≤ 10）
- 自托管，运维自己负责

**如果你打算做公网多用户商业服务**，需要额外考虑（本仓库**不提供**）：

| 关注点 | 自托管小规模 | 公网多用户商业 |
|---|---|---|
| 用户隔离 | dashboard 多 companion 已支持 | 需账号体系 + 数据分库 |
| 限流 | `src/ratelimit.mjs` 简单 IP 限流 | 需要更精细的账户级配额 |
| 审计 | 日志 + 备份 | 需要操作审计 trail（GDPR/PIPL 合规） |
| 内容安全 | `moderation.mjs` 关键字 | 接阿里云 / 腾讯云内容安全 API |
| 隐私合规 | 用户自管 | 需要隐私协议 / 删除请求 / 数据导出 |
| 备份 | 本地 + 异地 | 多区域 + 加密 + 测试恢复 |
| 监控 | uptime + log | APM + tracing + 告警 |
| 安全门 | v1.9.0 已有自伤检测 + proactive 安全门 | 需要接专业心理危机 hotline 推送 |

**强烈建议**：商业部署前请**先咨询法律和心理健康专业人士**。AI 陪伴产品的伦理边界比普通 SaaS 复杂得多。

---

## 附：常见问题

**Q: 启动后第一次 npm install 很慢？**
`postinstall` 会跑 `wx-voice compile` 编译语音模块。如果不需要语音，可以设 `npm ci --ignore-scripts` 跳过。

**Q: SQLite 锁了怎么办？**
WAL 模式下基本不会锁。如果出现 `database is locked`，先停应用再 `bash scripts/restore-db.sh --latest`。

**Q: 我能用 PostgreSQL/MySQL 替换 SQLite 吗？**
当前不支持。本项目重度依赖 `better-sqlite3` 的同步 API 和事务模型。如果你真的要换，需要重写 `src/db.mjs` 的全部 3800+ 行。**不推荐**。

**Q: 想跑在低配 VPS（512MB RAM）上？**
关掉 `INNER_OS_MODE=off`（v1.8.2+）能省一半 token，但内存占用主要来自 Node + SQLite mmap。512MB 通常够。

---

更多问题请提 Issue 或在 `docs/HANDOFF.md` 找历史决策记录。
