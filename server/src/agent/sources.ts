/** Source connectors + boot-time seeding (breakdown steps_005 §5b).
 *  File/repo connectors live; Jira fixture-tested only (I3 — env-gated live
 *  later). Seeding is idempotent: butler's ingest is content-addressed, so
 *  unchanged docs are skipped on re-boot. */
import { fileConnector, repoConnector, jiraConnector, ingest, type SqliteStorage, type StorageRetriever } from '@mainactordev/butler';
import { join } from 'node:path';


/** bundle ids provided by a registered repo — via the repo-refs detector
 *  (project.yml/xcodegen conventions), the same source of truth repo.apps uses */
async function appBundlesFor(repoDir: string): Promise<string[]> {
  try {
    const { detectBundles } = await import('./repo-refs.ts');
    return await detectBundles(repoDir);
  } catch { return []; }
}

export function fileSource(root: string): ReturnType<typeof fileConnector> {
  return fileConnector('lionidas-files', { root });
}

export function repoSource(origin: string, symbols = true): ReturnType<typeof repoConnector> {
  // skipDirs: server/repos holds CI workspace clones (whole iOS repos + build
  // caches — thousands of files that would eat the walk budget and pollute
  // agent context with foreign source)
  return repoConnector('lionidas-repo', { origin, symbols, skipDirs: ['repos', '.hermes', 'sketches', 'brainstorm', 'plans', 'reviews'] });
}

export function jiraSource(cfg: { baseUrl: string; project: string; authHeader?: string; jql?: string; maxIssues?: number }, fetchImpl?: typeof fetch): ReturnType<typeof jiraConnector> {
  return jiraConnector('lionidas-jira', cfg, fetchImpl);
}

/** boot-time seed: fixture tickets always; repo (symbol chunks over the
 *  grammar-as-code) unless AGENT_INGEST_REPO=0. Errors are logged, never
 *  fatal — a missing/unreadable source must not block server boot. */
export async function seedSources(deps: { storage: SqliteStorage; retriever: StorageRetriever; artifactsDir: string; reposRoot?: string }, opts?: { fixturesRoot?: string; repoRoot?: string; reposRoot?: string }): Promise<{ documents: number; skipped: number }> {
  const fixturesRoot = opts?.fixturesRoot ?? new URL('../../test/fixtures/agent-tickets', import.meta.url).pathname;
  let documents = 0;
  let skipped = 0;
  try {
    const r = await ingest(fileSource(fixturesRoot), deps.storage, { artifactsDir: deps.artifactsDir });
    documents += r.documents.length;
    skipped += r.skipped.length;
    for (const d of r.documents) deps.retriever.registerChunks(await deps.storage.documentChunks(d.sha256));
  } catch (err) {
    console.warn('[agent] fixture seed skipped:', (err as Error).message);
  }
  if (process.env['AGENT_INGEST_REPO'] !== '0') {
    const repoRoot = opts?.repoRoot ?? new URL('../../../', import.meta.url).pathname;
    try {
      const r = await ingest(repoSource(repoRoot), deps.storage, { artifactsDir: deps.artifactsDir });
      documents += r.documents.length;
      skipped += r.skipped.length;
      for (const d of r.documents) deps.retriever.registerChunks(await deps.storage.documentChunks(d.sha256));
    } catch (err) {
      console.warn('[agent] repo seed skipped:', (err as Error).message);
    }
    // rev23: ALSO seed every REGISTERED workspace clone (ios-consumer etc.) —
    // the agent's codebase reading depends on symbol chunks being present
    const reposRoot = opts?.reposRoot ?? deps.reposRoot ?? process.env['CRUCIBLE_REPOS_ROOT'] ?? './repos';
    if (!opts?.repoRoot) { // hermetic tests pass repoRoot to a nonexistent dir — skip there
      try {
        const { readdir } = await import('node:fs/promises');
        const entries = await readdir(reposRoot, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if (!e.isDirectory() || e.name.startsWith('.')) continue;
          const r2 = await ingest(repoSource(join(reposRoot, e.name)), deps.storage, { artifactsDir: deps.artifactsDir });
          documents += r2.documents.length;
          skipped += r2.skipped.length;
          for (const d of r2.documents) deps.retriever.registerChunks(await deps.storage.documentChunks(d.sha256));
          // identifier index (plan 20261014T132710Z): rebuild for every app bundle this
          // repo provides AFTER ingest — the gate needs fresh code truth per sync
          try {
            const db = (deps as { db?: import('better-sqlite3').Database }).db;
            if (db) {
              const { reindexBundle } = await import('./identifier-index.ts');
              for (const b of await appBundlesFor(join(reposRoot, e.name))) {
                reindexBundle(db, b, e.name, join(reposRoot, e.name));
              }
            }
          } catch { /* index errors never block ingest */ }
        }
      } catch (err) {
        console.warn('[agent] registered-repo seed skipped:', (err as Error).message);
      }
    }
  }
  return { documents, skipped };
}
