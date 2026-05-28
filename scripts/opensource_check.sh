#!/usr/bin/env bash
# 发布前自检脚本：6 项检查
#   1) forbidden files
#   2) secret patterns
#   3) production paths/domains
#   4) package.json JSON syntax
#   5) large files (>5MB)
#   6) .env is not git-tracked
#
# 任何一项失败立刻退出非零。
#
# Copyright (c) 2026 溪语 AI Contributors. MIT License.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pass=0; fail=0
check() {
  local name="$1"; local ok="$2"; local detail="${3:-}"
  if [ "$ok" = "1" ]; then
    printf "  ✓ %s\n" "$name"
    pass=$((pass+1))
  else
    printf "  ✗ %s\n" "$name"
    [ -n "$detail" ] && printf "      %s\n" "$detail"
    fail=$((fail+1))
  fi
}

echo "==> 1) forbidden files (must not be tracked by git)"
FORBIDDEN_FOUND=$(git ls-files 2>/dev/null | grep -E '^\.env$|\.auth-secret|\.admin-secret|\.admin-credentials|\.weixin-credentials|/bot\.db$|_backup_billing_v1/' || true)
if [ -z "$FORBIDDEN_FOUND" ]; then check "no forbidden files in git" 1
else check "no forbidden files in git" 0 "$FORBIDDEN_FOUND"
fi

echo "==> 2) secret patterns (literal keys, not \${var} placeholders)"
SECRETS=$(grep -RInE "(sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|xoxb-[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{20,})" \
  . --exclude-dir=node_modules --exclude-dir=.git --exclude='*.md' 2>/dev/null || true)
if [ -z "$SECRETS" ]; then check "no literal API keys" 1
else check "no literal API keys" 0 "$(echo "$SECRETS" | head -5)"
fi

echo "==> 3) production paths/domains"
# .gitignore 里的 _backup_billing_v1/ 是防御性忽略规则（防止误提交），不是泄漏 — 一并排除
PROD=$(grep -RInE "/opt/zhaohy-wechat-poc|/var/www/zhaohy\.xyz|xiyuai\.cc|zhaohy\.xyz|_backup_billing_v1" \
  . --exclude-dir=node_modules --exclude-dir=.git --exclude='*.md' \
  --exclude='opensource_check.sh' --exclude='.gitignore' 2>/dev/null || true)
if [ -z "$PROD" ]; then check "no production paths/domains" 1
else check "no production paths/domains" 0 "$(echo "$PROD" | head -5)"
fi

echo "==> 4) package.json valid JSON + has MIT + start script"
if node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8')); if(p.license!=='MIT')process.exit(2); if(!p.scripts||!p.scripts.start)process.exit(3); process.exit(0)" 2>/dev/null; then
  check "package.json (JSON + MIT + scripts.start)" 1
else
  check "package.json (JSON + MIT + scripts.start)" 0
fi

echo "==> 5) no files >5MB"
LARGE=$(find . -type f -size +5M -not -path './.git/*' -not -path './node_modules/*' 2>/dev/null || true)
if [ -z "$LARGE" ]; then check "no files larger than 5MB" 1
else check "no files larger than 5MB" 0 "$LARGE"
fi

echo "==> 6) .env not in git tracking"
if git ls-files 2>/dev/null | grep -qE "^\.env$"; then
  check ".env not git-tracked" 0
else
  check ".env not git-tracked" 1
fi

echo
echo "================================================"
echo "  Pass: $pass / Fail: $fail"
echo "================================================"
[ "$fail" -eq 0 ]
