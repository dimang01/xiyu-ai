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

### 推荐来源

- [ChineseBQB](https://github.com/zhaoolee/ChineseBQB) — 一个常见的中文表情包合集（请阅读其 License 与每个子集的具体来源后再决定是否再分发）
- 你自己有权使用的任何素材

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

### Suggested sources

- [ChineseBQB](https://github.com/zhaoolee/ChineseBQB) — a popular Chinese sticker collection (please read its license and per-pack source before redistributing)
- Any pack you have rights to use

### What happens if this directory stays empty?

If `manifest.json` is missing or empty, sticker replies are **silently disabled**. The application starts normally and the AI just won't insert `[STICKER:tag]` markers. See `src/stickers.mjs` for details.
