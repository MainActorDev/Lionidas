#!/bin/bash
# lionidas MCP stdio launcher — claude-cli mount + external MCP clients.
# PORTABLE: derives the repo root from this script's own location; sources
# server/.env for BUTLER_*/LIONIDAS_PAT; finds node via nvm fallbacks.
set -euo pipefail
AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$AGENT_DIR/../.."
cd "$SERVER_DIR"
if ! command -v node >/dev/null 2>&1; then
  for v in "$HOME/.nvm/versions/node/v24.20.0" "$HOME/.nvm/versions/node/v24.12.0" "$HOME"/.nvm/versions/node/v22.*; do
    if [ -d "$v" ]; then export PATH="$v/bin:$PATH"; break; fi
  done
fi
[ -f .env ] && set -a && source .env && set +a
exec node --import tsx src/agent/mcp-stdio.ts
