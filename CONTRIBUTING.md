# 为溪语 AI 做贡献

谢谢你愿意花时间。这份文档 3 分钟读完，照着做 PR 基本一次过。

## 从哪开始

- 不知道做什么：看带 [`good first issue`](https://github.com/dimang01/xiyu-ai/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) 或 [`help wanted`](https://github.com/dimang01/xiyu-ai/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) 标签的 issue
- 想做大改动：先开 issue 讨论，避免方向不对白写
- 报 bug / 提功能：用 issue 模板，信息越具体越快被处理
- 安全漏洞：**不要开公开 issue**，走 [SECURITY.md](./SECURITY.md)

## 开发环境

```bash
git clone https://github.com/dimang01/xiyu-ai.git
cd xiyu-ai
npm install        # Node ≥ 20，better-sqlite3 需要编译工具链
npm run setup      # 生成最小 .env + 预检
npm start          # http://localhost:3000
```

不用微信凭据也能开发：`/app/playground.html` 在浏览器里跑完整人设管线。

## 提交 PR 前自检

```bash
node --check <你改过的每个 .mjs>
npm run check:imports              # ESM 循环依赖 / 死 import
npm run check:p0                   # P0/P1 回归（HTTP 部分需本地起服务，CI 会跑纯代码部分）
bash scripts/opensource_check.sh   # 开源合规 6 项，必须 6/6
```

CI 还会跑情绪机压测、safety 护栏等 smoke（见 `.github/workflows/ci.yml`），全绿才合。

## PR 约定

- **小而聚焦**：一个 PR 解决一件事；大改动拆成多个
- commit 首行 ≤72 字，风格 `feat:` / `fix:` / `hotfix:` / `chore:` / `docs:`
- PR 描述写清**动机**（为什么改）比写改了什么更重要
- 不要提交任何密钥 / `.env` / `data/` 下的运行时数据

## 产品调性（重要）

这个项目有明确的产品哲学，跟代码规范同等重要：

- **真人感 = 减法，不是加法。** AI 味的根源是"太好了"——太及时、太顺从、太完美。让她更像人的方向是拿掉过度服务，而不是叠功能
- **北极星：「愿意在真实生活的空隙给你温柔和陪伴」。** 她有自己的生活，少、准、轻，而不是填满
- **调性红线：** 远离黑化 / 病娇 / 色气 / 致郁 / 沉迷向幻象。偏向温暖、有尊严、"她像个有自己生活的真实的人"

与调性冲突的功能 PR（例如 NSFW 模式、多角色后宫、无限讨好）不会被合并，提前说明省双方时间。

## 已知做不了的（别踩坑）

- **微信端发语音**：iLink 协议层禁止 outbound voice，实测 HTTP 200 但静默丢弃，不是代码问题
- **Pro/Free 分级**：v1.3.4 已全部撤掉，不要重新引入
- 详见 README「已知限制」一节

## 许可

提交贡献即表示你同意以 [MIT](./LICENSE) 协议发布你的代码。
