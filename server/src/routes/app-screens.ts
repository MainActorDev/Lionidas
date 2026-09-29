import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { validateRegistry, validateAppLogin, validateAppLogout, type AppScreen } from '@crucible/shared/app-screens';
import { requireRole } from '../auth/roles.ts';

/** R2 S3 — app screen registry API.
 *  GET    /api/apps/:bundle/screens        → { screens } (parsed JSON)
 *  PUT    /api/apps/:bundle/screens        → replace the app's registry
 *                                           (validates whole doc; 422 with errors)
 *  DELETE /api/apps/:bundle/screens/:id    → remove one screen
 *  GET    /api/apps/:bundle/screens.yaml   → YAML export (git-versionable)
 *  PUT    /api/apps/:bundle/screens.yaml   → YAML import (same validation)
 *  The registry is the app's map: cases reference screens by id; deleting a
 *  screen referenced by a case fails that case's NEXT save (S4 resolution),
 *  never historical runs (snapshots carry the selector sets). */
export function registerAppScreenRoutes(app: FastifyInstance, db: Database.Database): void {
  const rowsFor = (bundle: string) =>
    db.prepare('SELECT screen_id, entry_json, refresh_json, states_json, updated_at FROM app_screens WHERE app_bundle_id = ? ORDER BY screen_id').all(bundle) as
      Array<{ screen_id: string; entry_json: string; refresh_json: string | null; states_json: string; updated_at: number }>;

  const screensFor = (bundle: string): Array<import('@crucible/shared/app-screens').AppScreen> =>
    rowsFor(bundle).map((r) => {
      const screen: import('@crucible/shared/app-screens').AppScreen = {
        id: r.screen_id,
        entry: JSON.parse(r.entry_json) as AppScreen['entry'],
        states: JSON.parse(r.states_json) as AppScreen['states'],
      };
      if (r.refresh_json) screen.refresh = JSON.parse(r.refresh_json) as AppScreen['refresh'];
      // login recipe rides along (plan rev 2): the screens page + yaml export
      // surface it; null when the screen has none

      return screen;
    });

  const replaceRegistry = (bundle: string, screens: Array<import('@crucible/shared/app-screens').AppScreen>): number => {
    // F3: the registry revision persists ACROSS replaces — read before the
    // delete, write back as nextRevision on every inserted row (one registry
    // = one revision; per-row storage is the PK-friendly carrier)
    const prev = (db.prepare('SELECT COALESCE(MAX(revision), 1) AS r FROM app_screens WHERE app_bundle_id = ?').get(bundle) as { r: number }).r;
    const next = prev + 1;
    const tx = db.transaction((list: AppScreen[]) => {
      // login recipes are APP-level (app_login) since the login-as-procedure
      // plan — a registry replace never touches them (the per-screen column
      // is gone; settled 2026-09-29, plan 20260929T080249Z).
      db.prepare('DELETE FROM app_screens WHERE app_bundle_id = ?').run(bundle);
      const ins = db.prepare('INSERT INTO app_screens(app_bundle_id, screen_id, entry_json, refresh_json, states_json, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const s of list) {
        ins.run(bundle, s.id, JSON.stringify(s.entry), s.refresh ? JSON.stringify(s.refresh) : null, JSON.stringify(s.states), Date.now(), next);
      }
    });
    tx(screens);
    return next;
  };

  /** All-bundles listing (registry-UI stage 1, A2 screens page): every
   *  registry with its screens — the page groups by bundle client-side. */
  app.get('/api/apps/screens', async () => {
    const rows = db.prepare('SELECT app_bundle_id, screen_id, entry_json, refresh_json, states_json FROM app_screens ORDER BY app_bundle_id, screen_id').all() as
      Array<{ app_bundle_id: string; screen_id: string; entry_json: string; refresh_json: string | null; states_json: string }>;
    const byBundle = new Map<string, Array<import('@crucible/shared/app-screens').AppScreen>>();
    for (const r of rows) {
      const scr: import('@crucible/shared/app-screens').AppScreen = {
        id: r.screen_id,
        entry: JSON.parse(r.entry_json) as import('@crucible/shared/app-screens').AppScreen['entry'],
        states: JSON.parse(r.states_json) as import('@crucible/shared/app-screens').AppScreen['states'],
      };
      if (r.refresh_json) scr.refresh = JSON.parse(r.refresh_json) as import('@crucible/shared/app-screens').AppScreen['refresh'];

      const list = byBundle.get(r.app_bundle_id) ?? [];
      list.push(scr);
      byBundle.set(r.app_bundle_id, list);
    }
    return { registries: [...byBundle.entries()].map(([bundle, screens]) => ({ bundle, screens })) };
  });

  app.get('/api/apps/:bundle/screens', async (req) => {
    const { bundle } = req.params as { bundle: string };
    // registry revision (F3): bumped on every replace; the UI echoes it on
    // PUT and 409s on mismatch instead of silently clobbering a concurrent edit
    const rev = (db.prepare('SELECT COALESCE(MAX(revision), 1) AS r FROM app_screens WHERE app_bundle_id = ?').get(bundle) as { r: number }).r;
    return { screens: screensFor(bundle), revision: rev };
  });

  app.put('/api/apps/:bundle/screens', async (req, reply) => {
    const { bundle } = req.params as { bundle: string };
    const b = req.body as { screens?: unknown; revision?: number };
    const errors = validateRegistry(b?.screens);
    if (errors.length > 0) return reply.code(422).send({ errors });
    // F3 revision guard: when the client echoes a revision, a mismatch means
    // someone else replaced the registry since they loaded it — 409 with the
    // CURRENT state so the editor can re-fetch and re-apply. Revisionless
    // PUTs (scripts, yaml imports) keep the old last-write behavior.
    if (typeof b?.revision === 'number') {
      const cur = (db.prepare('SELECT COALESCE(MAX(revision), 1) AS r FROM app_screens WHERE app_bundle_id = ?').get(bundle) as { r: number }).r;
      if (cur !== b.revision) {
        return reply.code(409).send({ error: 'registry changed while you were editing', code: 'REGISTRY_STALE', revision: cur, screens: screensFor(bundle) });
      }
    }
    const rev = replaceRegistry(bundle, b!.screens as AppScreen[]);
    return { ok: true, count: (b!.screens as AppScreen[]).length, revision: rev };
  });

  app.delete('/api/apps/:bundle/screens/:id', async (req, reply) => {
    const { bundle, id } = req.params as { bundle: string; id: string };
    const r = db.prepare('DELETE FROM app_screens WHERE app_bundle_id = ? AND screen_id = ?').run(bundle, id);
    if (r.changes === 0) return reply.code(404).send({ error: `no screen "${id}" for this app` });
    return { ok: true };
  });

  // YAML round-trip: minimal, stable key order — hand-editable in git.
  const toYaml = (screens: Array<import('@crucible/shared/app-screens').AppScreen>): string => {
    const lines: string[] = [];
    for (const s of screens) {
      lines.push(`- id: ${s.id}`);
      const entry = s.entry;
      if (entry.tab) {
        const t = entry.tab;
        const parts = [t.identifier ? `identifier: ${JSON.stringify(t.identifier)}` : '', t.label ? `label: ${JSON.stringify(t.label)}` : '', t.labelContains ? `labelContains: ${JSON.stringify(t.labelContains)}` : '', t.point ? `point: [${t.point[0]}, ${t.point[1]}]` : ''].filter(Boolean);
        lines.push(`  entry:`);
        lines.push(`    tab:`);
        for (const p of parts) lines.push(`      ${p}`);
      } else if (entry.deepLink) {
        lines.push(`  entry:`);
        lines.push(`    deepLink: ${JSON.stringify(entry.deepLink)}`);
      } else if (entry.navigate) {
        lines.push(`  entry:`);
        lines.push(`    navigate:`);
        for (const st of entry.navigate) {
          const rec = st as Record<string, unknown>;
          if (typeof rec['on'] === 'string') lines.push(`      - on: ${JSON.stringify(rec['on'])}`);
          else lines.push(`      - { x: ${rec['x']}, y: ${rec['y']} }`);
        }
      }
      if (s.refresh) {
        lines.push(`  refresh:`);
        lines.push(`    gesture: ${s.refresh.gesture}`);
        if (s.refresh.selector) {
          const t = s.refresh.selector;
          if (t.identifier) lines.push(`    selector: { identifier: ${JSON.stringify(t.identifier)} }`);
          else if (t.label) lines.push(`    selector: { label: ${JSON.stringify(t.label)} }`);
          else if (t.labelContains) lines.push(`    selector: { labelContains: ${JSON.stringify(t.labelContains)} }`);
        }
        if (s.refresh.deepLink) lines.push(`    deepLink: ${JSON.stringify(s.refresh.deepLink)}`);
      }
      lines.push(`  states:`);
      for (const [name, def] of Object.entries(s.states)) {
        lines.push(`    ${name}:`);
        const selInline = (sel: { identifier?: string; label?: string; labelContains?: string }): string =>
          ['identifier' in sel && sel.identifier ? `identifier: ${JSON.stringify(sel.identifier)}` : '', 'label' in sel && sel.label ? `label: ${JSON.stringify(sel.label)}` : '', 'labelContains' in sel && sel.labelContains ? `labelContains: ${JSON.stringify(sel.labelContains)}` : ''].filter(Boolean).join(', ');
        // ONE all:/any: key with list items — repeated keys collapse in YAML
        // (last wins), and a single selector still parses as a mapping, not a
        // list. `- { … }` items keep both shapes a list.
        if (def.all) {
          lines.push(`      all:`);
          for (const sel of def.all) lines.push(`        - { ${selInline(sel)} }`);
        }
        if (def.any) {
          lines.push(`      any:`);
          for (const sel of def.any) lines.push(`        - { ${selInline(sel)} }`);
        }
      }
    }
    return `${lines.join('\n')}\n`;
  };

  app.get('/api/apps/:bundle/screens.yaml', async (req, reply) => {
    const { bundle } = req.params as { bundle: string };
    reply.header('content-type', 'text/yaml; charset=utf-8');
    // the recipes ride the export (they're per-bundle facts like the screens):
    // wrapper form `screens: […]; login: …; logout: …` — the bare list stays
    // importable for hand-written/legacy files
    const screensYaml = toYaml(screensFor(bundle));
    const loginRow = db.prepare('SELECT login_json FROM app_login WHERE bundle_id = ?').get(bundle) as { login_json: string } | undefined;
    const logoutRow = db.prepare('SELECT logout_json FROM app_logout WHERE bundle_id = ?').get(bundle) as { logout_json: string } | undefined;
    if (!loginRow && !logoutRow) return screensYaml;
    const YAML = await import('yaml');
    const indent = (y: string): string => y.split('\n').filter((l) => l.trim()).map((l) => `  ${l}`).join('\n');
    const parts = [`screens:\n${indent(screensYaml)}`];
    if (loginRow) parts.push(`login:\n${indent(YAML.stringify(JSON.parse(loginRow.login_json)))}`);
    if (logoutRow) parts.push(`logout:\n${indent(YAML.stringify(JSON.parse(logoutRow.logout_json)))}`);
    return parts.join('\n') + '\n';
  });

  app.put('/api/apps/:bundle/screens.yaml', async (req, reply) => {
    const { bundle } = req.params as { bundle: string };
    const b = req.body as { yaml?: string } | string;
    const yaml = typeof b === 'string' ? b : b?.yaml ?? '';
    // parse: yaml → screens (js-yaml is already a server dep for case files)
    const YAML = await import('yaml');
    let parsed: unknown;
    try { parsed = YAML.parse(yaml); } catch (err) {
      return reply.code(422).send({ errors: [`invalid yaml: ${err instanceof Error ? err.message : String(err)}`] });
    }
    // wrapper form: {screens: […], login: …, logout: …} — recipes are
    // optional; validate with the same validators the panels use
    let screensDoc = parsed;
    let loginDoc: unknown = undefined;
    let logoutDoc: unknown = undefined;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'screens' in (parsed as Record<string, unknown>)) {
      const w = parsed as Record<string, unknown>;
      screensDoc = w['screens'];
      loginDoc = w['login'];
      logoutDoc = w['logout'];
      if (loginDoc !== undefined) {
        const errs = validateAppLogin(loginDoc, screensFor(bundle) as unknown as unknown[]);
        if (errs.length > 0) return reply.code(422).send({ errors: errs.map((e) => `login: ${e}`) });
      }
      if (logoutDoc !== undefined) {
        const errs = validateAppLogout(logoutDoc);
        if (errs.length > 0) return reply.code(422).send({ errors: errs.map((e) => `logout: ${e}`) });
      }
    }
    const errors = validateRegistry(screensDoc);
    if (errors.length > 0) return reply.code(422).send({ errors });
    replaceRegistry(bundle, screensDoc as AppScreen[]);
    // import REPLACES absent recipe keys? No — screens replace wholesale, but
    // recipes are absent-safe: only write what the file carries (a legacy
    // bare-list export must not delete the panels' recipes)
    if (loginDoc !== undefined) {
      db.prepare(`INSERT INTO app_login(bundle_id, login_json, updated_at, revision) VALUES (?, ?, ?, 1)
                  ON CONFLICT(bundle_id) DO UPDATE SET login_json = excluded.login_json, updated_at = excluded.updated_at, revision = revision + 1`)
        .run(bundle, JSON.stringify(loginDoc), Date.now());
    }
    if (logoutDoc !== undefined) {
      db.prepare(`INSERT INTO app_logout(bundle_id, logout_json, updated_at, revision) VALUES (?, ?, ?, 1)
                  ON CONFLICT(bundle_id) DO UPDATE SET logout_json = excluded.logout_json, updated_at = excluded.updated_at, revision = revision + 1`)
        .run(bundle, JSON.stringify(logoutDoc), Date.now());
    }
    return { ok: true, count: (screensDoc as AppScreen[]).length, ...(loginDoc !== undefined ? { login: true } : {}), ...(logoutDoc !== undefined ? { logout: true } : {}) };
  });

  // per-screen login routes REMOVED (settlement 2026-09-29, plan
  // 20260929T080249Z review F1): login is app-level (app_login, the
  // "login flow" panel). These wrote the dropped app_screens.login_json
  // column and had no web consumers.

  /** login as an app-level procedure (login-as-app-procedure plan): GET /
   *  PUT / DELETE on the app's SINGLE login flow. Revision-guarded (F4);
   *  operator-gated like the registry writes. validateAppLogin
   *  cross-checks the verify (screen, state) reference against the
   *  app's live registry. */
  app.get('/api/apps/:bundle/login', async (req, _reply) => {
    const { bundle } = req.params as { bundle: string };
    const row = db.prepare('SELECT login_json, revision FROM app_login WHERE bundle_id = ?').get(bundle) as { login_json: string; revision: number } | undefined;
    if (!row) return { login: null, revision: 1 };
    try { return { login: JSON.parse(row.login_json), revision: row.revision }; } catch { return { login: null, revision: row.revision }; }
  });

  app.put('/api/apps/:bundle/login', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { bundle } = req.params as { bundle: string };
    const b = (req.body ?? {}) as { login?: unknown; revision?: number };
    const screens = screensFor(bundle);
    const errors = validateAppLogin(b.login, screens as unknown as unknown[]);
    if (errors.length > 0) return reply.code(422).send({ errors });
    const prev = db.prepare('SELECT revision FROM app_login WHERE bundle_id = ?').get(bundle) as { revision: number } | undefined;
    const rev = prev?.revision ?? 1;
    if (b.revision !== undefined && b.revision !== rev) return reply.code(409).send({ error: `login flow changed since you loaded it (revision ${rev}) — reload and retry`, revision: rev });
    const next = rev + 1;
    db.prepare(`INSERT INTO app_login(bundle_id, login_json, updated_at, revision) VALUES (?, ?, ?, ?)
                ON CONFLICT(bundle_id) DO UPDATE SET login_json = excluded.login_json, updated_at = excluded.updated_at, revision = excluded.revision`)
      .run(bundle, JSON.stringify(b.login), Date.now(), next);
    return { ok: true, revision: next };
  });

  app.delete('/api/apps/:bundle/login', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { bundle } = req.params as { bundle: string };
    const r = db.prepare('DELETE FROM app_login WHERE bundle_id = ?').run(bundle);
    if (r.changes === 0) return reply.code(404).send({ error: 'no login flow for this app' });
    return { removed: bundle };
  });

  /** logout as an app-level procedure (plan 20260929T080249Z): ONE recipe
   *  per bundle — the procedure bare `ensure logout:` resolves. Revision-
   *  guarded like login (review F5); validateAppLogout enforces the shape. */
  app.get('/api/apps/:bundle/logout', async (req, _reply) => {
    const { bundle } = req.params as { bundle: string };
    const row = db.prepare('SELECT logout_json, revision FROM app_logout WHERE bundle_id = ?').get(bundle) as { logout_json: string; revision: number } | undefined;
    if (!row) return { logout: null, revision: 1 };
    try { return { logout: JSON.parse(row.logout_json), revision: row.revision }; } catch { return { logout: null, revision: row.revision }; }
  });

  app.put('/api/apps/:bundle/logout', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { bundle } = req.params as { bundle: string };
    const b = (req.body ?? {}) as { logout?: unknown; revision?: number };
    const errors = validateAppLogout(b.logout);
    if (errors.length > 0) return reply.code(422).send({ errors });
    const prev = db.prepare('SELECT revision FROM app_logout WHERE bundle_id = ?').get(bundle) as { revision: number } | undefined;
    const rev = prev?.revision ?? 1;
    if (b.revision !== undefined && b.revision !== rev) return reply.code(409).send({ error: `logout flow changed since you loaded it (revision ${rev}) — reload and retry`, revision: rev });
    const next = rev + 1;
    db.prepare(`INSERT INTO app_logout(bundle_id, logout_json, updated_at, revision) VALUES (?, ?, ?, ?)
                ON CONFLICT(bundle_id) DO UPDATE SET logout_json = excluded.logout_json, updated_at = excluded.updated_at, revision = excluded.revision`)
      .run(bundle, JSON.stringify(b.logout), Date.now(), next);
    return { ok: true, revision: next };
  });

  app.delete('/api/apps/:bundle/logout', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { bundle } = req.params as { bundle: string };
    const r = db.prepare('DELETE FROM app_logout WHERE bundle_id = ?').run(bundle);
    if (r.changes === 0) return reply.code(404).send({ error: 'no logout flow for this app' });
    return { removed: bundle };
  });
}
