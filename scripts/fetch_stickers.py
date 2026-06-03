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
    # ── 情绪 · 基本 ──
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

    # ── v1.9.2: 反讽 / 吐槽 / 嘲讽 / 翻白眼（meme 场景，截图里熊猫"你又觉得你配了"那种） ──
    "无语": ["whatever", "speechless"],
    "翻白眼": ["eyeroll", "dismissive"],
    "白眼": ["eyeroll", "dismissive"],
    "嘲": ["mock", "sarcasm"], "嘲讽": ["mock", "sarcasm"],
    "讽刺": ["sarcasm"],
    "切": ["dismissive"], "哼": ["dismissive", "tsun"],
    "呵呵": ["sarcasm", "dismissive"],
    "啊这": ["awkward", "speechless"],
    "尴尬": ["awkward"],
    "汗": ["awkward"],
    "懒得": ["dismissive", "tired"],
    "随便": ["dismissive", "whatever"],
    "算了": ["dismissive"],
    "无奈": ["resigned", "tired"],
    "敷衍": ["dismissive"],
    "呸": ["dismissive", "mock"],
    "鄙视": ["mock", "dismissive"],
    "傻": ["mock", "tease"], "蠢": ["mock"],
    "笨": ["tease", "mock"], "笨蛋": ["tease"],
    "废": ["mock"], "菜": ["mock", "tease"],
    "牛": ["impressed", "praise"], "厉害": ["impressed"],
    "服": ["impressed", "speechless"],
    "扎心": ["heartbroken", "mock"],
    "心碎": ["heartbroken"],
    "戏": ["drama"], "演": ["drama"],
    "酸": ["jealous", "petty"],
    "柠檬": ["jealous"],
    "怀疑": ["suspicious"], "怀疑人生": ["speechless"],
    "?": ["confused"], "？": ["confused"],
    "啥": ["confused"], "什么鬼": ["confused", "speechless"],
    # 熊猫头系列高频文案
    "熊猫": ["meme", "panda"],
    "再见.*兄弟": ["dismissive"],
    "我裂开": ["speechless", "broken"],
    "你礼貌吗": ["dismissive", "speechless"],
    "牛逼": ["impressed", "praise"],

    # ── 动作 ──
    "招手": ["wave"], "再见": ["wave"], "拜拜": ["wave"], "byebye": ["wave"],
    "吃": ["eat"], "饿": ["eat", "hungry"],
    "喝": ["drink"], "茶": ["drink"], "奶茶": ["drink"],
    "摸头": ["cute"], "rua": ["cute"],
    "送花": ["flower", "love"], "花花": ["flower"],

    # ── 场景 ──
    "早安": ["morning"], "早上好": ["morning"],
    "晚上": ["night"], "夜": ["night"],
    "周末": ["weekend"],
    "蛋糕": ["cake"], "生日": ["birthday", "cake"],
    "咖啡": ["coffee"],
}

# 挑选这几个包 + 每包"建议主标签"
#
# ⚠️ 版权提示（v1.9.2 修订，本注释必须保留）：
# 以下列表是抓取**默认值**，跑脚本前请自己确认每个 pack 的实际素材来源：
# - 动物类（cat/duck/hamster/turtle）通常风险最低，多为原创/CC0 风格
# - PandaHead 系列源自互联网 meme 二创，**商业/公网部署慎用**
# - 不要加入含真人头像 / 影视截图 / 政治符号 / 种族敏感内容的 pack
#   （ChineseBQB 仓库里有此类内容，已被本默认列表排除）
# 你的 production 责任：跑脚本 → 人工筛 → 删掉不合规素材 → 重建 manifest
PACKS = [
    # 通用可爱（动物 / 卡通，IP 风险低）
    ("002CuteGirl_可爱的女孩纸👧BQB", ["cute", "girl"], "cute"),
    ("060MurCat_Mur猫😺BQB", ["cat", "cute"], "cute"),
    ("010Cat_是喵星人啦🐱BQB", ["cat"], "cute"),
    ("049CatEveryday_猫咪日常BQB", ["cat"], "cute"),
    ("008HappyDuck_开心鸭🐥BQB", ["duck", "cute"], "happy"),
    ("057HappyDuck_开心鸭BQB", ["duck", "cute"], "happy"),
    ("006Hamster_仓鼠🐹BQB", ["hamster", "cute"], "cute"),
    # v1.9.2 新增：通用动物（更多日常反应）
    ("027Turtle_乌龟🐢BQB", ["turtle", "cute"], "cute"),
    ("026Chicken_小幺鸡🐔BQB", ["chicken", "cute"], "cute"),
    ("031Penguin_沙雕企鹅🐧BQB", ["penguin", "silly"], "happy"),
    # v1.9.2 新增：反讽/吐槽/翻白眼 meme 核心（截图里"你又觉得你配了"这种）
    # 金馆长熊猫源自互联网 meme，二创繁多。如果做商业/公网部署，
    # 替换成自己原创素材；个人本地玩可保留。
    #
    # v1.9.3 修：base_tags 显式覆盖 prompt 里写的所有反讽 tag。
    # 之前只有 sarcasm 一个，prompt 让 AI 用 [STICKER:mock]/[STICKER:eyeroll]
    # 时只能靠 stickers.mjs 子串模糊匹配落到 sarcasm 池，命中率低。
    # 现在 PandaHead 池被 8 个 tag 全部直接命中，AI 选哪个反讽词都能直出。
    ("015Golden_Curator_Panda金馆长熊猫🐼BQB",
        ["panda", "meme", "sarcasm", "mock", "dismissive", "eyeroll", "whatever", "speechless"],
        "mock"),
    # 花泽香菜（声优表情包，IP 边界模糊；个人本地玩可保留）
    ("040HanazawaKana表情包三巨头_花泽香菜BQB", ["cute", "girl"], "happy"),
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
    # v1.9.2: 加入反讽/吐槽类 priority。情感强类排前，meme 类排中段，
    # 通用 cute/wave 兜底放最后。这只影响 manifest.json 里每条的 emotion
    # 默认字段，不影响 tags（tags 完整保留）。
    priority = [
        # 强情感
        "love", "kiss", "hug", "heartbroken",
        # 正面
        "happy", "shy", "proud", "cheer", "impressed",
        # 负面
        "sad", "angry", "jealous", "petty",
        # meme / 反讽（v1.9.2 新增）
        "mock", "sarcasm", "dismissive", "eyeroll", "whatever",
        "speechless", "awkward", "tsun", "resigned",
        # 状态
        "sleepy", "tired", "shock", "confused", "suspicious", "drama",
        # 兜底
        "pout", "cute", "wave", "meme",
    ]
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
