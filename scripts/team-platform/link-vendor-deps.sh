#!/bin/bash
# AionUi team-platform 辅助：bun 的 file: 依赖会被复制进 node_modules/.bun store，
# 且 file: 依赖之间的相互引用（vendor-ai 内部 @ai-sdk/*互引）不会自动互链。
# 本脚本为 store 内的 vendor 包补齐互链与公共依赖链接；bun install 之后运行一次。
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD/node_modules
BUN=$ROOT/.bun
VENDOR=$(cd ../AionTeamPlatform/packages/vendor-ai/packages && pwd)

link_into(){ # $1=store 包目录(node_modules 的父目录) $2=依赖名 $3=依赖真实根
  local target="$1/node_modules/$2"
  [ -e "$target" ] && return 0
  mkdir -p "$(dirname "$target")"
  ln -sfn "$3" "$target"
}

ensure(){ # $1=vendor 包名（store 目录名，含 scope）
  local store_entry
  store_entry=$(find "$BUN" -maxdepth 1 -type d -name "$1@file+*" | head -1)
  [ -z "$store_entry" ] && { echo "skip $1 (no store entry)"; return 0; }
  link_into "$store_entry" @ai-sdk/provider "$VENDOR/provider"
  link_into "$store_entry" @ai-sdk/provider-utils "$VENDOR/provider-utils"
  link_into "$store_entry" @ai-sdk/gateway "$VENDOR/gateway"
  link_into "$store_entry" zod "$ROOT/zod"
  link_into "$store_entry" eventsource-parser "$ROOT/eventsource-parser"
  link_into "$store_entry" @workflow/serde "$VENDOR/provider-utils/node_modules/@workflow/serde"
  link_into "$store_entry" @standard-schema/spec "$ROOT/@standard-schema/spec"
  link_into "$store_entry" @vercel/oidc "$ROOT/@vercel/oidc"
  link_into "$store_entry" ws "$ROOT/ws"
  echo "linked $1"
}

for pkg in "ai" "@ai-sdk+openai-compatible" "@ai-sdk+gateway" "@ai-sdk+provider" "@ai-sdk+provider-utils"; do ensure "$pkg"; done
echo done
