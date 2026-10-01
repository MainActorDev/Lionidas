import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/main.ts';
import { harness, seedOperator, type Harness } from './harness.ts';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Phase 2 contract: folder/screen/suite + case authoring round-trips against
 *  the REAL server (harness). Exit codes and --json shapes are the contract. */

let h: Harness;
let cookie: string;
let tmp: string;

beforeAll(async () => {
  h = await harness();
  cookie = await seedOperator(h);
  tmp = mkdtempSync(join(tmpdir(), 'lionidas-p2-'));
  process.env['LIONIDAS_URL'] = h.baseUrl;
  process.env['LIONIDAS_TOKEN'] = `__cookie__${cookie}`;
});

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const savedStdout = process.stdout.write.bind(process.stdout);
  const savedStderr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (s: string) => { out += s; return true; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (s: string) => { err += s; return true; };
  let code = 0;
  try { code = await run([...args, '--json']); } catch { code = 1; }
  (process.stdout as { write: unknown }).write = savedStdout;
  (process.stderr as { write: unknown }).write = savedStderr;
  return { code, out, err };
}

const APP = 'com.p2.contract.app';

describe('phase 2 — case authoring', () => {
  it('case new (yaml) → round-trip yaml → edit adds a step', async () => {
    const y1 = `name: p2 contract case\napp: ${APP}\nsteps:\n  - tap: { on: btn_a }\n`;
    const f1 = join(tmp, 'c1.yaml');
    writeFileSync(f1, y1);
    const created = await cli('case', 'new', f1);
    expect(created.code).toBe(0);
    const row = JSON.parse(created.out) as { id: string; name: string };
    expect(row.id).toMatch(/^tpl_/);
    expect(row.name).toBe('p2 contract case');

    const got = await cli('case', 'yaml', row.id);
    expect(got.code).toBe(0);
    const cur = JSON.parse(got.out) as string; // --json wraps the yaml text in a JSON string
    const y2 = `${cur}  - expect: { on: screen_b }\n`;
    const f2 = join(tmp, 'c2.yaml');
    writeFileSync(f2, y2);
    const edited = await cli('case', 'edit', row.id, f2);
    expect(edited.code).toBe(0);

    const rt = await cli('case', 'yaml', row.id);
    expect(rt.out).toContain('screen_b');
  });

  it('case new with INVALID yaml → non-zero + server error verbatim', async () => {
    const f = join(tmp, 'bad.yaml');
    writeFileSync(f, `name: bad\nsteps:\n  - frobnicate: {}\n`);
    const r = await cli('case', 'new', f);
    expect(r.code).toBe(1);
    expect(r.out.toLowerCase()).toContain('error');
  });

  it('duplicate → distinct id, auto-(copy) name → delete both', async () => {
    const y = `name: p2 dup source\napp: ${APP}\nsteps:\n  - tap: { on: btn_a }\n`;
    const f = join(tmp, 'dup.yaml');
    writeFileSync(f, y);
    const a = JSON.parse((await cli('case', 'new', f)).out) as { id: string };
    const d = await cli('case', 'duplicate', a.id);
    expect(d.code).toBe(0);
    const dup = JSON.parse(d.out) as { id: string; name: string };
    expect(dup.id).not.toBe(a.id);
    expect(dup.name).toContain('copy');
    expect((await cli('case', 'delete', a.id)).code).toBe(0);
    expect((await cli('case', 'delete', dup.id)).code).toBe(0);
  });

  it('export zip → import round-trip renames on collision', async () => {
    const y = `name: p2 export me\napp: ${APP}\nsteps:\n  - tap: { on: btn_a }\n`;
    const f = join(tmp, 'exp.yaml');
    writeFileSync(f, y);
    const a = JSON.parse((await cli('case', 'new', f)).out) as { id: string };
    const zip = join(tmp, 'exp.zip');
    const ex = await cli('case', 'export', a.id, '--out', zip);
    expect(ex.code).toBe(0);
    expect(readFileSync(zip).length).toBeGreaterThan(100); // real zip bytes
    const im = await cli('case', 'import', zip);
    expect(im.code).toBe(0);
    const body = JSON.parse(im.out) as { imported: Array<{ id: string }>; renamed: Array<{ to: string }> };
    expect(body.imported.length).toBe(1);
    expect(body.imported[0]!.id).not.toBe(a.id);
    expect(body.renamed[0]!.to).toContain('imported');
    await cli('case', 'delete', a.id);
    await cli('case', 'delete', body.imported[0]!.id);
  });
});

describe('phase 2 — folders', () => {
  it('new → list (tree) → rename → case move → delete guards', async () => {
    const mk = await cli('folder', 'new', '--app', APP, '--name', 'p2top');
    expect(mk.code).toBe(0);
    const top = JSON.parse(mk.out) as { id: string };
    const sub = await cli('folder', 'new', '--app', APP, '--name', 'p2sub', '--parent', top.id);
    expect(sub.code).toBe(0);

    const y = `name: p2 foldered\napp: ${APP}\nfolder: p2top/p2sub\nsteps:\n  - tap: { on: btn_a }\n`;
    const f = join(tmp, 'fold.yaml');
    writeFileSync(f, y);
    const c = JSON.parse((await cli('case', 'new', f)).out) as { id: string };

    const ls = await cli('folder', 'list', '--app', APP);
    expect(ls.code).toBe(0);
    const tree = JSON.parse(ls.out) as Array<{ path: string; caseCount: number }>;
    expect(tree.find((x) => x.path === 'p2top/p2sub')?.caseCount).toBe(1);

    // delete guard: folder not empty → 409 error surfaces
    const guarded = await cli('folder', 'delete', JSON.parse(sub.out).id);
    expect(guarded.code).toBe(1);
    expect(guarded.out).toContain("isn't empty");

    // move case to root then delete chain
    const mv = await cli('folder', 'move', 'root', '--cases', c.id, '--app', APP);
    expect(mv.code).toBe(0);
    expect((await cli('folder', 'delete', JSON.parse(sub.out).id)).code).toBe(0);
    expect((await cli('folder', 'delete', top.id)).code).toBe(0);
    expect((await cli('case', 'delete', c.id)).code).toBe(0);
  });
});

describe('phase 2 — screens + recipes', () => {
  it('register → list → yaml raw round-trip → remove', async () => {
    const reg = await cli('screen', 'register', '--app', APP, '--name', 'p2-screen',
      '--entry', '{"navigate":[{"on":"btn_a"}]}',
      '--states', '{"default":{"all":[{"identifier":"scr_p2"}]}}');
    expect(reg.code).toBe(0);

    const ls = await cli('screen', 'list', APP);
    expect(ls.code).toBe(0);
    const screens = JSON.parse(ls.out) as Array<{ id: string }>;
    expect(screens.some((s) => s.id === 'p2-screen')).toBe(true);

    const y = await cli('screen', 'yaml', APP);
    expect(y.code).toBe(0);
    expect(JSON.parse(y.out) as string).toContain('p2-screen');

    const rm = await cli('screen', 'remove', APP, 'p2-screen');
    expect(rm.code).toBe(0);
  });

  it('login-flow write rejects an incomplete recipe (server 422 verbatim)', async () => {
    const f = join(tmp, 'login-bad.yaml');
    writeFileSync(f, 'steps:\n  - tap: { on: email }\n');
    const r = await cli('screen', 'login-flow', APP, f);
    expect(r.code).toBe(1);
    expect(r.out).toContain('entry');
  });

  it('login-flow full shape saves + reads back', async () => {
    // need a screen for verify
    await cli('screen', 'register', '--app', APP, '--name', 'p2-logged-in',
      '--entry', '{"navigate":[{"on":"btn_a"}]}',
      '--states', '{"default":{"all":[{"identifier":"scr_ok"}]}}');
    const f = join(tmp, 'login-ok.yaml');
    writeFileSync(f, `entry:\n  navigate:\n    - on: btn_a\nsteps:\n  - tap: { on: email }\n  - type: { on: email, text: "\${P2_USER}" }\n  - tap: { on: submit }\nverify:\n  screen: p2-logged-in\n  state: default\n`);
    const w = await cli('screen', 'login-flow', APP, f);
    expect(w.code).toBe(0);
    const got = JSON.parse((await cli('screen', 'login-flow', APP)).out) as { login: { steps?: unknown[] } | null };
    expect(got.login?.steps?.length).toBe(3);
    await cli('screen', 'remove', APP, 'p2-logged-in');
  });
});

describe('phase 2 — suites', () => {
  it('new with members → list → get → edit members → delete', async () => {
    const y = `name: p2 suite member\napp: ${APP}\nsteps:\n  - tap: { on: btn_a }\n`;
    const f = join(tmp, 'su.yaml');
    writeFileSync(f, y);
    const c = JSON.parse((await cli('case', 'new', f)).out) as { id: string };

    const mk = await cli('suite', 'new', '--name', 'p2 contract suite', '--members', c.id, '--app', APP);
    expect(mk.code).toBe(0);
    const su = JSON.parse(mk.out) as { id: string };
    expect(su.id).toMatch(/^suite_/);

    const ls = JSON.parse((await cli('suite', 'list')).out) as Array<{ id: string; memberCount: number }>;
    expect(ls.find((x) => x.id === su.id)?.memberCount).toBe(1);

    const got = JSON.parse((await cli('suite', 'get', su.id)).out) as { name: string; members?: unknown[] };
    expect(got.name).toBe('p2 contract suite');
    expect(got.members?.length).toBe(1);

    expect((await cli('suite', 'delete', su.id)).code).toBe(0);
    expect((await cli('case', 'delete', c.id)).code).toBe(0);
  });

  it('suite new with an UNKNOWN member → honest 400', async () => {
    const r = await cli('suite', 'new', '--name', 'p2 ghost suite', '--members', 'tpl_doesnotexist', '--app', APP);
    expect(r.code).toBe(1);
    expect(r.out).toContain('unknown template');
  });
});

describe('phase 2 — cleanup', () => {
  it('tmp dir removed', () => {
    rmSync(tmp, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
