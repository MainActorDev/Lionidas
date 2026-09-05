/** Evidence ingest — the ONE implementation (playback + automated runner
 *  previously carried divergent copies; the divergence caused a real bug:
 *  bundle_id='manual' vs runId split retention deletes).
 *  Copies a source file into artifacts/{runId}/, content-addresses it,
 *  records the evidence row. Returns { id, path } — callers store the
 *  INGESTED path (never the engine's temp source, which the OS cleans). */
import type Database from 'better-sqlite3';
import { mkdirSync, existsSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface IngestDeps {
  db: Database.Database;
  artifactsDir: string;
}

export function ingestEvidence(deps: IngestDeps, runId: string, bundleId: string, type: string, srcPath: string | undefined): { id: string; path: string } | null {
  if (!srcPath || !existsSync(srcPath)) return null;
  mkdirSync(join(deps.artifactsDir, runId), { recursive: true });
  const dest = join(deps.artifactsDir, runId, `${type}-${createHash('sha256').update(srcPath).digest('hex').slice(0, 8)}-${randomUUID().slice(0, 4)}-${srcPath.split('/').pop()}`);
  if (!existsSync(dest)) copyFileSync(srcPath, dest);
  const sha = createHash('sha256').update(dest).digest('hex');
  const id = `ev_${sha.slice(0, 12)}`;
  deps.db
    .prepare(`INSERT OR IGNORE INTO evidence(id, bundle_id, type, path, sha256, bytes, moov_ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, bundleId, type, dest, sha, statSync(dest).size, null, Date.now());
  return { id, path: dest };
}
