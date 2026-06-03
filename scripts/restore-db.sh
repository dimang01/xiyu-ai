#!/usr/bin/env bash
# restore-db.sh —— 从备份文件恢复 SQLite 数据库
#
# 用法：
#   bash scripts/restore-db.sh <backup-file>          # 从指定备份文件恢复
#   bash scripts/restore-db.sh --latest               # 从 data/backups/ 选最新的
#   bash scripts/restore-db.sh --list                 # 列出所有可用备份
#
# 行为：
#   1. 校验备份文件完整性（sqlite3 PRAGMA integrity_check）
#   2. 把当前 DB 改名为 bot.db.before-restore-<timestamp>（**不删**，保留兜底）
#   3. 用备份替换 DB
#   4. 跑 npm run doctor 验证恢复后能起来
#
# 强烈建议：恢复前先停掉应用（systemctl stop xiyu-ai 或 docker compose stop）。
# 在应用运行中直接覆盖 SQLite 文件会导致 WAL 不一致。
#
# Copyright (c) 2026 溪语 AI Contributors. MIT License.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${DB_PATH:-$ROOT/data/bot.db}"
BACKUP_DIR="$ROOT/data/backups"

red()   { printf '\033[31m✗ %s\033[0m\n' "$*"; }
green() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m! %s\033[0m\n' "$*"; }
step()  { echo; echo "==> $*"; }

usage() {
  cat <<EOF
Usage:
  bash scripts/restore-db.sh <backup-file>     从指定文件恢复
  bash scripts/restore-db.sh --latest          从 data/backups/ 中选最新的
  bash scripts/restore-db.sh --list            列出所有可用备份

恢复前 **务必先停应用**，否则 SQLite WAL 会与新文件不一致。
EOF
}

[ $# -lt 1 ] && { usage; exit 1; }

# ── 1. 解析参数 ──────────────────────────────────────────────────────────────
case "${1:-}" in
  --help|-h)
    usage; exit 0 ;;
  --list)
    step "可用备份（$BACKUP_DIR）"
    if [ ! -d "$BACKUP_DIR" ]; then yellow "备份目录不存在：$BACKUP_DIR"; exit 0; fi
    ls -lh "$BACKUP_DIR"/bot-*.db 2>/dev/null || yellow "没有找到 bot-*.db 备份文件"
    exit 0
    ;;
  --latest)
    if [ ! -d "$BACKUP_DIR" ]; then red "备份目录不存在：$BACKUP_DIR"; exit 1; fi
    SOURCE=$(ls -1t "$BACKUP_DIR"/bot-*.db 2>/dev/null | head -n 1 || true)
    if [ -z "$SOURCE" ]; then red "没有找到可用备份"; exit 1; fi
    green "使用最新备份：$SOURCE"
    ;;
  *)
    SOURCE="$1"
    ;;
esac

# ── 2. 备份文件存在性 ────────────────────────────────────────────────────────
if [ ! -f "$SOURCE" ]; then
  red "备份文件不存在：$SOURCE"
  exit 1
fi

# ── 3. 完整性检查 ────────────────────────────────────────────────────────────
step "完整性校验：$SOURCE"
if ! command -v sqlite3 >/dev/null 2>&1; then
  red "需要 sqlite3 命令（apt install sqlite3 / brew install sqlite）"
  exit 1
fi
INTEGRITY=$(sqlite3 "$SOURCE" "PRAGMA integrity_check;" 2>&1 || echo "FAIL")
if [ "$INTEGRITY" != "ok" ]; then
  red "完整性校验失败：$INTEGRITY"
  exit 1
fi
green "完整性 OK"

# ── 4. 表存在性快速 sanity check ────────────────────────────────────────────
TABLES=$(sqlite3 "$SOURCE" ".tables" 2>/dev/null || echo "")
for t in companions companion_memories companion_conversation_turns; do
  if ! echo "$TABLES" | grep -qw "$t"; then
    red "备份文件缺少关键表：$t —— 拒绝恢复"
    exit 1
  fi
done
green "关键表 (companions / companion_memories / companion_conversation_turns) 存在"

# ── 5. 警告 + 二次确认（如果当前 DB 存在） ──────────────────────────────────
if [ -f "$DB" ]; then
  yellow "当前 DB 存在：$DB"
  yellow "  将被改名为 bot.db.before-restore-<ts>（保留兜底，不删除）"
  echo -n "确认继续？输入 yes 继续："
  read -r CONFIRM
  if [ "$CONFIRM" != "yes" ]; then
    red "已取消"
    exit 1
  fi
  TS=$(date +%Y%m%d-%H%M%S)
  BACKUP_OLD="${DB}.before-restore-${TS}"
  mv "$DB" "$BACKUP_OLD"
  # 同时移动 WAL/SHM（如果存在）
  [ -f "${DB}-wal" ] && mv "${DB}-wal" "${BACKUP_OLD}-wal" || true
  [ -f "${DB}-shm" ] && mv "${DB}-shm" "${BACKUP_OLD}-shm" || true
  green "原 DB 已保留为：$BACKUP_OLD"
fi

# ── 6. 复制备份到 DB 位置 ────────────────────────────────────────────────────
step "恢复：$SOURCE → $DB"
mkdir -p "$(dirname "$DB")"
cp "$SOURCE" "$DB"
green "文件已复制"

# ── 7. 跑 doctor 验证 ────────────────────────────────────────────────────────
step "运行 npm run doctor 验证"
cd "$ROOT"
if npm run doctor 2>&1 | tee /tmp/xiyu_restore_doctor.log | tail -n 20; then
  green "doctor 跑通"
else
  yellow "doctor 退出非 0，请人工查看 /tmp/xiyu_restore_doctor.log"
fi

echo
echo "================================================"
green "恢复完成。"
echo "  · 数据库：$DB"
echo "  · 原 DB 兜底（如有）：${BACKUP_OLD:-（无）}"
echo "  · 下一步：启动应用并通过 dashboard 检查 companion 是否完整"
echo "================================================"
