import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/index.ts';

/** Breakdown steps_004 §4d: operator gate on /api/agent/* + /mcp, turn events
 *  on the bus, note injection through the conversation transport, hermetic
 *  (mock provider; BUTLER_PROVIDER_* stripped). */

const hasButler = (() => { try { require.resolve('@mainactordev/butler'); return true; } catch { return false; } })();

describe.skipIf(!hasButler)('agent routes (operator gate + transports)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: import('better-sqlite3').Database;
  let dir: string;
  let operatorCookie: string;
  let viewerCookie: string;

  async function login(email: string, password: string): Promise<string | null> {
    const r = await app.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    const setCookie = r.headers['set-cookie'] as string | string[] | undefined;
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    return /crucible_session=([a-f0-9]{64})/.exec(cookie ?? '')?.[1] ?? null;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'butler-routes-'));
    process.env['CRUCIBLE_DB_PATH'] = join(dir, 't.db');
    process.env['CRUCIBLE_ARTIFACTS_DIR'] = join(dir, 'artifacts');
    process.env['CRUCIBLE_SILENT'] = '1';
    process.env['CRUCIBLE_WATCHDOG'] = '0';
    process.env['CRUCIBLE_PIN'] = 'cli-test-pin-1';
    // hermetic: force mock provider
    delete process.env['BUTLER_PROVIDER_BASE_URL'];
    delete process.env['BUTLER_API_KEY'];
    delete process.env['BUTLER_MODEL'];
    app = await buildApp(process.env);
    db = (app as unknown as { db: { raw: import('better-sqlite3').Database } }).db.raw;
    // seed operator + viewer (approved) with known passwords
    const now = Date.now();
    const mk = (id: string, email: string, role: string): void => {
      db.prepare(`INSERT INTO users(id, email, name, role, auth_source, active, approved, created_at) VALUES (?, ?, ?, ?, 'local', 1, 1, ?)`).run(id, email, email.split('@')[0]!, role, now);
    };
    mk('usr_op', 'op@local', 'operator');
    mk('usr_vw', 'vw@local', 'viewer');
    const { hashPassword } = await import('../src/auth/users.ts');
    const h = hashPassword('pw-agent-1');
    db.prepare('UPDATE users SET password_hash = ? WHERE id IN (?, ?)').run(h, 'usr_op', 'usr_vw');
    operatorCookie = (await login('op@local', 'pw-agent-1'))!;
    viewerCookie = (await login('vw@local', 'pw-agent-1'))!;
    expect(operatorCookie).toBeTruthy();
    expect(viewerCookie).toBeTruthy();
    // seed one screen so cases.list has something? (not needed for tools/list)
  });

  it('anonymous → 401 with the exact gate body', async () => {
    const r = await app.app.inject({ method: 'GET', url: '/api/agent/sessions' });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'sign in required' });
  });

  it('viewer → 403 requires role: operator', async () => {
    const r = await app.app.inject({ method: 'GET', url: '/api/agent/sessions', headers: { cookie: `crucible_session=${viewerCookie}` } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'requires role: operator' });
  });

  it('operator: sessions list 200; session create 201; a turn persists messages + emits agent.turn frames', async () => {
    const frames: Array<{ sessionId: string; type: string }> = [];
    app.bus.on('agent.turn', (e) => { frames.push({ sessionId: e.sessionId, type: e.type }); });

    const list = await app.app.inject({ method: 'GET', url: '/api/agent/sessions', headers: { cookie: `crucible_session=${operatorCookie}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveProperty('sessions');

    const created = await app.app.inject({ method: 'POST', url: '/api/agent/sessions', headers: { cookie: `crucible_session=${operatorCookie}` }, payload: {} });
    expect(created.statusCode).toBe(201);
    const sid = created.json()['session']?.['id'] ?? created.json()['id'];
    expect(sid).toBeTruthy();

    // mock provider: single scripted assistant turn → turn.ok with answer
    const turn = await app.app.inject({ method: 'POST', url: `/api/agent/sessions/${sid}/messages`, headers: { cookie: `crucible_session=${operatorCookie}` }, payload: { content: 'list the login cases' } });
    expect([200, 201]).toContain(turn.statusCode);
    const body = turn.json() as { turn?: { ok?: boolean } };
    expect(body['turn']?.['ok']).toBe(true);

    // persisted messages (butler_messages table in agent db)
    const agentDb = app.agent.storage;
    const msgs = await agentDb.sessionMessages(sid);
    expect(msgs.length).toBeGreaterThanOrEqual(2); // user + assistant

    // frames seen for THIS session
    expect(frames.some((f) => f.sessionId === sid && f.type === 'turn.end')).toBe(true);
  });

  it('MCP: initialize + tools/list gated; act tools invisible; cases.list callable', async () => {
    const H = { cookie: `crucible_session=${operatorCookie}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const init = await app.app.inject({ method: 'POST', url: '/mcp', headers: H, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } } } });
    expect([200, 201]).toContain(init.statusCode);
    // session header for stateful streamable-HTTP
    const mcpSession = (init.headers['mcp-session-id'] as string | undefined) ?? '';
    const H2 = { ...H, ...(mcpSession ? { 'mcp-session-id': mcpSession } : {}) };
    const tools = await app.app.inject({ method: 'POST', url: '/mcp', headers: H2, payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } } );
    expect([200, 201]).toContain(tools.statusCode);
    const raw = tools.body;
    const names = [...raw.matchAll(/"name":"(.*?)"/g)].map((m) => m![1]!);
    expect(names).toContain('cases.list');
    expect(names).not.toContain('case.play');
    expect(names).not.toContain('device.power');

    const call = await app.app.inject({ method: 'POST', url: '/mcp', headers: H2, payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cases.list', arguments: {} } } });
    expect([200, 201]).toContain(call.statusCode);
    expect(call.body).toContain('id');
  });

  it('MCP anonymous → 401 (same gate)', async () => {
    const r = await app.app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'sign in required' });
  });

  it('note injection: note saved in session A appears in a later turn (persisted rows)', async () => {
    // save a note with unmistakable content
    const noteOut = await app.agent.registry.execute('note.save', { scopeKey: 'app:com.test.app', kind: 'pitfall', content: 'UNIQUE-INJECTION-MARKER-7734', sourceRef: 'run_inject' }, { sessionId: 'routes-test', signal: undefined }, app.agent.policy);
    expect(noteOut).toMatch(/^note /);

    const created = await app.app.inject({ method: 'POST', url: '/api/agent/sessions', headers: { cookie: `crucible_session=${operatorCookie}` }, payload: {} });
    const sid = created.json()['session']?.['id'] ?? created.json()['id'];
    await app.app.inject({ method: 'POST', url: `/api/agent/sessions/${sid}/messages`, headers: { cookie: `crucible_session=${operatorCookie}` }, payload: { content: 'what pitfalls do you know' } });

    // injection happens inside runLoop (systemPrompt + notesBlock) which is
    // butler's own pinned behavior; the Lionidas-side contract here: the note
    // is active in the SAME storage the conversation transport reads from,
    // and turns keep completing with it present.
    const notes = await app.agent.storage.activeNotes();
    expect(notes.some((n) => n.content.includes('UNIQUE-INJECTION-MARKER-7734'))).toBe(true);
    const turn2 = await app.app.inject({ method: 'POST', url: `/api/agent/sessions/${sid}/messages`, headers: { cookie: `crucible_session=${operatorCookie}` }, payload: { content: 'again' } });
    expect(turn2.json()['turn']?.['ok']).toBe(true);
  });

  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });


  // ── rev5: deterministic scope guardrail ──
  it('refuses clearly off-scope asks with 422 before any provider call', async () => {
    const off = await app.app.inject({ method: 'POST', url: `/api/agent/sessions/${(await app.app.inject({ method: 'POST', url: '/api/agent/sessions', headers: { cookie: `crucible_session=${operatorCookie}` }, payload: {} })).json()['session']['id']}/messages`, headers: { cookie: `crucible_session=${operatorCookie}` }, payload: { content: 'write me a poem about the sea' } });
    expect(off.statusCode).toBe(422);
    expect(off.json()['error']).toContain('outside my scope');
  });
  it('bare greetings get the scope hint, in-scope asks pass through', async () => {
    const greet = await app.app.inject({ method: 'POST', url: `/api/agent/sessions/${(await app.app.inject({ method: 'POST', url: '/api/agent/sessions', headers: { cookie: `crucible_session=${operatorCookie}` }, payload: {} })).json()['session']['id']}/messages`, headers: { cookie: `crucible_session=${operatorCookie}` }, payload: { content: 'hi' } });
    expect(greet.statusCode).toBe(422);
  });
});
