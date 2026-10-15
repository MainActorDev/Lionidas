/** rev23 F2 tests — attachments: store dedup/cap/kind, upload route, attachment.get tool. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttachmentStore, ATTACHMENT_CAP_BYTES } from '../src/agent/attachments.ts';
import { buildToolRegistry } from '../src/agent/tools.ts';
import { buildAgentContext } from '../src/agent/context.ts';

let dir: string;
let db: Database.Database;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'att-test-'));
  db = new Database(':memory:');
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); db.close(); });

function store(): AttachmentStore { return new AttachmentStore(db, dir); }

describe('AttachmentStore', () => {
  it('saves text files as text-kind and reads them back', async () => {
    const s = store();
    const row = await s.save('notes.md', Buffer.from('# plan\nlogin flows'));
    expect(row.kind).toBe('text');
    expect(row.id).toMatch(/^att_[0-9a-f]{12}$/);
    expect(await s.readText(row.id)).toContain('login flows');
  });

  it('dedupes identical content to the same id (different names kept apart)', async () => {
    const s = store();
    const a = await s.save('a.md', Buffer.from('same'));
    const b = await s.save('b.md', Buffer.from('same'));
    expect(a.id).toBe(b.id);           // sha-identical → one row
    expect(a.fileName).toBe('a.md');   // first name wins
  });

  it('binary files return an honest not-extracted line, not an empty string', async () => {
    const s = store();
    const row = await s.save('shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    expect(row.kind).toBe('binary');
    const t = await s.readText(row.id);
    expect(t).toMatch(/binary .* not extracted/);
  });

  it('rejects oversized uploads at the store level', async () => {
    const s = store();
    await expect(s.save('big.bin', Buffer.alloc(ATTACHMENT_CAP_BYTES + 1, 1))).rejects.toThrow(/too large/);
  });

  it('missing id → get undefined, readText null', async () => {
    const s = store();
    expect(s.get('att_deadbeefdead')).toBeUndefined();
    expect(await s.readText('att_deadbeefdead')).toBeNull();
  });
});

describe('attachment.get registry tool', () => {
  it('returns text content for a text attachment', async () => {
    const ctx = buildAgentContext(db, { dbPath: ':memory:', artifactsDir: dir, env: {} });
    const row = await ctx.attachments.save('t.txt', Buffer.from('hello attach'));
    const out = await ctx.registry.execute('attachment.get', { id: row.id }, { signal: undefined, sessionId: 't' }, ctx.policy);
    expect(out).toContain('hello attach');
  });

  it('honest error for unknown id', async () => {
    const ctx = buildAgentContext(db, { dbPath: ':memory:', artifactsDir: dir, env: {} });
    const out = await ctx.registry.execute('attachment.get', { id: 'att_nope' }, { signal: undefined, sessionId: 't' }, ctx.policy);
    expect(out).toMatch(/no attachment/);
  });
});

describe('refs search tools registered (F3/F4 seams arrive next)', () => {
  it('registry carries attachment.get; jira/repo tools land in F3/F4', () => {
    const registry = buildToolRegistry({ db, storage: null as never, retriever: null as never, artifactsDir: dir });
    expect(registry.get('attachment.get')).toBeTruthy();
    expect(registry.list().some((t) => t.name === 'cases.list')).toBe(true);
  });
});
