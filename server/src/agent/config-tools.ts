/** Config-author tools (breakdown steps_001..003): read + write over suites,
 *  network scenarios, traffic presets — route-faithful, in-process, verbatim
 *  errors. Reads OMIT play-verdict rollups (F3); scenario reads include the
 *  members join. Writes land in steps 2-3. */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { flowHistory, flakeScore } from '../domain/flake.ts';
import type { ToolRegistry, SqliteStorage } from '@mainactordev/butler';

export interface ConfigToolDeps {
  db: Database.Database;
  registry: ToolRegistry;
  /** F2: preset writes must push to the live forge proxy — wired in index.ts */
  syncPresets?: () => void;
  /** apply-bridge (plan 20261015T121500Z R3): verify-outcome durability notes */
  storage?: SqliteStorage;
}

interface SuiteRow { id: string; name: string; description: string | null; app_bundle_id: string | null; created_by: string; created_at: number; updated_at: number }
interface MemberRow { suite_id: string; template_id: string; variant_ids_json: string | null; position: number }

function safeParse(json: string): unknown {
  try { return JSON.parse(json); } catch { return null; }
}

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
  const { db, registry, storage } = deps;

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


  // ── failure-knowledge tools (tool-surface steps_001; F1 evidence modes, F2 columns) ──

  registry.register({
    name: 'evidence.get',
    description: 'evidence for a run failure: by evidenceId, or by runId+stepIdx (all evidence attached to that step). Descriptor + absolute path; inline:true returns base64 for screenshots <=1MB.',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: { evidenceId: { type: 'string' }, runId: { type: 'string' }, stepIdx: { type: 'number' }, inline: { type: 'boolean' } },
    },
    async execute(args) {
      const inline = args['inline'] === true;
      const { existsSync, readFileSync } = await import('node:fs');
      const desc = (row: { id: string; bundle_id: string; type: string; path: string; sha256: string; bytes: number; created_at: number }): Record<string, unknown> => {
        const out: Record<string, unknown> = { ...row };
        if (!existsSync(row.path)) {
          out['error'] = `evidence file missing at ${row.path}`;
          return out;
        }
        if (inline) {
          if (row.type === 'screenshot' && row.bytes <= 1_048_576) out['base64'] = readFileSync(row.path).toString('base64');
          else out['note'] = 'inline skipped (type/size)';
        }
        return out;
      };
      const EV_COLS = 'id, bundle_id, type, path, sha256, bytes, created_at';
      if (typeof args['evidenceId'] === 'string') {
        const row = db.prepare(`SELECT ${EV_COLS} FROM evidence WHERE id = ?`).get(args['evidenceId']) as Record<string, string | number> | undefined;
        if (!row) return `error: no evidence "${String(args['evidenceId'])}"`;
        if (!existsSync(String(row['path']))) return `error: evidence file missing at ${String(row['path'])}`;
        return JSON.stringify(desc(row as never));
      }
      if (typeof args['runId'] === 'string' && typeof args['stepIdx'] === 'number') {
        const step = db.prepare('SELECT evidence_ids_json FROM run_steps WHERE run_id = ? AND idx = ?').get(args['runId'], args['stepIdx']) as { evidence_ids_json: string } | undefined;
        if (!step) return `error: step not found`;
        const ids = JSON.parse(step.evidence_ids_json) as string[];
        if (ids.length === 0) return JSON.stringify([]);
        const ph = ids.map(() => '?').join(',');
        const rows = db.prepare(`SELECT ${EV_COLS} FROM evidence WHERE id IN (${ph})`).all(...ids) as Array<Record<string, string | number>>;
        return JSON.stringify(rows.map((r) => desc(r as never)));
      }
      return 'error: evidenceId or runId+stepIdx required';
    },
  });

  registry.register({
    name: 'run.triage.get',
    description: 'triage view of one run step: status, reason, wait/work timing split, and attached evidence rows. Mirrors GET /api/runs/:id/steps/:idx/triage.',
    permission: 'read',
    parameters: { type: 'object', properties: { runId: { type: 'string' }, stepIdx: { type: 'number' } }, required: ['runId', 'stepIdx'] },
    async execute(args) {
      const runId = String(args['runId'] ?? '');
      const idx = Number(args['stepIdx']);
      const step = db.prepare('SELECT idx, flow_name, kind, name, status, reason, evidence_ids_json, evaluated_json, duration_ms FROM run_steps WHERE run_id = ? AND idx = ?').get(runId, idx) as
        | { idx: number; flow_name: string; kind: string; name: string; status: string; reason: string | null; evidence_ids_json: string; evaluated_json: string | null; duration_ms: number }
        | undefined;
      if (!step) return 'error: step not found';
      const timing = (() => { try { const j = JSON.parse(step.evaluated_json ?? '{}') as { waitMs?: number; workMs?: number }; return { waitMs: j.waitMs ?? null, workMs: j.workMs ?? null }; } catch { return { waitMs: null, workMs: null }; } })();
      const evIds = JSON.parse(step.evidence_ids_json) as string[];
      const evidence = evIds.length
        ? (db.prepare(`SELECT id, type, path, sha256, bytes FROM evidence WHERE id IN (${evIds.map(() => '?').join(',')})`).all(...evIds) as Array<Record<string, unknown>>)
        : [];
      const out: Record<string, unknown> = { idx: step.idx, flow: step.flow_name, kind: step.kind, name: step.name, status: step.status, reason: step.reason, timing, durationMs: step.duration_ms, evidence };
      if (step.status !== 'fail') out['note'] = 'no failure';
      return JSON.stringify(out);
    },
  });

  registry.register({
    name: 'case.versions',
    description: 'revision history of a case (full route columns incl. yaml_canonical and scenario pin per revision), newest first.',
    permission: 'read',
    parameters: { type: 'object', properties: { idOrName: { type: 'string' } }, required: ['idOrName'] },
    async execute(args) {
      const key = String(args['idOrName'] ?? '');
      const tpl = (db.prepare('SELECT id FROM templates WHERE id = ?').get(key) ?? db.prepare('SELECT id FROM templates WHERE name = ?').get(key)) as { id: string } | undefined;
      if (!tpl) return `error: no case "${key}"`;
      const rows = db.prepare(
        'SELECT id, revision, steps_sha256, yaml_canonical, scenario_id, scenario_snapshot_json, source, created_by, created_at FROM case_versions WHERE template_id = ? ORDER BY revision DESC',
      ).all(tpl.id);
      return JSON.stringify(rows);
    },
  });

  registry.register({
    name: 'flakes.list',
    description: 'flaky-flow ledger: per flow — recent statuses, flake score, active quarantine (reason/by). Mirrors GET /api/flakes.',
    permission: 'read',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const flows = db.prepare('SELECT DISTINCT flow_name FROM run_steps ORDER BY flow_name').all() as Array<{ flow_name: string }>;
      const out = flows.map(({ flow_name }) => {
        const hist = flowHistory(deps.db, flow_name);
        const q = deps.db.prepare('SELECT reason, by, at FROM flow_quarantine WHERE flow_key = ? AND released_at IS NULL').get(flow_name) as { reason: string; by: string; at: number } | undefined;
        return {
          flow: flow_name,
          score: Math.round(flakeScore(hist) * 100) / 100,
          recent: hist.slice(0, 10).map((h) => h.status),
          ...(q ? { quarantine: q } : {}),
        };
      });
      return JSON.stringify(out);
    },
  });


  // ── organization tools (tool-surface steps_002; F4: mirror the right route per kind) ──

  const FOLDER_TABLES = { cases: 'folders', scenarios: 'scenario_folders', presets: 'preset_folders' } as const;
  type FolderKind = keyof typeof FOLDER_TABLES;
  const folderTable = (kind: string): { table: string } | string => {
    if (kind !== 'cases' && kind !== 'scenarios' && kind !== 'presets') return `error: unknown kind "${kind}" — cases | scenarios | presets`;
    return { table: FOLDER_TABLES[kind as FolderKind] };
  };

  registry.register({
    name: 'folder.create',
    description: 'create a folder. kind=cases: app-scoped (appBundleId + name required, parent must share the app, depth cap). kind=scenarios|presets: GLOBAL tree (name only). Errors verbatim.',
    permission: 'draft',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['cases', 'scenarios', 'presets'] }, name: { type: 'string' }, appBundleId: { type: 'string' }, parentId: { type: 'string' } },
      required: ['kind', 'name'],
    },
    async execute(args) {
      const kind = String(args['kind'] ?? '');
      const t = folderTable(kind);
      if (typeof t === 'string') return t;
      const name = String(args['name'] ?? '').trim();
      const now = Date.now();
      let parent: string | null = null;
      if (kind === 'cases') {
        const app = typeof args['appBundleId'] === 'string' ? args['appBundleId'] : '';
        if (!app || !name) return 'INVALID: appBundleId and name required';
        if (args['parentId']) {
          const p = db.prepare('SELECT id, app_bundle_id FROM folders WHERE id = ?').get(args['parentId'] as string) as { id: string; app_bundle_id: string } | undefined;
          if (!p) return `INVALID: parent folder "${String(args['parentId'])}" not found`;
          if (p.app_bundle_id !== app) return `INVALID: parent folder belongs to ${p.app_bundle_id} — folders are app-scoped`;
        }
        parent = (args['parentId'] as string | undefined) ?? null;
        const id = `fld_${randomUUID().slice(0, 8)}`;
        try {
          db.prepare('INSERT INTO folders(id, app_bundle_id, parent_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, app, parent, name, 'agent', now, now);
        } catch {
          return `INVALID: a folder named "${name}" already exists here`;
        }
        return JSON.stringify({ id, appBundleId: app, parentId: parent, name });
      }
      // global kinds (factory semantics: sibling-unique via UNIQUE index, depth cap 8)
      if (!name) return 'INVALID: name required';
      if (args['parentId']) {
        const p = db.prepare(`SELECT id FROM ${t.table} WHERE id = ?`).get(args['parentId'] as string) as { id: string } | undefined;
        if (!p) return `INVALID: parent folder "${String(args['parentId'])}" not found`;
      }
      parent = (args['parentId'] as string | undefined) ?? null;
      const prefix = kind === 'scenarios' ? 'sfld_' : 'pfld_';
      const id = `${prefix}${randomUUID().slice(0, 8)}`;
      try {
        db.prepare(`INSERT INTO ${t.table}(id, parent_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, parent, name, 'agent', now, now);
      } catch {
        return `INVALID: a folder named "${name}" already exists here`;
      }
      return JSON.stringify({ id, parentId: parent, name });
    },
  });

  registry.register({
    name: 'folder.rename',
    description: 'rename a folder (any kind). Errors verbatim.',
    permission: 'draft',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['cases', 'scenarios', 'presets'] }, id: { type: 'string' }, name: { type: 'string' } }, required: ['kind', 'id', 'name'] },
    async execute(args) {
      const kind = String(args['kind'] ?? '');
      const t = folderTable(kind);
      if (typeof t === 'string') return t;
      const id = String(args['id'] ?? '');
      const name = String(args['name'] ?? '').trim();
      if (!name) return 'INVALID: name required';
      const row = db.prepare(`SELECT id FROM ${t.table} WHERE id = ?`).get(id) as { id: string } | undefined;
      if (!row) return `error: no folder "${id}"`;
      try {
        db.prepare(`UPDATE ${t.table} SET name = ?, updated_at = ? WHERE id = ?`).run(name, Date.now(), id);
      } catch {
        return `INVALID: a folder named "${name}" already exists here`;
      }
      return JSON.stringify({ id, name });
    },
  });

  registry.register({
    name: 'case.move',
    description: 'move CASES into a folder (or to root with folderId:null). Folder must share the cases app. Mirrors POST /api/folders/move; errors verbatim, nothing partially moved.',
    permission: 'draft',
    parameters: { type: 'object', properties: { templateIds: { type: 'array', items: { type: 'string' } }, folderId: { type: 'string' } }, required: ['templateIds'] },
    async execute(args) {
      const ids = Array.isArray(args['templateIds']) ? (args['templateIds'] as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
      if (ids.length === 0) return 'INVALID: templateIds required';
      let folder: { id: string; app_bundle_id: string } | null = null;
      if (typeof args['folderId'] === 'string' && args['folderId']) {
        folder = db.prepare('SELECT id, app_bundle_id FROM folders WHERE id = ?').get(args['folderId']) as { id: string; app_bundle_id: string } | undefined ?? null;
        if (!folder) return `INVALID: folder "${String(args['folderId'])}" not found`;
      }
      const tx = db.transaction(() => {
        for (const tid of ids) {
          const tpl = db.prepare('SELECT id, app_bundle_id FROM templates WHERE id = ?').get(tid) as { id: string; app_bundle_id: string | null } | undefined;
          if (!tpl) throw new Error(`unknown template: ${tid}`);
          if (folder && tpl.app_bundle_id !== folder.app_bundle_id) throw new Error(`case ${tid} belongs to ${tpl.app_bundle_id ?? '(no app)'} — folders are app-scoped`);
          db.prepare('UPDATE templates SET folder_id = ?, updated_at = ? WHERE id = ?').run(folder ? folder.id : null, Date.now(), tid);
        }
      });
      try { tx(); } catch (e) {
        return `INVALID: ${e instanceof Error ? e.message : String(e)}`;
      }
      return JSON.stringify({ moved: ids.length, folderId: folder ? folder.id : null });
    },
  });

  registry.register({
    name: 'case.duplicate',
    description: 'duplicate a case: full copy, fresh id, "(copy)" collision-loop name, status draft. Original untouched.',
    permission: 'draft',
    parameters: { type: 'object', properties: { idOrName: { type: 'string' } }, required: ['idOrName'] },
    async execute(args) {
      const key = String(args['idOrName'] ?? '');
      const row = (db.prepare('SELECT * FROM templates WHERE id = ?').get(key) ?? db.prepare('SELECT * FROM templates WHERE name = ?').get(key)) as Record<string, unknown> | undefined;
      if (!row) return `error: no case "${key}"`;
      const now = Date.now();
      const newId = `tpl_${randomUUID().slice(0, 8)}`;
      const origName = String(row['name']);
      const tx = db.transaction(() => {
        let name = `${origName} (copy)`;
        let n = 2;
        while (db.prepare('SELECT 1 FROM templates WHERE name = ?').get(name)) {
          name = `${origName} (copy ${n})`; n += 1;
        }
        db.prepare(
          `INSERT INTO templates(id, name, description, ticket_key, udid, logical_w, logical_h, steps_json, app_bundle_id, app_name, app_version, tags_json, setup_json, alerts_policy, variants_json, entry_json, default_preset_id, status, folder_id, created_by, created_at, updated_at)
           SELECT ?, ?, description, ticket_key, udid, logical_w, logical_h, steps_json, app_bundle_id, app_name, app_version, tags_json, setup_json, alerts_policy, variants_json, entry_json, default_preset_id, 'draft', folder_id, 'agent', ?, ? FROM templates WHERE id = ?`,
        ).run(newId, name, now, now, row['id'] as string);
        return name;
      });
      const name = tx() as string;
      return JSON.stringify({ templateId: newId, name, status: 'draft' });
    },
  });

  registry.register({
    name: 'cases.search',
    description: 'search cases by tag substring, exact app bundle, or exact status (draft|active|deprecated). Returns id/name/status/app.',
    permission: 'read',
    parameters: { type: 'object', properties: { tags: { type: 'string' }, app: { type: 'string' }, status: { type: 'string', enum: ['draft', 'active', 'deprecated'] } } },
    async execute(args) {
      const rows = db.prepare('SELECT id, name, status, app_bundle_id, tags_json FROM templates ORDER BY name LIMIT 200').all() as Array<{ id: string; name: string; status: string | null; app_bundle_id: string | null; tags_json: string | null }>;
      let out = rows;
      if (typeof args['app'] === 'string') out = out.filter((r) => r.app_bundle_id === args['app']);
      if (typeof args['status'] === 'string') out = out.filter((r) => (r.status ?? 'active') === args['status']);
      if (typeof args['tags'] === 'string') out = out.filter((r) => (r.tags_json ?? '').includes(args['tags'] as string));
      return JSON.stringify(out.map(({ id, name, status, app_bundle_id }) => ({ id, name, status, app_bundle_id })));
    },
  });

  registry.register({
    name: 'case.validate',
    description: 'DRY-RUN validation of case yaml (parser + refs + registry gates) — saves NOTHING. Returns {ok:true} or INVALID with verbatim errors. Use before case.draft.save for non-trivial drafts.',
    permission: 'draft',
    parameters: { type: 'object', properties: { yaml: { type: 'string' } }, required: ['yaml'] },
    async execute(args) {
      const yaml = String(args['yaml'] ?? '');
      const { parseCaseYaml } = await import('@crucible/shared/case-yaml');
      const { resolveCaseRefs } = await import('../routes/templates.ts');
      const hasLoginRecipe = (bundle: string | null | undefined): boolean => !bundle ? false : !!db.prepare('SELECT 1 FROM app_login WHERE bundle_id = ?').get(bundle);
      const hasLogoutRecipe = (bundle: string | null | undefined): boolean => !bundle ? false : !!db.prepare('SELECT 1 FROM app_logout WHERE bundle_id = ?').get(bundle);
      const r = parseCaseYaml(yaml, {
        hasLogoutRecipe: (bundle) => (bundle === null || bundle === undefined ? true : hasLogoutRecipe(bundle)),
        hasLoginRecipe: (bundle) => (bundle === null || bundle === undefined ? true : hasLoginRecipe(bundle)),
      });
      if (!r.ok || !r.case) {
        const errs = (r.errors ?? []).map((e) => (typeof e === 'string' ? e : `line ${e.line}: ${e.message}`)).join('; ');
        return `INVALID: ${errs}`;
      }
      const c = r.case as { name: string; app?: string | null };
      const refErr = resolveCaseRefs(db, c as never, c.app ?? null);
      if (refErr) return `INVALID: ${refErr}`;
      return JSON.stringify({ ok: true });
    },
  });


  // ── unlocked gates (tool-surface steps_003; F3: Option A full-list + revision echo) ──

  registry.register({
    name: 'screens.draft.save',
    description: 'write an app screen registry: requires the FULL screen list and the CURRENT revision echo (fetch screens.registry first). Refuses to DROP existing screens; stale revisions get the current one back for retry. Login recipes are app-level and never touched.',
    permission: 'draft',
    parameters: {
      type: 'object',
      properties: {
        appBundle: { type: 'string' },
        revision: { type: 'number', description: 'the CURRENT registry revision you fetched (REGISTRY_STALE refusal returns the live one)' },
        screens: { type: 'array', items: { type: 'object' }, description: 'FULL list: [{id, entry:{navigate:[steps]}, states:{name:{all:[sel]}}}]' },
      },
      required: ['appBundle', 'screens'],
    },
    async execute(args) {
      const bundle = String(args['appBundle'] ?? '');
      if (!bundle) return 'INVALID: appBundle required';
      if (typeof args['revision'] !== 'number') return 'INVALID: revision is required (echo the current registry revision — fetch with screens.registry)';
      const screens = args['screens'];
      const { validateRegistry } = await import('@crucible/shared/app-screens');
      const errors = validateRegistry(screens);
      if (errors.length > 0) return `INVALID: ${errors.join('; ')}`;
      // Option A full-list rule: never silently DROP screens
      const currentIds = new Set((db.prepare('SELECT screen_id FROM app_screens WHERE app_bundle_id = ?').all(bundle) as Array<{ screen_id: string }>).map((r) => r.screen_id));
      const submittedIds = new Set((screens as Array<{ id: string }>).map((s) => s.id));
      const dropped = [...currentIds].filter((id) => !submittedIds.has(id));
      if (dropped.length > 0) return `INVALID: refused — this write would DROP screens: ${dropped.join(', ')}. Submit the FULL list (fetch with screens.registry, edit, resubmit).`;
      // stale check (F3): COALESCE(MAX(revision),1)
      const cur = (db.prepare('SELECT COALESCE(MAX(revision), 1) AS r FROM app_screens WHERE app_bundle_id = ?').get(bundle) as { r: number }).r;
      if (args['revision'] !== cur) {
        return `INVALID: registry changed while you were editing (REGISTRY_STALE) — current revision is ${cur}; fetch screens.registry and resubmit`;
      }
      // replaceRegistry mirror: delete-then-insert at cur+1, one transaction
      const now = Date.now();
      const next = cur + 1;
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM app_screens WHERE app_bundle_id = ?').run(bundle);
        const ins = db.prepare('INSERT INTO app_screens(app_bundle_id, screen_id, entry_json, refresh_json, states_json, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const s of screens as Array<{ id: string; entry: unknown; refresh?: unknown; states: unknown }>) {
          ins.run(bundle, s.id, JSON.stringify(s.entry ?? { navigate: [] }), s.refresh ? JSON.stringify(s.refresh) : null, JSON.stringify(s.states ?? {}), now, next);
        }
      });
      tx();
      return JSON.stringify({ appBundle: bundle, revision: next, count: (screens as unknown[]).length });
    },
  });

  // ── build-config apply bridge (plan 20261015T121500Z B1) ──
  registry.register({
    name: 'build_config.propose',
    description: 'Park a build-config proposal for THIS session (the /build-config-propose hard-stop flow). Returns the rendered table to show the user. The parked row stays pending until the USER confirms in a later message — the state flip is structural (turn seam), not yours.',
    permission: 'draft',
    parameters: { type: 'object', properties: {
      projectId: { type: 'string', description: 'the project id (repo.projects)' },
      transport: { type: 'string', enum: ['repo-lane', 'generic'] },
      scheme: { type: 'string' },
      configuration: { type: 'string' },
      prepare: { type: 'array', items: { type: 'object', properties: { run: { type: 'string' } }, required: ['run'] } },
      evidence: { type: 'array', items: { type: 'string' }, description: 'file:line citations per claim' },
    }, required: ['projectId', 'transport'] },
    async execute(args, ctx) {
      const { parkProposal } = await import('./build-config-flow.ts');
      const projectId = String(args['projectId'] ?? '');
      const proj = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as { id: string; name: string } | undefined;
      if (!proj) return JSON.stringify({ error: `unknown projectId ${projectId}` });
      const proposal = {
        transport: (args['transport'] === 'repo-lane' ? 'repo-lane' : 'generic') as 'repo-lane' | 'generic',
        scheme: args['scheme'] != null ? String(args['scheme']) : null,
        configuration: args['configuration'] != null ? String(args['configuration']) : null,
        prepare: Array.isArray(args['prepare']) ? (args['prepare'] as Array<{ run?: unknown }>).filter((x) => x && typeof x['run'] === 'string').map((x) => ({ run: String(x['run']) })) : [],
        evidence: Array.isArray(args['evidence']) ? (args['evidence'] as unknown[]).map(String) : [],
      };
      parkProposal(db, ctx.sessionId, projectId, proposal);
      const prep = proposal.prepare.map((x) => x.run).join(' → ') || '(no prepare steps)';
      return JSON.stringify({
        parked: true, projectId, project: proj.name,
        render: `| transport | scheme | configuration | prepare |\n|---|---|---|---|\n| ${proposal.transport} | ${proposal.scheme ?? '—'} | ${proposal.configuration ?? '—'} | ${prep} |`,
        next: 'Render the table with your evidence, then HARD STOP: "Confirm applying this build config? The host writes it (provenance ai+user) and verify-build runs."',
      });
    },
  });

  registry.register({
    name: 'build_config.apply',
    description: 'Write the CONFIRMED build-config revision and fire verify-build. Succeeds ONLY when the user has already confirmed (the proposal row is in state applied — the flip happened in the turn seam, before you saw the turn). Calling this on a pending/unconfirmed proposal is refused.',
    permission: 'draft',
    parameters: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
    async execute(args, ctx) {
      const { getParked } = await import('./build-config-flow.ts');
      const projectId = String(args['projectId'] ?? '');
      // session-id bridge: the row may live under the MCP child's placeholder id;
      // the FLIP was driven by the user's chat message — match by project + state
      let parked = getParked(db, ctx.sessionId, projectId);
      if (!parked) {
        const anyRow = db.prepare(`SELECT * FROM build_config_proposals WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`).get(projectId) as
          { session_id: string; project_id: string; proposal_json: string; created_at: number; state: 'pending' | 'applied' | 'declined' } | undefined;
        if (anyRow) {
          const { getParked: getRow } = await import('./build-config-flow.ts');
          parked = getRow(db, anyRow.session_id, projectId);
        }
      }
      if (!parked) return JSON.stringify({ error: 'NO_PROPOSAL', detail: `no parked proposal for this project — call build_config.propose first` });
      if (parked.state !== 'applied') {
        return JSON.stringify({ error: 'NOT_CONFIRMED', detail: `the proposal is ${parked.state} — the USER must confirm in a message before this write. Do not retry; render the proposal and stop.` });
      }
      const { writeBuildConfigRevision } = await import('../projects/build-configs.ts');
      const row = writeBuildConfigRevision(db, {
        projectId,
        transport: parked.proposal.transport,
        scheme: parked.proposal.scheme,
        configuration: parked.proposal.configuration,
        prepare: parked.proposal.prepare,
        provenance: { by: 'ai+user', at: Date.now(), source: 'chat confirmation via apply bridge (plan 20261015T121500Z)', evidence: parked.proposal.evidence },
      });
      // verify: fire-and-forget — the verdict stamps the revision minutes later;
      // a best-effort durable note carries the outcome to later turns (review R3)
      const { startBuildVerify } = await import('../projects/builds.ts');
      const v = startBuildVerify(db, projectId);
      void (async () => {
        try {
          const deadline = Date.now() + 15 * 60_000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 15_000));
            const fresh = getParked(db, ctx.sessionId, projectId); // parked still exists; read the revision verdict instead
            void fresh;
            const rev = db.prepare('SELECT verify_state, verify_log FROM build_configs WHERE id = ?').get(row.id) as { verify_state: string | null; verify_log: string | null } | undefined;
            if (rev && rev.verify_state && rev.verify_state !== 'unverified') {
              try {
                await storage?.insertNote({
                  scope_key: `project:${projectId}`, kind: 'env-gate',
                  content: `build-config verify ${rev.verify_state} (rev ${row.revision}, ${parked.proposal.scheme ?? parked.proposal.transport}) — ${(rev.verify_log ?? '').slice(0, 400)}`,
                  source_type: 'session', source_ref: ctx.sessionId, created_by: 'apply-bridge',
                });
              } catch { /* note best-effort */ }
              break;
            }
          }
        } catch { /* poll best-effort */ }
      })();
      return JSON.stringify({ applied: true, revision: row.revision, recipeId: row.id, verify: v.ok ? 'started' : v.error });
    },
  });

  // ── env_config.provision (autonomy plan 20261015T164500Z A1, review R1) ──
  registry.register({
    name: 'env_config.provision',
    description: 'Copy gitignored *.xcconfig env-config files that already exist on this machine into a project\'s workspace clone (cp semantics — contents are NEVER returned, only sha256+bytes). Exact filenames only; credential-looking names refused. Missing files report ENV_CONFIG_NOT_FOUND with the searched dirs — that is the human bootstrap.',
    permission: 'draft',
    parameters: { type: 'object', properties: {
      projectId: { type: 'string' },
      files: { type: 'array', items: { type: 'string' }, description: 'exact *.xcconfig filenames, e.g. DevelopmentConfig.xcconfig' },
      force: { type: 'boolean', description: 'overwrite an existing different-sha file (default false → conflict reported)' },
    }, required: ['projectId', 'files'] },
    async execute(args) {
      const { provisionEnvConfigs } = await import('../projects/env-provision.ts');
      const projectId = String(args['projectId'] ?? '');
      const proj = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as { id: string; name: string } | undefined;
      if (!proj) return JSON.stringify({ error: `unknown projectId ${projectId}` });
      const { projectWorkspace } = await import('../manual/packages.ts');
      const ws = projectWorkspace(proj.name);
      const files = Array.isArray(args['files']) ? (args['files'] as unknown[]).map(String) : [];
      if (!files.length) return JSON.stringify({ error: 'files required' });
      const out = provisionEnvConfigs(db, projectId, proj.name, ws, files, { force: args['force'] === true });
      if (out.refused.length || out.conflicts.length || out.missing.length) {
        return JSON.stringify({ ...out, hint: out.missing.length ? `ENV_CONFIG_NOT_FOUND — searched: ${out.missing.join(', ')} not in any registered source dir. A human must place them (bootstrap).` : undefined });
      }
      return JSON.stringify(out);
    },
  });

  // ── build_config.write — AUTONOMOUS path (plan 20261015T164500Z A2) ──
  registry.register({
    name: 'build_config.write',
    description: 'Autonomously write a build-config revision and fire verify (simulator-slice autonomy). Budgets are ENGINE-enforced: max 3 revisions/hour/project, verify 3/hour/project, identical-error circuit breaker. Provenance is ai-auto — never laundered as user-confirmed.',
    permission: 'draft',
    parameters: { type: 'object', properties: {
      projectId: { type: 'string' },
      transport: { type: 'string', enum: ['repo-lane', 'generic'] },
      scheme: { type: 'string' },
      configuration: { type: 'string' },
      prepare: { type: 'array', items: { type: 'object', properties: { run: { type: 'string' } }, required: ['run'] } },
      evidence: { type: 'array', items: { type: 'string' } },
    }, required: ['projectId', 'transport'] },
    async execute(args) {
      const projectId = String(args['projectId'] ?? '');
      const proj = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id: string } | undefined;
      if (!proj) return JSON.stringify({ error: `unknown projectId ${projectId}` });
      // revision budget (R2)
      const hourAgo = Date.now() - 60 * 60_000;
      const revs = (db.prepare('SELECT COUNT(*) AS n FROM build_configs WHERE project_id = ? AND created_at > ?').get(projectId, hourAgo) as { n: number }).n;
      if (revs >= 3) return JSON.stringify({ error: 'REVISION_BUDGET_EXHAUSTED', detail: `${revs} revisions in the last hour (cap 3) — END THE TURN; report state and what was tried.` });
      // R3: refuse device destinations on untoggled projects — never mutate silently
      const allowDevice = Boolean((db.prepare('SELECT allow_device_signing FROM projects WHERE id = ?').get(projectId) as { allow_device_signing?: number } | undefined)?.allow_device_signing);
      const prepare = Array.isArray(args['prepare']) ? (args['prepare'] as Array<{ run?: unknown }>).filter((x) => x && typeof x['run'] === 'string').map((x) => ({ run: String(x['run']) })) : [];
      for (const step of prepare) {
        if (/iphoneos|generic\/platform=iOS(?! Simulator)/.test(step.run) && !allowDevice) {
          return JSON.stringify({ error: 'DEVICE_SIGNING_BLOCKED', detail: `'${step.run.slice(0, 60)}' names a DEVICE destination but projects.allow_device_signing is off — an honest refusal beats a silently modified build. Propose a simulator destination or ask the human to enable the toggle.` });
        }
      }
      const { writeBuildConfigRevision } = await import('../projects/build-configs.ts');
      const row = writeBuildConfigRevision(db, {
        projectId,
        transport: (args['transport'] === 'repo-lane' ? 'repo-lane' : 'generic') as 'repo-lane' | 'generic',
        scheme: args['scheme'] != null ? String(args['scheme']) : null,
        configuration: args['configuration'] != null ? String(args['configuration']) : null,
        prepare,
        provenance: { by: 'ai-auto', at: Date.now(), source: 'autonomous build-config loop (plan 20261015T164500Z)', evidence: Array.isArray(args['evidence']) ? (args['evidence'] as unknown[]).map(String) : [] },
      });
      const { startBuildVerify } = await import('../projects/builds.ts');
      const v = startBuildVerify(db, projectId);
      return JSON.stringify({ written: true, revision: row.revision, recipeId: row.id, provenance: 'ai-auto', verify: v.ok ? 'started' : `${v.code}: ${v.error}` });
    },
  });

  registry.register({
    name: 'recipes.get',
    description: 'read an app login/logout recipes (app-level, revisioned). Route shape: {login: <recipe|null>, revision}; absent → null, not an error.',
    permission: 'read',
    parameters: { type: 'object', properties: { appBundle: { type: 'string' }, kind: { type: 'string', enum: ['login', 'logout'] } }, required: ['appBundle'] },
    async execute(args) {
      const bundle = String(args['appBundle'] ?? '');
      const kind = args['kind'] === 'login' || args['kind'] === 'logout' ? args['kind'] : null;
      const out: Record<string, unknown> = {};
      if (kind !== 'logout') {
        const row = db.prepare('SELECT login_json, revision FROM app_login WHERE bundle_id = ?').get(bundle) as { login_json: string; revision: number } | undefined;
        out['login'] = row ? { login: safeParse(row.login_json), revision: row.revision } : { login: null, revision: 1 };
      }
      if (kind !== 'login') {
        const row = db.prepare('SELECT logout_json, revision FROM app_logout WHERE bundle_id = ?').get(bundle) as { logout_json: string; revision: number } | undefined;
        out['logout'] = row ? { logout: safeParse(row.logout_json), revision: row.revision } : { logout: null, revision: 1 };
      }
      return JSON.stringify(out);
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
