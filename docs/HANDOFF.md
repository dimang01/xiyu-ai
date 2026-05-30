# 新对话交接提示词（v1.4.1 之后）

> 把下面整段复制给新对话作为第一条消息。它包含让新执行者立刻能干活所需的
> 全部上下文，不依赖任何前面的对话。

---

## 项目背景

你是 dimang01/xiyu-ai 开源仓的代码协作者。这是一个 MIT 协议的微信 AI 陪伴
框架（溪语 AI），自托管为主。

- 本地路径：`/root/xiyu-ai-opensource`
- GitHub：`https://github.com/dimang01/xiyu-ai`
- 默认分支：`main`
- **当前代码版本（main HEAD）**：含 v1.4.1 所有功能
- **package.json 版本**：`1.3.4`（v1.4.0+v1.4.1 都没升版本号，下次发版统一处理）
- **最新已发布 tag**：`v1.3.4`

完整功能清单见 [`docs/FEATURES.txt`](./FEATURES.txt)（先读它，比 README 更准确）。

## 工作流（必须遵守）

1. **绝不直推 main**，auto 模式会拦。所有改动走分支 → PR → 合并：
   ```bash
   git checkout main && git pull origin main
   git checkout -b <branch-name>
   # 改 → commit → push
   git push -u origin <branch-name>
   gh pr create --base main --head <branch-name> --title "…" --body "…"
   # CLEAN 后
   gh pr merge <PR-num> --merge --delete-branch
   ```
2. 提交信息风格：`feat:` / `hotfix:` / `fix:` / `chore:` / `docs:` 首行 ≤72 字
3. 合并后**不一定要发 release**——alpha/beta/hotfix 通常只合并不打 tag
4. 用 `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` 水印

## 服务运行状态

```
PID:         320401（nohup 跑着，跟当前对话无关，可被新执行者直接接管）
端口:        3399
日志:        /tmp/xiyu.log
启动方式:    nohup node index.mjs > /tmp/xiyu.log 2>&1 &
重启:        kill <PID> && nohup node index.mjs > /tmp/xiyu.log 2>&1 &
```

注意：服务器上**还有一个老项目** `/opt/zhaohy-wechat-poc/` 跑在端口 3000，
不要碰它（不是这个开源仓）。

## 配置（.env 已填，但 key 已多次泄露在公开对话）

```
TTS_PROVIDER=minimax  + MINIMAX_API_KEY=sk-api-...
CHAT_PROVIDER=deepseek + DEEPSEEK_API_KEY=sk-...
TTS_MODEL=speech-02-turbo, TTS_VOICE_ID=female-tianmei
VOICE_DAILY_CHAR_LIMIT=500（测试期）
```

⚠️ **用户测完会去作废这些 key**。如果新对话需要继续测试且 key 已失效，
请用户给新 key 你写进 .env（.env 在 .gitignore 里，安全）。

## 测试账号

```
DB: data/bot.db
用户名: testuser01
邮箱:   test@example.com
密码:   xiyu1234（被我重置过）
当前活跃 companion: id=2, name=溪语, user_id=3, 已绑微信
微信 bot_id: 3cdbc5c98214@im.bot
```

## 关键文件（开干前必读）

| 文件 | 职责 |
|---|---|
| `docs/FEATURES.txt` | **完整功能清单（含 DB 表、最近 PR）** |
| `docs/voice-sprint-plan.md` | 语音功能 sprint 计划（含 Sprint 2 失败结论） |
| `docs/ROADMAP.md` | P0/P1/P2A/P2B/P2C 完成情况 |
| `README.md` | 用户视角说明（可能略落后于代码） |
| `src/companion.mjs::buildSystemPrompt()` | 18 节人设 prompt 拼接 |
| `src/emotion_state.mjs` | 情绪状态机（v1.4.1 升级版） |
| `src/proactive.mjs` | 主动消息（晚安/告白/纪念日/场景照） |
| `src/bot.mjs` | 入站消息主处理器 |
| `src/db.mjs` | 全部 SQLite + 所有 migrateXxx() 注册点 |
| `src/api.mjs` | REST，鉴权范式 `requireOwnedCompanion` |
| `public/app/dashboard.html` | 1800+ 行，主界面，含 v1.4.1 想你卡片 |

## 校验命令

```bash
# 改完必跑
node --check <file>
bash scripts/opensource_check.sh   # 必须 6/6 通过

# 启动冒烟
DB_PATH=/tmp/x.db API_PORT=3998 PORT=3998 AUTH_MODE=local timeout 7 node index.mjs > /tmp/x.log 2>&1 &
sleep 4 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3998/api/health -m 3
kill %1; rm -f /tmp/x.db*

# p0 回归（HTTP 部分 13 项失败可忽略——是 :3000 老项目占端口）
node scripts/p0_regression_check.mjs
```

## 已知不能做（不要尝试）

| 事情 | 原因 |
|---|---|
| **bot 在微信发语音** | iLink/ClawBot 协议禁止。实测 HTTP 200 但消息静默丢弃，腾讯官方 SDK 无 sendVoiceMessageWeixin。详见 docs/voice-sprint-plan.md 末尾 |
| **Pro/Free 分级** | v1.3.4 已全部撤掉，所有功能对所有人开放。**不要重新引入** |
| **多角色市场 / Live2D** | 跟"微信单一伴侣"定位冲突 |
| **服务器上动 /opt/zhaohy-wechat-poc/** | 那是另一个项目，与开源仓无关 |

## 当前可以做的高价值候选

来自 grok #6 评估后**未做**的几个（按性价比）：

1. **#5 共同创作**：接龙小说 / 未来计划 timeline。中等工作量，独特玩法
2. **#8 时间胶囊**：在 achievements 基础上加 unlock_at 字段，未来某天打开
3. **#14 心情词云**：从 emotion_history 算 mood 词频，dashboard 一张图
4. **#7 节日皮肤**：fixedHolidays 已识别 14 个节日，加 CSS 变量切换
5. **#10 聊天导出小说**：一次性 AI 调用 + 下载
6. **TTS Sprint 3**：豆包 / Azure / OpenAI provider + 情绪驱动朗读速度
7. **发 v1.4.1 release**：升 package.json + 打 tag + 写 release notes

详细评估见对话历史里 grok 那条的回复表（用户当时选了 #6 语音备忘）。

## 如何被新执行者接管

新对话开干前问用户：
1. 服务进程 `kill 320401` 后想我重启还是你自己起？
2. 用户继续用之前的 testuser01 测试还是新建账号？
3. 这次想做哪个候选功能？

如果用户直接说"做 XX"，先 `cd /root/xiyu-ai-opensource && git checkout main && git pull` 确保最新，然后建分支开干。

---

## 对话风格约定（用户偏好）

- **简体中文**输出，不要日语 / 英文总结
- **单步操作**别批量并发工具调用（之前因为并行调用频繁触发 malformed 错误）
- **任何 key 泄露**第一时间提醒用户作废 + 重新生成
- 用户**不要 emoji 滥用**，但允许偶尔用一两个表达态度
- 用户喜欢**先评估再做**：盘点现状 → 方案 → 用户拍板 → 才开始改代码
- **绝不撒谎**：v1.4.0 试了发现微信发不了 voice，就明示在 README / dashboard，不假装能用
