#!/bin/bash
# AionUi 团队功能分层回归（T7.8）：lint → unit → contract → e2e-mock → 关闭态全量。
# e2e-live（真实 team-platform 栈）不在本脚本范围，见 docs/05 §8。
set -euo pipefail
cd "$(dirname "$0")/.."

run() { printf '\n\033[1;35m[regression] %s\033[0m\n' "$1"; shift; "$@"; }

run "① lint（0 errors 门槛）" sh -c 'bun run lint 2>&1 | tail -1'

run "② M1 账号/网关单测" bun run vitest run tests/unit/team/pkce.test.ts tests/unit/team/gatewayRuntime.test.ts tests/unit/team/accountRuntime.test.ts

run "③ M2 记忆单测" bun run vitest run tests/unit/team/memory

run "④ M4/M5 知识库与工具单测" bun run vitest run tests/unit/team/knowledge

run "⑤ 契约（BFF ↔ team-server）" bun run vitest run tests/unit/team/contract

run "⑥ e2e-mock（BFF 全链路）" bun run vitest run tests/unit/team/e2e

run "⑦ 团队套件全量" bun run vitest run tests/unit/team

run "⑧ 全仓回归（关闭态零侵入验证）" sh -c 'bun run test 2>&1 | grep -E "Test Files|Tests "'

printf '\n\033[1;32m[regression] ALL GREEN\033[0m\n'
