/** Managed env vars (plan rev 2, Stage 3): scoped key/value CRUD.
 *
 *  GET is open to any signed-in user (secrets masked — value never leaves);
 *  PUT/DELETE are operator-tier (review F3 — same gate as baseline approvals).
 *  The empty-secret sentinel is scoped (review F2): empty value on an EXISTING
 *  secret row = "leave unchanged" (note edits without re-typing); empty on
 *  create, or on a non-secret row, is a named 422. Clearing a secret = DELETE. */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireRole } from '../auth/roles.ts';
import { capabilitiesFor } from '../auth/capabilities.ts';
import type { Role } from '../auth/users.ts';

interface EnvVarRow {
  id: string;
  scope: 'global' | 'app' | 'plan';
  app_bundle_id: string | null;
  plan_id: string | null;
  key: string;
  value: string;
  secret: number;
  note: string | null;
  updated_by: string;
  updated_at: number;
}

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/** case scan: which ${env.KEY} refs exist across stored templates
 *  (steps + setup), with per-key reference counts. Powers the /env page's
 *  gaps strip (referenced but set nowhere) and in-use badges. Read-only,
 *  recomputed on demand — no stored usage state to drift. */
function scanEnvUsage(db: Database.Database): Record<string, number> {
  const usage: Record<string, number> = {};
  const rows = db.prepare('SELECT steps_json, setup_json FROM templates').all() as Array<{ steps_json: string | null; setup_json: string | null }>;
  for (const row of rows) {
    for (const col of [row.steps_json, row.setup_json]) {
      if (!col) continue;
      const keys = new Set<string>();
      for (const m of col.matchAll(/\$\{env\.([A-Z][A-Z0-9_]*)\}/g)) keys.add(m[1]!);
      for (const k of keys) usage[k] = (usage[k] ?? 0) + 1;
    }
  }
  return usage;
}

export function registerEnvVarRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/env-vars/usage', async () => ({ usage: scanEnvUsage(db) }));

  app.get('/api/env-vars', async (req) => {
    const rows = db.prepare('SELECT * FROM env_vars ORDER BY scope, app_bundle_id, plan_id, key').all() as EnvVarRow[];
    return {
      vars: rows.map((r) => ({
        id: r.id,
        scope: r.scope,
        appBundleId: r.app_bundle_id,
        planId: r.plan_id,
        key: r.key,
        // secrets NEVER leave the server: masked to null + status badge (D4).
        // RBAC viewer mask (plan 20261009T102032Z): values are sensitive —
        // viewers get the key list with masked values; everyone else full.
        value: r.secret || !capabilitiesFor((req.user?.role ?? 'viewer') as Role).readEnvValues ? null : r.value,
        masked: !capabilitiesFor((req.user?.role ?? 'viewer') as Role).readEnvValues,
        secret: r.secret === 1,
        status: 'set',
        note: r.note,
        updatedBy: r.updated_by,
        updatedAt: r.updated_at,
      })),
    };
  });

  /** upsert by natural key (scope, app?, plan?, key) — id in the path is the
   *  natural-key identity for PUT semantics; new rows may post to /api/env-vars */
  const upsert = async (req: { body: unknown; user?: { name: string } | null }, reply: { code: (c: number) => { send: (b: unknown) => unknown } }, existing: EnvVarRow | null): Promise<unknown> => {
    const b = (req.body ?? {}) as { scope?: string; appBundleId?: string | null; planId?: string | null; key?: string; value?: string; secret?: boolean; note?: string | null };
    const scope = b.scope ?? existing?.scope;
    if (scope !== 'global' && scope !== 'app' && scope !== 'plan') return reply.code(422).send({ error: 'scope must be global | app | plan' });
    const key = (b.key ?? existing?.key ?? '').trim();
    if (!KEY_RE.test(key)) return reply.code(422).send({ error: `key must match ${KEY_RE.source}` });
    const appBundleId = b.appBundleId !== undefined ? b.appBundleId : existing?.app_bundle_id ?? null;
    const planId = b.planId !== undefined ? b.planId : existing?.plan_id ?? null;
    // scope-column consistency (review F2/F3 plan edit): app ⇒ bundle set,
    // plan ⇒ plan set, global ⇒ both NULL
    if (scope === 'app' && !appBundleId) return reply.code(422).send({ error: 'app scope requires appBundleId' });
    if (scope === 'plan' && !planId) return reply.code(422).send({ error: 'plan scope requires planId' });
    if (scope === 'global' && (appBundleId || planId)) return reply.code(422).send({ error: 'global scope takes no appBundleId/planId' });
    if (scope === 'app' && planId) return reply.code(422).send({ error: 'app scope takes no planId' });
    if (scope === 'plan' && appBundleId) return reply.code(422).send({ error: 'plan scope takes no appBundleId' });
    if (appBundleId && db.prepare('SELECT 1 FROM app_catalog WHERE bundle_id = ?').get(appBundleId) == null && !existing) {
      // unknown bundle: warn-level accept (app_catalog may lag side-loads) but
      // require a plan row to exist for plan scope (FK enforces anyway)
    }
    if (planId && db.prepare('SELECT 1 FROM plans WHERE id = ?').get(planId) == null) return reply.code(422).send({ error: `unknown plan: ${planId}` });

    const secret = b.secret !== undefined ? (b.secret ? 1 : 0) : existing?.secret ?? 0;
    const note = b.note !== undefined ? b.note : existing?.note ?? null;
    let value: string;
    if (b.value === undefined || b.value === '') {
      // empty-value sentinel ONLY for an existing secret row (review F2)
      if (existing && existing.secret === 1 && secret === 1) value = existing.value;
      else return reply.code(422).send({ error: existing ? 'value required (empty keeps only an existing secret)' : 'value required' });
    } else {
      value = b.value;
    }

    const now = Date.now();
    const by = req.user?.name ?? 'qa';
    if (existing) {
      db.prepare('UPDATE env_vars SET scope = ?, app_bundle_id = ?, plan_id = ?, key = ?, value = ?, secret = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?')
        .run(scope, appBundleId, planId, key, value, secret, note, by, now, existing.id);
      return { id: existing.id, updated: true };
    }
    const id = `ev_${randomUUID().slice(0, 8)}`;
    try {
      db.prepare('INSERT INTO env_vars(id, scope, app_bundle_id, plan_id, key, value, secret, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, scope, appBundleId, planId, key, value, secret, note, by, now);
    } catch (e) {
      if (String(e).includes('idx_env_vars_key')) return reply.code(409).send({ error: `key "${key}" already exists in scope ${scope}` });
      throw e;
    }
    return { id, created: true };
  };

  app.post('/api/env-vars', { preHandler: requireRole('operator') }, async (req, reply) => upsert(req, reply, null));

  app.put('/api/env-vars/:id', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = db.prepare('SELECT * FROM env_vars WHERE id = ?').get(id) as EnvVarRow | undefined;
    if (!existing) return reply.code(404).send({ error: 'not found' });
    return upsert(req, reply, existing);
  });

  app.delete('/api/env-vars/:id', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = db.prepare('DELETE FROM env_vars WHERE id = ?').run(id);
    if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { deleted: id };
  });
}
