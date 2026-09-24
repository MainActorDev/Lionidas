#!/usr/bin/env bash
# Crucible setup — one command from clone to green checks.
# Provisions every capability Crucible uses, detects what exists, and
# reports honestly. Safe to re-run: each step is idempotent.
#
#   bash scripts/setup.sh          # install what's missing (prompts on brew)
#   bash scripts/setup.sh --check  # report only, exit 1 on anything missing
set -euo pipefail

CHECK_ONLY="${1:-}"
BOLD=$'\033[1m'; DIM=$'\033[2m'; OK=$'\033[32m'; WARN=$'\033[33m'; ERR=$'\033[31m'; RST=$'\033[0m'

ok()   { echo "${OK}✓${RST} $1"; }
miss() { echo "${ERR}✗${RST} $1 ${DIM}— $2${RST}"; }
have() { echo "${BOLD}•${RST} $1 ${DIM}(already present)${RST}"; }
step() { echo; echo "${BOLD}$1${RST}"; }

FAILURES=0
note_failure() { FAILURES=$((FAILURES + 1)); }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ─────────────────────────────────────────────────────────────────────────────
step "node 24.12 (pinned — 24.20 crashes worker pools on arm64)"
NODE_VER="$(node --version 2>/dev/null || true)"
if [[ "$NODE_VER" == "v24.12."* ]]; then
  ok "node $NODE_VER"
elif [[ -n "$NODE_VER" && "$NODE_VER" == v24.* ]]; then
  echo "${WARN}!${RST} node $NODE_VER — 24.12.x is the pinned version (other 24.x may work; 24.20 known-bad on arm64 CI)"
  note_failure
else
  miss "node ($NODE_VER)" "install nvm: brew install nvm, then: nvm install 24.12.0"
  note_failure
fi

# ─────────────────────────────────────────────────────────────────────────────
step "pnpm"
if command -v pnpm >/dev/null 2>&1; then ok "pnpm $(pnpm --version)"; else
  if [[ "$CHECK_ONLY" == "--check" ]]; then miss "pnpm" "corepack enable && corepack install"; note_failure
  else corepack enable 2>/dev/null && corepack install && ok "pnpm installed via corepack" || { miss "pnpm" "manual: corepack enable && corepack install"; note_failure; }
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
step "dependencies"
if [[ -d node_modules ]]; then have "node_modules"; else
  if [[ "$CHECK_ONLY" == "--check" ]]; then miss "node_modules" "pnpm install"; note_failure
  else echo "installing…"; pnpm install; ok "installed"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
step "Alloy — the execution engine (github.com/MainActorDev/Alloy)"
ALLOY_SIBLING="$ROOT/../alloy"
if [[ -f "$ALLOY_SIBLING/package.json" ]]; then
  ok "sibling clone at ../alloy"
else
  if [[ "$CHECK_ONLY" == "--check" ]]; then
    miss "../alloy" "git clone https://github.com/MainActorDev/Alloy ../alloy && (cd ../alloy && pnpm install)"
    note_failure
  else
    echo "cloning Alloy as a sibling…"
    git clone --depth 1 https://github.com/MainActorDev/Alloy "$ALLOY_SIBLING"
    (cd "$ALLOY_SIBLING" && pnpm install)
    ok "Alloy cloned + installed at ../alloy"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
step "forge proxy — mitmproxy"
if command -v mitmdump >/dev/null 2>&1; then
  ok "mitmdump $(mitmdump --version 2>/dev/null | head -1 || echo present)"
else
  if [[ "$CHECK_ONLY" == "--check" ]]; then miss "mitmdump" "brew install mitmproxy"; note_failure
  else brew install mitmproxy && ok "mitmproxy installed" || { miss "mitmdump" "brew install mitmproxy"; note_failure; }
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
step "Xcode simulator runtime"
if xcrun simctl list devices >/dev/null 2>&1; then
  BOOTED="$(xcrun simctl list devices | grep -c Booted || true)"
  if [[ "$BOOTED" -gt 0 ]]; then ok "simctl present · $BOOTED booted simulator(s)"
  else ok "simctl present ${DIM}(no sim booted — boot one on the devices page later)${RST}"
  fi
else
  if [[ "$CHECK_ONLY" == "--check" ]]; then miss "xcode/simctl" "install Xcode + one iOS runtime"; note_failure
  else miss "xcode/simctl" "install Xcode from the App Store, accept the license, install one iOS runtime — then re-run"; note_failure
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
echo
if [[ "$FAILURES" -gt 0 ]]; then
  echo "${ERR}setup incomplete — $FAILURES item(s) need attention above${RST}"
  [[ "$CHECK_ONLY" == "--check" ]] || echo "${DIM}fix the ✗ items, then re-run: bash scripts/setup.sh${RST}"
  exit 1
fi
echo "${OK}setup complete.${RST} ${DIM}verify with: pnpm check${RST}"
