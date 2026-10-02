#!/bin/bash
# lionidas MCP stdio launcher — Hermes entry (steps_006 §6b)
# Auth: LIONIDAS_PAT must carry a lion_… operator token (tokens panel).
# Provider env (BUTLER_*) + LIONIDAS_PAT are sourced from server/.env — the
# same file main.ts loads (loadEnvFile ../.env relative to src/).
cd /Volumes/berkakyo/Users/berkamain/Developer/w0rk/lionparcel/ai/lionidas/server || exit 1
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
[ -f .env ] && set -a && source .env && set +a
exec node --import tsx src/agent/mcp-stdio.ts
