/** Host-level simulator traffic routing.
 *
 *  iOS sims have no per-device proxy setting honored on modern iOS (the old
 *  com.apple.CommCenter DeviceProxy defaults trick is ignored), but they DO
 *  inherit the host's system proxy at BOOT. So routing sim traffic through
 *  the forge proxy = set the host's web/secure-web proxy on the default-route
 *  network service, then reboot the sims. Charles/Proxyman do exactly this.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
}

/** Map the default-route interface (e.g. en1) to its network service name. */
export function primaryNetworkService(): string {
  const route = sh('route', ['-n', 'get', 'default']);
  const m = /interface:\s*(\S+)/.exec(route);
  const iface = m?.[1];
  if (!iface) throw new Error('no default route — cannot resolve primary network service');
  const ports = sh('networksetup', ['-listallhardwareports']);
  const re = new RegExp(`Hardware Port: (.+)\\nDevice: ${iface}\\b`);
  const sm = re.exec(ports);
  if (!sm?.[1]) throw new Error(`no network service found for interface ${iface}`);
  return sm[1];
}

export interface RoutingState {
  enabled: boolean;
  service: string | null;
  host: string | null;
  port: number | null;
}

export function simRoutingState(): RoutingState {
  try {
    const service = primaryNetworkService();
    const out = sh('networksetup', ['-getwebproxy', service]);
    const enabled = /^Enabled: Yes$/m.test(out);
    const host = /Server: (\S+)/.exec(out)?.[1] ?? null;
    const port = Number(/Port: (\d+)/.exec(out)?.[1] ?? 0) || null;
    return { enabled, service, host, port };
  } catch {
    return { enabled: false, service: null, host: null, port: null };
  }
}

/** Simulator trust: sims have their OWN trust store — host keychain anchors
 *  (login OR System) do NOT reach it. `simctl keychain add-root-cert` is the
 *  supported install path. Returns the sims the cert was installed on. */
export function installRootCertToSims(certPath: string): string[] {
  const out = sh('xcrun', ['simctl', 'list', 'devices', '-j']);
  const devices = JSON.parse(out) as { devices: Record<string, Array<{ udid: string; state: string; name: string }>> };
  const installed: string[] = [];
  for (const list of Object.values(devices.devices)) {
    for (const d of list) {
      try {
        execFileSync('xcrun', ['simctl', 'keychain', d.udid, 'add-root-cert', certPath]);
        installed.push(d.name);
      } catch { /* device not available (e.g. not created) — skip */ }
    }
  }
  return installed;
}

/** Ensure the Apple-compliant CA hierarchy exists at confdir. mitmproxy's
 *  DEFAULT CA signs leaves directly with the root — iOS strict TLS rejects
 *  that ('leaf MissingIntermediate' → NSURLError -1200). Generate a proper
 *  root → intermediate hierarchy on first use so a fresh machine never
 *  silently falls back to the broken default. */
export function ensureForgeCa(confdir: string): { created: boolean; rootCertPath: string } {
  const caPem = join(confdir, 'mitmproxy-ca.pem');
  if (existsSync(caPem)) return { created: false, rootCertPath: join(confdir, 'root.crt') };
  mkdirSync(confdir, { recursive: true });
  const run = (args: string[]): void => {
    try { execFileSync('openssl', args, { stdio: 'ignore' }); } catch (err) {
      throw new Error(`CA generation failed (openssl ${args[0]}…): ${err instanceof Error ? err.message : String(err)} — run scripts/setup-forge-tls.command manually`);
    }
  };
  run(['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
    '-keyout', join(confdir, 'root.key'), '-out', join(confdir, 'root.crt'),
    '-subj', '/CN=Forge Root/O=Crucible',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run(['req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(confdir, 'int.key'), '-out', join(confdir, 'int.csr'),
    '-subj', '/CN=Forge Intermediate/O=Crucible']);
  // intermediate extension config (openssl needs a real file for -extfile)
  const extPath = join(confdir, 'int.ext');
  writeFileSync(extPath, 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
  run(['x509', '-req', '-in', join(confdir, 'int.csr'),
    '-CA', join(confdir, 'root.crt'), '-CAkey', join(confdir, 'root.key'), '-CAcreateserial',
    '-days', '1825', '-sha256', '-out', join(confdir, 'int.crt'),
    '-extfile', extPath]);
  // mitmproxy confdir contract: mitmproxy-ca.pem = signing key + cert chain
  const ca = [readFileSync(join(confdir, 'int.key'), 'utf8'), readFileSync(join(confdir, 'int.crt'), 'utf8'), readFileSync(join(confdir, 'root.crt'), 'utf8')].join('');
  writeFileSync(caPem, ca, { mode: 0o600 });
  return { created: true, rootCertPath: join(confdir, 'root.crt') };
}

/** Point the host (and thus sims, after reboot) at the forge proxy. */
export function enableSimRouting(port: number): RoutingState {
  const service = primaryNetworkService();
  sh('networksetup', ['-setwebproxy', service, '127.0.0.1', String(port)]);
  sh('networksetup', ['-setsecurewebproxy', service, '127.0.0.1', String(port)]);
  return simRoutingState();
}

/** Restore direct connection. */
export function disableSimRouting(): RoutingState {
  const service = primaryNetworkService();
  sh('networksetup', ['-setwebproxystate', service, 'off']);
  sh('networksetup', ['-setsecurewebproxystate', service, 'off']);
  return simRoutingState();
}
