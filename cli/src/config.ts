/** CLI config + credentials store: ~/.lionidas/config.json (0600).
 *  Resolution order for the base URL: LIONIDAS_URL env > config > default. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CliConfig {
  baseUrl: string;
  /** PAT (Bearer lion_…) — preferred when present */
  token?: string;
  /** session cookie value (interim auth, 12h) */
  sessionCookie?: string;
  sessionExpiresAt?: number;
  email?: string;
}

const DIR = join(homedir(), '.lionidas');
const PATH = join(DIR, 'config.json');

export const DEFAULT_URL = 'http://127.0.0.1:9230';

export function configPath(): string { return PATH; }

export function readConfig(): CliConfig | null {
  if (!existsSync(PATH)) return null;
  try {
    return JSON.parse(readFileSync(PATH, 'utf8')) as CliConfig;
  } catch { return null; }
}

export function writeConfig(cfg: CliConfig): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(PATH, JSON.stringify(cfg, null, 2) + '\n');
  try { chmodSync(PATH, 0o600); } catch { /* best-effort on exotic fs */ }
}

export function resolveBaseUrl(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim().replace(/\/+$/, '');
  const env = process.env['LIONIDAS_URL'];
  if (env && env.trim()) return env.trim().replace(/\/+$/, '');
  return readConfig()?.baseUrl ?? DEFAULT_URL;
}

/** Auth material: env LIONIDAS_TOKEN wins (CI), then stored PAT, then cookie. */
export function authHeaders(cfg: CliConfig | null): Record<string, string> {
  const envToken = process.env['LIONIDAS_TOKEN'];
  if (envToken && envToken.startsWith('__cookie__')) {
    // test/harness escape hatch: session cookie passed via env without touching ~/.lionidas
    return { cookie: `crucible_session=${envToken.slice('__cookie__'.length)}` };
  }
  if (envToken) return { authorization: `Bearer ${envToken}` };
  if (cfg?.token) return { authorization: `Bearer ${cfg.token}` };
  if (cfg?.sessionCookie) return { cookie: `crucible_session=${cfg.sessionCookie}` };
  return {};
}
