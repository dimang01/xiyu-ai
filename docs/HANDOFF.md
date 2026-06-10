# 新对话交接提示词（2026-06-11 刷新，对应 v1.21.2）

> 把下面整段复制给新对话作为第一条消息。它包含让新执行者立刻能干活所需的
> 全部上下文，不依赖任何前面的对话。
> 维护约定：**每次发版后顺手更新本文档**（版本号 / 服务状态 / 候选清单），别等它烂掉。

---

## 项目背景

你是 dimang01/xiyu-ai 开源仓的代码协作者。这是一个 MIT 协议的微信 AI 陪伴
框架（溪语 AI），自托管为主，同时有一个生产部署在 xiyuai.cc 对外运营。

- 开发克隆：`/root/xiyu-ai-opensource`（在这里改代码、发 PR）
- **生产克隆：`/opt/xiyu-ai-new`**（main HEAD = 生产 HEAD，发版后 `git pull` + 重启）
- GitHub：`https://github.com/dimang01/xiyu-ai`
- 默认分支：`main`
- **当前版本：v1.21.2**（package.json 与 git tag 已同步，发版时一起升）
- 规模：55 个 `src/**.mjs` · 17 个 `public/app/*.html` · 77 个 `scripts/` · 100+ releases

功能全景：README「它能做什么」最新最准；`docs/FEATURES.txt` 详述的是
v1.4.1 基线 + 增量索引；逐版本细节看 GitHub Releases。

## 产品哲学（先读，改人设/prompt/proactive 前必读）

- **真人感 = 减法，不是加法。** AI 味的根源是"太好了"——太及时、太顺从、太完美
- **北极星：「愿意在真实生活的空隙给你温柔和陪伴」**——少、准、轻，不是填满
- **调性红线：** 远离黑化/病娇/色气/致郁/沉迷向幻象；NSFW 永不作卖点
- 纯 prompt 拦不住强默认行为，要配**确定性兜底**（出口清洗/硬注入/状态机喂值）
- 详见 CONTRIBUTING.md「产品调性」一节

## 工作流（必须遵守）

1. **绝不直推 main**。所有改动走分支 → PR → CI 绿 → 合并：
   ```bash
   cd /root/xiyu-ai-opensource
   git fetch origin && git checkout -B <branch-name> origin/main
   # 改 → commit → push
   git push -u origin <branch-name>
   gh pr create --base main --head <branch-name> --title "…" --body "…"
   gh pr merge <PR-num> --merge --delete-branch   # CI 绿后（权限受限时留给用户点）
   ```
2. 提交信息风格：`feat:` / `fix:` / `hotfix:` / `chore:` / `docs:` 首行 ≤72 字
3. 合并后不一定发 release；发 release 时 package.json 版本号一起升
4. Claude 协作时带 `Co-Authored-By: Claude <noreply@anthropic.com>` 水印

## 服务运行状态（生产，2026-06-10 实查）

```
进程:     systemd 服务 zhaohy-wechat（历史命名遗留，跑的就是 xiyu-ai）
端口:     3000（nginx 反代 https://xiyuai.cc/api/ → :3000）
目录:     /opt/xiyu-ai-new
重启:     systemctl restart zhaohy-wechat
日志:     journalctl -u zhaohy-wechat -f
备份:     crontab 每日 04:10 → /opt/xiyu-ai-new/data/backups/（scripts/backup-db.sh）
```

`/root/xiyu-ai-opensource` 没有常驻测试实例；要冒烟就临时起
（见下方校验命令），用完杀掉。

### nginx 前端双目录（重要，发版必看）

- nginx root = `/var/www/zhaohy.xyz/frontend/`（**不是**仓库 `public/`）
- **发版后必须 rsync**，否则前端改动不生效：
  ```bash
  rsync -av --exclude='.gitkeep' /opt/xiyu-ai-new/public/ /var/www/zhaohy.xyz/frontend/
  ```
- **运行时素材（`/avatars/` 场景照/头像/候选自拍）不依赖 rsync**：
  2026-06-10 起 nginx 有 `location ^~ /avatars/` 直出 `/opt/xiyu-ai-new/public/avatars/`，
  找不到再 fallback 到 frontend 老目录。新生成的照片即时可见
- nginx 配置：`/etc/nginx/sites-available/xiyuai.cc`，
  `sites-enabled/` 里是**软链**（2026-06-10 整治过；改配置只改 sites-available 这一份，
  `nginx -t && systemctl reload nginx`）

## 配置

- 生产 `.env`：`/opt/xiyu-ai-new/.env`（chmod 600，gitignore）
- 开发 `.env`：`/root/xiyu-ai-opensource/.env`
- 当前生产 provider 组合：DeepSeek(chat) / 302.ai 中转(image，OpenRouter 欠费备
  着随时切回) / MiniMax(TTS) / Qwen(ASR/audio情绪) / Tavily(search) / Resend(邮件)
- ⚠️ 任何 key 出现在对话/日志里，第一时间提醒用户作废重生成

## 测试账号（开发库 data/bot.db）

```
用户名: testuser01   邮箱: test@example.com
（密码如失效让用户重置；生产库的真实用户数据绝不拿来测试）
```

## 关键文件（开干前必读）

| 文件 | 职责 |
|---|---|
| `README.md` | 功能全景（更新最勤，先读它） |
| `docs/ROADMAP.md` | P0→P2 完成情况 + 2026-06 真人感路线回顾 |
| `src/companion.mjs::buildSystemPrompt()` | 18 节人设 prompt 拼接 |
| `src/emotion_state.mjs` | 11 维情绪状态机 + presence |
| `src/relationship_arc.mjs` + `relationship_arc_runtime.mjs` | v1.21 冲突与和好弧（设计：docs/CONFLICT_ARC.md；debug：/app/emotion-debug.html） |
| `src/proactive.mjs` + `proactive_engine.mjs` | 主动消息（读空气/挽留/纪念日/场景照） |
| `src/bot.mjs` | 微信入站主处理器 + 连发合并 |
| `src/inner_os.mjs` | 内心 OS double-pass |
| `src/open_loops.mjs` | 她记得未完成的事 |
| `src/sleep.mjs` | 作息与睡眠系统 |
| `src/escalation.mjs` | 被反复戳的情绪单向升级 |
| `src/photo_planner.mjs` / `photo_sender.mjs` / `visual_identity*.mjs` | 发图链路 |
| `src/db.mjs` | 全部 SQLite + migrateXxx() 注册点（4400 行） |
| `src/api.mjs` | REST，鉴权范式 `requireOwnedCompanion`（4300 行） |
| `public/app/dashboard.html` | 主界面（3400 行） |

## 校验命令

```bash
# 改完必跑
node --check <file>
npm run check:imports
bash scripts/opensource_check.sh   # 必须 6/6 通过

# 启动冒烟（临时实例，跑完杀掉）
DB_PATH=/tmp/x.db API_PORT=3998 PORT=3998 AUTH_MODE=local timeout 7 node index.mjs > /tmp/x.log 2>&1 &
sleep 4 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3998/api/health -m 3
kill %1; rm -f /tmp/x.db*

# 回归全家桶（CI 也跑）
node scripts/p0_regression_check.mjs   # HTTP 部分失败=本地没起服务，可忽略
node scripts/emotion_stress_test.mjs
node scripts/safety_smoke.mjs
npm run arc:digest        # 冲突弧观察周日报（只读；生产加 DB_PATH=/opt/xiyu-ai-new/data/bot.db）
```

## 已知不能做（不要尝试）

| 事情 | 原因 |
|---|---|
| **bot 在微信发语音** | iLink/ClawBot 协议禁止。实测 HTTP 200 但静默丢弃。详见 docs/voice-sprint-plan.md |
| **Pro/Free 分级现在恢复** | 骨架在（`users.plan`/`BETA_ALL_PRO`），但商户号实名卡在运营者年龄，到点再开 |
| **多角色市场 / Live2D / 群聊** | 跟"微信 1:1 单一伴侣"定位冲突；一个微信号只能绑一个 clawbot |
| **NSFW 任何形式** | 调性红线 |

## 当前高价值候选（2026-06-10 评估，按优先级）

1. ~~#4b 关系低谷→冷→和好弧~~（v1.21.0 已落地：6 状态事件状态机 + 依恋调制 +
   红线确定性护栏 + emotion-debug 面板，docs/CONFLICT_ARC.md）；
   **#2「她今天就是不想聊」低能量模式做透**剩余（已并入 v1.21 统一语气出口，
   触发面与表达扩展待做）
2. **分享卡片**：日记/纪念日/聊天瞬间一键生成去隐私化分享图（竖版）。抖音是
   唯一验证获客渠道，让用户的"晒"变成获客飞轮
3. **留存观察**：scripts/retention_dashboard.mjs 看第 7 天还在的用户前 3 天
   做了什么，再决定下一个产品动作
4. ~~未成年人保护~~（v1.20 已落地：minor_guard 检测 + 粘性安全模式 + 年龄声明解除端点）
5. README 顶部 demo GIF（需要真人录屏，等用户自己录）

## 对话风格约定（用户偏好）

- **简体中文**输出（包括 thinking）
- 任何 key 泄露第一时间提醒作废 + 重新生成
- 不要 emoji 滥用，偶尔一两个表达态度可以
- 用户喜欢**先评估再做**：盘点现状 → 方案 → 用户拍板 → 才开始改代码
- **绝不撒谎**：做不到的（如微信语音）明示在 README/dashboard，不假装能用
- 发版后**主动**更新 HANDOFF / memory，不用等用户提醒
