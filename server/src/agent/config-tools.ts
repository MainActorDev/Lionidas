/** Config-author tools (breakdown steps_001..003): read + write over suites,
 *  network scenarios, traffic presets — route-faithful, in-process, verbatim
 *  errors. Reads OMIT play-verdict rollups (F3); scenario reads include the
 *  members join. Writes land in steps 2-3. */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
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


  // ── suite writes (steps_002; F4: mirror the route's tx-catch exactly) ────

  const validateMembers = (raw: unknown, bundle: string | null): Array<{ templateId: string; variantIds: string[] | null }> | string => {
    if (!Array.isArray(raw)) return 'members must be an array';
    if (raw.length > 64) return 'too many members (max 64)';
    const variantsOf = db.prepare('SELECT variants_json, app_bundle_id AS appBundleId FROM templates WHERE id = ?');
    const out: Array<{ templateId: string; variantIds: string[] | null }> = [];
    for (const [i, m] of raw.entries()) {
      const tid = (m as { templateId?: unknown })?.templateId;
      if (typeof tid !== 'string' || !tid) return `members[${i}].templateId required`;
      const trow = variantsOf.get(tid) as { variants_json: string | null; appBundleId: string | null } | undefined;
      if (!trow) return `unknown template: ${tid}`;
      if (bundle !== null && trow.appBundleId !== bundle) return `member ${tid} belongs to ${trow.appBundleId ?? 'no app'} — suite is ${bundle}`;
      const vocab = trow.variants_json ? (JSON.parse(trow.variants_json) as Array<{ id: string }>).map((v) => v.id) : [];
      const vids = (m as { variantIds?: unknown }).variantIds;
      if (vids != null) {
        if (!Array.isArray(vids) || vids.some((v) => typeof v !== 'string')) return `members[${i}].variantIds must be string[]`;
        const unknown = (vids as string[]).filter((v) => !vocab.includes(v));
        if (unknown.length) return `member ${tid}: unknown variants ${unknown.join(',')}`;
      }
      if (out.some((x) => x.templateId === tid)) return `duplicate member ${tid}`;
      out.push({ templateId: tid, variantIds: vids != null ? (vids as string[]) : null });
    }
    return out;
  };

  registry.register({
    name: 'suite.draft.save',
    description: 'create a suite (single-app pack of cases). Bundle scope: explicit appBundleId or the first member app; every member must match. Errors verbatim.',
    permission: 'draft',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        appBundleId: { type: 'string' },
        members: { type: 'array', items: { type: 'object', properties: { templateId: { type: 'string' }, variantIds: { type: 'array', items: { type: 'string' } } }, required: ['templateId'] } },
      },
      required: ['name'],
    },
    async execute(args) {
      const name = String(args['name'] ?? '').trim();
      if (!name) return 'INVALID: name required';
      let bundle: string | null = null;
      if (typeof args['appBundleId'] === 'string' && args['appBundleId'].trim()) {
        bundle = args['appBundleId'].trim();
      } else if (Array.isArray(args['members']) && args['members'].length > 0) {
        const firstTid = (args['members'][0] as { templateId?: unknown })?.templateId;
        if (typeof firstTid === 'string') {
          const first = db.prepare('SELECT app_bundle_id AS b FROM templates WHERE id = ?').get(firstTid) as { b: string | null } | undefined;
          bundle = first?.b ?? null;
        }
      }
      const members = validateMembers(args['members'], bundle);
      if (typeof members === 'string') return `INVALID: ${members}`;
      const id = `suite_${randomUUID().slice(0, 8)}`;
      const now = Date.now();
      const tx = db.transaction(() => {
        db.prepare('INSERT INTO suites(id, name, description, app_bundle_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, name, args['description'] ? String(args['description']).trim() : null, bundle, 'agent', now, now);
        const ins = db.prepare('INSERT INTO suite_members(suite_id, template_id, variant_ids_json, position) VALUES (?, ?, ?, ?)');
        members.forEach((m, i) => ins.run(id, m.templateId, m.variantIds ? JSON.stringify(m.variantIds) : null, i));
      });
      try { tx(); } catch { return 'INVALID: suite name already exists'; }
      return JSON.stringify({ suiteId: id, name, memberCount: members.length });
    },
  });

  registry.register({
    name: 'suite.draft.edit',
    description: 'edit an existing suite (name/description/members — members replace wholesale). appBundleId is immutable. Errors verbatim.',
    permission: 'draft',
    parameters: {
      type: 'object',
      properties: {
        idOrName: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        members: { type: 'array', items: { type: 'object', properties: { templateId: { type: 'string' }, variantIds: { type: 'array', items: { type: 'string' } } }, required: ['templateId'] } },
      },
      required: ['idOrName'],
    },
    async execute(args) {
      const key = String(args['idOrName'] ?? '');
      const row = (db.prepare('SELECT * FROM suites WHERE id = ?').get(key) ?? db.prepare('SELECT * FROM suites WHERE name = ?').get(key)) as SuiteRow | undefined;
      if (!row) return `error: no suite "${key}"`;
      const b = args as { name?: unknown; description?: unknown; members?: unknown; appBundleId?: unknown };
      if (b.name !== undefined && typeof b.name === 'string' && !b.name.trim()) return 'INVALID: name cannot be empty';
      if (b.appBundleId !== undefined && b.appBundleId !== row.app_bundle_id) return 'INVALID: appBundleId is immutable — create a new suite to change app scope';
      let members: Array<{ templateId: string; variantIds: string[] | null }> | null = null;
      if (b.members !== undefined) {
        const v = validateMembers(b.members, row.app_bundle_id);
        if (typeof v === 'string') return `INVALID: ${v}`;
        members = v;
      }
      const tx = db.transaction(() => {
        db.prepare('UPDATE suites SET name = ?, description = ?, updated_at = ? WHERE id = ?')
          .run(b.name !== undefined ? String(b.name).trim() : row.name, b.description !== undefined ? (String(b.description).trim() || null) : row.description, Date.now(), row.id);
        if (members !== null) {
          db.prepare('DELETE FROM suite_members WHERE suite_id = ?').run(row.id);
          const ins = db.prepare('INSERT INTO suite_members(suite_id, template_id, variant_ids_json, position) VALUES (?, ?, ?, ?)');
          members.forEach((m, i) => ins.run(row.id, m.templateId, m.variantIds ? JSON.stringify(m.variantIds) : null, i));
        }
      });
      try { tx(); } catch { return 'INVALID: suite name already exists'; }
      const count = (db.prepare('SELECT COUNT(*) n FROM suite_members WHERE suite_id = ?').get(row.id) as { n: number }).n;
      return JSON.stringify({ suiteId: row.id, name: b.name !== undefined ? String(b.name).trim() : row.name, memberCount: count });
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
