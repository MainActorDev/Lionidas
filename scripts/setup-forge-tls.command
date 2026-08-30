#!/bin/bash
# Crucible Forge TLS — one-time CA setup (human-run; double-click me)
#
# Generates an Apple-compliant CA hierarchy (root → intermediate) for the MITM
# proxy and trusts the ROOT in the login keychain. macOS will prompt for your
# password — that prompt is the security decision.
#
# WHY a custom CA: mitmproxy's default CA signs leaves directly with the root;
# iOS/macOS strict TLS policy requires an intermediate ('leaf MissingIntermediate'
# → NSURLError -1200 "A TLS error caused the secure connection to fail").
# With this hierarchy the proxy serves leaf ← intermediate ← root and strict
# evaluators (LP API client, Firebase SDKs) accept it.
#
# Reboot booted simulators once after trusting (sims read trust at boot).
set -e

CONFDIR="${CRUCIBLE_MITM_CONFDIR:-$HOME/.forge-ca}"
mkdir -p "$CONFDIR"

if [ ! -f "$CONFDIR/mitmproxy-ca.pem" ]; then
  echo "Generating CA hierarchy in $CONFDIR (root → intermediate)…"
  # root (self-signed, 10y)
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$CONFDIR/root.key" -out "$CONFDIR/root.crt" \
    -subj "/CN=Forge Root/O=Crucible" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  # intermediate signed by root (5y, pathlen 0)
  openssl req -newkey rsa:2048 -nodes \
    -keyout "$CONFDIR/int.key" -out "$CONFDIR/int.csr" \
    -subj "/CN=Forge Intermediate/O=Crucible"
  openssl x509 -req -in "$CONFDIR/int.csr" \
    -CA "$CONFDIR/root.crt" -CAkey "$CONFDIR/root.key" -CAcreateserial \
    -days 1825 -sha256 -out "$CONFDIR/int.crt" \
    -extfile <(printf "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign")
  # mitmproxy confdir contract: mitmproxy-ca.pem = signing key + cert chain
  cat "$CONFDIR/int.key" "$CONFDIR/int.crt" "$CONFDIR/root.crt" > "$CONFDIR/mitmproxy-ca.pem"
  chmod 600 "$CONFDIR/mitmproxy-ca.pem"
  echo "✓ CA generated."
else
  echo "CA already exists in $CONFDIR — skipping generation."
fi

echo "Trusting Forge Root in the login keychain (enter your password when prompted)…"
security add-trusted-cert -d -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$CONFDIR/root.crt"
echo "✓ Root trusted on the host."

echo "Installing the root into every simulator's trust store…"
xcrun simctl list devices -j | python3 -c "
import json, subprocess, sys
data = json.load(sys.stdin)
n = 0
for runtime, devices in data['devices'].items():
    for d in devices:
        try:
            subprocess.run(['xcrun', 'simctl', 'keychain', d['udid'], 'add-root-cert', '$CONFDIR/root.crt'], check=True, capture_output=True)
            n += 1
        except Exception:
            pass
print(f'✓ CA installed into {n} simulators.')
"
echo "Reboot booted simulators once (device tile → shut down → boot)."
read -r -p "Press Enter to close…" _
