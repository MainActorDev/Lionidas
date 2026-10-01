/** Config-author tools (breakdown steps_001..003): read + write over suites,
 *  network scenarios, traffic presets — route-faithful, in-process, verbatim
 *  errors. Reads OMIT play-verdict rollups (F3); scenario reads include the
 *  members join. Writes land in steps 2-3. */
import type Database from 'better-sqlite3';
import type { ToolRegistry } from '@mainactordev/butler';

export interface ConfigToolDeps {
  db: Database.Database;
  registry: ToolRegistry;
  /** F2: preset writes must push to the live forge proxy — wired in index.ts */
  syncPresets?: () => void;
}

interface SuiteRow { id: string; name: string; description: string | null; app_bundle_id: string | null; created_by: string; created_at: number; updated_at: number }
interface MemberRow { suite_id: string; template_id: string; variant_ids_json: string | null; position: number }

function suiteOutLite(db: Database.Database, r: SuiteRow): Record<string, unknown> {
  const members = (db.prepare('SELECT * FROM suite_members WHERE suite_id = ? ORDER BY position').all(r.id) as MemberRow[]).map((m) => {
    const t = db.prepare('SELECT id, name, app_bundle_id FROM templates WHERE id = ?').get(m.template_id) as { id: string; name: string; app_bundle_id: string | null } | undefined;
    return {
      templateId: m.template_id,
      name: t?.name ?? null,
      appBundleId: t?.app_bundle_id ?? null,
      variantIds: m.variant_ids_json ? (JSON.parse(m.variant_ids_json) as string[]) : null,
    };
  });
  return { id: r.id, name: r.name, description: r.description, appBundleId: r.app_bundle_id, members };
}

export function registerConfigTools(deps: ConfigToolDeps): void {
  const { db, registry } = deps;

  // ── reads (steps_001) ────────────────────────────────────────────────────

  registry.register({
    name: 'suites.list',
    description: 'list suites with their members (case ids + names). Structure only — no play verdicts.',
    permission: 'read',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const rows = db.prepare('SELECT * FROM suites ORDER BY updated_at DESC').all() as SuiteRow[];
      return JSON.stringify(rows.map((r) => suiteOutLite(db, r)));
    },
  });

  registry.register({
    name: 'suites.get',
    description: 'one suite by id or name, with members',
    permission: 'read',
    parameters: { type: 'object', properties: { idOrName: { type: 'string' } }, required: ['idOrName'] },
    async execute(args) {
      const key = String(args['idOrName'] ?? '');
      const row = (db.prepare('SELECT * FROM suites WHERE id = ?').get(key) ?? db.prepare('SELECT * FROM suites WHERE name = ?').get(key)) as SuiteRow | undefined;
      if (!row) return `error: no suite "${key}"`;
      return JSON.stringify(suiteOutLite(db, row));
    },
  });

  registry.register({
    name: 'scenarios.list',
    description: 'list network scenarios; folderId filters to DIRECT children of that folder (empty string = root)',
    permission: 'read',
    parameters: { type: 'object', properties: { folderId: { type: 'string' } } },
    async execute(args) {
      const fid = args['folderId'];
      const all = db.prepare('SELECT id, name, description, launch_arg, immutable_since, folder_id FROM scenarios ORDER BY rowid DESC').all() as Array<Record<string, unknown>>;
      let rows: Array<Record<string, unknown>>;
      if (typeof fid !== 'string') rows = all;
      else if (fid === '') rows = all.filter((r) => r['folder_id'] == null);
      else rows = all.filter((r) => r['folder_id'] === fid);
      return JSON.stringify(rows);
    },
  });

  registry.register({
    name: 'scenarios.get',
    description: 'one network scenario by id or name, with its preset members (join: preset_id, enabled, method, path_pattern, status)',
    permission: 'read',
    parameters: { type: 'object', properties: { idOrName: { type: 'string' } }, required: ['idOrName'] },
    async execute(args) {
      const key = String(args['idOrName'] ?? '');
      const row = (db.prepare('SELECT * FROM scenarios WHERE id = ?').get(key) ?? db.prepare('SELECT * FROM scenarios WHERE name = ?').get(key)) as Record<string, unknown> | undefined;
      if (!row) return `error: no scenario "${key}"`;
      const members = db.prepare(
        `SELECT so.preset_id, so.enabled, p.method, p.path_pattern, p.status
         FROM scenario_overrides so JOIN presets p ON p.id = so.preset_id
         WHERE so.scenario_id = ? ORDER BY p.created_at DESC`,
      ).all(row['id'] as string);
      return JSON.stringify({ scenario: row, members });
    },
  });

  registry.register({
    name: 'presets.list',
    description: 'list traffic presets; folderId filters to DIRECT children of that folder (empty string = root)',
    permission: 'read',
    parameters: { type: 'object', properties: { folderId: { type: 'string' } } },
    async execute(args) {
      const fid = args['folderId'];
      const all = db.prepare('SELECT id, name, method, path_pattern, match, status, folder_id, created_by, created_at FROM presets ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
      let rows: Array<Record<string, unknown>>;
      if (typeof fid !== 'string') rows = all;
      else if (fid === '') rows = all.filter((r) => r['folder_id'] == null);
      else rows = all.filter((r) => r['folder_id'] === fid);
      return JSON.stringify(rows);
    },
  });
}
