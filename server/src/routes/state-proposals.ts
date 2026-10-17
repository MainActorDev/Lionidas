import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { validateAppState, type AppState } from '@crucible/shared/app-states';
import { requireRole } from '../auth/roles.ts';

/** Phase B S1 — state proposals: the AI write-proposal inbox (plan
 *  20261017T170500Z). The agent DRAFTS registry states from green-run
 *  evidence; a human accepts/rejects. The ACCEPT route is the only
 *  proposal→registry bridge and stamps provenance 'ai+user' with
 *  source_proposal — the registry row never exists without the human tap.
 *
 *  GET  /api/apps/:bundle/proposals      → { proposals } (open first)
 *  POST /api/states/proposals            → create — validates the draft against
 *                                          the SAME grammar as the registry;
 *                                          idempotent on (bundle, open state_id);
 *                                          registry collision 409s BEFORE storing
 *  POST /api/states/proposals/:id/accept → create registry entry (ai+user,
 *                                          rev 1, history) + mark decided
 *  POST /api/states/proposals/:id/reject → final decision
 *
 *  Authority honesty (plan self-review #2): these are session-auth routes in
 *  the same class as every registry write; the human gate lives at tool
 *  registration (no agent tool wraps accept/reject) + the panel being the
 *  blessed UI. No busy guard — data-table write class (phase A S2 decision). */

interface ProposalRow {
  id: string; app_bundle_id: string; state_id: string; label: string;
  probe_json: string; recipe_json: string; verify_json: string;
  rationale: string; source_run_id: string | null; status: string;
  created_by: string; created_at: number; decided_by: string | null; decided_at: number | null;
}

interface Proposal {
  id: string; bundle: string; stateId: string; label: string;
  probe: AppState['probe']; recipe: AppState['recipe']; verify: AppState['verify'];
  rationale: string; sourceRunId: string | null; status: 'open' | 'accepted' | 'rejected';
  createdBy: string; createdAt: number; decidedBy: string | null; decidedAt: number | null;
}

export function registerStateProposalRoutes(app: FastifyInstance, db: Database.Database): void {
  const byBundle = db.prepare(
    "SELECT * FROM state_proposals WHERE app_bundle_id = ? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT 100",
  );

  const rowToProposal = (r: ProposalRow): Proposal => ({
    id: r.id,
    bundle: r.app_bundle_id,
    stateId: r.state_id,
    label: r.label,
    probe: JSON.parse(r.probe_json) as AppState['probe'],
    recipe: JSON.parse(r.recipe_json) as AppState['recipe'],
    verify: JSON.parse(r.verify_json) as AppState['verify'],
    rationale: r.rationale,
    sourceRunId: r.source_run_id,
    status: r.status as Proposal['status'],
    createdBy: r.created_by,
    createdAt: r.created_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
  });

  const fetch = (id: string): ProposalRow | undefined =>
    db.prepare('SELECT * FROM state_proposals WHERE id = ?').get(id) as ProposalRow | undefined;

  app.get('/api/apps/:bundle/proposals', async (req) => {
    const { bundle } = req.params as { bundle: string };
    return { proposals: (byBundle.all(bundle) as ProposalRow[]).map(rowToProposal) };
  });

  app.post('/api/states/proposals', { preHandler: requireRole('operator') }, async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const bundle = typeof body?.bundle === 'string' ? body.bundle : '';
    if (!bundle.trim()) return reply.code(422).send({ error: 'bundle is required' });
    const rationale = typeof body?.rationale === 'string' ? body.rationale.trim() : '';
    if (!rationale) return reply.code(422).send({ error: 'rationale is required — a proposal cites its evidence (plan S2)' });
    const sourceRunId = typeof body?.sourceRunId === 'string' && body.sourceRunId.trim() ? body.sourceRunId : null;

    // same grammar as the registry — a draft that can't be accepted has no
    // business entering the inbox
    const clean = { ...body } as Record<string, unknown>;
    delete clean['provenance']; delete clean['createdBy']; delete clean['revision']; delete clean['id'];
    delete clean['bundle']; delete clean['rationale']; delete clean['sourceRunId'];
    const errors = validateAppState(clean);
    if (errors.length > 0) return reply.code(422).send({ error: errors[0], errors });
    const draft = clean as unknown as AppState;

    // registry collision 409s BEFORE storing (edge 1's create-time half)
    const regHit = db.prepare('SELECT id FROM app_states WHERE app_bundle_id = ? AND state_id = ?').get(bundle, draft.stateId) as { id: string } | undefined;
    if (regHit) return reply.code(409).send({ error: `state "${draft.stateId}" already exists in the registry for ${bundle} — proposals create NEW states only` });

    // idempotent on the OPEN (bundle, state_id) pair (edge 2)
    const open = db.prepare("SELECT * FROM state_proposals WHERE app_bundle_id = ? AND state_id = ? AND status = 'open'").get(bundle, draft.stateId) as ProposalRow | undefined;
    if (open) return reply.code(200).send({ proposal: rowToProposal(open), deduped: true });

    const id = `sp_${randomBytes(6).toString('hex')}`;
    const user = (req.user?.name ?? req.user?.id ?? 'unknown') as string;
    const now = Date.now();
    db.prepare(
      'INSERT INTO state_proposals(id, app_bundle_id, state_id, label, probe_json, recipe_json, verify_json, rationale, source_run_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, bundle, draft.stateId, draft.label, JSON.stringify(draft.probe), JSON.stringify(draft.recipe), JSON.stringify(draft.verify), rationale, sourceRunId, 'open', user, now);
    return reply.code(201).send({ proposal: rowToProposal(fetch(id)!), deduped: false });
  });

  app.post('/api/states/proposals/:id/accept', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = fetch(id);
    if (!row) return reply.code(404).send({ error: `no proposal with id ${id}` });
    if (row.status !== 'open') return reply.code(409).send({ error: `proposal ${id} is already ${row.status} — decisions are final (edge 5: re-propose instead)` });
    const user = (req.user?.name ?? req.user?.id ?? 'unknown') as string;
    const now = Date.now();
    const draft = rowToProposal(row);

    // re-validate: grammar may have drifted since creation (edge 4)
    const errors = validateAppState({ stateId: draft.stateId, label: draft.label, probe: draft.probe, recipe: draft.recipe, verify: draft.verify });
    if (errors.length > 0) return reply.code(422).send({ error: `proposal no longer validates: ${errors[0]}`, errors });
    // registry may have grown the state since the draft (edge 1's accept half)
    const regHit = db.prepare('SELECT id FROM app_states WHERE app_bundle_id = ? AND state_id = ?').get(draft.bundle, draft.stateId) as { id: string } | undefined;
    if (regHit) return reply.code(409).send({ error: `state "${draft.stateId}" entered the registry after this proposal was drafted — reject it and re-propose against the new entry`, registryId: regHit.id });

    const tx = db.transaction(() => {
      const stateId = `st_${randomBytes(6).toString('hex')}`;
      db.prepare(
        "INSERT INTO app_states(id, app_bundle_id, state_id, label, probe_json, recipe_json, verify_json, provenance, source_proposal, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ai+user', ?, 1, ?, ?, ?)",
      ).run(stateId, draft.bundle, draft.stateId, draft.label, JSON.stringify(draft.probe), JSON.stringify(draft.recipe), JSON.stringify(draft.verify), row.id, user, now, now);
      db.prepare(
        'INSERT INTO app_states_history(id, app_state_id, revision, snapshot_json, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?)',
      ).run(`sth_${randomBytes(6).toString('hex')}`, stateId, JSON.stringify({ id: stateId, stateId: draft.stateId, label: draft.label, probe: draft.probe, recipe: draft.recipe, verify: draft.verify, sourceProposal: row.id }), user, now);
      db.prepare("UPDATE state_proposals SET status = 'accepted', decided_by = ?, decided_at = ? WHERE id = ?").run(user, now, row.id);
      return stateId;
    });
    const stateId = tx();
    return { stateId, proposal: rowToProposal(fetch(row.id)!) };
  });

  app.post('/api/states/proposals/:id/reject', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = fetch(id);
    if (!row) return reply.code(404).send({ error: `no proposal with id ${id}` });
    if (row.status !== 'open') return reply.code(409).send({ error: `proposal ${id} is already ${row.status} — decisions are final` });
    const user = (req.user?.name ?? req.user?.id ?? 'unknown') as string;
    db.prepare("UPDATE state_proposals SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?").run(user, Date.now(), row.id);
    return { proposal: rowToProposal(fetch(row.id)!) };
  });
}
