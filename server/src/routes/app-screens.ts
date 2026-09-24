import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { validateRegistry, type AppScreen } from '@crucible/shared/app-screens';

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
      return screen;
    });

  const replaceRegistry = (bundle: string, screens: Array<import('@crucible/shared/app-screens').AppScreen>): void => {
    const tx = db.transaction((list: AppScreen[]) => {
      db.prepare('DELETE FROM app_screens WHERE app_bundle_id = ?').run(bundle);
      const ins = db.prepare('INSERT INTO app_screens(app_bundle_id, screen_id, entry_json, refresh_json, states_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const s of list) {
        ins.run(bundle, s.id, JSON.stringify(s.entry), s.refresh ? JSON.stringify(s.refresh) : null, JSON.stringify(s.states), Date.now());
      }
    });
    tx(screens);
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
    return { screens: screensFor(bundle) };
  });

  app.put('/api/apps/:bundle/screens', async (req, reply) => {
    const { bundle } = req.params as { bundle: string };
    const b = req.body as { screens?: unknown };
    const errors = validateRegistry(b?.screens);
    if (errors.length > 0) return reply.code(422).send({ errors });
    replaceRegistry(bundle, b!.screens as AppScreen[]);
    return { ok: true, count: (b!.screens as AppScreen[]).length };
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
        lines.push(`    navigate: ${JSON.stringify(entry.navigate)}`);
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
    return toYaml(screensFor(bundle));
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
    const errors = validateRegistry(parsed);
    if (errors.length > 0) return reply.code(422).send({ errors });
    replaceRegistry(bundle, parsed as AppScreen[]);
    return { ok: true, count: (parsed as AppScreen[]).length };
  });
}
