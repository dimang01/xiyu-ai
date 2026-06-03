# Stickers / 表情包

[中文](#中文) · [English](#english)

---

## 中文

### 为什么仓库里没有表情包图片？

本开源仓库**只包含**表情包的加载与匹配机制（`src/stickers.mjs`），**不分发**任何真实表情包图片。

原因：

- 一些常见表情包集合可能含有第三方 IP、影视动漫角色、网络梗图或用户上传内容，重新分发时的授权状态不清晰。
- 仓库只保留加载机制；图片本体请你自行准备**有合法授权**的素材。

### 期望目录结构

```text
assets/stickers/
├── manifest.json          # 由你创建
├── happy/                 # 任意 tag 名作为子目录
├── love/
├── cat/
└── sleepy/
```

`src/stickers.mjs` 期望的 `manifest.json` 形如：

```json
{
  "happy":  ["happy/01.gif", "happy/02.png"],
  "love":   ["love/01.gif"],
  "cat":    ["cat/01.jpg"],
  "sleepy": ["sleepy/01.gif"]
}
```

本目录下的 `manifest.example.json` 是一份空模板可以照抄。

### 推荐来源 + 一键填库（v1.9.2 新增）

仓库自带一个 Python 抓取脚本：

```bash
npm run stickers:fetch          # 或者：python3 scripts/fetch_stickers.py
```

脚本会从 [ChineseBQB](https://github.com/zhaoolee/ChineseBQB) 抓取 12 个默认 pack（动物 / 通用可爱 / 反讽 meme），自动从中文文件名派生 emotion 标签，写入 `manifest.json`。完成后表情包功能立即可用，AI 在 system prompt 里会看到 tag 列表并在合适场景插入 `[STICKER:xxx]` 标记。

支持的 emotion 标签范围（v1.9.2 扩展）：

| 类型 | tag 例子 |
|---|---|
| 基本情绪 | happy, sad, angry, shy, love, kiss, sleepy |
| **反讽 / 吐槽 / meme**（v1.9.2 新增）| mock, sarcasm, dismissive, eyeroll, whatever, speechless, awkward, tsun |
| 状态 | shock, confused, suspicious, tired, drama |
| 场景 | morning, night, weekend, birthday, coffee |
| 动物 | cat, duck, hamster, turtle, chicken |

#### ⚠️ 版权与合规要求

**fetch 脚本只是一个起点**。你必须自己评估并对 production 使用负责：

- **动物类**（cat / duck / hamster / turtle 等）通常无 IP 风险
- **PandaHead 金馆长熊猫** 源自互联网二创，**商业 / 公网部署慎用**或替换为自己原创
- 默认列表已**排除**含真人头像 / 影视截图 / 政治符号 / 种族敏感内容的 pack
- 跑完脚本后**人工 review** `assets/stickers/` 目录，删掉任何你认为不合规的素材
- 重新跑 `npm run stickers:fetch` 不会重复下载已有文件
- **不要**把抓回来的素材 commit 到公开仓库 —— `assets/stickers/*` 不在 `.gitignore` 里只是为了 `manifest.example.json` 可见

#### 完全自备素材

如果你不想用 ChineseBQB，按 [期望目录结构](#期望目录结构) 自己放图片 + 写 `manifest.json` 即可。

### 其他来源

- 你自己有权使用的素材
- CC0 表情包合集（如 OpenMoji）
- 自制 / 委托设计

### 如果这个目录一直是空的会怎样？

如果 `manifest.json` 缺失或为空，**表情包功能会被自动禁用**，应用正常启动，AI 只是不会再插入 `[STICKER:tag]` 标记。具体细节见 `src/stickers.mjs`。

---

## English

### Why aren't sticker images shipped here?

The repository contains **only the sticker loading and tag-matching code** (`src/stickers.mjs`). **No actual sticker images are bundled or redistributed.**

Reasons:

- Common sticker collections often include third-party IP, anime / TV characters, memes, or user-contributed art whose redistribution rights are unclear.
- This repo keeps only the loader; you bring your own **licensed** assets.

### Expected layout

```text
assets/stickers/
├── manifest.json          # you create this
├── happy/                 # any sub-folder name matching a tag
├── love/
├── cat/
└── sleepy/
```

A `manifest.json` compatible with the loader in `src/stickers.mjs` looks like:

```json
{
  "happy":  ["happy/01.gif", "happy/02.png"],
  "love":   ["love/01.gif"],
  "cat":    ["cat/01.jpg"],
  "sleepy": ["sleepy/01.gif"]
}
```

See `manifest.example.json` in this directory for the canonical empty shape.

### Suggested sources + one-shot fetcher (added in v1.9.2)

A Python fetcher is bundled:

```bash
npm run stickers:fetch          # or: python3 scripts/fetch_stickers.py
```

The script pulls 12 default packs from [ChineseBQB](https://github.com/zhaoolee/ChineseBQB) (animals / generic cute / sarcasm memes), auto-derives emotion tags from Chinese filenames, and writes `manifest.json`. Sticker replies activate immediately — the AI sees the tag list in its system prompt and inserts `[STICKER:xxx]` markers when appropriate.

Supported emotion tags (expanded in v1.9.2):

| Category | Tag examples |
|---|---|
| Basic emotions | happy, sad, angry, shy, love, kiss, sleepy |
| **Sarcasm / mock / meme** (new in v1.9.2) | mock, sarcasm, dismissive, eyeroll, whatever, speechless, awkward, tsun |
| States | shock, confused, suspicious, tired, drama |
| Scenes | morning, night, weekend, birthday, coffee |
| Animals | cat, duck, hamster, turtle, chicken |

#### ⚠️ License & compliance

**The fetcher is only a starting point.** You must do your own evaluation:

- Animal packs (cat / duck / hamster / turtle) usually have no IP risk
- **PandaHead** memes originate from internet remix culture — replace with your own art for commercial / public deployment
- Default list already **excludes** packs containing real-person photos / TV stills / political symbols / racially sensitive content
- After running the script, **manually review** the `assets/stickers/` directory and delete anything you find non-compliant
- Re-running `npm run stickers:fetch` skips already-downloaded files
- **Do NOT** commit fetched assets to a public repo

#### Fully BYO assets

If you don't want to use ChineseBQB at all, drop your own images per the [layout above](#expected-layout) and write your own `manifest.json`.

### Other sources

- Anything you have the right to use
- CC0 sticker collections (e.g. OpenMoji)
- Self-made or commissioned art

### What happens if this directory stays empty?

If `manifest.json` is missing or empty, sticker replies are **silently disabled**. The application starts normally and the AI just won't insert `[STICKER:tag]` markers. See `src/stickers.mjs` for details.
