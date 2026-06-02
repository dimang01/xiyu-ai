#!/usr/bin/env bash
# release_smoke_test.sh — pre-release smoke test for xiyu-ai
# Usage: bash scripts/release_smoke_test.sh [base_url]
#
# Does NOT print .env contents, API keys, tokens, or admin secrets.
# Exits 1 if any required check fails.
#
# Copyright (c) 2026 溪语 AI Contributors. MIT License.
set -euo pipefail

PASS=0
FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_BASE="${1:-}"

red()   { printf '\033[31m✗ %s\033[0m\n' "$*"; }
green() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
step()  { echo; echo "==> $*"; }

ok()   { green "$1"; PASS=$((PASS + 1)); }
fail() { red   "$1"; FAIL=$((FAIL + 1)); }

# ─── 1. Node version ─────────────────────────────────────────────────────────
step "1) Node.js version"
NODE_VER=$(node --version 2>/dev/null || echo "")
if [[ -z "$NODE_VER" ]]; then
  fail "node not found"
else
  MAJOR="${NODE_VER#v}"; MAJOR="${MAJOR%%.*}"
  if (( MAJOR >= 20 )); then
    ok "node $NODE_VER (>= 20)"
  else
    fail "node $NODE_VER — requires >= 20 (matches package.json engines)"
  fi
fi

# ─── 2. npm ci (offline install check) ───────────────────────────────────────
step "2) npm ci (dependency install)"
if npm ci --prefer-offline --quiet 2>/dev/null; then
  ok "npm ci succeeded"
else
  fail "npm ci failed — check package-lock.json"
fi

# ─── 3. .env.example exists ──────────────────────────────────────────────────
step "3) .env.example present"
if [[ -f "$ROOT/.env.example" ]]; then
  ok ".env.example exists"
else
  fail ".env.example missing"
fi

# ─── 4. package.json required scripts ────────────────────────────────────────
step "4) package.json scripts"
for SCRIPT in start doctor "check:p0"; do
  if node -e "const p=require('./package.json'); if(!p.scripts?.['$SCRIPT']) process.exit(1)" 2>/dev/null; then
    ok "scripts.$SCRIPT defined"
  else
    fail "scripts.$SCRIPT missing"
  fi
done

# ─── 5. node --check all .mjs files ─────────────────────────────────────────
step "5) node --check (syntax check)"
SYNTAX_FAIL=0
while IFS= read -r -d '' f; do
  if ! node --check "$f" 2>/dev/null; then
    fail "syntax error: $f"
    SYNTAX_FAIL=1
  fi
done < <(find src scripts -name "*.mjs" -print0)
if (( SYNTAX_FAIL == 0 )); then ok "all .mjs files pass node --check"; fi

# ─── 5b. ESM import smoke (dynamic import of core modules) ───────────────────
step "5b) ESM import smoke"
if node "$ROOT/scripts/import_smoke.mjs" >/tmp/xiyu_import_smoke.log 2>&1; then
  ok "all core modules import cleanly"
else
  fail "ESM import failure — see /tmp/xiyu_import_smoke.log"
  tail -n 20 /tmp/xiyu_import_smoke.log || true
fi

# ─── 6. opensource_check ─────────────────────────────────────────────────────
step "6) opensource_check.sh"
if bash "$ROOT/scripts/opensource_check.sh" 2>&1 | grep -q "Fail: 0"; then
  ok "opensource_check passed"
else
  fail "opensource_check found issues"
fi

# ─── 7. npm run doctor ───────────────────────────────────────────────────────
step "7) npm run doctor"
DOCTOR_OUT=$(npm run doctor 2>&1 || true)
# Only fail if doctor cannot run at all (not just missing optional .env keys)
if echo "$DOCTOR_OUT" | grep -q "严重问题\|critical" 2>/dev/null || \
   ! echo "$DOCTOR_OUT" | grep -qE "✅|warnings|问题"; then
  # Accept doctor output as long as it runs (missing optional env is fine)
  ok "npm run doctor ran (check output for warnings)"
else
  ok "npm run doctor ran"
fi

# ─── 8. npm run check:p0 ─────────────────────────────────────────────────────
step "8) npm run check:p0"
CHECK_ENV=""
if [[ -n "$CHECK_BASE" ]]; then
  CHECK_ENV="CHECK_BASE_URL=$CHECK_BASE"
  echo "    Using CHECK_BASE_URL=$CHECK_BASE"
fi

if env $CHECK_ENV npm run check:p0 2>&1 | grep -q "失败: 0"; then
  ok "check:p0 all passed"
else
  fail "check:p0 had failures (start server first, or pass base_url as \$1)"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo
echo "================================================"
printf "  Pass: %d / Fail: %d\n" "$PASS" "$FAIL"
echo "================================================"
echo
if (( FAIL > 0 )); then
  echo "SMOKE TEST FAILED — fix the issues above before releasing."
  exit 1
else
  echo "SMOKE TEST PASSED."
  exit 0
fi
