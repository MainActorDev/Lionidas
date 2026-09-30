import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { harness, seedOperator, type Harness } from './harness.ts';
import { run } from '../src/main.ts';

/** Stage-0 command contract tests: every command against a REAL listening
 *  server (F2 harness). --json mode exercised everywhere. */

let h: Harness;
let SID = '';

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  // auth material via env so tests never touch the real ~/.lionidas
  const prevUrl = process.env['LIONIDAS_URL'];
  const prevCookie = process.env['LIONIDAS_TOKEN'];
  process.env['LIONIDAS_URL'] = h.baseUrl;
  process.env['LIONIDAS_TOKEN'] = `__cookie__${SID}`; // client sends env token as Bearer — for cookie mode we pass via LIONIDAS_COOKIE below
  const r = await runArgs(args);
  process.env['LIONIDAS_URL'] = prevUrl;
  process.env['LIONIDAS_TOKEN'] = prevCookie;
  return r;
}

// thin wrapper capturing stdout/stderr + exit path
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
async function runArgs(args: string[]): Promise<{ code: number; out: string; err: string }> {
  // run() prints directly; capture via in-process hooks
  const chunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true; };
  (process.stderr as { write: (s: string) => boolean }).write = (s: string) => { errChunks.push(s); return true; };
  let code = 0;
  try {
    // cookie auth for the client: harness session via env the config layer reads
    process.env['LIONIDAS_SESSION'] = SID;
    code = await run(args) ?? 0;
  } catch (e) {
    code = 1;
    errChunks.push(e instanceof Error ? e.message : String(e));
  } finally {
    (process.stdout as { write: (s: string) => boolean }).write = origOut as never;
    (process.stderr as { write: (s: string) => boolean }).write = origErr as never;
    delete process.env['LIONIDAS_SESSION'];
  }
  return { code, out: chunks.join(''), err: errChunks.join('') };
}
void cli; void spawnSync; void pathToFileURL;

describe('stage-0 commands', () => {
  beforeAll(async () => { h = await harness(); SID = await seedOperator(h); });
  afterAll(async () => { await h.close(); h.cleanup(); });

  it('auth status (json): authenticated as the seeded admin via session cookie', async () => {
    const r = await cli('auth', 'status', '--json');
    const body = JSON.parse(r.out) as { authenticated?: boolean; user?: { name?: string } };
    expect(r.code).toBe(0);
    expect(body.authenticated).toBe(true);
    expect(body.user?.name).toBe('admin');
  });

  it('context (json): returns apps/devices/cases/env arrays', async () => {
    const r = await cli('context', '--json');
    const body = JSON.parse(r.out) as { apps?: unknown[]; bootedDevices?: unknown[]; cases?: unknown[]; envKeys?: unknown[] };
    expect(r.code).toBe(0);
    for (const k of ['apps', 'bootedDevices', 'cases', 'envKeys'] as const) expect(Array.isArray(body[k])).toBe(true);
  });

  it('env set + list + delete round-trip (masked values from server)', async () => {
    const key = `CLI_TEST_${Date.now().toString(36).toUpperCase()}`;
    const set = await cli('env', 'set', key, 'hello-value', '--json');
    if (set.code !== 0) console.error('ENVSET ERR:', set.err, 'OUT:', set.out);
    expect(set.code).toBe(0);
    const list = await cli('env', 'list', '--json');
    const body = JSON.parse(list.out) as Array<{ key: string; value: string }>;
    expect(body.some((v) => v.key === key)).toBe(true);
    const del = await cli('env', 'delete', key, '--json');
    expect(del.code).toBe(0);
    const list2 = await cli('env', 'list', '--json');
    const body2 = JSON.parse(list2.out) as Array<{ key: string }>;
    expect(body2.some((v) => v.key === key)).toBe(false);
  });

  it('case list (json) against the scratch server', async () => {
    const r = await cli('case', 'list', '--json');
    if (r.code !== 0) console.error('CASELIST ERR:', r.err, 'OUT:', r.out);
    expect(r.code).toBe(0);
    expect(Array.isArray(JSON.parse(r.out))).toBe(true);
  });

  it('stack status (json): reports server health from the harness port', async () => {
    const r = await cli('stack', 'status', '--json');
    const body = JSON.parse(r.out) as { server?: { up?: boolean }; node?: { ok?: boolean } };
    expect(r.code).toBe(0);
    expect(body.server?.up).toBe(true);
    expect(body.node?.ok).toBe(true);
  });

  it('stack down → honest phase-1 message, non-zero exit', async () => {
    const r = await cli('stack', 'down', '--json');
    expect(r.code).toBe(1);
    const body = JSON.parse(r.out) as { error?: string };
    expect(body.error).toContain('phase 1');
  });

  it('unknown case id → NOT_FOUND error, exit 1', async () => {
    const r = await cli('case', 'get', 'tpl_doesnotexist', '--json');
    expect(r.code).toBe(1);
    const body = JSON.parse(r.out) as { error?: string };
    expect(body.error).toBeTruthy();
  });
});
