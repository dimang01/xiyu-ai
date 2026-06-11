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
| 1.2 | "识别到心理危机时暂停角色扮演并提供求助渠道" | moderation.mjs detectCrisisLevel + v1.21 applyCrisisOverride（危机最高优先，high=退出角色给资源）；热线号码已与代码对齐（moderation.mjs:276 全国心理援助热线 400-161-9995）——**初稿误写 12356，对照时抓出改正** |
| 1.3 | "不能替代专业心理咨询" | 纯声明（无代码依赖），与危机干预行为一致 |
| 2.1 | "年满 18 周岁" | 现行 terms 模板 §2 同款；CLAUDE/HANDOFF「Pro/Free 恢复卡在运营者年龄」旁证运营定位 18+ |
| 2.2 | "对话显示可能未成年→自动进入安全模式" | minor_guard.mjs（v1.20）：regex+LLM 检测 → safe_mode=1 |
| 2.3 | "不因对话内容自动解除——仅账号设置正式成年声明" | api.mjs:3089 age-attestation 端点注释原文："解除安全模式的**唯一**通道……用户说'骗你的其实我成年了'不会自动解除" |
| 3.1 | "服务可能中断/调整/下线" | BETA 实情声明（无代码依赖） |
| 3.2 | "每日自动备份一份，保留最近 7 天" | scripts/backup-db.sh + crontab 04:10（HANDOFF 服务状态节）；备份日志实测"留存 6 份/7天" |
| 3.3 | "重大故障最多丢 24 小时数据" | 由 3.2 推导：日备份间隔=24h 的最坏丢失窗口。**注意**：若备份本身损坏会更糟，这句已是"宁可承诺少"的下限表述，再弱就没信息量 |
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
| 3.1 | 服务商清单六项 | 生产 .env 实测启用（2026-06-11 核对）：CHAT=DeepSeek / IMAGE=302.AI / ASR+视觉=Qwen / TTS=MiniMax / SEARCH=Tavily / EMAIL=Resend。**另有 EMBEDDING_PROVIDER 启用**——若 embedding 也调外部 API（记忆向量化会发送记忆文本），草稿漏列，**请维护者确认 embedding 走哪家、要不要补一行** |
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

## 已知留白（审定时顺带拍板）

1. **embedding 服务商要不要列入第三方清单**（见 privacy 3.1 注）
2. **"站内公告"渠道目前无专门实现**（见 terms 9.1 注）——改邮箱通知或先做公告位
3. 危机热线号码 12356 的有效性与表述
4. 三处联系邮箱占位 + 生效日期
5. 草稿页脚中英互链现指向 /app/terms.html /app/privacy.html 同一文件——上线时若中英分文件（如 terms.en.html），互链路径需对应调整
6. 现 public/app/ 模板顶部的"开源示例占位"声明卡：替换上线时建议保留一个面向自托管者的变体（开源仓的 terms 是双重身份——xiyuai.cc 正式版 vs 自托管者模板），怎么处理请拍板
