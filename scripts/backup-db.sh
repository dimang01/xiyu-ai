#!/usr/bin/env bash
# 备份 SQLite 数据库到 data/backups/，备份后做完整性校验，按天数轮转。
#
# 用法：
#   bash scripts/backup-db.sh                      # 默认备份到 data/backups/，保留 7 天
#   KEEP_DAYS=30 bash scripts/backup-db.sh         # 保留 30 天
#   BACKUP_DIR=/mnt/nas/xiyu bash scripts/backup-db.sh   # 备份到异机挂载点
#
# 定时任务（cron / systemd timer 两种接法）见 deploy/README.md「定时备份」。
# 恢复：bash scripts/restore-db.sh --list / --latest / <file>
#
# Copyright (c) 2026 溪语 AI Contributors. MIT License.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${DB_PATH:-$ROOT/data/bot.db}"
DEST_DIR="${BACKUP_DIR:-$ROOT/data/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"

mkdir -p "$DEST_DIR"

if [ ! -f "$DB" ]; then
  echo "DB not found: $DB"
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "需要 sqlite3 CLI（Debian/Ubuntu: apt install sqlite3 / macOS 自带）"
  exit 1
fi

# 文件名带时分：手动补跑不会覆盖当天 cron 产物
TS=$(date +%Y%m%d-%H%M)
OUT="$DEST_DIR/bot-$TS.db"

# .backup 走 SQLite 在线备份 API，应用运行中执行也是一致快照（WAL 安全）
sqlite3 "$DB" ".backup '$OUT'"

# 备份完立刻验完整性——损坏的备份比没有备份更危险（恢复时才发现就晚了）
CHECK=$(sqlite3 "$OUT" 'PRAGMA integrity_check;')
if [ "$CHECK" != "ok" ]; then
  echo "integrity_check FAILED: $CHECK"
  echo "已删除损坏备份 $OUT，原库未动。请检查源库：sqlite3 '$DB' 'PRAGMA integrity_check;'"
  rm -f "$OUT"
  exit 1
fi

find "$DEST_DIR" -name 'bot-*.db' -mtime +"$KEEP_DAYS" -delete

SIZE=$(du -h "$OUT" | cut -f1)
COUNT=$(find "$DEST_DIR" -name 'bot-*.db' | wc -l)
echo "backed up: $OUT ($SIZE, integrity ok, 留存 $COUNT 份/${KEEP_DAYS}天)"
