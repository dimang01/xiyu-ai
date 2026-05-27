# Stickers

Sticker image files are **not** included in this open-source repository.

Reason:

- Sticker packs may contain third-party IP, memes, anime characters, or user-contributed images whose licensing is unclear when redistributed.
- The application only provides the **sticker loading mechanism** (see `src/stickers.mjs`).
- Please prepare your own licensed sticker assets before production use.

## Expected structure

```text
assets/stickers/
├── manifest.json          # you create this
├── happy/                 # any sub-folder name matching a tag
├── love/
├── cat/
└── sleepy/
```

A `manifest.json` compatible with the sticker loader used by `src/stickers.mjs` looks like:

```json
{
  "happy":  ["happy/01.gif", "happy/02.png"],
  "love":   ["love/01.gif"],
  "cat":    ["cat/01.jpg"],
  "sleepy": ["sleepy/01.gif"]
}
```

See `manifest.example.json` in this directory for the canonical empty shape.

## Suggested sources

- [ChineseBQB](https://github.com/zhaoolee/ChineseBQB) — a popular Chinese sticker collection (please read its license and per-pack source before redistributing)
- Any sticker pack you have rights to use

## What happens if this directory stays empty?

If `manifest.json` is missing or empty, sticker replies are **silently disabled**. The application starts normally and the AI just won't insert `[STICKER:tag]` markers. See `src/stickers.mjs` for details.
