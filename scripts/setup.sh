#!/usr/bin/env bash
# 一键启动脚本：检查 node 版本 -> 装依赖 -> 创建 .env -> 启动
#
# Copyright (c) 2026 溪语 AI Contributors. MIT License.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cyan() { printf "\033[1;36m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }

cyan "==> 检查 Node.js 版本（需 >= 20）"
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未安装 Node.js。请先安装 Node 20+ (https://nodejs.org)"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Node 版本过低: $(node -v)。请升级到 20+"
  exit 1
fi
green "    Node $(node -v) ✓"

cyan "==> 安装依赖"
if [ ! -d node_modules ]; then
  npm install
else
  green "    node_modules 已存在，跳过 npm install"
fi

cyan "==> 检查 / 配置 .env"
# 调用 setup-wizard：TTY 交互、非 TTY 自动复制 .env.example
node scripts/setup-wizard.mjs || true

# 已配置好（chat provider + 对应 API key）就继续；否则提示用户
if ! node scripts/setup-wizard.mjs --check >/dev/null 2>&1; then
  yellow "⚠  .env 还没配好（缺 CHAT_PROVIDER 对应的 API_KEY）。"
  yellow "   你可以："
  yellow "     · 重新运行  npm run setup        (TTY 交互)"
  yellow "     · 或手动编辑 .env 后再次 npm start"
  yellow "     · 或先启动服务，浏览器打开 /app/setup.html 看引导"
  exit 0
fi

cyan "==> 创建数据目录"
mkdir -p data logs public/avatars

echo
echo "Optional WeChat iLink login:"
echo "  npm run ilink:login"
echo
echo "This will print a QR code in your terminal. Scan it with WeChat to connect your bot."
echo "（可选，不扫码也能启动 — 微信功能会处于 disabled 状态。）"
echo

green "==> 启动服务  (http://localhost:${API_PORT:-3000})"
exec node index.mjs
