/** Audit surface (RBAC round, plan 20261009T102032Z T3): coverage writes on
 *  run play/abort, build trigger, case edits, manual take-control, device
 *  actions, and RBAC denials — all landing in the existing auth_log with a
 *  NAMED ACTOR. Read side: GET /api/audit (supervisor+), paged, filterable.
 *
 *  Denial flood control (review F4): at most one denial row per
 *  (actor, route) per minute — a looping client must not grow the log
 *  unboundedly. */
import type Database from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';

export type AuditEvent =
  | 'login' | 'login_failed' | 'logout' | 'session_killed' | 'approved' | 'unapproved'
  | 'role_changed' | 'active_changed' | 'password_changed' | 'bot_token_rotated'
  // RBAC coverage additions:
  | 'run_play' | 'run_abort' | 'build_trigger' | 'case_edit' | 'case_create' | 'case_delete'
  | 'manual_take_control' | 'manual_release' | 'device_action' | 'app_installed' | 'app_uninstalled' | 'rbac_denied'
  // agent chat lifecycle (P3 rev 5):
  | 'chat_renamed' | 'chat_deleted';

export function auditWrite(db: Database.Database, req: FastifyRequest | null, event: AuditEvent, detail: string, targetUserId?: string): void {
  const actor = req?.user;
  db.prepare('INSERT INTO auth_log(at, email, user_id, event, detail) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), actor?.email ?? null, targetUserId ?? actor?.id ?? null, event, `${detail}${actor ? ` by ${actor.name}` : ' by system'}`);
}

/** Denial audit with flood control: one row per (actor, route) per minute. */
const denialWindow = new Map<string, number>();
export function auditDenial(db: Database.Database, req: FastifyRequest, route: string, reason: string): void {
  const key = `${req.user?.id ?? 'anon'}|${route}`;
  const now = Date.now();
  const last = denialWindow.get(key) ?? 0;
  if (now - last < 60_000) return; // flood-controlled (review F4)
  denialWindow.set(key, now);
  auditWrite(db, req, 'rbac_denied', `denied ${route}: ${reason}`);
  // the window map is bounded by (users × routes) — small; no eviction needed
}

/** GET /api/audit handler — supervisor+ (gated at registration).
 *  Page-based (numbered) pagination; `q` = substring match across
 *  email/event/detail. NOTE: offset pagination on a live log can drift a
 *  row across page seams between fetches — accepted for an audit UI
 *  (rows are timestamped, not transactional).
 *  Facet (event-class) filtering is intentionally NOT here: the UI counts
 *  and filters classes client-side over the loaded window ("in view"). */
export function auditList(db: Database.Database, q: { actor?: string; event?: string; q?: string; page?: string; limit?: string }): { events: unknown[]; total: number; page: number; pageCount: number } {
  const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '50', 10) || 50, 1), 200);
  const page = Math.max(Number.parseInt(q.page ?? '1', 10) || 1, 1);
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.actor) { where.push('email LIKE ?'); params.push(`%${q.actor}%`); }
  if (q.event) { where.push('event = ?'); params.push(q.event); }
  if (q.q) { where.push('(email LIKE ? OR event LIKE ? OR detail LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM auth_log ${whereSql}`).get(...(params as unknown[])) as { n: number }).n;
  const pageCount = Math.ceil(total / limit);
  const rows = db.prepare(`SELECT id, at, email, user_id, event, detail FROM auth_log ${whereSql} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...(params as unknown[]), limit, (page - 1) * limit) as unknown[];
  return { events: rows, total, page, pageCount };
}
