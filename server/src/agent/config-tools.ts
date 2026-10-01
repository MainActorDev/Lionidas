/** Config-author tools (breakdown steps_001..003): read + write over suites,
 *  network scenarios, traffic presets — route-faithful, in-process, verbatim
 *  errors. Reads OMIT play-verdict rollups (F3); scenario reads include the
 *  members join. Writes land in steps 2-3. */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
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




  // ── case lifecycle (steps_004; F5 name flow, invalid-yaml copy survival) ──

  registry.register({
    name: 'case.draft.revise',
    description: 'revise an ACTIVE or DEPRECATED case: saves a NEW draft copy with your yaml applied (the live case is never touched). If your yaml is invalid, a plain copy survives and its id is returned. Activation stays human.',
    permission: 'draft',
    parameters: { type: 'object', properties: { idOrName: { type: 'string' }, yaml: { type: 'string' } }, required: ['idOrName', 'yaml'] },
    async execute(args, ctx) {
      const key = String(args['idOrName'] ?? '');
      const yaml = String(args['yaml'] ?? '');
      const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(key) ?? db.prepare('SELECT * FROM templates WHERE name = ?').get(key);
      if (!row) return `error: no case "${key}"`;
      if ((row as { status: string }).status === 'draft') return 'INVALID: already a draft — use case.draft.edit';

      // duplicate-route semantics: fresh id, collision-loop name, FULL copy, status draft
      const now = Date.now();
      const newId = `tpl_${randomUUID().slice(0, 8)}`;
      const origName = (row as { name: string }).name;
      const tx = db.transaction(() => {
        let name = `${origName} (copy)`;
        let n = 2;
        while (db.prepare('SELECT 1 FROM templates WHERE name = ?').get(name)) {
          name = `${origName} (copy ${n})`; n += 1;
        }
        db.prepare(
          `INSERT INTO templates(id, name, steps_json, app_bundle_id, tags_json, setup_json, alerts_policy, variants_json, entry_json, udid, logical_w, logical_h, status, folder_id, created_by, created_at, updated_at)
           SELECT ?, ?, steps_json, app_bundle_id, tags_json, setup_json, alerts_policy, variants_json, entry_json, udid, logical_w, logical_h, 'draft', folder_id, 'agent', ?, ? FROM templates WHERE id = ?`,
        ).run(newId, name, now, now, (row as { id: string }).id);
        return name;
      });
      const copyName = tx() as string;

      // F5: yaml without `name` keeps the copy's name — inject it so the
      // validator doesn't reject an otherwise-fine revision for a missing key
      const yamlWithName = /^[ \t]*name[ \t]*:/m.test(yaml) ? yaml : `name: ${copyName}\n${yaml}`;
      // apply the user's yaml through the SAME edit path (registry round-trip:
      // one definition of edit semantics; the guard passes — the copy is a draft)
      const editOut = await deps.registry.execute('case.draft.edit', { idOrName: newId, yaml: yamlWithName }, ctx, { name: 'draft', allows: 'draft' });
      if (editOut.startsWith('INVALID:')) {
        return `${editOut} (a plain draft copy was saved as ${newId} — edit it and retry)`;
      }
      const applied = JSON.parse(editOut) as { name?: string };
      return JSON.stringify({ templateId: newId, name: applied['name'] ?? copyName, status: 'draft' });
    },
  });

  registry.register({
    name: 'case.deprecate',
    description: 'retire a case (status → deprecated). Only transition the agent may perform; activation is human-only. Idempotent.',
    permission: 'draft',
    parameters: { type: 'object', properties: { idOrName: { type: 'string' } }, required: ['idOrName'] },
    async execute(args) {
      const key = String(args['idOrName'] ?? '');
      const row = (db.prepare('SELECT id, status FROM templates WHERE id = ?').get(key) ?? db.prepare('SELECT id, status FROM templates WHERE name = ?').get(key)) as { id: string; status: string } | undefined;
      if (!row) return `error: no case "${key}"`;
      if (row.status === 'draft') return `INVALID: drafts aren't deprecated — they're simply never activated (delete is human)`;
      if (row.status === 'deprecated') return JSON.stringify({ templateId: row.id, status: 'deprecated', note: 'already deprecated' });
      db.prepare('UPDATE templates SET status = ?, updated_at = ? WHERE id = ?').run('deprecated', Date.now(), row.id);
      return JSON.stringify({ templateId: row.id, status: 'deprecated' });
    },
  });

  // ── scenario + preset writes (steps_003; F1 name guard, immutable-first, F2 sync)

  const IMMUTABLE_MSG = 'INVALID: scenario is immutable (referenced by runs) — use scenario.duplicate to make an editable copy, then edit that';
  const scenarioBy = (key: string): Record<string, unknown> | undefined =>
    (db.prepare('SELECT * FROM scenarios WHERE id = ?').get(key) ?? db.prepare('SELECT * FROM scenarios WHERE name = ?').get(key)) as Record<string, unknown> | undefined;

  registry.register({
    name: 'scenario.draft.save',
    description: 'create a network scenario bundling presets. Same-name create is refused (never silently merges). Errors verbatim.',
    permission: 'draft',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        launchArg: { type: 'string' },
        presetIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
    async execute(args) {
      const name = String(args['name'] ?? '').trim();
      if (!name) return 'INVALID: name required';
      // F1 guard: the route's deterministic id + INSERT OR IGNORE + unconditional
      // member REPLACE would silently mutate an existing scenario on name reuse.
      if (db.prepare('SELECT 1 FROM scenarios WHERE name = ?').get(name)) {
        return `INVALID: a scenario named "${name}" already exists`;
      }
      const presetIds = Array.isArray(args['presetIds']) ? (args['presetIds'] as unknown[]) : [];
      for (const pid of presetIds) {
        if (typeof pid !== 'string' || !db.prepare('SELECT 1 FROM presets WHERE id = ?').get(pid)) {
          return `INVALID: unknown preset ${String(pid)}`;
        }
      }
      const id = `s_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
      db.prepare('INSERT INTO scenarios(id, name, description, launch_arg, created_by, immutable_since) VALUES (?, ?, ?, ?, ?, NULL)')
        .run(id, name, args['description'] != null ? String(args['description']) : null, args['launchArg'] != null ? String(args['launchArg']) : null, 'agent');
      for (const pid of presetIds) {
        db.prepare('INSERT OR REPLACE INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES (?, ?, 1)').run(id, pid as string);
      }
      return JSON.stringify({ scenarioId: id, name, memberCount: presetIds.length });
    },
  });

  registry.register({
    name: 'scenario.draft.edit',
    description: 'edit a scenario (name/description/launchArg/folderId). Immutable scenarios are refused — duplicate first. Errors verbatim.',
    permission: 'draft',
    parameters: {
      type: 'object',
      properties: { idOrName: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, launchArg: { type: 'string' }, folderId: { type: 'string' } },
      required: ['idOrName'],
    },
    async execute(args) {
      const row = scenarioBy(String(args['idOrName'] ?? ''));
      if (!row) return `error: no scenario "${String(args['idOrName'] ?? '')}"`;
      if (row['immutable_since'] !== null && row['immutable_since'] !== undefined) return IMMUTABLE_MSG; // BEFORE name-409 (order pinned)
      const b = args as { name?: unknown; description?: unknown; launchArg?: unknown; folderId?: unknown };
      if (b.name !== undefined) {
        const nm = String(b.name).trim();
        if (!nm) return 'INVALID: name cannot be empty';
        if (db.prepare('SELECT id FROM scenarios WHERE name = ? AND id != ?').get(nm, row['id'] as string)) {
          return `INVALID: a scenario named "${nm}" already exists`;
        }
      }
      if (b.folderId !== undefined && b.folderId !== null && !db.prepare('SELECT id FROM scenario_folders WHERE id = ?').get(b.folderId as string)) {
        return `INVALID: folder "${String(b.folderId)}" not found`;
      }
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (b.name !== undefined) { sets.push('name = ?'); vals.push(String(b.name).trim()); }
      if (b.description !== undefined) { sets.push('description = ?'); vals.push(b.description); }
      if (b.launchArg !== undefined) { sets.push('launch_arg = ?'); vals.push(b.launchArg); }
      if (b.folderId !== undefined) { sets.push('folder_id = ?'); vals.push(b.folderId); }
      if (sets.length === 0) return 'INVALID: nothing to update';
      db.prepare(`UPDATE scenarios SET ${sets.join(', ')} WHERE id = ?`).run(...vals, row['id'] as string);
      return JSON.stringify({ scenarioId: row['id'], name: b.name !== undefined ? String(b.name).trim() : row['name'] });
    },
  });


  registry.register({
    name: 'scenario.duplicate',
    description: 'duplicate a scenario (new id, "(copy)" collision-loop name, same members, immutable_since NULL — editable). THE path forward when an immutable scenario needs changes.',
    permission: 'draft',
    parameters: { type: 'object', properties: { idOrName: { type: 'string' } }, required: ['idOrName'] },
    async execute(args) {
      const row = scenarioBy(String(args['idOrName'] ?? ''));
      if (!row) return `error: no scenario "${String(args['idOrName'] ?? '')}"`;
      const origName = String(row['name']);
      const tx = db.transaction(() => {
        let name = `${origName} (copy)`;
        let n = 2;
        while (db.prepare('SELECT 1 FROM scenarios WHERE name = ?').get(name)) {
          name = `${origName} (copy ${n})`; n += 1;
        }
        const id = `s_${randomUUID().slice(0, 8)}`;
        db.prepare('INSERT INTO scenarios(id, name, description, launch_arg, folder_id, created_by, immutable_since) VALUES (?, ?, ?, ?, ?, ?, NULL)')
          .run(id, name, row['description'] ?? null, row['launch_arg'] ?? null, row['folder_id'] ?? null, 'agent');
        for (const m of db.prepare('SELECT preset_id, enabled FROM scenario_overrides WHERE scenario_id = ?').all(row['id'] as string) as Array<{ preset_id: string; enabled: number }>) {
          db.prepare('INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES (?, ?, ?)').run(id, m.preset_id, m.enabled);
        }
        return { id, name };
      });
      const out = tx() as { id: string; name: string };
      return JSON.stringify({ scenarioId: out.id, name: out.name, note: 'editable copy — immutable_since cleared' });
    },
  });

  registry.register({
    name: 'scenario.members.set',
    description: 'replace a scenario member presets wholesale ({presetId, enabled?}). Immutable scenarios refused. Errors verbatim.',
    permission: 'draft',
    parameters: {
      type: 'object',
      properties: { idOrName: { type: 'string' }, members: { type: 'array', items: { type: 'object', properties: { presetId: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['presetId'] } } },
      required: ['idOrName', 'members'],
    },
    async execute(args) {
      const row = scenarioBy(String(args['idOrName'] ?? ''));
      if (!row) return `error: no scenario "${String(args['idOrName'] ?? '')}"`;
      if (row['immutable_since'] !== null && row['immutable_since'] !== undefined) return IMMUTABLE_MSG;
      const raw = args['members'];
      if (!Array.isArray(raw)) return 'INVALID: members array required';
      for (const m of raw as Array<Record<string, unknown>>) {
        if (typeof m?.['presetId'] !== 'string') return 'INVALID: each member needs presetId';
        if (!db.prepare('SELECT 1 FROM presets WHERE id = ?').get(m['presetId'])) return `INVALID: unknown preset ${String(m['presetId'])}`;
      }
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM scenario_overrides WHERE scenario_id = ?').run(row['id'] as string);
        const ins = db.prepare('INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES (?, ?, ?)');
        for (const m of raw as Array<Record<string, unknown>>) ins.run(row['id'] as string, m['presetId'] as string, m['enabled'] === false ? 0 : 1);
      });
      tx();
      return JSON.stringify({ scenarioId: row['id'], memberCount: raw.length });
    },
  });

  registry.register({
    name: 'preset.draft.save',
    description: 'create a traffic preset (stub rule: pathPattern+status required; method/match/headers/delayMs/seq/failure/throttleKbps optional). Ids are content-addressed: identical body → same id (no-op overwrite).',
    permission: 'draft',
    parameters: {
      type: 'object',
      properties: {
        pathPattern: { type: 'string' },
        status: { type: 'number' },
        method: { type: 'string' },
        match: { type: 'string', enum: ['exact', 'glob', 'regex'] },
        headers: { type: 'object' },
        delayMs: { type: 'number' },
        seq: { type: 'array', items: { type: 'object' } },
        failure: { type: 'string' },
        throttleKbps: { type: 'number' },
      },
      required: ['pathPattern', 'status'],
    },
    async execute(args) {
      if (typeof args['pathPattern'] !== 'string' || typeof args['status'] !== 'number') return 'INVALID: pathPattern and status required';
      const body = JSON.stringify(args);
      const id = `p_${createHash('sha256').update(body).digest('hex').slice(0, 8)}`;
      db.prepare(
        `INSERT OR REPLACE INTO presets(id, method, path_pattern, match, status, headers_json, body_path, delay_ms, seq_json, failure, throttle_kbps, guards_json, created_by, created_at, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        (args['method'] as string) ?? '*',
        args['pathPattern'] as string,
        (args['match'] as string) ?? 'exact',
        args['status'] as number,
        args['headers'] ? JSON.stringify(args['headers']) : null,
        null,
        (args['delayMs'] as number | null) ?? null,
        args['seq'] ? JSON.stringify(args['seq']) : null,
        (args['failure'] as string) ?? null,
        (args['throttleKbps'] as number | null) ?? null,
        null,
        'api',
        Date.now(),
        createHash('sha256').update(body).digest('hex'),
      );
      deps.syncPresets?.();
      return JSON.stringify({ presetId: id });
    },
  });


  registry.register({
    name: 'preset.body.write',
    description: 'write a preset response BODY (the stub text the app receives). Mirrors PUT /api/forge/presets/:id/body: text (<=256KB) required, atomic tmp+rename, optional contentType merged into headers, live proxy synced.',
    permission: 'draft',
    parameters: {
      type: 'object',
      properties: {
        presetId: { type: 'string' },
        text: { type: 'string', description: 'full response body text (JSON, XML, anything textual)' },
        contentType: { type: 'string', description: 'e.g. application/json — merged into headers (null/empty removes it)' },
      },
      required: ['presetId', 'text'],
    },
    async execute(args) {
      const id = String(args['presetId'] ?? '');
      const existing = db.prepare('SELECT id, headers_json FROM presets WHERE id = ?').get(id) as { id: string; headers_json: string | null } | undefined;
      if (!existing) return `error: no preset "${id}"`;
      if (typeof args['text'] !== 'string') return 'INVALID: text required';
      const buf = Buffer.from(args['text'], 'utf8');
      if (buf.length > 262_144) return `INVALID: body too large for the editor (${buf.length}B > 256KB) — edit the file at its body_path directly`;
      // bodies dir: SAME derivation the forge state service uses (B6: under the
      // DB path's root, overridable for tests) — no forgeState needed here.
      const { writeFileSync, mkdirSync, renameSync } = await import('node:fs');
      const { join, dirname, resolve } = await import('node:path');
      const bodiesDir = resolve(join(dirname(process.env['CRUCIBLE_DB_PATH'] ?? './crucible.db'), 'preset-bodies'));
      mkdirSync(bodiesDir, { recursive: true });
      const finalPath = join(bodiesDir, `${id}.body`);
      const tmpPath = `${finalPath}.${process.pid}.tmp`;
      writeFileSync(tmpPath, buf);
      renameSync(tmpPath, finalPath); // atomic — the addon never sees a torn body
      if (args['contentType'] !== undefined) {
        let headers: Record<string, string> = {};
        try { headers = existing.headers_json ? JSON.parse(existing.headers_json) as Record<string, string> : {}; } catch { /* malformed — rebuild */ }
        if (args['contentType'] === null || args['contentType'] === '') delete headers['content-type'];
        else headers['content-type'] = String(args['contentType']);
        db.prepare('UPDATE presets SET headers_json = ? WHERE id = ?').run(Object.keys(headers).length ? JSON.stringify(headers) : null, id);
      }
      db.prepare('UPDATE presets SET body_path = ? WHERE id = ?').run(finalPath, id);
      deps.syncPresets?.();
      return JSON.stringify({ presetId: id, bodyPath: finalPath, bytes: buf.length });
    },
  });

  registry.register({
    name: 'preset.draft.edit',
    description: 'partial-update a preset (same id — memberships keep pointing at it). Mirrors PATCH stamps; syncs the live proxy. Errors verbatim.',
    permission: 'draft',
    parameters: {
      type: 'object',
      properties: {
        presetId: { type: 'string' },
        name: { type: 'string' },
        method: { type: 'string' },
        pathPattern: { type: 'string' },
        match: { type: 'string', enum: ['exact', 'glob', 'regex'] },
        status: { type: 'number' },
        headers: { type: 'object' },
        delayMs: { type: 'number' },
        seq: { type: 'array', items: { type: 'object' } },
        failure: { type: 'string' },
        throttleKbps: { type: 'number' },
      },
      required: ['presetId'],
    },
    async execute(args) {
      const id = String(args['presetId'] ?? '');
      if (!db.prepare('SELECT 1 FROM presets WHERE id = ?').get(id)) return `error: no preset "${id}"`;
      const b = args as Record<string, unknown>;
      const sets: string[] = [];
      const vals: unknown[] = [];
      const col = (name: string, value: unknown): void => { sets.push(`${name} = ?`); vals.push(value); };
      if (b['method'] !== undefined) col('method', String(b['method']));
      if (b['name'] !== undefined) col('name', b['name'] === null ? null : String(b['name']).trim() || null);
      if (b['pathPattern'] !== undefined) col('path_pattern', String(b['pathPattern']));
      if (b['match'] !== undefined) col('match', String(b['match']));
      if (b['status'] !== undefined) col('status', Number(b['status']));
      if (b['headers'] !== undefined) {
        if (typeof b['headers'] !== 'object' || b['headers'] === null) return 'INVALID: headers must be an object';
        col('headers_json', JSON.stringify(b['headers']));
      }
      if (b['delayMs'] !== undefined) col('delay_ms', b['delayMs'] === null ? null : Math.max(0, Number(b['delayMs'])));
      if (b['throttleKbps'] !== undefined) col('throttle_kbps', b['throttleKbps'] === null ? null : Math.max(0, Number(b['throttleKbps'])));
      if (b['failure'] !== undefined) col('failure', b['failure'] === null ? null : String(b['failure']));
      if (b['seq'] !== undefined) {
        if (!Array.isArray(b['seq']) || b['seq'].length === 0) return 'INVALID: seq must be a non-empty array of {status, delayMs?, bodyPath?}';
        col('seq_json', JSON.stringify(b['seq']));
      }
      if (sets.length === 0) return 'INVALID: no updatable fields provided';
      col('created_by', 'editor');
      col('sha256', createHash('sha256').update(`${id}|${Date.now()}`).digest('hex'));
      db.prepare(`UPDATE presets SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
      deps.syncPresets?.();
      return JSON.stringify({ presetId: id });
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
