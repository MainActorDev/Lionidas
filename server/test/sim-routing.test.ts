import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleProxyServices, healStaleProxies } from '../src/forge/sim-routing.ts';

let binDir: string;
const oldPath = process.env.PATH;

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'crucible-sr-'));
  process.env.PATH = `${binDir}:${oldPath}`;
  makeNetworksetup();
});
afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
  process.env.PATH = oldPath;
});

/** Fake networksetup: service inventory from the `services` file, per-service
 *  proxy output from files named after the service, set-calls appended to
 *  `calls` for assertion. */
function makeNetworksetup(): void {
  writeFileSync(join(binDir, 'services'), 'An asterisk (*) denotes that a network service is disabled.\nEthernet\nWi-Fi\nUSB\n');
  writeFileSync(join(binDir, 'calls'), '');
  const f = join(binDir, 'networksetup');
  writeFileSync(f, [
    '#!/bin/sh',
    'd="$(dirname "$0")"',
    'case "$1" in',
    '  -listallnetworkservices) cat "$d/services"; exit 0;;',
    '  -getwebproxy) cat "$d/$2" 2>/dev/null || echo "** Error: Unable to find item in network database."; exit 0;;',
    '  -setwebproxystate|-setsecurewebproxystate) printf "%s %s %s\\n" "$1" "$2" "$3" >> "$d/calls"; exit 0;;',
    '  *) exit 1;;',
    'esac',
  ].join('\n'));
  chmodSync(f, 0o755);
}

function svc(name: string, enabled: boolean, host: string, port: number | string): void {
  writeFileSync(join(binDir, name), `Enabled: ${enabled ? 'Yes' : 'No'}\nServer: ${host}\nPort: ${port}\nAuthenticated Proxy: 0\n`);
}

function svcErr(name: string): void {
  writeFileSync(join(binDir, name), '** Error: Unable to find item in network database.\n');
}

function lsofListening(ports: number[]): void {
  const f = join(binDir, 'lsof');
  writeFileSync(f, [
    '#!/bin/sh',
    'port=""',
    'for a in "$@"; do case "$a" in -iTCP:*) port="${a##*:}";; esac; done',
    `case " ${ports.join(' ')} " in *" $port "*) echo LISTENER; exit 0;; *) exit 1;; esac`,
  ].join('\n'));
  chmodSync(f, 0o755);
}

function calls(): string[] {
  return readFileSync(join(binDir, 'calls'), 'utf8').split('\n').filter(Boolean);
}

import { readFileSync } from 'node:fs';

describe('staleProxyServices', () => {
  it('flags enabled localhost proxy with dead listener', () => {
    svc('Wi-Fi', true, '127.0.0.1', 52310);
    svc('Ethernet', false, '127.0.0.1', 60793); // disabled → inert leftover, untouched
    svc('USB', true, 'corp-proxy.lan', 8080); // not localhost → never touched
    lsofListening([]);
    expect(staleProxyServices()).toEqual([{ service: 'Wi-Fi', port: 52310 }]);
  });

  it('leaves enabled localhost proxies whose listener is alive', () => {
    svc('Wi-Fi', true, '127.0.0.1', 52310);
    lsofListening([52310]);
    expect(staleProxyServices()).toEqual([]);
  });

  it('tolerates phantom services (per-service error)', () => {
    svcErr('USB');
    svc('Wi-Fi', true, '127.0.0.1', 9999);
    lsofListening([]);
    expect(staleProxyServices()).toEqual([{ service: 'Wi-Fi', port: 9999 }]);
  });

  it('accepts localhost/::1 spellings', () => {
    svc('Wi-Fi', true, 'localhost', 1111);
    svc('Ethernet', true, '::1', 2222);
    lsofListening([]);
    expect(staleProxyServices()).toEqual([
      { service: 'Ethernet', port: 2222 },
      { service: 'Wi-Fi', port: 1111 },
    ]);
  });

  it('skips services missing from the proxy db entirely', () => {
    svc('Wi-Fi', true, '127.0.0.1', 3333); // Ethernet has NO file → cat fails → error path
    lsofListening([]);
    expect(staleProxyServices()).toEqual([{ service: 'Wi-Fi', port: 3333 }]);
  });
});

describe('healStaleProxies', () => {
  it('disables both web and secure-web on each stale service, returns what healed', () => {
    svc('Wi-Fi', true, '127.0.0.1', 52310);
    svc('Ethernet', true, '127.0.0.1', 60793);
    lsofListening([]);
    const healed = healStaleProxies();
    expect(healed).toEqual([
      { service: 'Ethernet', port: 60793 },
      { service: 'Wi-Fi', port: 52310 },
    ]);
    expect(calls()).toEqual([
      '-setwebproxystate Ethernet off',
      '-setsecurewebproxystate Ethernet off',
      '-setwebproxystate Wi-Fi off',
      '-setsecurewebproxystate Wi-Fi off',
    ]);
  });

  it('no stale entries → no writes at all', () => {
    svc('Wi-Fi', false, '127.0.0.1', 52310);
    lsofListening([]);
    expect(healStaleProxies()).toEqual([]);
    expect(calls()).toEqual([]);
  });
});
