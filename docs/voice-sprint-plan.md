# v1.4.0 主动发语音模式 · Sprint 计划

> 每个 Sprint 都是 self-contained 的：把对应那节复制给一个新对话/新执行者，他不需要看本文档其他部分就能干完。
> 仅"项目上下文"那节是所有 Sprint 都要先读的公共部分。

---

## 📌 项目上下文（所有 Sprint 通用，开干前先读这节）

### 仓库
- 本地：`/root/xiyu-ai-opensource`
- GitHub：`https://github.com/dimang01/xiyu-ai`
- 默认分支：`main`
- 当前版本：`v1.3.3`（package.json）

### 工作流（必须遵守）
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
2. 发布版本：`git tag -a v1.4.x -m "…" && git push origin v1.4.x && gh release create …`
3. 提交信息用项目风格：`feat:` / `hotfix:` / `chore:` / `docs:`
4. 不要写出 `Co-Authored-By: Claude` 之外的水印；首行 ≤ 72 字符

### 技术栈
- Node.js ≥ 20，ESM only，`type: "module"`
- Express 5、better-sqlite3、dotenv
- 数据库：SQLite 单文件 `data/bot.db`，迁移用 `addColIfMissing` / `CREATE TABLE IF NOT EXISTS` 模式（见 `src/db.mjs` 的 `migrateXxx()` 函数列表）
- 前端：纯静态 HTML + Tailwind CDN + 自家 `public/app/glass.css` 液态玻璃层

### 关键文件职责
| 文件 | 职责 |
|---|---|
| `src/providers/{chat,vision,asr,image,embedding}.mjs` | 5 类能力的 provider 抽象 + REGISTRY |
| `src/ilink.mjs` | 微信 iLink 长轮询 + sendmessage + media 上传 |
| `src/media.mjs` | CDN AES-128-ECB 加密上传（图片已用，**voice 复用**） |
| `src/bot.mjs` | 入站消息主处理器 |
| `src/proactive.mjs` | 主动消息调度（早安/晚安/告白/纪念日/场景照） |
| `src/companion.mjs` | `buildSystemPrompt()` 18 节人设拼接 |
| `src/emotion_state.mjs` | 7 维情绪状态机 |
| `src/db.mjs` | 全部 SQLite + migrate 注册点 |
| `src/api.mjs` | REST API，`requireOwnedCompanion` 鉴权范式 |

### 校验命令
- `node --check <file>` — 改动后必查
- `bash scripts/opensource_check.sh` — 6/6 通过
- `node scripts/p0_regression_check.mjs` — source-level 107 项；末尾 13 项 HTTP 失败是 :3000 老服务占端口，与改动无关，忽略
- 临时启动冒烟：
  ```bash
  DB_PATH=/tmp/x.db API_PORT=3990 PORT=3990 AUTH_MODE=local timeout 7 node index.mjs > /tmp/x.log 2>&1 &
  sleep 4 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3990/api/health -m 3
  kill %1; rm -f /tmp/x.db*
  ```

### 已做完的可参考前例（v1.3.x）
- v1.2.10 SW + 默认采样 (#18)
- v1.2.11 她的日记 (#19) — **provider 抽象 + cron + DB 迁移 + API + 前端页 = 全套范式**
- v1.2.12 纪念日主动祝福 (#20)
- v1.3.0 液态玻璃 UI (#21)
- v1.3.3 主动消息滑块 (#27) — **dashboard 加 slider + DB 字段 + 前端联动 = 范式**

---

## 🎯 v1.4.0 总目标

让"她"能在微信主动给用户发语音消息（晚安/告白/纪念日等场景），覆盖入站 ASR + 出站 TTS 完整"听+说"闭环。

### 协议关键点（必须知道）
- iLink `sendmessage` voice 走 `msg_type=3`、`encode_type=6 (SILK)`
- 音频要先转 **SILK v3**（24kHz mono PCM 编码）
- CDN 上传 AES-128-ECB 加密，本仓 `src/media.mjs::uploadFile` 已实现，voice 走同套
- TTS 输出通常是 mp3/wav，**必须本地转码到 SILK** → 用 `wx-voice` npm 包 + ffmpeg

### TTS Provider 选型（已定）
默认 **MiniMax speech-2.8**（本仓 chat 已支持 minimax，复用账号；新户送 500 字符）；
情感场景进阶 **火山豆包 TTS 2.0**（指令式情感控制，配合 emotion_state 是亮点）。
Sprint 1 只先做 MiniMax；其他在 Sprint 3 补齐。

---

## 🏃 Sprint 1 · TTS 链路打通（5 天）

### 目标
让后端能拿一段中文文本 → 调 MiniMax TTS → 返回 SILK 字节 + 时长（毫秒），并提供一个 `/api/companions/:id/tts-preview` 路由给前端试听 mp3。**不接微信、不发任何东西**。

### 任务清单（按顺序）

#### T1.1 · 加 ffmpeg 依赖 + wx-voice
- `npm install wx-voice --save`
- Dockerfile 在 `apt-get install` 行加 `ffmpeg`
- 本地装 ffmpeg 验证：`ffmpeg -version`
- 验收：`node -e "require('wx-voice')"` 不报错

#### T1.2 · 新增 `src/providers/tts.mjs`
仿 `src/providers/vision.mjs` 范式（OpenAI-compat 优先）：
- 导出 `REGISTRY`，先只有 `minimax` 一项
  ```js
  minimax: {
    baseURL: 'https://api.minimax.chat/v1',
    defaultModel: 'speech-2.8',
    apiKeyEnv: 'MINIMAX_API_KEY',
    label: 'MiniMax speech-2.8',
    kind: 'minimax-native', // 不是 openai-compat
  }
  ```
- 导出 `getActiveProviderName()` / `getApiKey()`（同 vision.mjs 模式：env → app_settings → 报错）
- 导出 `async function ttsSynthesize(text, { voice_id, speed, emotion } = {})`
  - 返回 `{ audio: Buffer, format: 'mp3' }`（先不转码）
- MiniMax 调用文档查官方：`POST /v1/t2a_v2` with `voice_id` / `speed` / `emotion`
- 失败：抛 Error 含 `[tts]` 前缀，让 caller 决定降级

#### T1.3 · 新增 `src/voice_pipeline.mjs`
- 导出 `async function synthesizeAndConvertToSilk(text, opts)`：
  1. 调 `ttsSynthesize` 拿 mp3 Buffer
  2. 写临时文件（用 `os.tmpdir()` + 随机名）
  3. 用 wx-voice 编码到 SILK，得 silk 文件 + duration_ms
  4. 读回字节 → 删临时文件 → 返回 `{ silk: Buffer, duration_ms: number, mp3: Buffer }`
- 全程 try/finally 删临时文件，**任何一步失败都不能留垃圾**
- 失败抛 Error，**不要 fallback 到文本**（这是 Sprint 2 的事）

#### T1.4 · DB 字段
在 `src/db.mjs` 加 `migrateVoiceReply()`，注册到迁移列表（紧跟在 `migrateProactiveDailyTarget` 后面）：
- `addColIfMissing('companions', 'voice_reply_enabled', 'INTEGER DEFAULT 0')`
- `addColIfMissing('companions', 'voice_id', 'TEXT')`  — provider 自家的 voice id
- `addColIfMissing('companions', 'voice_speed', 'REAL DEFAULT 1.0')`（这个字段早就在 schema 里，跳过，addColIfMissing 自身幂等）
- 把 `voice_reply_enabled` / `voice_id` 加进 `ALLOWED_FIELDS`

#### T1.5 · `/api/companions/:id/tts-preview` 路由
在 `src/api.mjs` 加（仿 `/diary` 范式）：
```
POST /api/companions/:id/tts-preview
body: { text: string }
→ audio/mpeg (mp3 字节)
```
- `requireOwnedCompanion` 鉴权
- text 长度上限 100 字符，防滥用
- 直接返回 mp3 字节流（**不返 SILK**，浏览器播放 mp3 简单），SILK 转码留给微信路径用
- res.setHeader('Content-Type', 'audio/mpeg')

#### T1.6 · 端到端验证脚本
写一个 `scripts/voice_smoke.mjs`（不进 release，用完删/或留作开发工具）：
- 读 MINIMAX_API_KEY 环境变量
- 调 `synthesizeAndConvertToSilk('你好我是溪语')`
- 写 `/tmp/voice_test.silk` 和 `/tmp/voice_test.mp3`
- console.log duration_ms 和文件大小

### 验收
- [ ] `node --check src/providers/tts.mjs src/voice_pipeline.mjs src/db.mjs src/api.mjs` 全过
- [ ] `bash scripts/opensource_check.sh` 6/6
- [ ] 启动冒烟：`/api/health` 200
- [ ] 配上真 MINIMAX_API_KEY，`scripts/voice_smoke.mjs` 跑出 mp3 + silk 两个文件
- [ ] mp3 用本机播放器能听见
- [ ] silk 用 wx-voice 反解回 mp3 也能听见

### 发布
- 分支：`v1.4.0-alpha-tts-pipeline`
- PR 标题：`feat: TTS pipeline (MiniMax + wx-voice) [v1.4.0-alpha]`
- 不打 tag、不发 release，**这是 alpha**
- package.json **不**升版本

### 不要做的事（明确边界）
- ❌ 不要接 iLink 发语音
- ❌ 不要改 proactive.mjs / bot.mjs
- ❌ 不要加 setup wizard 或 dashboard UI
- ❌ 不要做豆包/Azure/OpenAI provider
- ❌ 不要做降级、用量上限、情感映射

---

## 🏃 Sprint 2 · 接微信出站 + 业务接入（5 天）

### 前置
Sprint 1 已合并进 main。

### 目标
让"她"能在三个高价值场景**真的发出**微信语音：晚安 / 告白 / 纪念日。用户可在 dashboard 一键开关。**默认关**，失败优雅降级到文本。

### 任务清单

#### T2.1 · `src/ilink.mjs::sendVoiceMessage`
仿 `sendMessageItem` 的实现：
- 参数：`ctx, toUserId, silkBuffer, duration_ms, contextToken`
- 走 `src/media.mjs::uploadFile` 上传 silk 字节 → 拿 voice item
- 调 `sendMessage` 把 voice item 当 `msg_items[0]` 发出
- 包 setLastStatus / log（同 sendImage 风格）
- voice 的 `encode_type=6`、`item.type='voice'`、`voice_item.duration_ms`

参考：`src/media.mjs::uploadFile` 已经处理了 CDN AES，沿用即可。如果 uploadFile 对 voice 类型有缺漏，按需扩展（保持图片路径不破）。

#### T2.2 · 出站决策：哪些回复发语音
**只在 proactive.mjs 接，bot.mjs 暂时不接**（普通对话自动转语音风险高，先稳）：

在 `src/proactive.mjs::sendProactiveMessage` 加分支：
- 仅当 `companion.voice_reply_enabled === 1`
- 仅当 `effectiveKind` ∈ `['goodnight', 'confession', 'reminder']`
- 仅当 reply 长度 ≤ 60 字（太长的语音体验差 + 烧 token）

流程：
```js
if (shouldVoice) {
  try {
    const { silk, duration_ms } = await synthesizeAndConvertToSilk(reply, {
      voice_id: companion.voice_id || DEFAULT_VOICE_ID,
      speed: companion.voice_speed || 1.0,
    });
    await sendVoiceMessage(ctx, companion.wechat_user_id, silk, duration_ms, null);
    // 还要保存对话轮 + 用量 + log
    return;
  } catch (e) {
    log('warn', `[Proactive] voice 失败 fallback 文本 companion=${companion.id}: ${e.message}`);
    // 继续走原文本路径
  }
}
// 原 sendTextMessage 路径
```

**关键**：voice 失败必须无感降级到文本，不能因为 TTS 挂了就什么都不发。

#### T2.3 · 用量上限
新增 `src/db.mjs::recordVoiceUsage(companionId, charCount)` + `getVoiceUsageToday(companionId)`：
- 新表 `companion_voice_usage(companion_id, date_key, char_count, count)` UNIQUE(companion_id, date_key)
- proactive 发语音前查当日字符数，超过 `VOICE_DAILY_CHAR_LIMIT`（env 默认 2000）就跳过 voice 走文本
- 失败也不计数

#### T2.4 · Dashboard 开关
在「主动找你」卡片下面（v1.3.3 加滑块那块），加：
- 一个 toggle「语音回复」(`t-voice`)，绑 `companion.voice_reply_enabled`
- 一个细灰字提示："仅在晚安/告白/纪念日时发语音，最多 N 字符/天"

完全照 v1.3.3 改动 dashboard 的模式，不再赘述。

#### T2.5 · `/api/companions/:id/tts-preview` 升级
Sprint 1 路由复用，但 voice_id / speed 改成从 query 读：
- 让 dashboard 后续做"试听"按钮时能传当前选择的 voice_id 测试

#### T2.6 · 自动化测试
- 单测：mock TTS provider 返回固定字节，验证 sendVoiceMessage 调用参数正确
- mock TTS 抛错，验证 proactive 优雅降级到文本

### 验收
- [ ] 所有 syntax / opensource_check / 启动冒烟通过
- [ ] dashboard 开关能存能读
- [ ] 改 companion.voice_reply_enabled=1 + 真实 MINIMAX_API_KEY + 等到晚安触发，微信能收到语音
- [ ] 故意配错 API key，微信收到的是文本晚安（降级生效）
- [ ] 当日用量超限后，下次触发收到的是文本
- [ ] 普通对话回复**仍然全是文本**（bot.mjs 没改）

### 发布
- 分支：`v1.4.0-beta-wechat-voice`
- PR 标题：`feat: WeChat outbound voice for goodnight/confession/reminder [v1.4.0-beta]`
- 不打 tag、不发 release，**这是 beta**
- 内部测试 3-5 天观察微信账号有没有受限

### 不要做的事
- ❌ 不要让 bot.mjs 的普通对话回复转语音（容易触发风控）
- ❌ 不要做声音克隆、emotion 映射
- ❌ 不要做 setup wizard 入口（v1.4.0-stable 阶段做）

---

## 🏃 Sprint 3 · 4 家 Provider 齐全 + 风控观察期（4-7 天）

### 前置
Sprint 2 beta 已经在你的真实微信号上跑 3-5 天，没被风控。如果被风控，先调 trigger 阈值再继续。

### 目标
TTS Provider 加齐（豆包、Azure、OpenAI），情绪状态机接通豆包指令式情感，**setup wizard 加第四块「🔊 语音回复」**，p0_regression 加 voice 用例。

### 任务清单

#### T3.1 · 豆包 TTS provider
- `src/providers/tts.mjs` REGISTRY 加 `doubao` 项（火山方舟接入点 ID 模式，类似 vision 那家）
- 注意豆包按年付 + 按音色，文档示例填 `voice_type=zh_male_xxx`
- 豆包**指令式情感**接 `voice_pipeline.mjs`：
  - 加 `opts.emotion`（'happy'|'sad'|'tender'|'whisper'…）
  - 调用时塞进 doubao 请求 body
  - 其他 provider 忽略这参数

#### T3.2 · Azure / OpenAI TTS provider
- Azure：`baseURL` 走 `https://<region>.tts.speech.microsoft.com`，SSML 格式
- OpenAI：`/v1/audio/speech`，`model=tts-1`
- 两家都加进 REGISTRY，setup wizard 自动出现选项

#### T3.3 · 情绪状态机 → 语音 emotion 映射
在 `src/emotion_state.mjs` 加：
```js
export function emotionStateToVoiceEmotion(emotionState) {
  // affection >= 70 + mood='happy' → 'tender'
  // mood='sad' → 'sad'
  // energy < 30 → 'whisper'
  // 默认 'neutral'
}
```
`proactive.mjs` 调用 voice_pipeline 时传这个 emotion，**仅豆包/支持的 provider 会用**。

#### T3.4 · Setup Wizard 第 4 块
在 `public/app/setup.html` 的 vision/asr 旁加「🔊 语音回复（tts）」折叠块：
- Provider 下拉：不启用 / MiniMax / 豆包 / Azure / OpenAI
- Model / API Key 输入框
- 保存 / 清除按钮
- 完全照 vision 那块复制

后端 `/api/setup/provider-config` 加 `capability === 'tts'` 分支（同 vision/asr）。

#### T3.5 · 试听按钮
dashboard 「语音回复」toggle 旁加按钮：
- 点击 → 弹"输入想试听的文本" → 调 `/api/companions/:id/tts-preview?text=…`
- 拿 mp3 直接 `<audio>` 播放
- 用浏览器自带 Audio API，不依赖第三方播放器

#### T3.6 · p0_regression 加 voice 用例
`scripts/p0_regression_check.mjs` 加：
- 检查 `src/providers/tts.mjs` 存在
- 检查 `src/voice_pipeline.mjs` 存在
- 检查 `companion_voice_usage` 表能查
- 检查 `/api/companions/:id/tts-preview` 未登录返回 401

#### T3.7 · 风控应对（如果 Sprint 2 观察到了问题）
按情况调整 proactive 触发条件 / 加更长冷却 / 减少最大每日 voice 数。

### 验收
- [ ] 4 家 provider 都能在 setup wizard 配 + 试听都能出声
- [ ] dashboard 试听按钮工作
- [ ] 豆包 voice 在情绪 happy/sad/whisper 时听感不同
- [ ] p0 通过，opensource_check 6/6

### 发布
- 分支：`v1.4.0-rc-providers`
- PR 标题：`feat: 4-provider TTS + emotion-aware voice [v1.4.0-rc]`
- 还是不打 tag，等 Sprint 4 一起发

---

## 🏃 Sprint 4 · 文档 + Docker + 发布（2-3 天）

### 前置
Sprint 3 已合并进 main，所有功能完整。

### 目标
让外部用户能直接 `docker pull ghcr.io/dimang01/xiyu-ai:1.4.0` 上手。

### 任务清单

#### T4.1 · README 加语音章节
在「核心特性」表加一行：
```
| 🔊 **语音回复** *(v1.4.0)* | 晚安/告白/纪念日她会发微信语音；4 家 TTS provider 可选(MiniMax/豆包/Azure/OpenAI)；豆包情绪联动；每日字符上限；失败自动降级文本 |
```

加一段 v1.4.0 更新（顶部，类似 v1.3.0 那段）。

英文部分同步。

#### T4.2 · 写 `docs/voice-setup.md`
详细指南，目标受众：自托管用户。内容：
1. 概念：什么是 TTS、什么是 SILK、为什么需要 ffmpeg
2. 4 家 provider 注册流程、API key 在哪拿、定价
3. ffmpeg 装哪里、Docker 用户用 1.4.0 镜像就自带
4. dashboard 怎么开启
5. 故障排查：发不出语音怎么办、试听能听见但微信收不到怎么办、被风控怎么办
6. 合规提醒：AI 生成内容需显著标识

#### T4.3 · ROADMAP 加 P2C-voice 段
在 `docs/ROADMAP.md` 加：
```
## P2C · Voice — ✅ v1.4.0 Done
| Area | Feature | Status |
| Voice | TTS provider abstraction (4 providers) | ✅ |
| Voice | mp3 → SILK pipeline | ✅ |
| Voice | iLink sendVoiceMessage | ✅ |
| Voice | Goodnight/confession/reminder voice | ✅ |
| Voice | Emotion-aware voice (Doubao) | ✅ |
| Voice | Daily char limit + graceful fallback | ✅ |
| Voice | Setup wizard + dashboard toggle + preview | ✅ |
```

#### T4.4 · Docker 镜像
- Dockerfile 已经在 Sprint 1 加了 ffmpeg
- 确认双架构（amd64 + arm64）能 build
- GitHub Actions 在 tag v1.4.0 时自动构建 + 推 GHCR
- 本地 smoke：
  ```
  docker run -p 3000:3000 -v xiyu-data:/app/data ghcr.io/dimang01/xiyu-ai:1.4.0
  ```

#### T4.5 · package.json 升 1.3.3 → 1.4.0
按 v1.3.x 提交流程走 PR。

#### T4.6 · tag + release
```
git tag -a v1.4.0 -m "v1.4.0: Voice replies — She speaks now"
git push origin v1.4.0
gh release create v1.4.0 --title "v1.4.0 — She speaks now" --notes "…"
```

Release notes 模板：
```
## ✨ 新增：主动发语音

晚安 / 告白 / 纪念日她会发微信语音了。
- 4 家 TTS provider 任选：MiniMax（推荐入门）/ 豆包（情绪最强）/ Azure / OpenAI
- 豆包 provider 自动接情绪状态机：开心时温柔、累时轻声、低落时缓慢
- 默认关，dashboard 一键开
- 每日字符上限保护，失败自动降级文本
- 完整指南见 docs/voice-setup.md

## 升级
docker pull ghcr.io/dimang01/xiyu-ai:1.4.0
（自带 ffmpeg）
```

### 验收
- [ ] README 渲染正常、英文段完整
- [ ] docs/voice-setup.md 第一次读的人能照着配出来
- [ ] Docker 镜像在 amd64 + arm64 都能拉、能跑、能发出 voice
- [ ] v1.4.0 release 出现在 GitHub releases 页且标 Latest

### 不要做的事
- ❌ 不要 v1.4.0 还塞新功能，文档/打包/发布而已
- ❌ 不要忘了清浏览器缓存验证页面新文案

---

## 📋 跨 Sprint 全局注意

### 提交信息规范（看 git log --oneline -20 学）
- `feat:` 新功能
- `hotfix:` 紧急修复（用户报告问题）
- `fix:` 普通修复
- `chore:` 版本/依赖/小杂活
- `docs:` 纯文档

### 测试不要跳
- 每个 Sprint 的"验收"清单全部要勾，不勾不能开 PR
- 启动冒烟是最低门槛，2 分钟的事
- 真机微信测试是 Sprint 2/3 的必经环节，**没有真号就不要开 v1.4.0-stable PR**

### 失败优雅降级是底线
- 任何路径上 TTS 挂了，用户必须能收到文本
- 任何路径上转码挂了，用户必须能收到文本
- 任何路径上 sendVoiceMessage 挂了，用户必须能收到文本

### 风控观察
- Sprint 2 beta 阶段必须 3-5 天连续观察自己微信账号
- 任何异常（被限制、警告）立刻停发 voice，调阈值

### 不要碰的雷区
- ❌ 不要修改 `src/ilink.mjs::sendMessage` 核心路径（图片/文本路径已稳定）
- ❌ 不要给入站 bot.mjs 默认开自动语音回复（风控高危）
- ❌ 不要把 voice_id / API key 写入日志
- ❌ 不要在没有 try/finally 的情况下创建临时文件

---

## 🎯 时间盘
| Sprint | 范围 | 工时 | 累计 |
|---|---|---|---|
| 1 | TTS 链路 | 5 天 | 5 天 |
| 2 | 接微信 + beta 观察 | 5 天 + 3-5 天观察 | 13 天 |
| 3 | 多 provider + 情绪 + setup wizard | 4-7 天 | 20 天 |
| 4 | 文档 + Docker + 发布 | 2-3 天 | 23 天 |

实际节奏：**3-4 周日历时间**（人不会每天 8h 全投）。

---

*文档生成于 v1.3.3 之后。如果开干时本仓已有新版本，优先看 main HEAD 实际情况。*
