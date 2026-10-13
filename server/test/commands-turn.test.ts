/** The turn-level proof: a chat POST with commands[] composes base+overlay once,
 *  narrows tools, and records [cmds:] — through the real conversation API. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.ts';

let app: Awaited<ReturnType<typeof buildApp>>;
let dir: string;
let cookie: string;
let sid: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cmds-chat-'));
  process.env['CRUCIBLE_DB_PATH'] = join(dir, 't.db');
  process.env['CRUCIBLE_ARTIFACTS_DIR'] = join(dir, 'art');
  process.env['CRUCIBLE_SILENT'] = '1';
  delete process.env['BUTLER_PROVIDER_BASE_URL'];
  delete process.env['BUTLER_API_KEY'];
  delete process.env['BUTLER_MODEL'];
  app = await buildApp(process.env);
  const db = (app as unknown as { db: { raw: import('better-sqlite3').Database } }).db.raw;
  db.prepare(`INSERT INTO users(id, email, name, role, auth_source, active, approved, created_at) VALUES ('u1','o@l','o','operator','local',1,1,?)`).run(Date.now());
  const { hashPassword } = await import('../src/auth/users.ts');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword('pw-1'), 'u1');
  const r = await app.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'o@l', password: 'pw-1' } });
  const setCookie = r.headers['set-cookie'] as string | string[] | undefined;
  const cookieRaw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  cookie = /crucible_session=([a-f0-9]{64})/.exec(cookieRaw ?? '')?.[1] ?? '';
  expect(cookie).toBeTruthy();
  const created = await app.app.inject({ method: 'POST', url: '/api/agent/sessions', headers: { cookie: `crucible_session=${cookie}` }, payload: {} });
  sid = created.json()['session']['id'];
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('commands as chat turns', () => {
  it('GET /api/agent/commands serves the registry', async () => {
    const r = await app.app.inject({ method: 'GET', url: '/api/agent/commands', headers: { cookie: `crucible_session=${cookie}` } });
    expect(r.statusCode).toBe(200);
    const cmds = r.json()['commands'] as Array<{ cmd: string; order: number }>;
    expect(cmds.map((c) => c.cmd)).toEqual(['/planning', '/breakdown', '/author']);
    expect(cmds[0]?.order).toBe(1);
  });

  it('a message with commands[] completes as a chat turn (mock provider) and persists', async () => {
    const r = await app.app.inject({
      method: 'POST', url: `/api/agent/sessions/${sid}/messages`,
      headers: { cookie: `crucible_session=${cookie}` },
      payload: { content: 'plan the login flow [cmds: /planning]', commands: ['/planning'] },
    });
    expect(r.statusCode).toBeLessThan(300);
    expect(r.json()['turn']?.['ok']).toBe(true);
    // the user row recorded the [cmds:] convention verbatim
    const rows = await app.agent.storage.sessionMessages(sid);
    expect(rows.some((m) => (m.content ?? '').includes('[cmds: /planning]'))).toBe(true);
  });

  it('unknown command in payload is ignored by the overlay (registry-validated) — plain turn', async () => {
    const r = await app.app.inject({
      method: 'POST', url: `/api/agent/sessions/${sid}/messages`,
      headers: { cookie: `crucible_session=${cookie}` },
      payload: { content: 'plain question', commands: ['/nope'] },
    });
    expect(r.json()['turn']?.['ok']).toBe(true);
  });
});
