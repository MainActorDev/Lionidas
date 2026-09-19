/** Case-version snapshots (Phase A T2): the immutable provenance record.
 *
 *  Identity = sha256(steps_json) + scenario CHOICE (not scenario content —
 *  the snapshot json records what was resolved, so preset edits don't fork
 *  revisions). Names/tags are management metadata, NOT behavior: renaming a
 *  case never creates a revision.
 *
 *  Canonical yaml rides the version via the SAME serializer the editor
 *  preview uses (caseToYaml) — one yaml writer, no drift. Backfill rows
 *  (created at migration with empty yaml) get their yaml filled on the
 *  next snapshot that reuses them.
 *
 *  Snapshots are taken BEFORE playback begins: the self-hardening sweep
 *  rewrites steps_json MID-RUN, and that rewrite must bump the NEXT run's
 *  revision, never mutate the running one's. */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { caseToYaml } from '@crucible/shared/case-yaml';
import type { YamlVariant } from '@crucible/shared/yaml-variants';

export interface VersionSnapshot {
  id: string;
  revision: number;
  /** false when an existing version was reused (content unchanged). */
  isNew: boolean;
  /** sha256 of the scenario snapshot json — what runs.scenario_sha stores. Null when no scenario. */
  scenarioSha: string | null;
}

interface TemplateRow {
  name: string;
  ticket_key: string | null;
  tags_json: string | null;
  app_bundle_id: string | null;
  app_name: string | null;
  setup_json: string | null;
  alerts_policy: string | null;
  steps_json: string;
}

/** Canonical yaml for a template row — the single reconstruction path. */
export function canonicalYaml(t: TemplateRow): string {
  let setup: unknown[] | undefined;
  try { setup = t.setup_json ? JSON.parse(t.setup_json) as unknown[] : undefined; } catch { setup = undefined; }
  let alerts: unknown;
  try { alerts = t.alerts_policy ? JSON.parse(t.alerts_policy) : undefined; } catch { alerts = undefined; }
  return caseToYaml({
    name: t.name,
    tags: t.tags_json ? JSON.parse(t.tags_json) as string[] : [],
    ...(t.app_bundle_id ? { app: t.app_bundle_id } : {}),
    ...(setup !== undefined ? { setup } : {}),
    ...(alerts !== undefined ? { alerts } : {}),
    steps: JSON.parse(t.steps_json) as unknown[],
  });
}

/** Resolve a scenario to its self-contained snapshot (preset rows, copied).
 *  Presets carry their own sha256; body files get a {path, sha} manifest —
 *  the FILE is not copied, the hash pins what was there. Null when the
 *  scenario id is unknown (honest: run proceeds, snapshot says no scenario). */
export function scenarioSnapshot(db: Database.Database, scenarioId: string): { presets: Array<Record<string, unknown>>; bodyManifest: Array<{ path: string; sha256: string }> } | null {
  const presets = db.prepare(
    `SELECT p.* FROM presets p JOIN scenario_overrides so ON so.preset_id = p.id WHERE so.scenario_id = ? AND so.enabled = 1`,
  ).all(scenarioId) as Array<Record<string, unknown>>;
  if (presets.length === 0) return null;
  const bodyManifest: Array<{ path: string; sha256: string }> = [];
  for (const p of presets) {
    const bp = p['body_path'];
    if (typeof bp === 'string' && bp.length > 0) {
      try {
        const bytes = readFileSync(bp);
        bodyManifest.push({ path: bp, sha256: createHash('sha256').update(bytes).digest('hex') });
      } catch {
        bodyManifest.push({ path: bp, sha256: 'missing' }); // honest: unreadable at snapshot time
      }
    }
  }
  return { presets, bodyManifest };
}

/**
 * Snapshot (or reuse) the version for this template+scenario combination.
 * Called at run start, before any step executes. Throws when the template
 * row is missing — a run without its case row has no provenance and must
 * not proceed silently.
 */
export function snapshotCaseVersion(db: Database.Database, args: {
  templateId: string;
  scenarioId?: string | null;
  /** Phase C: the variant this execution runs — env joins the version
   *  IDENTITY (two variants with different env are different inputs);
   *  variant without env shares the variantless version honestly. */
  variant?: YamlVariant | null;
  triggeredBy?: string | null;
}): VersionSnapshot {
  const t = db.prepare(
    'SELECT name, ticket_key, tags_json, app_bundle_id, app_name, setup_json, alerts_policy, steps_json FROM templates WHERE id = ?',
  ).get(args.templateId) as TemplateRow | undefined;
  if (!t) throw new Error(`snapshotCaseVersion: template ${args.templateId} not found`);

  const stepsSha = createHash('sha256').update(t.steps_json).digest('hex');
  const scenarioId = args.scenarioId ?? null;
  const variantEnvJson = args.variant?.env ? JSON.stringify(args.variant.env) : '';
  /** latest row's variant env as a comparable string ('' = none). */
  const latestVariantEnvJson = (row: { variant_env_json?: string | null }): string =>
    row.variant_env_json ?? '';
  const snap = scenarioId ? scenarioSnapshot(db, scenarioId) : null;
  const snapshotJson = snap ? JSON.stringify(snap) : null;
  const scenarioSha = snapshotJson ? createHash('sha256').update(snapshotJson).digest('hex') : null;

  // Reuse when executable content + scenario CHOICE match the latest version.
  const latest = db.prepare(
    'SELECT id, revision, steps_sha256, scenario_id, scenario_snapshot_json, variant_id, variant_env_json FROM case_versions WHERE template_id = ? ORDER BY revision DESC LIMIT 1',
  ).get(args.templateId) as { id: string; revision: number; steps_sha256: string; scenario_id: string | null; scenario_snapshot_json: string | null; variant_id: string | null; variant_env_json: string | null; yaml_canonical: string } | undefined;

  if (latest && latest.steps_sha256 === stepsSha && latest.scenario_id === scenarioId && latestVariantEnvJson(latest) === variantEnvJson) {
    // Backfill rows carry empty yaml — fill it now that we can (same
    // content, richer record; not a new revision).
    if (latest.yaml_canonical === '') {
      db.prepare('UPDATE case_versions SET yaml_canonical = ? WHERE id = ?').run(canonicalYaml(t), latest.id);
    }
    return { id: latest.id, revision: latest.revision, isNew: false, scenarioSha };
  }

  // Insert revision = max+1. The UNIQUE(template_id, revision) constraint
  // backs the concurrent-snapshot race: two lanes snapshotting the same
  // fresh edit — the loser's insert throws, and the retry finds the
  // winner's identical row (reuse path).
  for (let attempt = 0; ; attempt++) {
    const revision = ((db.prepare('SELECT MAX(revision) m FROM case_versions WHERE template_id = ?').get(args.templateId) as { m: number | null }).m ?? 0) + 1;
    const id = `cv_${randomUUID().slice(0, 12)}`;
    try {
      db.prepare(
        `INSERT INTO case_versions(id, template_id, revision, steps_sha256, yaml_canonical, scenario_id, scenario_snapshot_json, source, created_by, created_at, variant_id, variant_env_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'run', ?, ?, ?, ?)`,
      ).run(id, args.templateId, revision, stepsSha, canonicalYaml(t), scenarioId, snapshotJson, args.triggeredBy ?? null, Date.now(), args.variant?.id ?? null, variantEnvJson);
      return { id, revision, isNew: true, scenarioSha };
    } catch (err) {
      if (attempt < 1 && String((err as Error).message).includes('UNIQUE')) continue; // lost the race — reuse winner
      throw err;
    }
  }
}
