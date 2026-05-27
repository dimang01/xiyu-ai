#!/usr/bin/env python3
"""
从 ChineseBQB 下载可爱表情包并生成 manifest.json。

策略：
- 挑选适合 AI 女友聊天的几个包（CuteGirl / HanazawaKana / Cat / Duck / Hamster / MurCat）
- 每包挑前 N 个文件
- 根据中文文件名关键字自动派生 tags / emotion
- 文件名重写为 ASCII slug（避免 iLink CDN 上传时的编码问题）
- 大于 MAX_SIZE 的跳过
- 合并写入 assets/stickers/manifest.json
"""

import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STICKER_DIR = ROOT / "assets" / "stickers"
MANIFEST_PATH = STICKER_DIR / "manifest.json"

BASE = "https://api.github.com/repos/zhaoolee/ChineseBQB/contents/"
RAW_BASE = "https://raw.githubusercontent.com/zhaoolee/ChineseBQB/master/"

MAX_SIZE = 500 * 1024   # 500KB 上限
PER_PACK = 12           # 每包最多下载几个

# 关键字 → tag/emotion 映射（命中多个就都加进 tags）
KEYWORD_MAP = {
    # 情绪
    "笑": ["happy"], "嘻嘻": ["happy"], "哈哈": ["happy"], "开心": ["happy"], "乐": ["happy"],
    "害羞": ["shy"], "脸红": ["shy"], "羞": ["shy"],
    "哭": ["sad", "cry"], "委屈": ["sad", "pout"], "难过": ["sad"],
    "困": ["sleepy"], "睡": ["sleepy", "sleep"], "晚安": ["night", "sleepy"],
    "生气": ["angry"], "气": ["angry"], "凶": ["angry"], "怒": ["angry"],
    "爱": ["love"], "喜欢": ["love"], "心动": ["love"], "比心": ["love"],
    "亲": ["kiss"], "mua": ["kiss"], "Mua": ["kiss"],
    "抱": ["hug"], "拥抱": ["hug"],
    "想你": ["love", "think"], "想": ["think"], "思考": ["think"],
    "嘟嘴": ["pout"], "撒娇": ["cute"], "嗲": ["cute"], "萌": ["cute"], "可爱": ["cute"],
    "蒙": ["shock"], "惊": ["shock"], "震惊": ["shock"],
    "得意": ["proud"], "骄傲": ["proud"], "傲娇": ["proud"],
    "yeah": ["happy", "cheer"], "耶": ["cheer"], "胜利": ["cheer"], "加油": ["cheer"],
    "OK": ["ok"], "ok": ["ok"], "好的": ["ok"], "好": ["ok"],
    "不行": ["no"], "不要": ["no"], "拒绝": ["no"],
    # 动作
    "招手": ["wave"], "再见": ["wave"], "拜拜": ["wave"], "byebye": ["wave"],
    "吃": ["eat"], "饿": ["eat", "hungry"],
    "喝": ["drink"], "茶": ["drink"], "奶茶": ["drink"],
    "摸头": ["cute"], "rua": ["cute"],
    "送花": ["flower", "love"], "花花": ["flower"],
    # 场景
    "早安": ["morning"], "早上好": ["morning"],
    "晚上": ["night"], "夜": ["night"],
    "周末": ["weekend"],
    "蛋糕": ["cake"], "生日": ["birthday", "cake"],
    "咖啡": ["coffee"],
}

# 挑选这几个包 + 每包"建议主标签"
PACKS = [
    ("002CuteGirl_可爱的女孩纸👧BQB", ["cute", "girl"], "cute"),
    ("040HanazawaKana表情包三巨头_花泽香菜BQB", ["cute", "girl"], "happy"),
    ("060MurCat_Mur猫😺BQB", ["cat", "cute"], "cute"),
    ("010Cat_是喵星人啦🐱BQB", ["cat"], "cute"),
    ("049CatEveryday_猫咪日常BQB", ["cat"], "cute"),
    ("008HappyDuck_开心鸭🐥BQB", ["duck", "cute"], "happy"),
    ("057HappyDuck_开心鸭BQB", ["duck", "cute"], "happy"),
    ("006Hamster_仓鼠🐹BQB", ["hamster", "cute"], "cute"),
]


def slugify(text, fallback="item"):
    text = re.sub(r"[一-鿿]+", "", text)
    text = re.sub(r"[^A-Za-z0-9_]+", "_", text).strip("_").lower()
    return text or fallback


def tags_from_name(name, base_tags):
    found = set(base_tags)
    for kw, tags in KEYWORD_MAP.items():
        if kw.lower() in name.lower():
            for t in tags:
                found.add(t)
    return sorted(found)


def pick_emotion(tags, default):
    priority = ["love", "kiss", "hug", "happy", "shy", "sad", "sleepy", "angry",
                "shock", "proud", "cheer", "pout", "cute", "wave"]
    for p in priority:
        if p in tags:
            return p
    return default


def http_get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "xiyuai-sticker-fetcher"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def http_download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "xiyuai-sticker-fetcher"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    dest.write_bytes(data)
    return len(data)


def main():
    STICKER_DIR.mkdir(parents=True, exist_ok=True)
    existing = json.loads(MANIFEST_PATH.read_text("utf-8")) if MANIFEST_PATH.exists() else {}
    stickers = list(existing.get("stickers", []))
    existing_files = {s.get("file") for s in stickers}
    existing_ids = {s.get("id") for s in stickers}

    counter = 0
    skipped = 0
    pack_idx = 0
    for pack_dir, base_tags, default_emotion in PACKS:
        pack_idx += 1
        url = BASE + urllib.parse.quote(pack_dir, safe="")
        try:
            items = http_get_json(url)
        except Exception as e:
            print(f"[skip pack] {pack_dir}: {e}", file=sys.stderr)
            continue
        if not isinstance(items, list):
            print(f"[skip pack] {pack_dir}: not a list", file=sys.stderr)
            continue
        files = [it for it in items
                 if it.get("type") == "file"
                 and it["name"].lower().endswith((".png", ".jpg", ".jpeg", ".gif"))]

        # 排除超大的、优先尺寸适中的
        files = [f for f in files if f.get("size", 0) <= MAX_SIZE]
        files = files[:PER_PACK]

        for idx, it in enumerate(files, 1):
            orig_name = it["name"]
            ext = Path(orig_name).suffix.lower()
            base_slug = slugify(pack_dir.split("_")[0] if "_" in pack_dir else pack_dir, "pack")
            new_name = f"{base_slug.lower()}_{idx:02d}{ext}"
            dest = STICKER_DIR / new_name
            sticker_id = f"{base_slug.lower()}_{idx:02d}"
            if dest.exists() or new_name in existing_files or sticker_id in existing_ids:
                skipped += 1
                continue
            raw_url = RAW_BASE + urllib.parse.quote(pack_dir + "/" + orig_name, safe="/")
            try:
                size = http_download(raw_url, dest)
            except Exception as e:
                print(f"[fail] {orig_name}: {e}", file=sys.stderr)
                continue
            tags = tags_from_name(orig_name, base_tags)
            emotion = pick_emotion(tags, default_emotion)
            stickers.append({
                "id": sticker_id,
                "file": new_name,
                "tags": tags,
                "emotion": emotion,
                "description": orig_name.rsplit(".", 1)[0],
                "source": f"ChineseBQB/{pack_dir}/{orig_name}",
            })
            counter += 1
            print(f"  + {new_name} ({size//1024}KB) tags={tags}")

    # 写入 manifest
    out = {
        "_README": existing.get("_README", "把表情图片放到本目录下，并在 stickers[] 里登记。重启后生效。"),
        "_tagsCheatsheet": existing.get("_tagsCheatsheet", [
            "情绪: happy / shy / sad / sleepy / angry / love / shock / proud / cute / pout",
            "动作: hug / kiss / wave / cheer / cry / sleep / eat / drink / think",
            "场景: morning / night / weekend / cake / coffee / flower",
        ]),
        "_source": "ChineseBQB (https://github.com/zhaoolee/ChineseBQB) — CC0",
        "stickers": stickers,
    }
    MANIFEST_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), "utf-8")
    print(f"\n下载完成：+{counter} 张新表情，跳过 {skipped}，manifest 共 {len(stickers)} 项")


if __name__ == "__main__":
    main()
