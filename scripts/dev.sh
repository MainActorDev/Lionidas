#!/usr/bin/env bash
# dev.sh — start the Lionidas dev stack (server 9230 + web 5230), the safe way.
#
# Wraps `pnpm dev` with the environment fixes this Mac needs:
#   • Node v24 first on PATH — better-sqlite3 native is ABI 137; the v22 at
#     ~/.local/bin shadows nvm and crashes the server (NODE_MODULE_VERSION
#     mismatch; symptom: vite up, server dead).
#   • corepack pnpm enabled — repo scripts use `pnpm --filter` (npm run dev fails).
#
# Usage:
#   scripts/dev.sh            # start if not running, health-checked
#   scripts/dev.sh status     # is anything up?
#   scripts/dev.sh stop       # stop OUR stack (pidfile only, never pkill node)
#   scripts/dev.sh restart    # stop + start
#   scripts/dev.sh log        # tail the combined log
#
# Logs: /tmp/crucible-dev.log   Pidfile: /tmp/crucible-dev.pid
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="/tmp/crucible-dev.log"
PIDFILE="/tmp/crucible-dev.pid"
SERVER_URL="http://127.0.0.1:9230/api/health"
WEB_URL="http://[::1]:5230/"   # vite binds IPv6 [::1] only — 127.0.0.1 will lie

NODE_V24="$HOME/.nvm/versions/node/v24.12.0/bin"
export PATH="$NODE_V24:$PATH"

say() { printf '%s\n' "$*"; }

env_ok() {
  command -v pnpm >/dev/null 2>&1 || { say "✕ pnpm missing — run: corepack enable pnpm"; return 1; }
  local v; v="$(node -v 2>/dev/null || true)"
  [[ "$v" == v24.* ]] || { say "✕ node is ${v:-missing}, need v24 — check $NODE_V24"; return 1; }
}

stack_pid() { [[ -f "$PIDFILE" ]] && cat "$PIDFILE" 2>/dev/null || true; }

stack_alive() {
  local pid; pid="$(stack_pid)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null   # kernel truth, not .killed
}

wait_healthy() {
  local i
  for i in $(seq 1 30); do
    curl -sf -m 2 "$SERVER_URL" >/dev/null 2>&1 && return 0
    stack_alive || { say "✕ stack process died — tail of log:"; tail -5 "$LOG"; return 1; }
    sleep 1
  done
  return 1
}

cmd_start() {
  env_ok || exit 1
  if stack_alive; then say "already running (pid $(stack_pid)) — try: $0 restart"; exit 0; fi
  if curl -sf -m 2 "$SERVER_URL" >/dev/null 2>&1; then
    say "⚠ port 9230 answers but no pidfile (stack started outside this script) — leaving it alone."
    exit 0
  fi
  : > "$LOG"
  cd "$ROOT"
  nohup pnpm dev >>"$LOG" 2>&1 &
  local pid=$!
  echo "$pid" > "$PIDFILE"
  say "starting (pid $pid, log $LOG)…"
  if wait_healthy; then
    say "✓ server  http://127.0.0.1:9230"
    curl -sf -m 2 -o /dev/null "$WEB_URL" && say "✓ web     http://[::1]:5230" || say "⚠ web not answering yet (vite still booting? try: $0 log)"
  else
    say "✕ server never became healthy — check $LOG"
    exit 1
  fi
}

cmd_stop() {
  if stack_alive; then
    local pid; pid="$(stack_pid)"
    # kill the process GROUP: pnpm dev spawns server+vite as children
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    sleep 1
    say "✓ stopped (pid $pid)"
  else
    say "not running"
  fi
  rm -f "$PIDFILE"
  # honesty probe: never claim stopped while the port still answers
  curl -sf -m 2 "$SERVER_URL" >/dev/null 2>&1 && say "⚠ 9230 still answers — something else owns it"
  return 0
}

cmd_status() {
  env_ok >/dev/null || true
  if stack_alive; then say "stack: running (pid $(stack_pid))"; else say "stack: stopped"; fi
  curl -sf -m 2 "$SERVER_URL" >/dev/null 2>&1 && say "server: up" || say "server: down"
  curl -sf -m 2 -o /dev/null "$WEB_URL" >/dev/null 2>&1 && say "web:    up" || say "web:    down"
}

case "${1:-start}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status)  cmd_status ;;
  log)     tail -f "$LOG" ;;
  *) say "usage: $0 [start|stop|restart|status|log]"; exit 2 ;;
esac
