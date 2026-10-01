import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage, StorageRetriever } from '@mainactordev/butler';
import { fileSource, repoSource, jiraSource, seedSources } from '../src/agent/sources.ts';

/** Breakdown steps_005 §5a/5b/5d: file+repo connectors live against real
 *  files/repo; Jira connector on recorded fixtures only (I3 — no network). */

const hasButler = (() => { try { require.resolve('@mainactordev/butler'); return true; } catch { return false; } })();

describe.skipIf(!hasButler)('agent sources (live connectors + recorded Jira)', () => {
  it('fileConnector: fixture tickets ingest → searchable chunks', async () => {
    const base = mkdtempSync(join(tmpdir(), 'src-file-'));
    const docsDir = join(base, 'docs');
    mkdirSync(docsDir);
    mkdirSync(join(base, 'store'));
    const storage = new SqliteStorage(join(base, 'store', 'a.db'));
    const retriever = new StorageRetriever(storage);
    writeFileSync(join(docsDir, 'LP-9001.md'), '# LP-9001 Login loop\n## Requirement\nafter logout the login button is dead until settle\n');
    const { ingest } = await import('@mainactordev/butler');
    const r = await ingest(fileSource(docsDir), storage, { artifactsDir: join(base, 'artifacts') });
    expect(r.documents.map((d) => d.uri)).toEqual(['file://LP-9001.md']); // exactly the md — no stray binaries
    for (const d of r.documents) retriever.registerChunks(await storage.documentChunks(d.sha256));
    const hits = await retriever.retrieve('login button dead settle', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content.toLowerCase()).toContain('login button');
    rmSync(base, { recursive: true, force: true });
  });

  it('repoConnector: symbol chunks over the lionidas repo (grammar-as-code)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'src-repo-'));
    const storage = new SqliteStorage(join(dir, 'a.db'));
    const { ingest } = await import('@mainactordev/butler');
    const repoRoot = new URL('../../', import.meta.url).pathname; // server/test → 2ups = lionidas root
    const r = await ingest(repoSource(repoRoot), storage, { artifactsDir: dir });
    expect(r.documents.length).toBeGreaterThan(0);
    // symbol chunks: repo connector emits repo://…#symbols docs (kind='symbols')
    const symDocs = r.documents.filter((d) => d.uri.endsWith('#symbols'));
    expect(symDocs.length).toBeGreaterThan(0);
    const caseYamlSymbols = symDocs.find((d) => d.uri.includes('case-yaml')); expect(caseYamlSymbols).toBeTruthy(); // grammar-as-code symbol-chunked
    rmSync(dir, { recursive: true, force: true });
  });

  it('jiraConnector (recorded fetch): issue → normalized doc → searchable; zero live calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'src-jira-'));
    const storage = new SqliteStorage(join(dir, 'a.db'));
    const retriever = new StorageRetriever(storage);
    const recorded: Array<{ url: string }> = [];
    const fakeFetch = (async (url: string | URL | Request): Promise<Response> => {
      recorded.push({ url: String(url) });
      const body = JSON.stringify({ issues: [{ key: 'LP-777', fields: { summary: 'Cart total off by promo', description: 'promo double-applies when reapplied at checkout', status: { name: 'Open' }, comment: { comments: [] }, attachment: [] } }] });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const { ingest } = await import('@mainactordev/butler');
    const r = await ingest(jiraSource({ baseUrl: 'https://jira.example.test', project: 'LP', authHeader: 'Bearer x' }, fakeFetch), storage, { artifactsDir: dir });
    expect(recorded.length).toBe(1);
    expect(recorded[0]!.url).toContain('jira.example.test');
    expect(r.documents.length).toBe(1);
    expect(r.documents[0]!.uri).toContain('LP-777');
    for (const d of r.documents) retriever.registerChunks(await storage.documentChunks(d.sha256));
    const hits = await retriever.retrieve('promo checkout double applies cart', 3);
    expect(hits.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('seedSources: fixture dir seeds idempotently (2nd run skips unchanged)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'src-seed-'));
    const fixtures = join(dir, 'fixtures');
    mkdirSync(fixtures);
    writeFileSync(join(fixtures, 'LP-8001.md'), '# LP-8001 stable doc\n## Requirement\nno change\n');
    const storage = new SqliteStorage(join(dir, 'a.db'));
    const retriever = new StorageRetriever(storage);
    const deps = { storage, retriever, artifactsDir: dir };
    const first = await seedSources(deps, { fixturesRoot: fixtures, repoRoot: '/nonexistent-hermetic' });
    expect(first.documents).toBe(1);
    // 2nd run: content-addressed — the doc is returned cached:true and NOT re-chunked.
    // Assert no duplicate chunks rather than an empty doc list.
    const sha = (await storage.listDocuments(50)).find((d) => d.uri.includes('LP-8001'))!.sha256;
    const chunksAfterFirst = (await storage.documentChunks(sha)).length;
    await seedSources(deps, { fixturesRoot: fixtures, repoRoot: '/nonexistent-hermetic' });
    const chunksAfterSecond = (await storage.documentChunks(sha)).length;
    expect(chunksAfterSecond).toBe(chunksAfterFirst); // no duplication
    expect(chunksAfterFirst).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
