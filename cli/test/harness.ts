import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../server/src/index.ts';

/** CLI contract harness (plan F2): REAL listening server on an ephemeral
 *  port via buildApp + tmp DB — the CLI is an HTTP client; inject can't
 *  exercise the client layer. Shared by every per-command test file. */

export interface Harness {
  baseUrl: string;
  close(): Promise<void>;
  cleanup(): void;
}

let cached: Harness | null = null;

export async function harness(): Promise<Harness> {
  if (cached) return cached;
  const tmp = mkdtempSync(join(tmpdir(), 'lionidas-cli-'));
  process.env['CRUCIBLE_DB_PATH'] = join(tmp, 't.db');
  process.env['CRUCIBLE_ARTIFACTS_DIR'] = join(tmp, 'artifacts');
  process.env['CRUCIBLE_SILENT'] = '1';
  process.env['CRUCIBLE_WATCHDOG'] = '0';
  process.env['CRUCIBLE_PIN'] = 'cli-test-pin-1'; // deterministic admin seed
  const app = await buildApp(process.env);
  await app.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  cached = {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() { await app.close(); },
    cleanup() { rmSync(tmp, { recursive: true, force: true }); },
  };
  return cached;
}

// seed a known operator + login helper for guarded routes
export const OPERATOR = { email: 'admin@lionparcel.com', password: 'cli-test-pin-1', name: 'admin' };

export async function seedOperator(h: Harness): Promise<string> {
  const r = await fetch(`${h.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(OPERATOR),
  });
  if (r.ok) {
    const sc = r.headers.get('set-cookie') ?? '';
    const m = /crucible_session=([a-f0-9]{64})/.exec(sc);
    if (m?.[1]) return m[1];
  }
  throw new Error('operator login failed — is the test DB seeded with users?');
}
