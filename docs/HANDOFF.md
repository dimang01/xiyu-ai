# 新对话交接提示词（2026-06-12 刷新，对应 v1.21.6）

> 把下面整段复制给新对话作为第一条消息。它包含让新执行者立刻能干活所需的
> 全部上下文，不依赖任何前面的对话。
> 维护约定：**每次发版后顺手更新本文档**（版本号 / 服务状态 / 候选清单），别等它烂掉。

---

## 决议记录（已拍板事项账本——列待办/遗留前必读，已决事项不得重新登记为待拍板）

| 日期 | 决议 | 状态 |
|---|---|---|
| 2026-06-10 | 自研 const+= 扫描退役（被 ESLint no-const-assign 全覆盖且原生更准） | ✅ 2026-06-11 本次执行 |
| 2026-06-11 | #279 修复方案：根因修 prompt 组装重复 + 入站二级查重纵深（键=sender+内容+微信侧 create_time，退化 60s 窗）；issue 模板加官方托管选项；gh 只读、对外发言由维护者本人 | ✅ 已执行 |
| 2026-06-11 | #281 取 A（出口护栏 scrubPhotoImpersonation）+ B（sticker prompt 禁令），C（过去式 promise→真生成场景照）拆入 v1.21.4「她的世界的视觉一致性」 | ✅ 本次执行 |
| 2026-06-11 | v1.21.4 前置：好/坏样本标注工具（admin 页+annotation_corpus 表+JSONL 导出）——微调语料生产线，纯只读消费 turns 零运行时风险 | ✅ 本次执行 |
| 2026-06-12 | V1214_DESIGN（current_works）四条评审约束先行入档：作品名搜索验证真实存在/封面照一律 POV 内页书脊(防伪造+版权双坑)/存量虚构靠生命周期自然退场不回溯/现实锚定(天气节气节日)纳入设计范围 | ✅ 已入档 |
| 2026-06-12 | 照片承诺兑现链修复（patch v1.21.5）：PR-A 取证(开环根因)→PR-B 承诺前可行性闸门+超时兜底+her_promise 改期履约+时序修复→PR-C 月相锚定(纯数学杜绝凭空满月)；顺手补 bot.log logrotate。**根因更正(事后)：开环是真实结构纵深、修得对，但 06-11 当晚月亮/书封面"放鸽子"的直接真凶是 #289 的 planner 对象断图 400(非合法可行性拒绝)；her_promise 兜底全保留** | ✅ 已执行 |
| 2026-06-12 | **P0 静默断图 hotfix**：d22bf73(v1.21.2) 改 buildPlannerPrompt 返回 {prompt,shotMode} 却没改 call site→整个对象当 message content 传 LLM(400 content should be a string)→自 06-11 06:54 所有照片(user 索图+proactive 场景照)静默失败 1.5 天，fail-open 吞成 WARN。修：解构出 string prompt + plan 挂 shotMode/aspect(复活 v1.21.2 比例路由死代码)+回归 smoke 锁。**单独部署(最小 diff 干净归因)**：2026-06-12 已 pull+重启，验证恢复(health 200 + prod 主机 planner smoke 16/16) | ✅ 已部署 |
| 2026-06-12 | 照片品类部署拍板：#289 单独部署(修复型不夹带)，PR-A #290 惰性随 PR-D 正常发版；**品类 sampling 开关延到 PR-C 种子落地后随 PR-D 一起开**(现在开=对空场景池采样无意义,一次部署一个变量)；权重表照用；B/C/D 绿灯 | 🔄 执行中 |
| 2026-06-12 | 流程教训：**函数级绿 ≠ 调用链绿**(v1.21.2 e2e 绿着上线一个从没生效的比例路由+对象当 prompt 的 400)——与"本地绿≠CI 绿"并排；改函数返回类型必 grep 所有 call site，回归 smoke 打到真实调用链参数类型(mock llm 捕获断言)。**digest 报警盲区**：错误签名段只扫 [ERROR]，但 swallowed-LLM-failure 是 [WARN][ai]→1.5 天没尖叫；扫描器待扩(catch [ERROR]+高信号 [WARN] 白名单) | ✅ 第一版 #292 已修(白名单法)，极性反转优化见下条 |
| 2026-06-12 | 记功：auto-mode 在生产重启前停下等用户授权——#267 后装的栅栏首次真刀真枪立住(挡下未审 P0 部署) | ✅ |
| 2026-06-12 | **#292 报警极性反转**（立项下个 patch，不阻塞 PR-B）：白名单→反转为 **WARN 全量进签名聚合 + suppress 名单(外置配置文件,每条须注"为何无害"一句话)管已知良性**(cooldown/daily-count 等)，🆕 新签名/高频涨幅置顶。红验①拿这次的 400 烧旧极性必须漏、烧新极性必须报 ②一条已知良性 WARN 加进 suppress 后必须安静 | 📋 已立项 |
| 2026-06-12 | **封面临时护栏**（搭 PR-C 车）：planner prompt 加一行——真实出版物类(书/专辑/杂志/教材)只拍摊开内页或边角局部，不拍完整封面正面；反误伤断言：她自己的笔记本/手账封面不受限(非出版物)。**标注：V1214 正式解之前的临时规矩，正式解落地后此行撤销** | 🔄 搭 PR-C |
| 2026-06-12 | **通电冒烟测试**（立项 backlog，PR-D 顺路或单独 patch）：stub provider 拉起应用，真跑一次 proactive tick + 一次 photo plan 到发送层，断言全链通电(只验电流走通,不验内容质量)；红验：对 buildPlannerPrompt 对象 bug 坏版本必须红。完成后 HANDOFF 记一行"接线类 bug(const+=/migratePhotoLog/buildPlannerPrompt 三案)系统解已上线" | 📋 已立项 |
| 2026-06-12 | **《用户协议》《隐私政策》正式上线生效**（仅官方托管 xiyuai.cc）：四份正文(中英)从 drafts 落 public/app/{terms,privacy}{,.en}.html——中文替换占位模板+英文新增；注册页 auth.html 两链接 href(/app/terms.html、/app/privacy.html)一致可达。**未直接合并 #284**：它捎带的老 HANDOFF 会回退账本、且 drafts 非线上路径——改走干净 PR，#284 待关闭。opensource_check 加协议 xiyuai.cc 排除(官方域名按法律须写明,公开信息) | ✅ 已上线 |
| 2026-06-12 | **死人开关告警出口接线（P1）**：proactive_deadman 出口因 ADMIN_ALERT_EMAIL 未配置而哑火(取址空→只打日志不发)——本次照片断供期为 #263 形态准备的两道报警都没响(digest 盲区 #292 + 此条出口空)。修：抽 emitDeadmanAlert 从 env 取址、sendOpsAlertEmail 返回 message-id 作投递凭据、空收件人改显式 WARN「报警器自己哑了」、加 deadman_test_alert 端到端入口(收件人从 env 读、不写死)。**ADMIN_ALERT_EMAIL 明文只入生产 .env 一处，仓库/PR/账本一律以 ADMIN_ALERT_EMAIL 指代、不写明文** | ✅ 端到端闭环(维护者已配 .env) |
| 2026-06-12 | 规矩：**对外地址与告警地址分离**——proton(对外门面/协议联系)与 ADMIN_ALERT_EMAIL(私人邮箱/运维告警)永不混用；**生产 .env 配置变更=运营者亲手，代码变更=Claude Code 走 PR**(本次 .env 配置由维护者本人执行，Claude 只给精确命令) | ✅ 已记 |
| 2026-06-12 | **死人开关端到端闭环**：deadman_test_alert 真实取址+真发，message-id 凭据进 Gmail **收件箱**(非垃圾箱，发件域 auth.xiyuai.cc SPF/DKIM 正常)。**为 #263 静默断供形态准备的三道防线首次全员在岗**：①错误签名段(#292 扫描扩到高信号 WARN) ②死人开关出口(ADMIN_ALERT_EMAIL 已配+返回 id+空收件人显式 WARN) ③部署后人工 grep error | ✅ 闭环 |
| 2026-06-12 | 照片品类校准（patch 版 4 PR）：①先审计后改配比(#263)——审计实锤：proactive 主动分享 lifetime 仅 1 张(16 张里 15 张 user 索图)，通道近乎休眠，非"配比失衡"而是从零建通道 ②品类权重外置配置文件(默认 sampling 关,保持现状,切换值我拍板再切) ③新增"看到这个想到你"品类(preference/梗源,过指纹去重,taboo/隐私硬排除) ④食物一等公民+天空 sun_times 锚定(雨雪极端天气禁用至天气锚定建成)+caption/互拍升级 ⑤candid 实验 flag 默认关待 20 张评估我定默认值。观察周零 arc/emotion 改动；两停板点（权重切换值 / candid 默认值）我定 | ✅ 代码已合 v1.21.6，开闸待部署 |
| 2026-06-12 | 品类链发版收口 v1.21.6（今天单独发，与明天 v1.21.4 错开——一次部署一个变量、归因干净）：A→B→C 串行合并 main（#290→#300→#301；原 #294/#298 因 stacked base 随 --delete-branch 自动关闭→重开）；package.json + README/FEATURES/ROADMAP 同步、check:release 绿 | 🔄 代码已合，待开闸部署 |
| 2026-06-12 | 编排拍板 A：**首次开闸=运营者亲手**——sampling 总开关 PHOTO_CATEGORY_SAMPLING_ENABLED 是生产 .env 变更，按「配置变更运营者亲手」规矩由维护者配，Claude 只给逐段命令（.env 那行用先 grep 查重再 printf 追加的防重复写法） | ✅ 已记 |
| 2026-06-12 | 长期口径：**env 变更分级**——首次开闸/关闸类 env=运营者亲手；调参类 env=提案后亲手或明确授权；admin 运维配置页上线后调参类整体迁移到页面 | ✅ 已记 |
| 2026-06-12 | v1.21.4 current_works 设计稿主体过评审（#299 合并）+ **四批注落账**：①验证双闸=字符串级（kind《》兜底 + webSearch 判定，不加 LLM）②48h 冷却/周3/生命周期天数等为观察值、全 env 可调入 config ③works 不随人设导出（运行时状态先例，理由成文）④负结果不缓存（只缓 verified 单调正事实，失败/无证据每次重验） | ✅ 已记 |
| 2026-06-12 | **PR-W1（current_works 数据层 + 验证双闸）**：companion_current_works 表（不进 ALLOWED_FIELDS，防 dashboard 绕过验证）+ 双闸验证管线（缓存只缓 verified/日上限 50/provider 故障降 generic 不判真书为假/无证据重试 2 换候选）+ 生命周期状态（00:30 日程批搭便车换档，fail-open）+ 红验①②③ + 虚构书《她总在转角处等我》入档被拦降级泛读。current_works_smoke 17 项进 CI。表达层/proactive/退场 = PR-W2 | ✅ 已合 #303 |
| 2026-06-12 | W1 合并时机拍板：**现在合 dark 上线**（同 PR-B dark ship；中间态=资产——W2 首日即有真档案可注入，每月 ≈¥2 买"W2 首日有数据"是最便宜的期货）；#303 已合 main，待部署。**digest 加 works 建档流水段**（companion/书名/verify_status/当日验证搜索次数）——双闸生产首考要在早报一眼可见，本 PR 加 | 🔄 待部署 |
| 2026-06-12 | **W2 三执行要点钉死（开工前）**：①红验④存量退场做《她总在转角处等我》完整弧（她提过它→档案已换真书→用户问旧名时"那本看完啦"自然过渡 vs 失忆否认=事故，前者设计后者事故）②prompt 注入处复核"提及冷却只锁她主动提、用户问起永放行"断言真在（W1 是档案层，这条线在 W2 注入层才真正受考验）③proactive 供给走品类管线的 works sceneSeed，**不另起 proactive kind**（设计稿"不另起炉灶"，执行易手滑） | 📋 W2 待开 |

---

## 项目背景

你是 dimang01/xiyu-ai 开源仓的代码协作者。这是一个 MIT 协议的微信 AI 陪伴
框架（溪语 AI），自托管为主，同时有一个生产部署在 xiyuai.cc 对外运营。

- 开发克隆：`/root/xiyu-ai-opensource`（在这里改代码、发 PR）
- **生产克隆：`/opt/xiyu-ai-new`**（main HEAD = 生产 HEAD，发版后 `git pull` + 重启）
- GitHub：`https://github.com/dimang01/xiyu-ai`
- 默认分支：`main`
- **当前版本：v1.21.6**（package.json 已升；git tag 合并后打 v1.21.6）
- 规模：58 个 `src/**.mjs`（含 providers/security 子目录）· 17 个 `public/app/*.html` · 87 个 `scripts/` · 100+ releases

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

## 当前高价值候选（2026-06-11 评估，按优先级）

> v1.21.3 已落地：去"用户"三层防线（存量清洗已 apply，全库残留 0）/
> proactive 素材级防复读 / 调教改名默契 / AI 用量 admin-only /
> 互动历史自动化（创建薄版+水位全量，按钮已撤）。
> CI 门禁 25→28 项。观察周纪律持续：不动 arc/emotion 阈值。

### v1.21.4 候选（2026-06-11 存量清洗审读时记下）

- **ASR 空结果不入库**：voice 链路"情绪为中性，语气未明确，内容未明确"
  这类全空解析结果曾被当 user_profiles.notes 写库（生产实例已手清）。
  写入口加"内容未明确则丢弃"判定
- **化验单腔调治理**：存量记忆里"被描述为话少/情绪为中性/显示信任感提升"——
  穿帮词表治得了"用户/AI/助手"，治不了化验单句式。解在抽取 prompt 的
  叙事人称重写；最终靠微调语料（给建构包好坏样本库的选题 +1）。
  同根问题：抽取产物里她自称"AI/助手"（c12 实例已手改，写入侧待查同款根因）

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
