# 协议草稿 · 逐句事实对照表（2026-06-11，对应 v1.21.4 代码）

> ⚠️ **法律免责声明**：本对照表与四份草稿（terms / privacy 中英）是工程对照产物——
> 每条承诺核对的是"代码当前是否真的这么做"，不是法律合规性判断。
> **正式上线前建议过一次专业法律审阅。** 审表方式：逐行看「承诺 ↔ 证据」，
> 证据撑不住的句子直接删。

> 待维护者填写的占位（共 3 处 ×中英两版）：生效日期、运营者联系邮箱（terms §10 / privacy §6、§9）。

## 用户协议（terms.html）

| # | 草稿承诺 | 代码/配置证据 |
|---|---|---|
| 1.1 | "不是真人……均由 AI 生成" | 落地页 AI 披露（v1.16 合规项，public/index.html）；persona_guard AI 自称检测反向印证全链是 AI |
| 1.2 | "系统会在识别到相关风险时提供求助热线信息" | moderation.mjs detectCrisisLevel + applyCrisisOverride（high=退出角色给资源，热线文本在 moderation.mjs:276-277）。**文书引用机制不引用常量**：协议不写死号码，换号码不产生文书漂移（初稿曾误写 12356，第二稿曾写死 400-161-9995，终稿按拍板去号码化） |
| 1.3 | "不能替代专业心理咨询" | 纯声明（无代码依赖），与危机干预行为一致 |
| 2.1 | "年满 18 周岁" | 现行 terms 模板 §2 同款；CLAUDE/HANDOFF「Pro/Free 恢复卡在运营者年龄」旁证运营定位 18+ |
| 2.2 | "对话显示可能未成年→自动进入安全模式（停止亲密向互动、不再主动发送情感类消息）" | minor_guard.mjs（v1.20）：regex+LLM 检测 → safe_mode=1；行为=不拼想念/撒娇情绪话术（buildEmotionPromptHint safe_mode 分支）+ 禁主动告白（proactive confession 闸）+ arc 钳位优先 |
| 2.3 | "粘性：不因后续对话内容（含口头声称已成年）自动解除，仅可通过管理页面提交正式成年声明（显式确认出生年份）解除" | api.mjs:3089 age-attestation 端点（"解除安全模式的**唯一**通道"+需勾选确认+声明未成年年份保持安全模式）；入口实测在 dashboard.html:1627；safe_mode 不进 ALLOWED_FIELDS（PATCH 改不动，粘性是结构性的）——措辞已按 v1.20.0 真实机制逐词对齐（拍板补充②） |
| 3.1 | "服务可能中断/调整/下线" | BETA 实情声明（无代码依赖） |
| 3.2 | "每日自动备份一份，保留最近 7 天" | scripts/backup-db.sh + crontab 04:10（HANDOFF 服务状态节）；备份日志实测"留存 6 份/7天" |
| 3.3 | "重大故障最多丢 24 小时数据" | 由 3.2 推导：日备份间隔=24h 最坏窗口；**恢复演练有文档**（docs/PRODUCTION.md §7.2，v1.9.0+ 含逐步恢复流程与"有备份≠能恢复"月度演练建议）——演练过的诚实，从免责声明升格为可信声明 |
| 4.1 | "绕过频率限制/滥用接口" | ratelimit.mjs（api 多端点挂载）+ moderation inboundIsBlocked |
| 4.2 | "限制、暂停或终止账号" | admin.mjs is_banned 封禁机制（admin.html 有封禁 UI） |
| 5.1 | "你输入的内容归你所有" | 法律声明；服务端无任何主张用户内容所有权的行为 |
| 5.2 | "导出功能" | persona_export.mjs：GET /api/companions/:id/export（人设+核心记忆 JSON） |
| 5.3 | "代码 MIT 开源" | LICENSE 文件 |
| 6.1 | "内测期间全功能免费" | api.mjs BETA_ALL_PRO（HANDOFF：商户号未开，无任何收费路径） |
| 6.2 | "收费提前 30 日通知" | 对未来的程序性承诺（无代码依赖）；30 日数字请维护者确认接受 |
| 7.1 | "可能出现错误/不适内容……无法保证逐条完美" | 诚实化基调；护栏体系（persona_guard/moderation/redline）真实存在但非完美，如实表述 |
| 8.1 | "中国大陆法律 + 运营者所在地法院" | 任务书指定；管辖条款请法律审阅确认表述 |
| 9.1 | "更新生效日期 + 重大变更站内公告" | 程序性承诺；站内公告=落地页/dashboard 公告位（目前无专门公告组件——**站内公告若无实现渠道，此句考虑改为'本页面更新+注册邮箱通知'**，标黄给维护者拍板） |

## 隐私政策（privacy.html）

| # | 草稿承诺 | 代码/配置证据 |
|---|---|---|
| 1.1 | "密码以加盐哈希存储" | 用户密码：api.mjs:445 hashPassword（scrypt N=16384 加盐 + timingSafeEqual 校验）；admin 密码：admin.mjs:86 同 scrypt |
| 1.1b | "注册时填写的出生日期（仅用于成年验证）" | db.mjs:1047 user_accounts.birthday / age_at_registration 列（注册端点收集）——**起草初稿曾漏列，对照表自查补上** |
| 1.2 | "微信标识……不含微信密码或好友关系" | wechat_accounts 表仅存 wechat_user_id/bot_id/token；iLink 协议无通讯录接口 |
| 1.3 | "语音原始文件不留存" | voice_inbound.mjs:100-117：/tmp 临时转码，finally unlink 必删 |
| 1.4 | "图片原图不留存" | bot.mjs:531-533：fetchBuffer 内存识别（recognizeImage）后 buf 丢弃，无任何 writeFile；wechat_messages 只存 '[image]' 占位与识别文字 |
| 1.5 | "记忆/情绪等衍生数据" | companion_memories / emotion_state / relationship 系列表 |
| 1.6 | "不收集通讯录/位置/设备指纹/浏览历史" | 全仓无相关采集代码（grep geolocation/contacts/fingerprint 零命中） |
| 2.1 | "三个目的：生成回复/记忆/排查" | 与落地页诚实化文案（v1.21.1，index.html:772）一致 |
| 2.2 | "不出售、不自训、无广告" | 落地页现行承诺原文（"不出售你的数据，也不用于我们自有的模型训练"）+ 全站无广告代码 |
| 3.1 | 服务商清单七项 | 生产 .env 实测（2026-06-11/12 两次核对）：CHAT=DeepSeek / **EMBEDDING=Google Gemini（已按拍板列入：记忆文本外发生成向量，"用户原文出了服务器"判定成立）** / IMAGE=302.AI / ASR+视觉=Qwen / TTS=MiniMax / SEARCH=Tavily / EMAIL=Resend |
| 3.2 | "搜索仅发送提炼后的关键词" | web_search.mjs shouldSearch→query 提炼；非全文转发 |
| 3.3 | "Resend 仅发送邮箱与邮件内容" | email.mjs：验证码/运维告警两类 |
| 4.1 | "未做静态加密，如实告知" | SQLite 明文文件（data/bot.db）；诚实化基调主动披露 |
| 4.2 | "聊天原文 60 天自动清理" | plan_tasks.mjs:481：DELETE wechat_messages < -60 days（每小时 cleanup cron） |
| 4.3 | "对话上下文每角色约 100 轮，更早归纳为摘要后删原文" | plan_tasks.mjs:483-492：turns 留 100 + buildLongTermDigest 归档注释 |
| 4.4 | "记忆摘要长期保留直到删除" | companion_memories 无自动过期（decay 降权不删除；用户删除走 API） |
| 4.5 | "备份保留 7 天滚动" | backup-db.sh（同 terms 3.2） |
| 5.1 | "凭据类整条拒入长期记忆" | privacy_filter.mjs filterForStorage：shouldStoreMemory=false 整条丢弃（密码/key/身份证/银行卡） |
| 5.2 | "手机号/住址/学校班级脱敏" | privacy_filter.mjs REDACT_RULES → [已脱敏:住址] 等替换 |
| 5.3 | "60 天内原始聊天不经此过滤" | filterForStorage 挂载点在 saveMemory 等长期存储口（v1.20 八口子）；wechat_messages 原文不过滤——如实披露 |
| 6.1 | "记忆管理页查看" | /app/memories.html（7 层记忆 CRUD） |
| 6.2 | "导出 JSON" | persona_export（同 terms 5.2） |
| 6.3 | "删除单条/全部记忆" | DELETE /api/companions/:id/memories[/:mid]（api.mjs:38-39） |
| 6.4 | "删除角色及关联数据" | deleteCompanionForAccount（级联清理含 user_profiles 等） |
| 6.5 | "无自助删号，邮件申请 15 个工作日人工处理" | **全仓无 DELETE /me 端点（已核实）**——如实写人工路径；15 工作日数字请维护者确认接受 |
| 7.1 | 未成年人条款 | 同 terms 2.2/2.3 |

## 留白拍板结果（2026-06-12 全部落实）

1. ✅ embedding 列入（Gemini）——判定标准"用户原文出了服务器没有"
2. ✅ "站内公告"全部改"本页面更新 + 注册邮箱通知"（没有的渠道不进协议）
3. ✅ 热线去号码化："系统会在识别到相关风险时提供求助热线信息"——文书引用机制不引用常量
4. ✅ 生效日期 2026-06-12；邮箱 support@xiyuai.cc（×3 处，**维护者需在邮件服务商侧配置该收件地址**）
5. ✅ 中英平级文件（terms.html / terms.en.html），顶部右上角语言切换
6. ✅ 正文只服务 xiyuai.cc（§1 适用范围句）+ 四份源码头注释"自托管必须替换并自行承担合规责任" + README 自托管节同步一句
