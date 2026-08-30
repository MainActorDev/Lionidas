/** Host-level simulator traffic routing.
 *
 *  iOS sims have no per-device proxy setting honored on modern iOS (the old
 *  com.apple.CommCenter DeviceProxy defaults trick is ignored), but they DO
 *  inherit the host's system proxy at BOOT. So routing sim traffic through
 *  the forge proxy = set the host's web/secure-web proxy on the default-route
 *  network service, then reboot the sims. Charles/Proxyman do exactly this.
 */
import { execFileSync } from 'node:child_process';

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
