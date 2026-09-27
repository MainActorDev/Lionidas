#!/bin/sh
# Lionidas forge watchdog — the dead-man switch.
#
# Every run (launchd: 15s interval): for every network service, if the web
# proxy is ENABLED, points at localhost, and NOTHING is listening on that
# port, disable it. A wedged/killed Lionidas then costs at most one interval
# of broken CFNetwork traffic; SSH/VNC are never affected (raw TCP, no
# system-proxy obedience). Non-localhost proxies (corp) are never touched.
#
# FORGE_WATCHDOG_DRY_RUN=1 → log decisions only, change nothing
# (pre-activation audit: proves parsing against a real machine safely).
set -u

LOG_TAG="crucible-forge-watchdog"
DRY_RUN="${FORGE_WATCHDOG_DRY_RUN:-0}"

log() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '%s [dry-run] %s\n' "$LOG_TAG" "$1" | tee -a /tmp/forge-watchdog-dry-run.log 2>/dev/null || \
      printf '%s [dry-run] %s\n' "$LOG_TAG" "$1"
  else
    logger -t "$LOG_TAG" "$1" 2>/dev/null || printf '%s %s\n' "$LOG_TAG" "$1" >> /tmp/forge-watchdog.log
  fi
}

# /bin/sh on macOS: pipelines run in subshells — collect heal actions into a
# temp file so the parent (which owns DRY_RUN state) performs the writes.
tmp=$(mktemp /tmp/forge-watchdog.XXXXXX) || exit 1
trap 'rm -f "$tmp"' EXIT

networksetup -listallnetworkservices 2>/dev/null | tail -n +2 | while IFS= read -r raw_svc; do
  svc=$(printf '%s' "$raw_svc" | sed 's/^\*//')
  [ -n "$svc" ] || continue
  out=$(networksetup -getwebproxy "$svc" 2>/dev/null) || continue
  enabled=$(printf '%s\n' "$out" | sed -n 's/^Enabled: \(.*\)$/\1/p')
  host=$(printf '%s\n' "$out" | sed -n 's/^Server: \(.*\)$/\1/p')
  port=$(printf '%s\n' "$out" | sed -n 's/^Port: \(.*\)$/\1/p')
  [ "$enabled" = "Yes" ] || continue
  case "$host" in 127.0.0.1|localhost|::1) ;; *) continue ;; esac
  case "$port" in ''|*[!0-9]*) continue ;; esac
  if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf '%s\n' "$svc" >> "$tmp"
  fi
done

while IFS= read -r svc; do
  [ -n "$svc" ] || continue
  if [ "$DRY_RUN" = "1" ]; then
    log "would disable stale web proxy on '$svc' (localhost listener dead)"
  else
    networksetup -setwebproxystate "$svc" off >/dev/null 2>&1 || true
    networksetup -setsecurewebproxystate "$svc" off >/dev/null 2>&1 || true
    log "disabled stale web proxy on '$svc' (localhost listener dead)"
  fi
done < "$tmp"
