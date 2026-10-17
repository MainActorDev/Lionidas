import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { validateAppState, type AppState, type StateProvenance } from '@crucible/shared/app-states';
import { requireRole } from '../auth/roles.ts';

/** Phase A S2 — app states registry API (plan 20261017T112229Z).
 *  GET    /api/apps/:bundle/states   → { states } — probe/recipe/verify parsed
 *  POST   /api/apps/:bundle/states   → create (state_id unique per bundle)
 *  PUT    /api/states/:id            → edit (revision++ + history append;
 *                                      optional revision echo → 409 REGISTRY_STALE)
 *  DELETE /api/states/:id            → remove (history purged with it)
 *
 *  Attribution law: created_by/updated_by stamp from req.user; body-supplied
 *  identity ignored. Provenance is stamped by ROUTE CONTEXT ('user' here —
 *  an import route stamps 'import'; an AI-assisted write lands as 'ai+user'
 *  when that seat exists), never model-asserted from the body.
 *
 *  No busy guard by design: this is a data-table write (same class as the
 *  screens registry and env fields), not a device mutation. Runs pin the
 *  revision they execute (step audit {stateId, revision}); device-scoped
 *  serialization is the S4 actuator guard's job. */
export function registerAppStateRoutes(app: FastifyInstance, db: Database.Database): void {
  const rowToState = (r: { id: string; state_id: string; label: string; probe_json: string; recipe_json: string; verify_json: string; provenance: string; revision: number }): AppState & { provenance: StateProvenance; revision: number } => ({
    id: r.id,
    stateId: r.state_id,
    label: r.label,
    probe: JSON.parse(r.probe_json) as AppState['probe'],
    recipe: JSON.parse(r.recipe_json) as AppState['recipe'],
    verify: JSON.parse(r.verify_json) as AppState['verify'],
    provenance: r.provenance as StateProvenance,
    revision: r.revision,
  });

  const snapshot = (id: string, stateId: string, label: string, probe: unknown, recipe: unknown, verify: unknown): string =>
    JSON.stringify({ id, stateId, label, probe, recipe, verify });

  const appendHistory = db.prepare(
    'INSERT INTO app_states_history(id, app_state_id, revision, snapshot_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );

  const crossCheckScreens = (bundle: string, probe: unknown, verify: unknown): string[] => {
    // registry cross-check: probe/verify `screen:` refs must exist in app_screens
    const screens = new Set(
      (db.prepare('SELECT screen_id FROM app_screens WHERE app_bundle_id = ?').all(bundle) as Array<{ screen_id: string }>).map((r) => r.screen_id),
    );
    const errors: string[] = [];
    for (const [where, sel] of [['probe', probe], ['verify', verify]] as const) {
      const scr = (sel as { screen?: string } | null)?.screen; // probe may be null (forced reset)
      if (typeof scr === 'string' && scr.trim() && !screens.has(scr)) {
        errors.push(`${where}.screen "${scr}" is not registered for ${bundle} — register the screen first (screens page)`);
      }
    }
    return errors;
  };

  app.get('/api/apps/:bundle/states', async (req) => {
    const { bundle } = req.params as { bundle: string };
    const rows = db.prepare('SELECT id, state_id, label, probe_json, recipe_json, verify_json, provenance, revision FROM app_states WHERE app_bundle_id = ? ORDER BY state_id').all(bundle) as Array<{ id: string; state_id: string; label: string; probe_json: string; recipe_json: string; verify_json: string; provenance: string; revision: number }>;
    return { states: rows.map(rowToState) };
  });

  app.post('/api/apps/:bundle/states', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { bundle } = req.params as { bundle: string };
    const body = req.body as Record<string, unknown>;
    // attribution law: identity/provenance arrive from route context — strip
    // body-supplied copies BEFORE validation so they are ignored, not 422'd
    const clean = { ...body } as Record<string, unknown>;
    delete clean['provenance']; delete clean['createdBy']; delete clean['revision']; delete clean['id'];
    const errors = [...validateAppState(clean), ...crossCheckScreens(bundle, clean['probe'], clean['verify'])];
    if (errors.length > 0) return reply.code(422).send({ error: errors[0], errors });
    const state = clean as unknown as AppState;
    const id = `st_${randomBytes(6).toString('hex')}`;
    const now = Date.now();
    const user = (req.user?.name ?? req.user?.id ?? 'unknown') as string;
    try {
      db.prepare('INSERT INTO app_states(id, app_bundle_id, state_id, label, probe_json, recipe_json, verify_json, provenance, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)')
        .run(id, bundle, state.stateId, state.label, JSON.stringify(state.probe), JSON.stringify(state.recipe), JSON.stringify(state.verify), 'user', user, now, now);
    } catch (e) {
      if (String(e).includes('UNIQUE constraint failed: app_states.app_bundle_id, app_states.state_id')) {
        return reply.code(409).send({ error: `state "${state.stateId}" already exists for ${bundle} — state ids are unique per app` });
      }
      throw e;
    }
    appendHistory.run(`sth_${randomBytes(6).toString('hex')}`, id, 1, snapshot(id, state.stateId, state.label, state.probe, state.recipe, state.verify), user, now);
    return reply.code(201).send({ state: { id, ...state, provenance: 'user' as const, revision: 1 } });
  });

  app.put('/api/states/:id', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const row = db.prepare('SELECT * FROM app_states WHERE id = ?').get(id) as
      | { id: string; app_bundle_id: string; state_id: string; label: string; probe_json: string; recipe_json: string; verify_json: string; provenance: string; revision: number; created_by: string; created_at: number; updated_at: number }
      | undefined;
    if (!row) return reply.code(404).send({ error: `no state with id ${id}` });

    // optimistic concurrency (screens-registry F3 pattern): a revision echo
    // that mismatches 409s with the current row; revisionless PUTs keep
    // last-write-wins so scripts/yaml imports never break
    if (typeof body?.revision === 'number' && body.revision !== row.revision) {
      return reply.code(409).send({ error: 'REGISTRY_STALE: this state changed since you loaded it — re-fetch and re-apply', state: rowToState(row) });
    }

    // merge semantics: absent keys keep their stored value (label-only edits
    // must not require re-sending the whole recipe)
    const next = {
      stateId: typeof body?.stateId === 'string' ? body.stateId : row.state_id,
      label: typeof body?.label === 'string' ? body.label : row.label,
      probe: body?.probe ?? JSON.parse(row.probe_json),
      recipe: body?.recipe ?? JSON.parse(row.recipe_json),
      verify: body?.verify ?? JSON.parse(row.verify_json),
    };
    const errors = [...validateAppState(next), ...crossCheckScreens(row.app_bundle_id, next.probe, next.verify)];
    if (errors.length > 0) return reply.code(422).send({ error: errors[0], errors });
    const now = Date.now();
    const user = (req.user?.name ?? req.user?.id ?? 'unknown') as string;
    const nextRev = row.revision + 1;
    try {
      db.prepare('UPDATE app_states SET state_id = ?, label = ?, probe_json = ?, recipe_json = ?, verify_json = ?, revision = ?, updated_at = ? WHERE id = ?')
        .run(next.stateId, next.label, JSON.stringify(next.probe), JSON.stringify(next.recipe), JSON.stringify(next.verify), nextRev, now, id);
    } catch (e) {
      if (String(e).includes('UNIQUE constraint failed: app_states.app_bundle_id, app_states.state_id')) {
        return reply.code(409).send({ error: `state "${next.stateId}" already exists for ${row.app_bundle_id} — state ids are unique per app` });
      }
      throw e;
    }
    appendHistory.run(`sth_${randomBytes(6).toString('hex')}`, id, nextRev, snapshot(id, next.stateId, next.label, next.probe, next.recipe, next.verify), user, now);
    return { state: { id, ...next, provenance: row.provenance as StateProvenance, revision: nextRev } };
  });

  app.delete('/api/states/:id', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // history purged explicitly — FK enforcement is a connection pragma, not
    // a schema guarantee (raw test DBs run without it)
    const tx = db.transaction((stateId: string) => {
      db.prepare('DELETE FROM app_states_history WHERE app_state_id = ?').run(stateId);
      const r = db.prepare('DELETE FROM app_states WHERE id = ?').run(stateId);
      return r.changes;
    });
    const changes = tx(id);
    if (changes === 0) return reply.code(404).send({ error: `no state with id ${id}` });
    return { deleted: id };
  });
}
