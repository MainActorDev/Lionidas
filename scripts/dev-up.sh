#!/usr/bin/env bash
# dev-up — bring the Lionidas dev stack up (API 9230 + web 5230).
#
# Why: both processes are plain background jobs from dev sessions; after a
# machine restart (or a dead terminal) the web UI is gone even though the
# API may still be running — "web server is down" with an unclear culprit.
# This script makes the state legible and one command reproducible.
#
# Usage:
#   ./scripts/dev-up.sh          # start what's missing, report both
#   ./scripts/dev-up.sh --restart # kill both, start fresh
#
# Logs: /tmp/lionidas-api.log, /tmp/lionidas-web.log
set -euo pipefail

API_PORT="${CRUCIBLE_PORT:-9230}"
WEB_PORT="${VITE_PORT:-5230}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# node via nvm (dev machines); harmless if already on PATH
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"

listening() { lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

pid_of() { lsof -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1; }

if [[ "${1:-}" == "--restart" ]]; then
  for p in "$API_PORT" "$WEB_PORT"; do
    pid="$(pid_of "$p" || true)"
    if [[ -n "$pid" ]]; then echo "· killing :$p (pid $pid)"; kill "$pid" || true; fi
  done
  sleep 1
fi

# ── API ──
if listening "$API_PORT"; then
  echo "✓ api already up  :$API_PORT (pid $(pid_of "$API_PORT"))"
else
  echo "· starting api on :$API_PORT …"
  (cd "$ROOT/server" && nohup npx tsx src/main.ts > /tmp/lionidas-api.log 2>&1 &)
  for i in $(seq 1 20); do
    listening "$API_PORT" && break
    sleep 0.5
  done
  if listening "$API_PORT"; then
    echo "✓ api up :$API_PORT (log /tmp/lionidas-api.log)"
  else
    echo "✗ api FAILED to listen on :$API_PORT — tail of /tmp/lionidas-api.log:" >&2
    tail -5 /tmp/lionidas-api.log >&2 || true
    exit 1
  fi
fi
curl -fsS "http://127.0.0.1:$API_PORT/api/health" >/dev/null && echo "✓ api health ok" || { echo "✗ api health check failed"; exit 1; }

# ── web (vite) ──
if listening "$WEB_PORT"; then
  echo "✓ web already up  :$WEB_PORT (pid $(pid_of "$WEB_PORT"))"
else
  echo "· starting web on :$WEB_PORT …"
  (cd "$ROOT/web" && nohup npx vite --port "$WEB_PORT" --strictPort > /tmp/lionidas-web.log 2>&1 &)
  for i in $(seq 1 20); do
    listening "$WEB_PORT" && break
    sleep 0.5
  done
  if listening "$WEB_PORT"; then
    echo "✓ web up :$WEB_PORT → http://localhost:$WEB_PORT (log /tmp/lionidas-web.log)"
  else
    echo "✗ web FAILED to listen on :$WEB_PORT — tail of /tmp/lionidas-web.log:" >&2
    tail -5 /tmp/lionidas-web.log >&2 || true
    exit 1
  fi
fi
curl -fsS -o /dev/null "http://localhost:$WEB_PORT/" && echo "✓ web serves the shell" || { echo "✗ web shell check failed"; exit 1; }

echo ""
echo "stack ready → http://localhost:$WEB_PORT"
