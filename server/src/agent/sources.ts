/** Source connectors + boot-time seeding (breakdown steps_005 §5b).
 *  File/repo connectors live; Jira fixture-tested only (I3 — env-gated live
 *  later). Seeding is idempotent: butler's ingest is content-addressed, so
 *  unchanged docs are skipped on re-boot. */
import { fileConnector, repoConnector, jiraConnector, ingest, type SqliteStorage, type StorageRetriever } from '@mainactordev/butler';

export function fileSource(root: string): ReturnType<typeof fileConnector> {
  return fileConnector('lionidas-files', { root });
}

export function repoSource(origin: string, symbols = true): ReturnType<typeof repoConnector> {
  return repoConnector('lionidas-repo', { origin, symbols });
}

export function jiraSource(cfg: { baseUrl: string; project: string; authHeader?: string; jql?: string; maxIssues?: number }, fetchImpl?: typeof fetch): ReturnType<typeof jiraConnector> {
  return jiraConnector('lionidas-jira', cfg, fetchImpl);
}

/** boot-time seed: fixture tickets always; repo (symbol chunks over the
 *  grammar-as-code) unless AGENT_INGEST_REPO=0. Errors are logged, never
 *  fatal — a missing/unreadable source must not block server boot. */
export async function seedSources(deps: { storage: SqliteStorage; retriever: StorageRetriever; artifactsDir: string }, opts?: { fixturesRoot?: string; repoRoot?: string }): Promise<{ documents: number; skipped: number }> {
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
  }
  return { documents, skipped };
}
