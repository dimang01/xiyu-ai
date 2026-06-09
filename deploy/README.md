# Deploy templates / 部署模板

[中文](#中文) · [English](#english)

---

## 中文

这里放的是把溪语 AI 长期跑在 VPS 上的几个模板文件。它们**不会**在 `npm install` 或 `docker compose up` 时被自动用到 —— 需要时复制粘贴改改即可。

### 文件

| 文件 | 用途 |
|---|---|
| `xiyu-ai.service` | systemd unit；把服务以 `xiyu` 用户长期运行，开机自启，崩溃自动重启 |
| `nginx.conf.example` | nginx 反代示例；终结 TLS、转发到本机 3000 端口 |
| `xiyu-ai-backup.service` + `.timer` | 每日 04:10 自动备份数据库（systemd timer 方式） |

### 典型 VPS 部署路径（裸跑，不用 Docker）

```bash
# 1. 拉代码到 /opt
sudo git clone https://github.com/dimang01/xiyu-ai.git /opt/xiyu-ai
sudo useradd -r -d /opt/xiyu-ai -s /sbin/nologin xiyu
sudo chown -R xiyu:xiyu /opt/xiyu-ai

# 2. 装依赖（以 xiyu 用户）
sudo -u xiyu bash -c 'cd /opt/xiyu-ai && npm ci --omit=dev'

# 3. 交互式配置 .env（如果 SSH 终端是 TTY）
sudo -u xiyu bash -c 'cd /opt/xiyu-ai && npm run setup'
sudo chmod 600 /opt/xiyu-ai/.env

# 4. 安装 systemd unit
sudo cp /opt/xiyu-ai/deploy/xiyu-ai.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xiyu-ai
journalctl -u xiyu-ai -f      # 看启动日志

# 5. nginx 反代 + TLS
sudo cp /opt/xiyu-ai/deploy/nginx.conf.example /etc/nginx/sites-available/xiyu-ai
sudo sed -i 's/your-domain.example.com/<your-domain>/g' /etc/nginx/sites-available/xiyu-ai
sudo ln -s /etc/nginx/sites-available/xiyu-ai /etc/nginx/sites-enabled/
sudo certbot --nginx -d <your-domain>
sudo nginx -t && sudo systemctl reload nginx
```

打开 `https://<your-domain>` 应该能看到落地页。如果还没填 chat provider API key，落地页底部会弹出引导条提示去 `/app/setup.html`。

### Docker 路径

如果你用 `docker compose up`，**这里的 systemd unit 就不需要了** —— compose 自身的 `restart: unless-stopped` 已经覆盖了类似职责。nginx 那份配置仍然可以用来在宿主机做 TLS 终结，把 80/443 反代到宿主上 `${HOST_PORT:-3000}` 暴露的 compose 端口即可。

### 定时备份

`scripts/backup-db.sh` 用 SQLite 在线备份 API 做一致快照（应用运行中执行也安全），备份后自动跑 `PRAGMA integrity_check`，默认保留 7 天（`KEEP_DAYS` 可调，`BACKUP_DIR` 可指到异机挂载点）。

接定时两种方式选一种：

**cron（最简单）**

```bash
crontab -e
# 每天 04:10 备份（错开 02:15-03:30 的日记/反思 cron 高峰），日志追加到文件
10 4 * * * cd /opt/xiyu-ai && bash scripts/backup-db.sh >> data/backups/backup.log 2>&1
```

**systemd timer（关机错过会补跑）**

```bash
sudo cp deploy/xiyu-ai-backup.{service,timer} /etc/systemd/system/
# 按实际路径改 service 里的 WorkingDirectory
sudo systemctl daemon-reload
sudo systemctl enable --now xiyu-ai-backup.timer
systemctl list-timers xiyu-ai-backup.timer    # 确认下次触发时间
```

**恢复**（先停应用再恢复，避免 WAL 不一致）：

```bash
bash scripts/restore-db.sh --list      # 看有哪些备份
sudo systemctl stop xiyu-ai
bash scripts/restore-db.sh --latest    # 自动校验完整性 + 旧库保留为 .before-restore-*
sudo systemctl start xiyu-ai
```

建议每季度做一次恢复演练：拿最新备份在测试目录起一个临时实例（`DB_PATH=/tmp/restore-drill.db PORT=3998 node index.mjs`），确认能登录、聊天记录在，再删掉。备份没被恢复验证过之前，不算真的有备份。

### 进一步

完整的生产部署 walkthrough（监控接入 / 多实例 / 日志切割）正在写，跟踪 [Issue #5](https://github.com/dimang01/xiyu-ai/issues/5)。

---

## English

This directory holds drop-in templates for running Xiyu AI long-term on a VPS. Nothing in here is invoked automatically by `npm install` or `docker compose up` — copy, tweak, and use as needed.

### Files

| File | Purpose |
|---|---|
| `xiyu-ai.service` | systemd unit — runs the service as a dedicated `xiyu` user, enabled on boot, auto-restart on crash |
| `nginx.conf.example` | nginx reverse proxy example — TLS termination, forwards to local port 3000 |
| `xiyu-ai-backup.service` + `.timer` | daily 04:10 automated DB backup (systemd timer flavor) |

### Typical VPS deploy (bare-metal, no Docker)

```bash
# 1. Clone into /opt
sudo git clone https://github.com/dimang01/xiyu-ai.git /opt/xiyu-ai
sudo useradd -r -d /opt/xiyu-ai -s /sbin/nologin xiyu
sudo chown -R xiyu:xiyu /opt/xiyu-ai

# 2. Install deps (as the xiyu user)
sudo -u xiyu bash -c 'cd /opt/xiyu-ai && npm ci --omit=dev'

# 3. Interactive .env setup (assuming the SSH session is a TTY)
sudo -u xiyu bash -c 'cd /opt/xiyu-ai && npm run setup'
sudo chmod 600 /opt/xiyu-ai/.env

# 4. Install the systemd unit
sudo cp /opt/xiyu-ai/deploy/xiyu-ai.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xiyu-ai
journalctl -u xiyu-ai -f      # follow startup logs

# 5. nginx reverse proxy + TLS
sudo cp /opt/xiyu-ai/deploy/nginx.conf.example /etc/nginx/sites-available/xiyu-ai
sudo sed -i 's/your-domain.example.com/<your-domain>/g' /etc/nginx/sites-available/xiyu-ai
sudo ln -s /etc/nginx/sites-available/xiyu-ai /etc/nginx/sites-enabled/
sudo certbot --nginx -d <your-domain>
sudo nginx -t && sudo systemctl reload nginx
```

Open `https://<your-domain>` and you should see the landing page. If a chat-provider API key is still missing, the bottom banner will point you at `/app/setup.html`.

### Docker path

When using `docker compose up`, **the systemd unit is unnecessary** — compose's own `restart: unless-stopped` already covers that role. The nginx config is still useful on the host for TLS termination, simply reverse-proxying 80/443 to the compose-exposed `${HOST_PORT:-3000}`.

### Scheduled backups

`scripts/backup-db.sh` takes a consistent snapshot via the SQLite online-backup API (safe while the app is running), runs `PRAGMA integrity_check` on the result, and keeps 7 days by default (`KEEP_DAYS`, `BACKUP_DIR` overridable).

Pick one of two scheduling flavors:

**cron (simplest)**

```bash
crontab -e
# daily 04:10 (clear of the 02:15-03:30 diary/reflection cron window)
10 4 * * * cd /opt/xiyu-ai && bash scripts/backup-db.sh >> data/backups/backup.log 2>&1
```

**systemd timer (catches up after downtime)**

```bash
sudo cp deploy/xiyu-ai-backup.{service,timer} /etc/systemd/system/
# adjust WorkingDirectory in the service file to your install path
sudo systemctl daemon-reload
sudo systemctl enable --now xiyu-ai-backup.timer
systemctl list-timers xiyu-ai-backup.timer
```

**Restore** (stop the app first to avoid WAL inconsistency):

```bash
bash scripts/restore-db.sh --list
sudo systemctl stop xiyu-ai
bash scripts/restore-db.sh --latest    # integrity-checked; old DB kept as .before-restore-*
sudo systemctl start xiyu-ai
```

Do a quarterly restore drill: boot a throwaway instance off the latest backup (`DB_PATH=/tmp/restore-drill.db PORT=3998 node index.mjs`), confirm login + chat history, delete it. A backup that has never been restore-tested isn't a backup.

### Further reading

A fuller production-deployment walkthrough (monitoring, multi-instance, log rotation) is being drafted — tracked in [Issue #5](https://github.com/dimang01/xiyu-ai/issues/5).
