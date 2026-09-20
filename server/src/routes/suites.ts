/** Phase D T2 — suites: named ordered collections of case memberships.
 *  Live read, not a snapshot: members join templates at read time; verdicts
 *  are COMPUTED from runs (suiteVerdicts), never stored. Membership dies
 *  with its case (FK CASCADE); a deleted suite's runs survive with
 *  runs.suite_id SET NULL — the runs page renders `suite: <deleted>`
 *  honestly. */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { suiteVerdicts, type CaseVerdict } from '../db/suite.ts';

interface SuiteRow { id: string; name: string; description: string | null; app_bundle_id: string | null; created_by: string; created_at: number; updated_at: number }
interface MemberRow { suite_id: string; template_id: string; variant_ids_json: string | null; position: number }

/** template join for member rendering: name, app, variant vocabulary. A
 *  deleted case can't linger (FK cascade), so every id resolves — the
 *  `?? null` arm only fires on unexpected states. */
function tplMap(db: Database.Database, members: MemberRow[]): Map<string, { name: string; appBundleId: string | null; variantVocab: string[] }> {
  const tpl = new Map<string, { name: string; appBundleId: string | null; variantVocab: string[] }>();
  const stmt = db.prepare('SELECT id, name, app_bundle_id AS appBundleId, variants_json FROM templates WHERE id = ?');
  for (const m of members) {
    if (tpl.has(m.template_id)) continue;
    const r = stmt.get(m.template_id) as { name: string; appBundleId: string | null; variants_json: string | null } | undefined;
    tpl.set(m.template_id, r
      ? { name: r.name, appBundleId: r.appBundleId, variantVocab: r.variants_json ? (JSON.parse(r.variants_json) as Array<{ id: string }>).map((v) => v.id) : [] }
      : { name: m.template_id, appBundleId: null, variantVocab: [] });
  }
  return tpl;
}

const suiteOut = (r: SuiteRow, members: MemberRow[], verdicts: Map<string, CaseVerdict>, tpl: Map<string, { name: string; appBundleId: string | null; variantVocab: string[] }> = new Map()) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  appBundleId: r.app_bundle_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  members: members
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((m) => ({
      templateId: m.template_id,
      name: tpl.get(m.template_id)?.name ?? null,
      appBundleId: tpl.get(m.template_id)?.appBundleId ?? null,
      variantVocab: tpl.get(m.template_id)?.variantVocab ?? [],
      variantIds: m.variant_ids_json ? (JSON.parse(m.variant_ids_json) as string[]) : null,
      position: m.position,
      ...(verdicts.get(m.template_id) ?? {
        lastRunId: null, lastStatus: null, lastBlocked: 0, lastFinishedAt: null, lastAppVersion: null, trend: null, totalRuns: 0,
      }),
    })),
});

export function registerSuiteRoutes(app: FastifyInstance, db: Database.Database): void {
  // ── list: suites + inline member rollup (T6 rail). Verdicts precomputed
  //  from suiteVerdicts; no filters yet — the rail is short. ──
  app.get('/api/suites', async () => {
    const rows = db.prepare('SELECT * FROM suites ORDER BY updated_at DESC').all() as SuiteRow[];
    const verdicts = suiteVerdicts(db);
    const memberStmt = db.prepare('SELECT * FROM suite_members WHERE suite_id = ? ORDER BY position');
    return {
      suites: rows.map((r) => {
        const members = memberStmt.all(r.id) as MemberRow[];
        const s = suiteOut(r, members, verdicts);
        // members stay in — the parity table computes per-member glyphs,
        // verdict rollup and drift flags client-side from live reads.
        return { ...s, memberCount: s.members.length };
      }),
    };
  });

  // ── shared member validation: templateId must exist; pinned variantIds
  //  must belong to that case's variants_json vocabulary. Bundle scope:
  //  every member's app_bundle_id must equal the suite's — a suite is one
  //  app's pack, never a mixed bag (400 names the offender). ──
  const validateMembers = (raw: unknown, bundle: string | null): Array<{ templateId: string; variantIds: string[] | null }> | { error: string } => {
    if (!Array.isArray(raw)) return { error: 'members must be an array' };
    if (raw.length > 64) return { error: 'too many members (max 64)' };
    const variantsOf = db.prepare('SELECT variants_json, app_bundle_id AS appBundleId FROM templates WHERE id = ?');
    const out: Array<{ templateId: string; variantIds: string[] | null }> = [];
    for (const [i, m] of raw.entries()) {
      const tid = (m as { templateId?: unknown })?.templateId;
      if (typeof tid !== 'string' || !tid) return { error: `members[${i}].templateId required` };
      const trow = variantsOf.get(tid) as { variants_json: string | null; appBundleId: string | null } | undefined;
      if (!trow) return { error: `unknown template: ${tid}` };
      if (bundle !== null && trow.appBundleId !== bundle) return { error: `member ${tid} belongs to ${trow.appBundleId ?? 'no app'} — suite is ${bundle}` };
      const vocab = trow.variants_json ? (JSON.parse(trow.variants_json) as Array<{ id: string }>).map((v) => v.id) : [];
      const vids = (m as { variantIds?: unknown }).variantIds;
      if (vids != null) {
        if (!Array.isArray(vids) || vids.some((v) => typeof v !== 'string')) return { error: `members[${i}].variantIds must be string[]` };
        const unknown = (vids as string[]).filter((v) => !vocab.includes(v));
        if (unknown.length) return { error: `member ${tid}: unknown variants ${unknown.join(',')}` };
      }
      if (out.some((x) => x.templateId === tid)) return { error: `duplicate member ${tid}` };
      out.push({ templateId: tid, variantIds: vids != null ? (vids as string[]) : null });
    }
    return out;
  };

  // ── create: full validation before insert; single transaction — unknown
  //  members never half-insert. Duplicate name → 409. Bundle scope: the
  //  suite's app is REQUIRED and derived from its members — all members
  //  must share it (validateMembers enforces). An empty-members suite with
  //  no bundle is legal (draft), bundle immutable after create. ──
  app.post('/api/suites', async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; description?: string; members?: unknown; createdBy?: string; appBundleId?: unknown };
    const name = b.name?.trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    let bundle: string | null = null;
    if (b.appBundleId !== undefined) {
      if (typeof b.appBundleId !== 'string' || !b.appBundleId.trim()) return reply.code(400).send({ error: 'appBundleId must be a non-empty string' });
      bundle = b.appBundleId.trim();
    }
    // scope BEFORE validation: no explicit bundle → the first member's
    // bundle becomes the suite scope; every other member must match it.
    // (Deriving after validation would let mixed packs slip through.)
    if (bundle === null && Array.isArray(b.members) && b.members.length > 0) {
      const firstTid = (b.members[0] as { templateId?: unknown })?.templateId;
      if (typeof firstTid === 'string') {
        const first = db.prepare('SELECT app_bundle_id AS b FROM templates WHERE id = ?').get(firstTid) as { b: string | null } | undefined;
        bundle = first?.b ?? null;
      }
    }
    const members = validateMembers(b.members, bundle);
    if ('error' in members) return reply.code(400).send({ error: members.error });
    const id = `suite_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO suites(id, name, description, app_bundle_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, name, b.description?.trim() || null, bundle, b.createdBy ?? 'qa', now, now);
      const ins = db.prepare('INSERT INTO suite_members(suite_id, template_id, variant_ids_json, position) VALUES (?, ?, ?, ?)');
      members.forEach((m, i) => ins.run(id, m.templateId, m.variantIds ? JSON.stringify(m.variantIds) : null, i));
    });
    try { tx(); } catch { return reply.code(409).send({ error: 'suite name already exists' }); }
    return reply.code(201).send(suiteOut(db.prepare('SELECT * FROM suites WHERE id = ?').get(id) as SuiteRow, db.prepare('SELECT * FROM suite_members WHERE suite_id = ?').all(id) as MemberRow[], suiteVerdicts(db)));
  });

  // ── patch: name/description/members. members REPLACE wholesale
  //  (position = array order); empty array legal. ──
  app.patch('/api/suites/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; description?: string | null; members?: unknown; appBundleId?: string };
    const row = db.prepare('SELECT * FROM suites WHERE id = ?').get(id) as SuiteRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (b.name !== undefined && !b.name.trim()) return reply.code(400).send({ error: 'name cannot be empty' });
    if (b.appBundleId !== undefined && b.appBundleId !== row.app_bundle_id) return reply.code(400).send({ error: 'appBundleId is immutable — create a new suite to change app scope' });
    let members: Array<{ templateId: string; variantIds: string[] | null }> | null = null;
    if (b.members !== undefined) {
      const v = validateMembers(b.members, row.app_bundle_id);
      if ('error' in v) return reply.code(400).send({ error: v.error });
      members = v;
    }
    const tx = db.transaction(() => {
      db.prepare('UPDATE suites SET name = ?, description = ?, updated_at = ? WHERE id = ?')
        .run(b.name !== undefined ? b.name.trim() : row.name, b.description !== undefined ? (b.description?.trim() || null) : row.description, Date.now(), id);
      if (members !== null) {
        db.prepare('DELETE FROM suite_members WHERE suite_id = ?').run(id);
        const ins = db.prepare('INSERT INTO suite_members(suite_id, template_id, variant_ids_json, position) VALUES (?, ?, ?, ?)');
        members.forEach((m, i) => ins.run(id, m.templateId, m.variantIds ? JSON.stringify(m.variantIds) : null, i));
      }
    });
    try { tx(); } catch { return reply.code(409).send({ error: 'suite name already exists' }); }
    const rows = db.prepare('SELECT * FROM suite_members WHERE suite_id = ?').all(id) as MemberRow[];
    return suiteOut(db.prepare('SELECT * FROM suites WHERE id = ?').get(id) as SuiteRow, rows, suiteVerdicts(db), tplMap(db, rows));
  });

  app.delete('/api/suites/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = db.prepare('DELETE FROM suites WHERE id = ?').run(id);
    if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.get('/api/suites/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM suites WHERE id = ?').get(id) as SuiteRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const members = db.prepare('SELECT * FROM suite_members WHERE suite_id = ?').all(id) as MemberRow[];
    const tpl = tplMap(db, members);
    return suiteOut(row, members, suiteVerdicts(db), tpl);
  });
}
