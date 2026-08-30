#!/bin/bash
# Crucible Forge TLS — one-time CA trust setup (human-run; double-click me)
# Installs mitmproxy's CA into the login keychain. macOS will prompt for your
# password and show the certificate — that prompt is the security decision.
set -e
CERT="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
if [ ! -f "$CERT" ]; then
  echo "✗ $CERT not found — run 'mitmdump' once first (it generates the CA), then re-run me."
  read -r -p "Press Enter to close…" _
  exit 1
fi
echo "Installing mitmproxy CA into login keychain (enter your password when prompted)…"
security add-trusted-cert -d -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$CERT"
echo "✓ CA trusted. Simulators honor login-keychain roots after a sim REBOOT."
echo "  (Existing booted sims: Device → Erase or restart them once.)"
read -r -p "Press Enter to close…" _
