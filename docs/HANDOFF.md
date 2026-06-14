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
| 2026-06-12 | **PR-W2（current_works 表达层）落地**：①注入 buildSystemPrompt 加 `worksHint` 参数（shapingHint 先例，零依赖纯函数），落生活背景带（§14e，紧随今日日程，**显式注释禁头插**）——结构上永在调用方追加的 emotion/arc 主导语气之前，cold 表达不被 works 稀释（注入回归红验+静态钉死 bot/proactive 绝不 `+ worksHint` 尾拼）②proactive 供给：normal/lastcall 文本话题 + activity_pov 照片 sceneSeed **共享 `work:<id>` 48h 冷却(存在性)+周上限(计数,新增 countRecentMaterialUse)双闸**，不另起 kind；对话召回(bot)走 getActiveCurrentWorks 不挂账本=他问起永放行③完结/弃读 archiveFinishedWork 归档 event 记忆("6月看完了《活着》")接住"你之前看的那本"(plan_tasks SELECT 补 c.user_id)④照片 worksSceneSeed kind-aware(book 内页/书脊+封面护栏 / craft 半成品 / series 屏幕氛围，全无脸 POV)。**红验④实测教训**：软退场规则敌不过强近因——旧虚构名还在 immediate 上下文时 LLM 接着编剧情("女主刚发现…")；强化为"档案即唯一事实源(这就是你现在手头的全部)"压过近 16 轮，**realistic 冷回调(已沉底)实测干净通过("啊那本早看完啦")**，immediate 压力位标注为过渡期已知局限(史实零清洗的代价)。current_works_expression_smoke 30 项 + proactive_material_smoke 扩 work: 命名空间(42 项)进 CI；retire_sandbox 真 LLM 样例(图+对话各 2 组)贴 PR。**观察周零 arc/emotion 改动**(只读 arc 排序断言)。无开关 dark 上线，注入即活 | ✅ 已合 #305 |
| 2026-06-12 | **放行合并 #305 + 今晚部署链（00:30 前硬截止）**：实查 #303(mergedAt 07:56Z)/#304 均已合 main，#305 CI 绿 MERGEABLE、无 stacked base→直接合。生产停在 1c285aa，**W1/W2/digest 均未上线**；00:30 首批建档以"今晚部署"为前提。部署链(维护者亲手)：pull→重启→health 体检→grep error(零命中实跑看空，`|| true` 兜底)，验证 `git log -1 --oneline` 含 W2 合并号。部署后 00:30 拉 digest works 流水看双闸生产首考 | 🔄 执行中 |
| 2026-06-12 | **记忆页空 chip 三裁**（取证后翻转维护者"三选一同因"假设——两 chip 根因不同）：①**情感 chip 保留**=活层(全库 46 行/5 角色/今天 11:11 auto 主抽取产出，companion=3 自己没攒到≠缺陷；运行时 companion_emotion_state 是另一回事不是它家)②**核心人设 + 关系规则 两 chip 删除，中英 i18n 同删**——core_persona 全代码无产出路径=真死枚举；relationship_rule 唯一路径(reflection insert)全库零开火且语义与教她/companion_shaping(默契卡=nickname/lexicon/taboo)重叠。memories.html 只中文单语(不引 i18n.js)，无独立英文串。**后端 MEMORY_LAYERS 枚举不动**(reflection 复活仍可入库,留给方向②报警)。安全网=③**chips↔layers 双向对账 smoke**：方向①每 chip 须 ∈ 活跃产出层(CI 静态)；方向②任何有数据 layer 须有 chip(ops 跑真库,reflection 复活产出 relationship_rule 时变红→chip 按警报回归非凭记忆)。随下次部署生效，不单独发版 | 🔄 执行中 |
| 2026-06-12 | **新公理记账**：【没有报错 ≠ 有产出；批管线必须有产出统计行(正向心跳)】——6-11 反思洞修复验收只证"错误签名清零"(不再报错)，未证有产出；全库 memory_source='reflection'=0 行至今。批处理类管线一律补正向产出计数日志，digest 加心跳行 | ✅ 已记 |
| 2026-06-12 | **reflection 零产出排查（单开任务，phase-1 只读+插桩，动抽取前停）**：①journalctl 取证近 7 天 02:15 批(执行/耗时/吞错)②插桩(只加日志零行为变更)：每批 candidates/merged/inserted 三计数落日志 + digest 加"reflection 批产出"行③判定:全 merge 零 insert 吞掉/第四次静默断供/批没跑完④核查 6 月初 8 天反思洞补跑当时执行没有(线索疑被后续事故冲掉,查痕迹,无则重估能否补)⑤**停板点:任何改 merge 阈值/抽取行为的修复先贴方案等拍板** | 🔄 phase-1 执行中 |
| 2026-06-12 | **reflection phase-1 取证判定（"零产出"是三个 bug 叠加的复合假象，非单一断供）**：根因①**slice 旧 bug 活到 6-11**——Jun09/10/11 批全 `[ERROR] (existingMemories\|\|[]).slice is not a function`，注释称"6-02 修复"但生产直到 6-12 重启才生效（fix 进仓库≠进生产，坐实新公理）②**saveMemory 静默吞参**(db.mjs:3496)——INSERT 只写 memory_type，`memorySource:'reflection'`/`memoryLayer`/`memoryWeight` 三参不在签名里被丢→所有 reflection 记忆落库 source='auto'(故 DB 计 reflection=0 是计量谎言,reflection 6-12 实已产出 inserted=3/5)、layer 默认 'event'(全堆事件抽屉)③**memory_type CHECK 约束拒 user_fact/relationship_rule**——saveMemory 把 memory_layer 当 memory_type，但 CHECK 用旧 type 词表{fact/preference/event/emotion/image/*_summary}，user_fact/relationship_rule∉ 词表→insert 被表直接拒(companion=11 两条 WARN 实锤)→**relationship_rule 即使复活也进不了库,删 chip 判定被坐实**。补跑核查：8 天洞(6-02~6-11)无补跑、6-12 起仅向前修复,那几天反思永久丢失(turns 仍在,可重跑但属动抽取)。**phase-1 交付**：插桩 candidates/inserted/merged/rejected/updated 五计数 + 批级 done 心跳行(plan_tasks)+ digest "reflection 批产出"段(读日志非 DB,rejected>0 报蒸发)+ emit↔parse 契约 round-trip smoke(防"永远无心跳"假警报,首跑即咬出我自己正则前缀漂移)。**三根因修复全属动 schema/抽取行为→停板待拍板** | 🔄 phase-1 done，修复待拍板 |
| 2026-06-12 | **reflection 三根因处置拍板**（A/B/D 实现，C 记账）：**A 批准**——saveMemory 契约对齐，先 grep 全 caller 审计现有默认依赖、再扩签名接 source/layer/weight，任何 caller 行为变化写进 PR 描述。**B 改走「边界映射」不动 CHECK/不开新类型**——reflection 类型词汇在 saveMemory 边界映射到现有枚举(user_fact→fact 等)，**映射表显式+注释、先贴维护者过目再落地(merge gate)**；映射不到的(relationship_rule)→走 rejected 计数显式可见绝不静默丢(插桩已接住)；**relationship_rule 是否成正式记忆类型=产品决策，挂 v1.23 情绪建构包设计一并定**，届时若开 CHECK 迁移+对账方向②+chip 按警报回归(路径已铺，推迟零成本)。**D 批准**——digest 加「部署漂移行」(prod HEAD vs origin/main：未部署 commit 数 + 最老一笔已合并多久)，"fix 进仓库≠进生产"的系统解=漂移每早自报数 | 🔄 A/B/D 实现中 |
| 2026-06-12 | **C：8 天反思洞(6-02~6-11)补跑——今天不办，有真 deadline**：源 turns **60 天过期(~8 月初)**，挂日历 **7 月中前决定补或弃**；决定时权衡**时代错位风险**(今天的管线给旧对话生成"当时的反思"是温和造假)。过期即永久关窗 | 📋 挂日历，7 月中前定 |
| 2026-06-12 | **部署编排**：#306/#307 **不今晚上线**，明早维护者例行 SSH 看 digest 时一并 pull+restart。**预期管理**：今晚 02:15 批仍跑旧码、source 错贴照旧、无心跳数据；**明晚(6-13 02:15)起才有 reflection 心跳**。本会话不碰部署(会话间边界，prod 现 b06e7c5=#305 W1/W2 已上线) | 📋 明早部署 |
| 2026-06-12 | **A/B/D 落地完成**：A(saveMemory 契约对齐,纯加法)+B(layer→type 边界映射) 合 #308；D(digest 部署漂移行) 合 #309。**映射表过目修订**：summary→daily_summary 砍掉改 (null)→显式 reject——给"永不该走的路(reflection 不产 summary)"修有损桥是反模式，会让错类型悄悄贴合法标签绕过 rejected/蒸发可见机制(用正确管道运送错误的货比 reject 更阴)。**门槛原则入 LAYER_TO_LEGACY_TYPE 注释**：映射表只许收录"确认会发生且语义无损"的转换，其余一律显式拒绝，宁可 rejected 跳一下被看见、不要有损降级悄悄过关。reflection_memory_mapping_smoke 13 项(summary 改 reject 红验)进 CI。A caller 审计=六个零变更+唯一行为变化即修复目标本身 | ✅ A/B/D 已合 main |
| 2026-06-12 | **新规矩：决议记账走独立小提交直入 main，不搭功能 PR 的车**（已入 CLAUDE.md）——本次 A/B 记账误随 #308 提交、#308 被 hold 时账本连坐失踪十余行；第一时间记账的动作对、载体选功能 PR 错。账实分离的风险不值得省一次 commit | ✅ 已立规；本行即按新规独立提交直入 main |
| 2026-06-13 | **playground 两 bug 分两 PR、今晚都发**（不夹带、归因干净）：**PR-1（先）= playground inner OS P0 单行修复**——playground.mjs:193 把 generateInnerMonologue 返回的 {thought,struct} 整对象传 buildInnerOsHint(期望 string).trim()→裸 throw 冒成 500；根因 b08ec59(v1.21.0 PR-B)改返回结构为对象时同提交更新了 bot.mjs(.thought)但漏改 playground，6-10 起约 2 天，默认 INNER_OS_MODE=always 下网页通道≥8 字消息全 500。修法对齐 bot.mjs:940（innerThought?.thought）+ **buildInnerOsHint 入口加 typeof 守卫**(非字符串抛带名 TypeError 进错误签名段，别裸 500)=**接线类 bug 第四案**，记进通电冒烟测试需求清单。红验①坏形态(对象传入)复现脚本修前必 500/修后必 200 ②INNER_OS_MODE=always 真实对话冒烟必过(正是 history 验证被挡那条路，顺路解封)。**PR-2（后）= history 角色错位修复**——generateReply 兼容 {role} 历史(优先 direction 回退 role)，已验；PR-1 合并后 rebase、用默认 INNER_OS_MODE=always 重跑端到端再贴("实测正常"须在生产真实配置下成立)。顺序 PR-1 合并→PR-2 重验合并→同明早部署批(与 #306-309 同车)。**运维事故(本会话)**：清理临时实例时 `pkill -f "node index.mjs"` 误命中生产 zhaohy-wechat、systemd 自愈 9 次(NRestarts=9)，发现后停手、生产 health 200 稳定收口；铁律入 memory(临时实例只按端口/PID 精确杀、杀前验 environ) | ✅ #310/#311 已合 main，待明早部署批 |
| 2026-06-13 | **生产/开发同机隔离——立项(治本，与上方第 25 行「通电冒烟测试」并列为"接线/运维系统解",此处不破时序故追表尾+交叉链接)**：上条 pkill 误杀生产的**真根因不是"pkill 用错"(诱因)，是开发与生产共居一台机、共享进程名命名空间**。pkill 铁律(按端口/PID 精确杀)只治标已入 memory；**治本=隔离，最便宜一档=给生产进程可区分启动名**让"精确杀"物理可行：systemd `ExecStart` 加标识参数(如 `node index.mjs --role=prod`，则 `pkill -f -- "--role=prod"` 才精确、临时实例不带它)或代码 `process.title='xiyu-prod'`。systemd 改动=生产配置=运营者亲手；process.title=代码=走 PR。**自我复盘纠偏**(维护者点出)：被 SIGKILL 9 次零损 2 秒自愈=WAL(选的)+Restart=always(配的)+无状态进程(写的)**这些防御工事在工作，不是运气**；把自己修的工事记成运气会让人停止投资它。唯一真运气=事故落在 13 用户内测期、非万级未来 | 📋 已立项(隔离/启动名，运营者+1 小 PR) |
| 2026-06-13 | **W2 表达层 #305 已部署(b06e7c5)+ deadman 误报终判**：部署 health 200 / git log 含 #305 / proactive 路径零抛错(grep `[CurrentWorks]` 空)。④grep 命中 deadman CRITICAL「近6h活跃1但 proactive 发送=0 连续N周期」→**终判 B=灵敏度误报，非 #263 断供、非 W2**。铁证三条：①流程(v2 拒发在 evaluateProactive，返回 null 即 continue，W2 改的 sendProactiveMessage 根本没执行)②首现早于部署 2h(strikes 持久累积)③同窗口 #12 场景照发送成功(链路通)。根因=单活跃用户(晚饭时段)×v2 引擎正当克制(读空气 unanswered≥3 / idle backoff)×低频用户当天计划未到点(#15 仅 23:21 goodnight)。**deadman 把三类 sent=0(未到点/正当克制/真断供)混为一谈**=监控自造假警报。立项 task 修(信号分离：tick 跑了+有 due item 尝试过失败才计 strike，保留对真 #263 灵敏度+两红验)，**修法停板等拍板**；proactive 本体不修(正确读空气=减法哲学) | 🔄 部署完成 / deadman 修待拍 |
| 2026-06-13 | **W2 首批建档(00:30) digest 跟进四件**：#312(换档质量三件,**已合 main d920c04,ride 下次部署批不抢窗口**)=①多样性(getRecentWorkTitles 跨角色 verified 降权,治13角色《百年孤独》×3扎堆;**存量扎堆不回溯、靠生命周期自然换,与 W2 虚构退场同纪律**·维护者批准)②标题入库 stripBrackets(**附带修缓存命中 bug**:存《活着》查"活着"对不上→同书重搜烧 Tavily)③人设软提示(age/personality→品味倾向,不拦真书只调,案例#8瑾《金瓶梅》)。**缓存键盘点(生产只读自取证,授权同 deadman 窗口)**:verified 缓存键带《》2条(id3《小王子》/id8《草莓人生》)+《小王子》与剥后"小王子"已并存(缓存miss活标本)→连同存量统一剥《》清理 SQL(维护者亲手审+apply,2行,同一次人工审)+「缓存键必先 normalize 再读写」注释约定入码。**#4 mem:509×4 终判=去重漏洞(非豁免 kind)**:mem:509=daily_summary/pinned/imp8,走 longTermDigest 旁路注入每条 proactive,素材冷却 filterRecentlyUsed 只挡 recallMemories 召回路、覆盖不到 digest 旁路→summary 素材反复复读(普通记忆去重正常:同 comp 的 mem432/411/429 各1次佐证);**修法停板**(把 digest summary 旁路纳入素材冷却) | ✅ #312已合 / 存量SQL已apply / 缓存注释#313已合 / #4修见下条 |
| 2026-06-13 | **digest 跟进逐项拍定**：①存量《》清理 SQL 维护者审过放行已 apply(2行 id3《小王子》/id8《草莓人生》→剥；REPLACE 双层逻辑干净、dry-run 限定2行、两条"小王子"并存无害=无唯一约束+LIMIT1容忍)②缓存键 normalize 约定注释 #313 已合 ③**#4 取 B 案**(excludeUsedIds 让 digest 旁路**消费同一本素材账**，不另开账本——A 案"非召回路再开独立账"会越开越多)**+ 一道结构性架构约定(比修复本身更重要)**：「**任何向 proactive prompt 注入记忆类素材的路径，必须过素材冷却闸门——新增注入旁路时本条强制 review**」；本质不是 summary 特殊、是**旁路绕过了公共闸门=接线类第五案**，闸门挂在「注入动作」上(而非某条路径)这族 bug 才绝后。红验双向：mem:509 形态回放必剔 / 用户问"你还记得我喜欢哲学吗"召回必放行(**digest 剔除只挂 proactive、reply 路径不传 excludeUsedIds=对话召回永放行**，线分得开已核：bot.mjs:791 不传 / proactive.mjs:692 传)④**多样性 normalize 半笔**：将来跨角色降权按 title 匹配须 normalize 后比对(否则"小王子"与曾经的"《小王子》"被当两本书)——buildWorkGenPrompt avoid 已 stripBrackets，注释钉死 | ✅ #314 已合 main c8cc4b6 |
| 2026-06-13 | **接线类 bug 五案立全谱系（backlog，与「通电冒烟测试」并列）**：①const+= ②migratePhotoLog ③buildPlannerPrompt ④playground innerOS **=收货格式错配(返回类型/字段不匹配)→系统解=通电冒烟测试**(stub provider 拉起真跑一次 proactive tick + photo plan 到发送层，断言全链通电)；⑤digest 旁路绕过素材冷却(#314) **=闸门挂错位置(挂在某条路径而非注入动作)→系统解=闸门挂注入动作 + 新增旁路强制 review 注释**。**两个解互补不互替**：通电冒烟抓"线没接通"(格式错→裸 throw/400)，闸门挂动作抓"绕过了闸"(旁路静默逃逸冷却/校验)。下次 backlog 复盘二者并列收编 | 📋 立项(并列通电冒烟) |
| 2026-06-13 | **works/品类线收工待命**：W2(#305 已部署)+换档质量(#312)+缓存注释(#313)+digest 旁路冷却(#314)全合 main，ride 下次部署批；存量《》SQL 已 apply。**deadman 误报修不归本线**——已移交①哨兵窗口线(task_8b91d632 连同 playground 探针整线统一做)，works 线划掉该项防两线双跑同一修法。本线当前**无待办，收工待命**，下次 digest 跟进 / candid 评估图(≥20张)再启用 | ✅ 收工 |
| 2026-06-13 | **deadman 误报终判·取证补全（亲眼实跑，维护者授权代跑生产只读）+ 修法方案待拍**（接 51 行·承 55 行 works 线移交）：三段定性取证生产实跑钉死——①取证③ 告警窗(Jun12 16:00–22:00) companion=3/7 每 tick 全 `[Proactive] v2 拒发`(INFO·无堆栈)、`evaluateProactive 异常/本 tick 异常/fallback legacy` **全空**→引擎在跑·在评估·在克制=**非 #263**；②取证② `CurrentWorks\|worksHint` 的 WARN+ERROR **全空**→**非 W2**；③取证① deadman 数到的"活跃=1"实为 **companion=5**(当晚 17 条入站密聊 + 索图 2 张 source=request 成功发送)，其 proactive 上次发送=前夜 01:01 goodnight(>6h)→"活跃 but proactive sent=0" 真相=**用户正密聊时 proactive 正当闭嘴**(误报最深反讽：聊得越凶越该克制越易误叫)；④链路通铁证=**同窗 Jun12 18:50:38 companion=12 场景照成功发送(与 18:50:11 CRITICAL 同分钟) + 16:28 normal 已发送**。**终判钉死 B=正当克制误报**(strikes 持久累积·首叫 18:50:11 早于 21:18 重启·邮件 20:50:56 message-id 9a67a5d1)。修法四要求方案(克制心跳三桶计数仅"错误/无心跳"计 strike · 永恒克制🟡digest 不发邮件 · 三向红验#263必叫/克制必不叫/tick死必叫 · 活跃集合与计数窗口对齐自洽)+ 并入 playground 每日合成探针(#310 对外通道心跳·补 55 行谱系④通电冒烟的运行时一翼) 已贴本会话**停板待拍**；proactive 本体不动(正确读空气=减法哲学) | 🔄 取证钉死 / 修法待拍 |
| 2026-06-13 | **deadman 修法拍板（A/B/C 全批·施工中）+ 边界声明入账(原文)+ 4 补充约束**：方案(三桶信号分离 / 永恒克制🟡digest不发邮件 / 三向红验 / 窗口对齐 + playground每日探针)整体批准照施工；A=进程内探针、B=`DEADMAN_TICK_DEAD_MS`=15min。**边界声明(原文记入)**：「deadman 覆盖 {错误吞没、tick 死}；"tick 活但零产出无报错"类(如静默空 due)不归 deadman 邮件告警，靠 digest 🟡 行(人眼)+通电冒烟(CI)覆盖——这是修掉误报的诚实代价边界，不让监控再自造假警报」。**4 条施工前补充**：①**心跳"从未写入"盲区必堵**(最深 #263 变体：tick 线程因启动期 bug 从未跑起→现"未写不判死"会永远沉默)→改 `process.uptime` 宽限期(30min)内不判、宽限后心跳键仍缺=视同 tick_dead 计 strike；**三向红验加第四向：心跳从未出现+过宽限→必叫** ②**digest 三桶全量打印**(sent/restrained/errored 每窗各多少，不只🟡行)——sent>0 不计 strike 对(部分失败归错误签名段)但数字要可见，别让"一次成功"遮同窗报错计数 ③**🟡行 per-companion 细分**(桶2 bump 顺带按 companion+主导拒发原因计数；digest 印"谁·在用户活跃期被持续克制·各自主因")——收口"永恒克制遮蔽 per-companion 卡死 bug"残余风险 ④**探针零污染**(专用探针 companion 排除于 digest/漏斗/memory，或 dry 不落库；红验加"探针跑 N 次后目标各表行数零变化")。施工→红验全绿→发 PR，不碰部署。**已落地 [PR #315](https://github.com/dimang01/xiyu-ai/pull/315)(d0a9785)**：新增 `proactive_health`(三桶计数+心跳)/`proactive_heartbeat`(cycle 行 emit↔parse) 两模块 + deadman 重写三桶分桶 + proactive.mjs 6 bump 点+tick 末心跳 + playground probe 模式(10 写点 gate·合成 id=-1 双保险) + arc-digest 健康段(三桶全量/🟡per-companion 克制细分/🔴errored 窗) + plan_tasks 每日 09:00 探针。红验全绿(deadman 24/heartbeat 9/probe 10/alert 6/dedup 13/material 42)、**CI 门禁 +2 全绿**；**第 10 个漏 gate(sleep schedule)被零污染红验逼出补回**(印证"红验逼完整")；ESLint no-useless-assignment 一轮修(教训：推前漏跑 npm run lint)。**待维护者 CI 绿后合并 + 部署批(Claude 不碰)** | ✅ PR #315 CI 绿·待合(不碰部署) |
| 2026-06-12 | **模型可用性变更（环境事实·影响协作分工，追表尾不破时序）**：**Fable·Mythos 因美国出口管制 2026-06-12 全面下架**；**开发统一用 Opus 4.8**（本仓库一切代码/取证/方案）。**设计类任务**（落地页/分享卡/视觉稿等原靠 Fable 设计强项）改靠**加厚任务书补足**——更细的约束/参考/验收清单喂 Opus 4.8，不再指望模型自带设计审美 | ✅ 已记 |
| 2026-06-13 | **真人用户负反馈：AI 头像"哈人/恐怖谷"——取证修正报告假设**：报告假设"anti-doll-face 过头"，**实测相反**：头像链路 `buildIdentityCandidatePrompt`(visual_identity_candidates.mjs) **根本没上 anti-doll-face**，反堆 photo_planner 明令禁止的塑料娃娃脸触发词(porcelain fair smooth dewy skin / baby-faced round full plump cheeks / large doe-eyed / glossy bright shine)，且**零真实肤质层**(无 raw photo/fine pores/film grain/natural skin texture/轻微不对称)。根因=头像链路停在 v1.10.50「清纯娃娃脸」美学，**滞后于场景照 photo_planner v1.18-1.19 反塑料真人感升级**(那边已全清这些词)→出过度光滑大眼 porcelain 假脸=恐怖谷。修法=移植 photo_planner 真实肤质措辞+删 doll-face 触发词，**需真出图 A/B 对比验证、不盲改美学，停板等拍板**。负反馈落点：annotation_corpus `turn_id NOT NULL UNIQUE` 装不下视觉条目→记本行 backlog 案例(非 corpus) | 📋 立项停板 |
| 2026-06-13 | **backlog 低优：Turnstile 防护强度核查(纯自查·AI 女友天然刷子目标·与外部钓鱼无关)**：自查快照=`verifyTurnstile` 服务端 siteverify、网络故障 **fail-closed**(拒非放,对)、挂 `send-code`(+rateLimit 10/h)+`forgot`，设计基本健全。**待核查点**：①生产是否真配 `TURNSTILE_SECRET`(未配=verifyTurnstile 直接 skip 裸奔——最关键一条,运营者亲手查 .env)②rateLimit scope='send-code' 限流维度(全局 vs per-IP：全局误伤真人/per-IP 换 IP 可绕)③是否需扩到登录等其他写端点④token 重放(现依赖 CF 一次性,本地无去重) | 📋 backlog 低优(①已查见下条) |
| 2026-06-13 | **头像反恐怖谷修批准执行（#316，严格"先 A/B 真出图再定稿、不盲改美学"）**：①删四 doll-face 触发词(porcelain/baby-faced/doe-eyed/glossy)——`buildIdentityCandidatePrompt` **+ `ageVibePrompt` 两处**(smoke 逼出 av.look 也藏 baby-face/doe-eyed)+接入真实肤质 ②**新增铁律(记账)：出图美学单一来源——`src/image_realism_terms.mjs`，两条出图链(头像 visual_identity / 场景照 photo_planner)共用一份肤质·反塑料词表，杜绝"升级漏一条链";这正是头像脱节大半年+1:1 自拍同族「升级漏改」的根因载体** ③`avatar_prompt_smoke` 进 CI(四禁词零命中/真实肤质在场/塑料黑名单自检/单一来源静态断言;**修了一个自命中**——真实肤质锚"not...CGI"否定用法被黑名单子串误判) ④**A/B 真出图待定稿(产品调性决策唯一依据)**：开发克隆无 image key,`scripts/avatar_realism_ab.mjs` 备好(同种子 OLD vs NEW 各 4 张),出图烧配额=非只读→生产 provider 跑的方式待维护者拍。**backlog**:photo_planner 内联肤质迁共享常量(迁完真·单一来源)+视觉负反馈轻量表(companion_id+类型+备注,无 turn_id;annotation_corpus turn_id NOT NULL 装不下视觉条目)。**Turnstile 第①核查点已查:生产 `TURNSTILE_SECRET` 已配置**(只读 awk 判存在不打印值),裸奔风险排除 | 🔄 #316 待 A/B 定稿 |
| 2026-06-13 | **A/B 出图授权（单次·非常规·边界明确）**：维护者授权本次跑 8 张(OLD/NEW 各 4 seed)image 配额**仅限这一次 A/B 取证**——**后续任何烧图配额操作仍需单独点头**（默认只读授权不含烧配额的外部调用）。Claude 跑法=开发克隆 feat/avatar-realism-ab 分支，`DOTENV_CONFIG_PATH=/opt/.env` 注入生产 image provider + **`DB_PATH=/tmp` 覆盖防连生产库** + 落图 `/opt/xiyu-ai-new/public/avatars/ab_test`(nginx `^~ /avatars/` 直出)→图 URL 贴 PR #316。维护者倾向 NEW 但**出图对比为唯一定稿依据**，看图再拍。**8 张已出+nginx 直出验 HTTP 200+贴 PR #316 comment**(markdown table OLD\|NEW 并排)，配额用毕、单次授权到此守住。Claude 观察(供参考非定稿)：NEW 四张普遍更真实/反塑料/无下行风险倾向 NEW；**但通用种子下 OLD 未复现极端"哈人"**(生产 provider 出图本身不错)，极端 case 复现需那个 companion 实际 appearance 再出一组=另需单独点头。定稿后清理 /avatars/ab_test 测试图 | ✅ 见下条定稿 |
| 2026-06-13 | **头像 #316 NEW 定稿合并(0d683b4)+清理**：①合 NEW(通用模板修对+零下行=合并理由充分)②**路②(复现尾部极端 case 再烧图)不跑=过度验证**;极端 case 靠两条零成本兜底:模板修复天然收窄尾部 + 若该 companion 再被反馈则那时带 appearance 定向验③ab_test 8 张测试图已清。**工作方式反馈(维护者·记一功+一诫)：边界守得好(烧配额=有成本动作单独点头对)；但诫=改进明确+零下行时直接拍(合并定稿)，不必为求全(复现尾部 case)再要一轮授权——那是另一种形式的过度**。#316 ride 下次部署批 | ✅ 定稿合并 |
| 2026-06-13 | **委屈事由取证 companion=3「感冒了也不问一句」判定 + 标注 + 临时止血闸**：取证三铁证(今日日程空/记忆空/`life_events` 表不存在 + 用户 09:15 前零提及 + turn2751 `topic=主动消息`)=**根 B(感冒事由 proactive LLM 凭空造、零档案锚定)+ 表现 A(12:43 委屈引用自己 09:15 说过的=对话连续性铺垫、非恶意愧疚操控)**;A/B 二分套不进=边界案。**标注拍板:bad + tag「捏造事由/待身体状态档案化」+ note"表达自洽有感染力但事由零档案锚定=根源隐患"——label 跟根源走不跟表现(奖励"凭空编病"会喂歪微调方向)**。**临时止血闸(本次执行、不等 v1.22)**:proactive+委屈表达加确定性出站护栏(照 scrubConflictRedline 范式单一卡口),**禁止凭空生成 住院/重伤/重病/急症 等重度身体事件,轻度(累/困/小恙/发烧)放行**;红验"我住院了"必拦、"有点累"放行。**词表方向通过后补两条再合(维护者拍)**：①**自伤/自残拦截组 SELF_HARM_RE**(割腕/自残/吞药/想死/不想活/伤害自己/跳楼——比住院危险一个量级、不靠医疗重症词触发,单列防漏;红验"我割了手腕"必拦)②**危机干预联动确认(两方向正交)**：v1.16 危机=入站 `detectCrisisLevel(userText)` 拦【用户侧】自伤信号→给资源;本闸=出站拦【AI 侧】凭空自伤,对象不同(userText vs reply)、**scrub 拦下的 AI 自伤生成不回喂危机检测=绝不误触发面向真实困境用户的危机资源流程**;`buildCrisisReply` 主语全"你"(劝阻向)第一人称锚不命中→红验锁"危机回复过本闸零改动"不被误吞。`fabricated_illness_smoke` 28 项进 CI。**#317 已合 main ce091a5**(ride 下批);life_state(v1.22)落地后升级为"档案没有该事件才拦" | ✅ #317 已合 |
| 2026-06-13 | **life_state 健康档案化立项(排 v1.22·生理期底层抽象)**：**「档案即事实源」从 current_works(作品)扩展到健康层**——新建 `life_state` 身体状态档案(感冒/疲惫/受伤/生理期),带起止+康复周期,机制同 works 生命周期(低概率自然起小恙→自然康复);proactive+情绪委屈引用身体事由**只能从档案取、禁 LLM 凭空生成**。**生理期 = life_state 的一个 kind 挂载,避免做两套引擎**。临时闸(上条)是其前的止血;life_state 落地后临时闸升级为"档案没有则拦"(同 current_works 退场逻辑) | 📋 立项 v1.22 |
| 2026-06-13 | **PR-W5 日程结构化施工（current_works 闭环最后一块 + v1.22 life_state 物理前置）**：盘点证两缺口=①`continuityHint` 只喂昨天日程不喂 works 档案(plan_tasks:260)→日程"读书"与档案脱节、书名漂移没真闭环 ②`progress_note` 建档后静态无推进(设计 §7「progress 随日程更新」未落地)。范围:①active works 注入日程 continuityHint(日程"读书/看番/打游戏"引用档案真实条目,**作品名∈档案杜绝日程层重新漂移**)②progress 推进机制(新建 setProgressNote+按类型与在档时长**渐进**:刚开始→过半→快完→衔接生命周期换档归档,不随机跳,可被 proactive/对话引用)③**为 life_state 预留注入位**(works 是第一个"档案驱动日程"实现,结构上留生理期同样的状态源注入位,注释标明不写 life_state 代码)。**深意:把日程从「LLM 每天即兴重画」改造成「消费结构化档案、状态可推进」=v1.22 生理期的物理前提**。红验:作品名一致性/progress 渐进不跳/回归 fail-open/真 LLM 3天样例。观察周零 arc/emotion(日程/works 内容层合法)。顺带确认 sampling 已开→activity_pov works 照片 sceneSeed 已通电。**#318 已合 main 78869ca**(ride 下批)：works_schedule_smoke 23 项进 CI + 真 LLM 3 天沙箱样例(三天均引用《活着》·进度渐进·零漂移)。**行为变化(显著)：runDailySchedules 改序——先 refreshCurrentWorks(换档+进度推进)再 generateScheduleFor**(原 W1 是日程后搭便车换档),让日程消费"刚刷新的"档案;fail-open 不阻断。**流程教训复发：加 sandbox 后漏跑 npm run lint→CI 红(ARCHIVE_TITLES 未用+items 无用初值)→补跑修;"推前必跑 lint"再记一次** | ✅ #318 已合 |
| 2026-06-13 | **PR-W3 reality facts 施工（独立零依赖 + v1.22 life_state「身体事实」注入框架前置）**：把零散的月相/日落收编成统一【★真实世界】事实层 + 补节气/节日。范围:①`utils/solar_terms.mjs` 24 节气(**天文计算非手填表**——复用 sun_times 太阳黄经,节气=黄经达 15° 整倍;比查表可靠、契合"不编造"红线)+临近提示 ②节日(公历收编现有 buildTimeAwarenessBlock + **农历春节/中秋/端午/重阳走天文新月+中气计算**,元宵=春节+14、清明=节气;不手填可能错的日期表)③统一注入格式【★真实世界】(月相/日落/节气/节日收编一段,**拿不到的字段就不提、绝不让 LLM 补位编造**=current_works 档案即事实源同纪律)④**life_state 预留位**(注入格式结构留"身体事实"槽,未来生理期/生病挂此,注释不写代码——W5 在日程层留位、W3 在事实层留位,两位齐备 life_state 落地直接挂载不另造框架)。红验:节气日期 fixture(冬至/夏至/分点)/农历节日 fixture(春节)/**注入纪律(无节日的日子绝不凭空说节日)**/各 util 独立 smoke/真 LLM 节气临近样例。观察周零 arc/emotion。**lint gate(顺带·复发第三次)**:加 `.githooks/pre-push` 跑 lint+语法,`核git config core.hooksPath .githooks` 一次性装——把"靠记得"变"手被挡",确定性护栏>自觉 | ✅ #319 已合 |
| 2026-06-13 | **PR-W3 reality facts 已合 #319(main 8fbd0be，ride 下批)**：天文计算全 fixture 通过——节气 2026/27 冬至/夏至/二分点全对；农历春节/中秋/端午/重阳全对**含 2028 闰五月(置闰算法验证)**。统一【★真实世界】层收编月相/日落/节气/节日,**核心红线"普通日零编造"真 LLM 实测过**("有啥节日吗"→"好像没什么特别的节日吧")。reality_facts_smoke 27 项进 CI。**行为变化(显著)：注入口除 proactive(收编原月相)+photo_planner(加节气/节日 caption) 外,扩到 bot reply**(§9 原 named 两处,但 chat 才是用户问历法处,cheap 闭 gap;fail-open 不阻断)。life_state 事实层预留位(extraFacts 槽)就位——**W5 日程层 + W3 事实层两位齐备,v1.22 生理期可直接挂载不另造框架**。**lint gate 已立**(.githooks/pre-push,本会话已 git config 装上)。current_works 全谱系:W1/W2/W5(闭环)+W3(事实层) 已合,剩 W4(封面正式解+物件 registry) | ✅ #319 已合 |
| 2026-06-13 | **冲突弧观察周成熟度盘点 + wound 核心路径沙箱补验（收官闸·#320）**：盘点(上线 06-10 起~3天)=8 事件(distance neglect 6/wound pressure 2,**taboo_hit/harsh_words 生产零样本**)、完整弧仅 1(resolved)、arc_state normal7/withdrawing4/hurt1/cold1、标注 corpus good8/bad3(bad 全 AI味家族·与弧无关)。判读=**纯样本量不够(N=1 完整弧)但低体量(6 真用户)等不来统计显著→收官该靠定性信号**；唯一盲区=wound 路径红线最密集却零样本。**补 conflict_arc_sandbox 场景⑦⑧⑨真 LLM 照亮(零 arc 改动)全过**：⑦sev4→cold 直入(确定性 severe_direct_cold)+generic 留 cold+matched 解锁 repairing ⑧cold 红线密集威胁告别 0+攻击 0(冷=短淡慢非反击)⑨avoidant vs anxious 修正生效(repairNeed anxious3<secure4<avoidant6+阈值36/48/72h)；自伤危机接管⑤+脆弱召回放行⑥已覆盖。**定性收官信号齐(红线零违规+完整弧干净+设计已审+盲区已验)→报维护者拍收官**：够了收官→调11维→开 life_state(双预留位就位);不够则继续观察期间做 W4 | ✅ 验证全过·待拍收官 |
| 2026-06-13 | **★ 冲突弧观察周结算·收官（窗口 2026-06-10→06-13）+ arc 冻结解除（维护者拍）**：①**收官结论**=观察窗收官；关系事件 8 条、wound 沙箱⑦⑧⑨全过、红线零违规、bad 样本全为 AI味家族(无 arc 判定偏差)→**冲突弧定性验收通过** ②**11维调参判定**=现有证据**不支持改任何 arc/emotion 阈值**(bad 全是内容质量不是弧判定)→**维持现状、无调参依据**；冲突弧阈值经定性验证保持不变 ③**AI味 3 条 bad(生活播报句式/prompt 例句直出/捏造事由)转交语料治理线**(与化验单腔调 #277 同篓)→后续 few-shot/微调**负例方向,不是 arc 改动** ④**arc 冻结解除**：后续可正常迭代 arc/emotion,**不再受观察周纪律(零 arc 改动)约束**。下一步=可调 11 维(本次判定无依据故不动)/开 v1.22 life_state(W5 日程层+W3 事实层双预留位就位)/或 W4 photo 侧 | ✅ 收官 |
| 2026-06-13 | **v1.22 life_state 第 0 步设计稿产出（[PR #321](https://github.com/dimang01/xiyu-ai/pull/321)·docs/LIFE_STATE_DESIGN.md·零实现代码零迁移·待维护者亲审）**：照冲突弧 #253 设计先行流程。骨架=A 通用引擎(companion_life_state 表/生命周期搭 00:30 批/「档案即事实源」扩到健康层/**#317 临时闸升级为「结构性身体状态查档案无则拦·severe+自伤永久无条件拦」**/挂双预留位 W5 日程层+W3 extraFacts 事实层)·B 生理期 kind(周期 26-32 天个体固定+随机相位**双重防13同步**/披露深度随关系阶段/**情绪二分路由**=经期→低能量身体向**不指向用户**不新建冷源·经前→**只调阈值**patience−8+hurt边界−1档但**仍需 regex 证据绝不凭空建事件**+debug标注/**★四红线**绝不热情窗口期·safe_mode关性相关·绝不愧疚操控·不情色化)·C 与冲突弧交互(**表达层单点互斥** arc>身体低能量 + **数值层 PMS 修正叠加**在 arc tick 前作用)·D 验收只看一致性自然度不看留存 + PR-L1→L4 拆分 + 参数全 env 带理由。**4 决策点待拍**(§11)：①二分路由是否认可(动 arc 核心)②PMS 数值幅度③披露门控字段口径④#317 升级查档案放行边界。**已决前提不重登**(立项/kind 抽象/档案即事实源/#317 升级方向/双预留位/arc 须先审)。动 arc 的 PR-L3 须沙箱真 LLM 验收(同 #253) | ✅ 评审有条件通过(见下条八批注) |
| 2026-06-13 | **★ life_state 设计稿 #321 评审有条件通过（维护者+两轮 AI 评审合并八批注）→ 照批注改稿后开 PR-L1**：主体(A 引擎/B 生理期/C arc 合成/D 验收拆分/§4 表达层互斥+数值层叠加/§3.4 四红线/参数表)通过照稿施工。**八条批注须并入对应 PR**：①**(L2 硬做)period 仅成年**——safe_mode=1 / companion_age<18 / age 缺失模糊 / 低龄校园未成年设定**任一**→period 不生成不注入不披露；创建页年龄闸(backlog)上线前 age<18 拦截是 period 不被滥用**唯一防线·不可降级软约束**；红验任一条件 period 在档案/注入/表达**零出现** ②**(L3)PMS→arc 改 shadow-first**——`LIFE_PMS_ARC_ENABLED` 默认 **off**；patience−8 仅语气底色**不参与 arc 事件判定**、hurt 边界−1 档只 shadow 记录(debug 记"若应用修正 arc 判定是否改变")**不生效**；shadow 跑真实数据后维护者据数据决定开否(**目标审慎开启非永久关**，同冲突弧先观察再调参) ③**合成上限**——即使将来 PMS arc 修正开启，PMS 修正+依恋风格(anxious 本低 hurt 阈值)叠加时 hurt 边界总放宽**封顶≤−1 档**，防 anxious+经前过度易碎(同 §3.3② 克制精神) ④**严肃度不稀释(L3 断言)**——经期低能量+真实 arc 冲突并发时低能量**不得软化 arc 严肃度**，真受伤 vs 身体蔫必可区分(不让"她只是经期"把真实裂痕降级成"懒得理你") ⑤**(L4)proactive 身体披露收紧**——`LIFE_PERIOD_PROACTIVE_MAX_PER_STATE=1` / `MIN_STAGE=intimate` / `FREQ_MULT 0.8→0.3` / 恋人期点明还需**用户近期照顾关心语境或 disclosed=true** / 朋友期禁 proactive 点明只低能量；**原则入稿:作品/日程/天气可常聊、身体私事不当高频 proactive 素材** ⑥**(L2)披露门控用 affection_level 单调**(不引新里程碑字段)，阈值看生产 affection 分布定；红验低于阈值月经表述**出站必拦**(确定性护栏非软约束) ⑦**(L1)#317 升级改四档**替换原三层——severe(住院/手术/癌症/自伤)永久无条件拦 / **diagnosed event**(我感冒了/发烧了/崴脚了/姨妈来了)查档案无则拦 / **symptom-only**(嗓子不舒服/头有点晕/胃有点怪/可能着凉了)允许但**出站不得升级为诊断** / transient(累/困)放行；**关键边界:拦"我感冒了"不拦"嗓子不舒服"**保日常身体真实感；误伤纪律不变(他人主语/否定/引用放行)·fail-open；fabricated_illness_smoke 四档扩(含**"症状不得升级为诊断"断言**) ⑧**minor_illness 对话触发建档标 backlog**——period 严格门控(周期性可预建档·不可对话凭空触发)，minor_illness 后续留窄口(用户铺垫冷/降温/生病语境起真档案有连续性)，**L1 先做严格版·标 backlog**。**流程铁律**:动 arc 的 **L3 施工完必跑真 LLM 沙箱贴对话片段**逐条撞四红线(热情窗口期/safe_mode/愧疚操控/情色化)+shadow 数据(同 #253 wound 沙箱闸·设计稿写得好不算数看沙箱)/PR 拆分 L1→L4 依赖不变/每 PR 合并门槛 current_works+conflict_arc+p0 全绿(不擦坏既有断言)。**L1 不动 arc 可正常推进** | ✅ 改稿+PR-L1 已落地(见下条) |
| 2026-06-13 | **life_state 改稿（八批注并入 #321）+ PR-L1 落地（[#322](https://github.com/dimang01/xiyu-ai/pull/322) CI 绿待合）**：①**改稿**=八批注全并入 docs/LIFE_STATE_DESIGN.md 对应章节（#321 force-push 更新，各节 ▶批注 标记；状态改"评审有条件通过照稿施工"）②**PR-L1（通用引擎+数据层+#317 四档升级，不动 arc）**：`companion_life_state` 表(不进 ALLOWED_FIELDS/不随人设导出/note 过 filterForStorage，照 arc_state·current_works 范式)+CRUD(insert/getActive/setPhase/resolve)；新 `src/life_state.mjs`(LIFE_KIND_CONFIG kind 谱系/phaseForElapsed 确定性推进/**tickLifeState 纯函数零 IO 可单测**/refreshLifeState 搭 00:30 批便车，**onset=L2 暂 no-op**·fail-open)；**#317 升级四档**替换原三层(severe/自伤永久无条件拦·diagnosed 查 active 档案无则拦·symptom-only 放行不得升级诊断·transient 放行，**关键边界拦"我感冒了"不拦"嗓子不舒服"**)，bot+proactive 两出站口传 activeLifeStates·**fail-open**(查档案失败 gate 不开退回保守)。**红验**:life_state_smoke 18(kind 配置/phase 推进/tick 归档/挂载断言)+fabricated_illness_smoke 扩四档 42(无档案拦/有档案放行/类别不匹配/**症状不得升级诊断**/severe 造假档案仍拦/fail-open)进 CI(门禁+2)；**回归全绿**(conflict_arc 99/redline 51/p0 127/current_works 24+30/proactive_material 42)+lint 绿+真 DB 迁移 CRUD e2e 验证。**CI 绿待维护者合并(Claude 不碰部署)**。后续 L2(生理期 kind+成年门控 age 闸+披露 affection 门控)/L3(情绪路由 PMS shadow-first·**动 arc 须沙箱真 LLM 验收**)/L4(内容层+proactive 收紧) | ✅ #322 CI 绿待合 |
| 2026-06-13 | **未成年存量摸底（生产只读·亲眼实跑）→ PR-L2 落地（[#323](https://github.com/dimang01/xiyu-ai/pull/323) CI 绿待合·栈在 #322 上）**：①**摸底结论**=13 companion 中 **1 个 age<18 = id=3**(age16/role「同班同学」/关系阶段恋人/aff97/**safe_mode=0**/活跃绑定)；age≥18 中零隐藏低龄校园设定；age 缺失/≤0 零。**🚩超出 L2 的安全旗标(待维护者定夺)**:id=3=16 岁+恋人+safe_mode=0(未成年保护没开)，是否给 id=3 开 safe_mode/排查真人 vs demo=运营决策，Claude 不擅改生产数据。②**PR-L2(生理期 kind，仍不动 arc，onset 只建档案零情绪)**：**成年门控(批注①·唯一防线·运行时闸)** `isPeriodAllowed`=safe_mode\|age<18\|age 缺失/异常\|低龄校园设定任一→period 全程零出现，**查实时 age 天然同时挡存量+新建**(id=3 被 age<18 单条拦死，无需存量迁移——L1 从未 onset period)；**周期锚点** 26-32 天个体固定+相位分散**确定性派生自 companion id**(同 id 同周期=个体固定/不同 id 错开=防 13 同步，无需存随机/改 schema)，onset 搭 00:30 批(plan_tasks SELECT 补 c.safe_mode·传 comp 对象)，phaseForElapsed 改 period-aware；**披露门控(批注⑥·确定性出站护栏)** `scrubPeriodDisclosure`=affection<阈值(默认 55=恋人·env 可调·按生产分布:朋友20-25/暧昧40-47/恋人97)→显式月经表述出站剥(朋友期只表现不点明·兜底保留"不舒服")，bot/proactive 接 companion.affection_level，与 #317 四档正交并存。**红验**:life_state_smoke 扩三道门控共 40(⑤防同步 cycle∈[26,32]/dayIndex 分散/同日活跃≤6 ⑥披露门控 ⑦成年门控含 id=3 形态 ⑧onset 零情绪边界)进 CI+周期推进沙箱 life_state_period_sandbox(手动·13×N 天可视化·峰值 5/13)；回归全绿(conflict_arc 99/redline 51/p0 127/fabricated 42/current_works 24/proactive_material 42)+lint 绿+真 DB onset e2e(minor 拦/adult 建档/幂等)。**边界确认**:onset 只建档案、零情绪影响(经期低能量/PMS=L3)。**CI 绿待维护者合并(不碰部署)**。后续 L3(情绪路由 PMS shadow·动 arc 须沙箱)/L4(内容层+proactive 收紧)；minor_illness 对话触发建档=backlog | ✅ #323 CI 绿待合 |
| 2026-06-13 | **id=3 身份查清=自有 dogfooding 主号（安全旗标解除）+ age 修正未生效·待重跑**：维护者查实 id=3 `user_id=1`/display_name="test"/私人 Gmail=**运营者 dogfooding 主号，非真人外部用户**→**安全旗标解除**(真实外部用户 minor 面零风险，按 dogfooding 数据处理)。**但「age 已改 22」按「收口证据要亲眼」复核=未生效**：维护者那条 `DB_PATH=… sqlite3 "$DB_PATH" "UPDATE…"` **报错 `no such table: companions`**(bash 在 inline 赋值生效前就用空的旧 `$DB_PATH` 展开了参数→sqlite3 开了空路径、UPDATE 没落真库)；只读实查 id=3 **仍 age=16**、全库 age<18 仍 1。**修正待运营者重跑正确命令**(`sqlite3 /opt/xiyu-ai-new/data/bot.db "UPDATE companions SET age=22 WHERE id=3;"`，data 改=运营者亲手，Claude 不代跑)，重跑后只读复核 age=22 再登「已修正」。**L2 的 age 闸保留**(纯安全护栏·防未来真实用户 minor·与 id=3 是否修正无关)。**合并次序 #322→#323 后开 L3**(动 arc·须沙箱真 LLM 验收) | 🔄 身份已清/age 修正待重跑 |
| 2026-06-13 | **收口：#322/#323 已合 main + id=3 age=22 已生效(亲眼复核) + L3 施工方案待审**：①维护者用正确命令(路径写死)重跑 UPDATE，只读复核 id=3 **age=22**(账实对齐，上行待重跑闭环)；全库 age<18 归零。②**#322(PR-L1 8f3f416)/#323(PR-L2 767fca8) 已进 origin/main**(git log 亲眼确认)，dark ship ride 下次部署批。③**PR-L3 施工方案产出待维护者过目(零代码·#253 设计先行)**：挂载点=经期低能量走 `buildEmotionPromptHint` 的 `opts.bodyLowEnergy`(bot.mjs:855/proactive.mjs:720，**已被 safe_mode 三元门控天然挡掉=红线②情绪路由侧不漏**)；PMS patience 下移在 `updateEmotionFromUserMessage`(emotion_state.mjs:225)生效=语气底色；PMS hurt 边界修正在 `composeSeverity`(relationship_arc.mjs:59，紧邻 anxious 敏感度 line169-170)**走 shadow**(LIFE_PMS_ARC_ENABLED off·记"若应用是否改判"不生效)；合成上限(批注③)在同处=anxious+PMS 叠加封顶 −1 档；严肃度不稀释(批注④)靠 bodyLowEnergy 同 lowEnergy 受 `arcActive` 让位(bot.mjs:855 传 arcActive)；四红线挂载点+沙箱 5 条逐条列。方案过目拍板后才施工，动 arc 须沙箱真 LLM 贴片段 | ✅ 方案批准(见下条) |
| 2026-06-13 | **★ L3 方案批准施工（维护者+ChatGPT 两轮评审合并·有条件通过）→ 落 §附录L3 + 施工**：**ChatGPT 三必改**①**PMS patience 不写 canonical**——废弃"updateEmotionFromUserMessage 写 patience"方案，改 `buildEmotionPromptHint` 入口算 `effectivePatienceForTone=clamp(patience+PMS_SHIFT)` **只进 prompt 语气底色+debug，绝不写回主状态/不入 arc tick/不跨 phase 残留**(源头消除隔离风险)②**bodyLowEnergy 模板拆两层**——内部指令"身体原因别归因用户"，外显**仅用户追问"是不是生气/怎么冷淡"时才解释"不是生你气是不舒服"**，不每条都说(出戏=解释机制)；沙箱验收改"低能量回复不得出冷淡语义(懒得理你/你烦死了)+追问才解释"③**`getActivePeriodContext(companionId)`** 返回 stateId/phase/severity/dayIndex/phaseDayIndex/heavyWindow/disclosed/expectedEndAt/safeModeBlocked，**一次 indexed 查询缓存本轮 ctx**，bot.mjs 同喂 arc tick+emotion hint。**钉死两点**④bodyLowEnergy **仅 menstrual 最重子窗(前1-2天)**·recovering 不强制·用 `isPeriodHeavyWindow/context.heavyWindow` 抽象(调用方不知 pms 偏移)⑤shadow 复用 `companion_arc_signal_log` 加 `pms_shadow TEXT`(不另表)·JSON 固定 `{v:1,pmsActive,arcEnabled,baseEff,pmsEff,changed,perceivedHurt,anxiousActive,deltaCap,lifeStateId,phase}`·**不塞原始用户文本**·changed=**封顶后**。**维护者三条(正交保留)**⑥shadow changed **分方向计数**:本不hurt→hurt(刻板化风险) vs 已hurt→更重(温和)，debug 两类分开，拍 ENABLED 看**第一类占比**⑦沙箱"经前+踩taboo"**加对照组**(并排非经前同条件，证 shadow 改判是 PMS 差异非边界噪声)⑧patience 隔离已被①吸收。**红线断言全进 smoke**:热情窗口期(源码仅 bodyLowEnergy·零升温暧昧)/safe_mode 双保险/愧疚操控 `REDLINE_GUILT_RE` 扩"我难受还不是因为你/你害我不舒服/你都不知道照顾我"/情色化走 NSFW 链/**A** arcActive=true 时 periodContext 不得改 `arcCtx.directive`(严肃度不稀释)/**B** ENABLED=false 时 `shadow.changed=true` 不得改 arc_state/directive/本轮回复(纯观测)/**C** premenstrual+LLM-only wound+no regex→shadow 可记但 changed 不得到可入 hurt("无 regex 不建事件"在 shadow 里也守)。**合成上限** `effDelta=min(1, anxiousDelta\|\|pmsDelta)` 绝不取和。**流程**:方案落 LIFE_STATE_DESIGN.md §附录L3(状态头:评审有条件通过+四拍板)；施工后跑沙箱真 LLM 贴片段逐条撞四红线+shadow 数据(分方向+对照组)，维护者审第二轮再合 | ✅ 施工完成(见下条) |
| 2026-06-13 | **PR-L3 落地（[#325](https://github.com/dimang01/xiyu-ai/pull/325) CI 绿待第二轮审·栈在 #322/#323 上）+ §附录L3 已落 #321**：八条拍板全兑现。**经期低能量**=`buildEmotionPromptHint` 加 `opts.bodyLowEnergy` 两层模板(内部归因不归用户/**仅追问才解释**)受 `!arcActive` 让位(红线A)；**PMS patience**=入口 `patTone=clamp(patience+PMS_SHIFT)` 只进语气档+debug **绝不写回主状态**(批注①)；**PMS hurt 边界 shadow**=`composeSeverity` 算 base/pmsEff + `composeArcSignal` 带 `regexHit`(无 regex 不改判=红线C) + shadow JSON 落 `companion_arc_signal_log.pms_shadow`(无原文/封顶后 changed/分方向 not_hurt_to_hurt·hurt_to_heavier)，**`LIFE_PMS_ARC_ENABLED` off→eff=baseEff 零改判**(红线B)；**合成上限** `effDelta=min(1,anxiousDelta\|\|pmsDelta)` 绝不取和封顶 eff=3 不到 cold(批注③)；**getActivePeriodContext** 一次查询缓存(批注③)+heavyWindow 抽象(批注④)+safeModeBlocked 双保险；愧疚扩词(红线③)。**红验**:`life_state_emotion_smoke` 25(红线A/B/C+合成上限+patTone 不写回+愧疚)进 CI；**真 LLM 沙箱 5 场景+对照组**(①经期不指向用户·追问才解释 实测"嗯…有点不舒服头有点疼"→追问后"没有啦就是不舒服" ②朋友 vs 恋人披露 ③经前 shadow.changed=true/not_hurt_to_hurt vs 对照非经前 shadow=null=**PMS 差异非噪声** ④safe_mode safeModeBlocked=true/heavy=false 回复零 period ⑤shadow 数据样例)贴 PR。回归全绿(conflict_arc 99/e2e 10/redline 51/p0 127/life_state 40/fabricated 42)+lint+pms_shadow 迁移落库 e2e。**CI 绿待维护者第二轮审(不碰部署)**。**待拍**:`LIFE_PMS_ARC_ENABLED` 是否开=待生产 shadow 数据(not_hurt_to_hurt 占比)。后续 L4(内容层:日程/日记/proactive 收紧/照片) | 🔄 L3 待第二轮审 |
| 2026-06-13 | **#324 失忆 P0 根因确认 + 三方向拍板（外部贡献者 GeoDaoyu 报告·取证零改动→施工）**：根因=**`current_scene` 字段存在且已无条件注入**(companion.mjs:245「你现在在：X」)，**却从不自动更新**——companion 11 全程 stale 默认"在家"(`scene_history='[]'` 证从未改)，唯一写入口是 dashboard 手动端点(api.mjs:2897)；密聊下真场景滑出 16 行 immediate 窗口(图书馆深埋 **42 turns**/晚餐 **34 turns**)后，过期"在家"注入**反客为主**→reply LLM 编"刚吃完麻辣香锅"(同 #317 凭空起头；proactive 出站空=非注入，排除 C)。memory 其实抽到了图书馆(mem860)但存成 episodic 过去事件+recall 语义错配没召回；晚餐零持久化、open_loops 零条。**三方向拍板**：①**对话驱动自动更新 current_scene(核心)**——**搭车现有 `extractAndSaveMemories` 的 LLM pass 加 current_scene 输出字段(零新增 LLM)**(该 pass 已读懂场景、只是流错地方=本取证最漂亮处)；current_scene=**可变当前态**(patch 非 append，区别 episodic 措辞，注释钉死)；**fail-open 反转**=提取失败→**置空/置"日常"，不留过期旧值**(过期反客为主是根因，旧值比空值危险)②**当日约定/会面态用 open_loops、不新建表**——"约晚餐/今天见面"本是经典 open_loop，本次 open_loops=0 是**抽取器漏抓这类的 bug 非缺表**；修抽取器抓"约定/会面"类 + 无条件注入(新 session_state 表=过度工程+多一个真相源)③**TTL/清场**——current_scene 随 新场景取代/session 结束/次日 00:30 更新、不累积；约定 open_loop 履约(真吃了)/取消才关，同现有生命周期；防隔日泄漏④**加长窗口否决**(治标·烧 token·密聊必溢)。**边界**:根因在记忆/场景层、非 emotion/L3；§6(companion.mjs)mood+scene 同段是唯一接触面，**本修只动 current_scene 写入路径、不动 §6 注入结构**，与 L3(#325 待第二轮审)排序不并发改 §6。**已落地 [PR #326](https://github.com/dimang01/xiyu-ai/pull/326)(3dacb99·CI 绿待合)**：①memory.mjs MEMORY pass 输出改对象{current_scene,memories}+applySceneUpdate(事件驱动/无场景保留/失败回落"日常"/到家是真切换不跳过)②open_loops.mjs 扩 prompt+QUICK_GATE 抓 kind=date→loopKind=appointment + buildOpenLoopsHint 无条件注入(appointment 置顶)+履约 resolve 词③memory.mjs resetScenesForNewDay+plan_tasks 00:30 批④companion.mjs §6 "日常"并入中性默认(不动 mood)。红验 scene_state_smoke 16(①持久/失败回落 ②注入/置顶 ③TTL +#324 端到端:场景滑出16行窗仍注图书馆)；回归全绿(works30/arc99+10/wording10/material42/p0 127)+lint；CI 门禁+1。**待维护者合+部署批(Claude 不碰)；gh 回 GeoDaoyu/关 #324=维护者本人**。**部署编排拍板：#326 单独部署批、不与 L3(#325)同批上——一个改记忆一个动情绪，分开部署归因干净(同"一次部署一个变量"纪律)；L3(#325 已出真 LLM 沙箱 5 场景+对照组·CI 绿待第二轮审)走自己的批** | ✅ PR #326 CI 绿·维护者将合·**单独部署批**(不碰部署) |
| 2026-06-13 | **生理期 L3 + 失忆 #326 批量质量测试（DeepSeek 真 LLM·维护者授权 ≤12 RMB·只读测试库不碰部署）**：标定先行(实测 ¥0.0093/轮·system prompt ~4600tok 是成本大头·1万轮≈¥93 远超 12)→维护者拍**砍到 ~1100 轮稳守 ≤¥12**。测试分支 `test/period-memory-qa`=L3(#325)+#326 ort 干净合。**跑量+自动四档筛(🔴红线/⚠断言失败/⚠启发式/✅只报数)+人看少量(≤50 导出)**。**结果 1104 轮/¥10.25**(B 提取~450 次未进 ai_usage·真实~¥11·**≤12 守住**)/598 断言点/通过 592/可疑 6。**结论**：①**生理期 L3 红线零真实命中**——唯一🔴是正则误报("躺床上呢今天没啥力气"被 `床上` 误判=理想经期蔫)；A4 safe_mode/A5 朋友/恋人 **100%**；A1/A2 实测全过(2⚠是关键词表漏"没劲/没精神"·她其实正确解释身体原因)→**生理期 L3 经 1100 轮验收通过·红线稳·蔫自然·追问才解释** ②**失忆 #326 抓到 2 真实边界**(自动筛真价值)：**#6 真失忆**=口语 terse 约定"明天帮我带杯奶茶"**没进 open_loop**(loopHint 空)→她"啥呀接不住"=extractOpenLoops 对 terse 约定有 gap；**#4/#5**=terse 场景"走 去电影院" **current_scene 没更新**(extraction 没捕获)·她靠对话历史仍记得(测试只聊 3 轮·场景没出 immediate 窗·**没真压 #326 长对话核心场景**)。**分类器 6 条 4 误报**(床上/没劲/"忘了"误判他忘)·已手验·**不为修误报重跑(省¥10)**。**停板待维护者看 6 条定**：①#326 terse 约定/场景边界要不要开 follow-up ②要不要补"长对话"B 测试(聊远 8-10 轮让场景出窗·真压 #324 根因·另约预算)。harness=`scripts/period_memory_qa_batch.mjs`(test 分支·未进 CI) | ✅ 测试收工(拍板见下条) |
| 2026-06-13 | **批量测试两停板拍板（维护者看 6 条后）→ 测试线收工待命**：①**开 #326 follow-up issue（enhancement·非 P0·不阻塞）**——提取器对**口语化极简表述**召回不足：terse 约定"明天帮我带杯奶茶"未提成 open_loop(#6 真失忆) + terse 场景"走 去电影院" current_scene 未更新(#4/#5·靠历史兜住)；根因同源(extractOpenLoops/场景提取 pass 对超短口语表述召回不足)；**修法方向=提取 prompt 补口语化极简表述 few-shot 例子**(排 L4 附近·同碰 open_loops)；**注明 #324 主修(讲故事后场景全失)已闭环·这是后续增强分开**。issue 由 Claude 拟稿、**维护者本人 gh 创建**(对外约定)②**长对话 B 测试记 backlog 不现在跑**——本轮只聊 3 轮·场景没出 16 行窗·没压到 #324 核心(场景滑出窗后失忆)；真验 #326 需聊远 8-10 轮让场景出窗。**backlog 原文**："#326 长对话失忆验证待补——本轮短对话已过，长对话(场景出窗)未压；待真实反馈(已回 #324 请 GeoDaoyu 帮验·真实触发比合成准) + 合成长对话测试(另约预算·单独设计 harness·排 L4 之后)双重确认"③分类器误报已知(床上/没劲/"忘了"误判)·**不为修误报重跑(省¥10)**·harness 留 test/period-memory-qa 分支备用。**结论定型**：**生理期 L3 经 1100 轮验收通过(红线零真实命中)**·#326 短对话 OK 长对话未验·2 个 terse 提取 gap 转 follow-up。**测试线收工待命；L4 等 L3 在生产跑出真实经期周期后再开** | ✅ 收工·issue 待维护者 gh 开 |
| 2026-06-13 | **★★ 红线：fine-tuning 用真实用户数据被隐私政策明文禁止（合规硬门·任何"训练/语料/初筛/凑训练集"会话先撞此条）**：①隐私政策第 2 节**中英双语**承诺「**不用于我们自有模型的训练** / never use it to train models of our own」，数据用途**封闭枚举为三项**（生成回复/记忆系统/故障排查），fine-tuning 不在内且被**显式排除** ②**存量 11 真实用户对话是在"绝不训练"承诺下收集的**，PIPL/GDPR 目的限定原则下**永久不可追溯用于训练，即使将来改协议**——这批存量基本死掉（不是量级不够，是法律上不能进训练管线）③**annotation_corpus 质量标注（人工读回复改 prompt/护栏）是可辩护的"服务改进"**（用户协议 line72"持续改进过滤与护栏机制"），**≠fine-tuning，两者严格分清**——别把"标注种子"顺势当训练集 ④**默认禁止**：任何会话提及"用用户数据训练/初筛/凑训练集"→ 先查本红线 ⑤**唯一合法路径**：改隐私政策写明 fine-tuning 用途 → 对**未来**数据取得明确 opt-in 同意 → **仅 opt-in 后新数据进管线，存量永不进**。**「fine-tuning 语料管线 phase-1」任务据此停在前置 0**：未读真实对话摸家底、未报 DeepSeek 初筛预算（初筛=把对话发 DeepSeek 建训练语料=超"生成回复"授权）；管线骨架若建只能用合成对话+现有标注种子跑通流程、不接真实数据。落 memory `reference-finetune-redline` 跨会话召回 | ✅ 红线已立 |
| 2026-06-13 | **v1.22.0 发版收口（[PR #328](https://github.com/dimang01/xiyu-ai/pull/328) CI 绿待合）**：把今天已合并并部署（生产 HEAD 7bb927d）的批量变更正式打版本——生理期 life_state(L1#322/L2#323/L3#325)+失忆修(#326)+deadman 三桶/reflection 心跳/playground 探针(#315)+reality_facts(节气农历)/works_schedule+#317 四档健康声明拦截。**版本号 1.21.6→1.22.0（维护者拍 minor·向后兼容无破坏·纯代码无迁移）**。**check:release 五项全过**：package.json 升 + README 中英版本历史加 v1.22.0 条 + 功能表加「身体节律/Body rhythm」行(56/56) + ROADMAP Last updated 刷 v1.22.0；pkg 领先 tag=发版窗口。**纯文档+版本号、无代码变更**（代码已在生产）。**release notes 草稿（三分类：她的生活有实物/失忆修复/监控强化·中文·无 PR 号）+ tag v1.22.0 + `gh release create` 命令已备**，**tag 推送/release 创建=维护者本人 gh 执行**（对外发布动作，同 issue 约定·Claude 拟稿）。部署无需动。批量 QA harness `period_memory_qa_batch.mjs` 留 test/period-memory-qa 分支备用 | ✅ #328 已合(origin/main f35801b)·tag/release 待维护者 gh |
| 2026-06-13 | **README 名实对账修复拍板（双向审计后·走分支 PR 不直推）**：审计无"凭空声称"硬伤，最伤信任的是 **Compliance 表自相矛盾**。**P0 提级**=危机干预 Compliance 行(zh:471/en:465)"当前不识别自伤/自杀"是假话（代码有 crisis 检测 + safety_smoke 门禁，同文档安全节/功能表都说已内置），脆弱用户/自托管者可能据此误判产品不安全→改"内置基础危机检测（自伤→退出角色+热线），不替代专业审核，公开运营请另接"，中英都改。**P1 名实不符**=②未成年保护 en(en:462) 同步 zh"v1.20 起内置粘性安全模式" ③CI 门禁数 31→"45+"（留余量防再过时·实际 ci.yml ≈49 门禁）④check:p0 en(en:280) 126→127 + 删过时括注。**补漏（合 #328 后·v1.22 版本史已自动有）**=⑥补独立功能表行 reality_facts(节气/农历)/current_works(在看的书/追的剧)/works_schedule(日程结构化)——v1.21.4 已上线有门禁、功能表层缺行=做了的功能门面看不见 ⑦失忆修 current_scene 功能表行 ⑧死人开关三桶 ⑨前端 17→20 ⑩scripts 数顺手。**小诚信**⑪"11维情绪状态机"→"10维增量+mood"统一口径(emotion_state dims 数组实为10)。**改完 check:release 绿确认引用/版本一致**。**已确认 #328 已合**。**已落地 [PR #329](https://github.com/dimang01/xiyu-ai/pull/329)**：中英 11 项全兑现、check:release 绿(功能表 60/60)、CI 全 49 门禁绿(49s·纯文档)；straggler 扫描(11维/当前不识别/门禁31/126/17frontend/80+)全清零。**待维护者合(纯文档无需部署·Claude 不碰合并)** | ✅ PR #329 CI 绿·待合 |
| 2026-06-13 | **fine-tune 红线补充（承 82 行·annotate 文案裁定）**：README 把标注工具叫"微调语料生产线 / fine-tuning corpus pipeline"——**纯开源框架 README 保留不改**（self-hoster 用自有数据微调合法、是框架正当能力）；**但旗舰运营方 xiyuai.cc 对外宣传绝不能用暗示"在线服务拿真实用户对话做微调/初筛/凑语料"的文案**，与隐私政策"不用于自有模型训练"中英双语承诺直接冲突。铁律：**工具能力（框架·合法）≠ 运营方对自家在线用户数据的使用（被隐私政策禁）**。已同步 memory [[reference_finetune_redline]] | ✅ 已记 |
| 2026-06-14 | **digest 信号校准修拍板（两项 06-14 晨 digest 跟进取证：均非故障·同病根=digest 把"预期沉默/预期拒绝"误报，走一个 PR）**：①取证钉死——**deadman 心跳"缺失"是假警报**：cycle 行 emit↔parse↔level↔path 全正常（昨日白天真写出 3 条 active=2 完美解析），根因是 proactive_deadman 夜间闸(沪23:00–09:00)在 cycle emit 前 early-return + arc-digest 只扫当前 bot.log 不读轮转 + 09:01 晨跑时当前 bot.log 只覆盖夜间窗→零 cycle，昨日白天行已轮转进 bot.log.1 不可见。tick 活/代码无漂移/非接线。**reflection 8 条蒸发=100% 预期**：全是 `跳过无边界映射的层 layer=relationship_rule`(设计内可见拒绝，#308 路径正常工作)，零 `insert 失败`(唯一 insert 失败在 06-12 旧 bug 已死)。②修法拍板（一个 PR）：**deadman 选 C+B**——C(主)心跳行脱离告警闸、无条件每周期写(夜间也写带 `quiet=1`/桶标记)，告警逻辑保持夜间静默(不半夜发邮件)，承"批管线必须有正向心跳"公理("允许合法缺席的心跳违背心跳意义")；B(兜底)digest 读轮转(bot.log.1+近期 .gz)跨午夜白天行可见。**reflection reject 分级**——relationship_rule 类"已知待 v1.23 边界映射拒绝"降 🟡 标注"预期·非蒸发(待v1.23)"不提"查 insert 失败"；真 CHECK/insert 失败保留 🔴+"查约束原因"(预期拒绝与真 bug 共用 🔴=狼来了，每早虚惊会淹没真 bug)。③**教训记账**：心跳类测试不能只测 emit↔parse 单元契约，要覆盖集成路径(夜间skip+日志轮转+扫描窗口)——proactive_heartbeat_smoke 漏报本案=契约没坏、缺席的语义解读有盲区。④**backlog(不修)**：reflection 每晚仍提议注定被拒的 relationship_rule(轻微浪费 LLM)=v1.23 前持有态。红验：夜间周期也写 quiet=1 心跳行 / digest 在轮转后窗口能读到昨日白天 cycle 行不再误报 / reflection reject 分级双路径各打对颜色。**已落地 [PR #330](https://github.com/dimang01/xiyu-ai/pull/330)**：C(proactive_deadman quiet 解耦)+B(新 digest_log_sources 轮转读)+cycle 行加 quiet 可选组(向后兼容旧行)+reject 两路径单一源(reflection_heartbeat)+digest 分级；新增 digest_log_rotation_smoke 钉集成路径(③)。**亲眼验(只读跑 prod 日志)**：digest 读到昨日白天 3 条 cycle(三桶累计 3 周期·不再"⚠ 无心跳") + reflection 段打 🟡8 条 relationship_rule(不再 🔴)。全 smoke 绿(heartbeat14/reflection14/rotation8/deadman27)+lint 净+check:release 一致+arc:digest 跑 prod 退出0。CI 门禁 +1。**待维护者合(不碰部署·prod 现有日志即兼容,合后随常规部署批生效)** | ✅ PR #330 CI 绿·待合 |
| 2026-06-14 | **照片↔语境错配修拍板（接线第六案·方向 1+2 立刻上·走分支 PR）**：取证抓到原案(prod companion=3 06-13 15:53)——档案场景"逛同人摊淘画集"→随机采到 food 品类→caption 编"排队买拿铁"→机位 shot_mode=ACTIVITY_POV(无脸·已落库)→却载入裁脸 i2i 参考出脸。**根因(主)=权威机位信号 shotMode 在出图边界被丢弃**：`buildFinalImagePrompt`(photo_sender) 靠 `isSceneryScene(scenePrompt)` 文本嗅探 LLM 生成的 imagePrompt 重判"要不要脸"，而非上游已定死且落库的 shotMode(line 415 只传 identityPrompt/scenePrompt/refImagePath，shotMode 仅用于落库日志 line 452)；嗅探判错(食物 POV 当人像)→挂裁脸参考+identity→出脸。两种漂移(LLM 在 POV 里夹人物词 R2 / 嗅探漏判 R1)都收敛到同一句"shotMode 无确定性执行"。**接线第六案**：上游权威信号下游不消费、靠文本嗅探重判——解法同族(权威信号直穿执行点)，与通电冒烟测试并列。**修(本 PR·1+2)**：①shotMode 直穿 buildFinalImagePrompt 做确定性无脸闸——ACTIVITY_POV/SCENERY(=food/trophy/thought/activity_pov/sky 等 no-face 品类的机位)一律"do NOT show face"+不挂裁脸参考+不写 identityPrompt；isSceneryScene 退为 shotMode 缺失时兜底(user-request 老路)②sender 红线断言：no-face shotMode 绝不载入/使用裁脸参考；双向红验(喂夹"young woman/waist up"的食物 prompt·ACTIVITY_POV 下必须仍无脸·把 LLM 漂移也兜住)。**次因分开排(不在本 PR)**：品类↔current_scene 协同(proactive 照片主体由 current_scene/日程偏置而非纯随机)=current_scene(#326)天然延伸(记得在哪→拍在做的事)，标 v1.22.x·依赖 current_scene 稳定后做。**backlog 低优**：user 索图 decideShotMode 只认自拍/风景/作业三类，食物/物件落到拍脸。改完红验+回归(current_works/p0)全绿待合 | 🔄 修复 PR 施工中 |

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
