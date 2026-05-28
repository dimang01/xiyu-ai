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

### 进一步

完整的生产部署 walkthrough（备份策略 / 监控接入 / 多实例 / 日志切割）正在写，跟踪 [Issue #5](https://github.com/dimang01/xiyu-ai/issues/5)。

---

## English

This directory holds drop-in templates for running Xiyu AI long-term on a VPS. Nothing in here is invoked automatically by `npm install` or `docker compose up` — copy, tweak, and use as needed.

### Files

| File | Purpose |
|---|---|
| `xiyu-ai.service` | systemd unit — runs the service as a dedicated `xiyu` user, enabled on boot, auto-restart on crash |
| `nginx.conf.example` | nginx reverse proxy example — TLS termination, forwards to local port 3000 |

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

### Further reading

A fuller production-deployment walkthrough (backup strategy, monitoring, multi-instance, log rotation) is being drafted — tracked in [Issue #5](https://github.com/dimang01/xiyu-ai/issues/5).
