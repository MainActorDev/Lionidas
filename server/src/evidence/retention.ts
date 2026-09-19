/** Latest-only artifact retention: a new run of the same template (or automated
 *  ticket) replaces the previous run's stored evidence — files and evidence rows
 *  are pruned; DB run history (status/steps/notes) is preserved.
 *
 *  Policy (2026-09-05): screenshots/videos exist ONLY for playback + automated
 *  runs, one generation per template. Manual/watch store nothing (already true). */
import type Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

export interface RetentionDeps {
  db: Database.Database;
  artifactsDir: string;
}

export type RetentionKey =
  | { templateId: string; variantId?: string | null }
  | { ticketKey: string };

/** Prune the most recent FINISHED run's artifacts under the same key, keeping
 *  the given run. A still-running previous run (finished_at IS NULL) is NEVER
 *  pruned — its evidence is being written right now. Missing dirs are
 *  best-effort. Returns the pruned run id or null. */
export function prunePreviousRunArtifacts(deps: RetentionDeps, key: RetentionKey, keepRunId: string): string | null {
  const templateScoped = 'templateId' in key;
  const where = templateScoped
    ? 'template_id = ? AND kind = \'manual\' AND variant_id IS ?'
    : 'ticket_key = ? AND template_id IS NULL AND kind = \'automated\'';
  const params: unknown[] = templateScoped
    ? [key.templateId, (key as { variantId?: string | null }).variantId ?? null, keepRunId]
    : [key.ticketKey, keepRunId];
  const prev = deps.db.prepare(
    `SELECT id FROM runs WHERE ${where} AND id != ? AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`,
  ).get(...params) as { id: string } | undefined;
  if (!prev) return null;

  // files: the run's artifact directory (screenshot + video land there)
  try { rmSync(join(deps.artifactsDir, prev.id), { recursive: true, force: true }); } catch { /* best-effort */ }

  // evidence rows for that run (ingestEvidence writes bundle_id = runId)
  deps.db.prepare('DELETE FROM evidence WHERE bundle_id = ?').run(prev.id);
  // step-level evidence references go with them
  deps.db.prepare(`UPDATE run_steps SET evidence_ids_json = '[]' WHERE run_id = ?`).run(prev.id);

  // dangling references on the run row
  deps.db.prepare('UPDATE runs SET artifact_path = NULL, video_path = NULL WHERE id = ?').run(prev.id);
  return prev.id;
}
