#!/usr/bin/env bash
# 备份 SQLite 数据库到 data/backups/，保留最近 7 天。
#
# Copyright (c) 2026 溪语 AI Contributors. MIT License.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${DB_PATH:-$ROOT/data/bot.db}"
DEST_DIR="$ROOT/data/backups"
KEEP_DAYS=7

mkdir -p "$DEST_DIR"

if [ ! -f "$DB" ]; then
  echo "DB not found: $DB"
  exit 1
fi

TS=$(date +%Y%m%d)
sqlite3 "$DB" ".backup '$DEST_DIR/bot-$TS.db'"
find "$DEST_DIR" -name 'bot-*.db' -mtime +$KEEP_DAYS -delete
echo "backed up: $DEST_DIR/bot-$TS.db"
