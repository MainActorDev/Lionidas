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

interface SuiteRow { id: string; name: string; description: string | null; created_by: string; created_at: number; updated_at: number }
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
        return { ...s, memberCount: s.members.length, members: undefined };
      }),
    };
  });

  // ── shared member validation: templateId must exist; pinned variantIds
  //  must belong to that case's variants_json vocabulary. Returns a
  //  normalized list or an error string — callers 400 on error. ──
  const validateMembers = (raw: unknown): Array<{ templateId: string; variantIds: string[] | null }> | { error: string } => {
    if (!Array.isArray(raw)) return { error: 'members must be an array' };
    if (raw.length > 64) return { error: 'too many members (max 64)' };
    const variantsOf = db.prepare('SELECT variants_json FROM templates WHERE id = ?');
    const out: Array<{ templateId: string; variantIds: string[] | null }> = [];
    for (const [i, m] of raw.entries()) {
      const tid = (m as { templateId?: unknown })?.templateId;
      if (typeof tid !== 'string' || !tid) return { error: `members[${i}].templateId required` };
      const trow = variantsOf.get(tid) as { variants_json: string | null } | undefined;
      if (!trow) return { error: `unknown template: ${tid}` };
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
  //  members never half-insert. Duplicate name → 409. ──
  app.post('/api/suites', async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; description?: string; members?: unknown; createdBy?: string };
    const name = b.name?.trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    const members = validateMembers(b.members);
    if ('error' in members) return reply.code(400).send({ error: members.error });
    const id = `suite_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO suites(id, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, name, b.description?.trim() || null, b.createdBy ?? 'qa', now, now);
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
    const b = (req.body ?? {}) as { name?: string; description?: string | null; members?: unknown };
    const row = db.prepare('SELECT * FROM suites WHERE id = ?').get(id) as SuiteRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (b.name !== undefined && !b.name.trim()) return reply.code(400).send({ error: 'name cannot be empty' });
    let members: Array<{ templateId: string; variantIds: string[] | null }> | null = null;
    if (b.members !== undefined) {
      const v = validateMembers(b.members);
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
