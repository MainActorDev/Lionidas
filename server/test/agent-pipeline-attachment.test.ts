/** rev23 F5 tests — attachment refs in the pipeline: compile merges text, honest line for
 *  binaries and dead ids; route accepts the kind; mixed ref sets flow end-to-end. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileKnowledge, type PipelineRef } from '../src/agent/knowledge.ts';
import { AttachmentStore } from '../src/agent/attachments.ts';
import { SqliteStorage } from '@mainactordev/butler';

let dir: string;
let db: Database.Database;
let store: AttachmentStore;
let storage: SqliteStorage;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'f5-'));
  db = new Database(path.join(dir, 'main.db'));
  store = new AttachmentStore(db, dir);
  storage = new SqliteStorage(path.join(dir, 'agent.db'));
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); db.close(); });

async function compile(refs: PipelineRef[], read: (id: string) => Promise<string | null>): Promise<string> {
  const out = await compileKnowledge('com.lionparcel.dev', refs, {
    storage,
    retriever: null as never,
    artifactsDir: dir,
    fetchExternal: async () => 'external fixture text',
    readAttachment: read,
  }, 'wfr_f5');
  const page = await storage.getArtifact(out.page.id);
  return page?.body ?? '';
}

describe('attachment refs compile', () => {
  it('text attachment content merges into the knowledge page', async () => {
    const row = await store.save('notes.md', Buffer.from('QR login regression checklist'));
    const body = await compile([{ kind: 'attachment', locator: row.id }], (id) => store.readText(id));
    expect(body).toContain('QR login regression checklist');
  });

  it('binary attachment compiles as the honest not-extracted line', async () => {
    const row = await store.save('shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const body = await compile([{ kind: 'attachment', locator: row.id }], (id) => store.readText(id));
    expect(body).toMatch(/binary .* not extracted/);
  });

  it('dead attachment id → skipped line, run does not fail', async () => {
    const body = await compile([{ kind: 'attachment', locator: 'att_deadbeefdead' }], () => Promise.resolve(null));
    expect(body).toMatch(/missing from store — skipped/);
  });

  it('mixed ref set (jira + github-pr + attachment) integrates all three', async () => {
    const row = await store.save('mixed.md', Buffer.from('mixed attachment text'));
    const body = await compile([
      { kind: 'jira', locator: 'LP-1042' },
      { kind: 'github-pr', locator: 'https://github.com/Lionparcel/ios-consumer/pull/8934' },
      { kind: 'attachment', locator: row.id },
    ], (id) => store.readText(id));
    expect(body).toContain('external fixture text');       // jira + pr via fetchExternal
    expect(body).toContain('mixed attachment text');       // attachment reader
  });
});
