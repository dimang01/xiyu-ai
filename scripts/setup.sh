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

cyan "==> 检查 .env"
if [ ! -f .env ]; then
  cp .env.example .env
  yellow "    已生成 .env（从 .env.example 复制）。"
  yellow "    请用编辑器打开 .env，至少填入：CHAT_PROVIDER 对应的 API_KEY"
  yellow "    然后再次运行 npm start"
  exit 0
fi

# 简单校验：是否至少有一个 *_API_KEY 非空
if ! grep -qE '^[A-Z_]+_API_KEY=.+' .env; then
  yellow "⚠  .env 中没有发现任何 *_API_KEY 已填入。"
  yellow "   请至少填一个 chat provider 的 key，然后再次运行 npm start。"
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
