import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/index.ts';
import { parseCaseYaml } from '@crucible/shared/case-yaml';
import { renderTemplateYaml } from '../src/routes/templates.ts';

/** Breakdown steps_005 §5e: the authoring eval (CI-hermetic, MockProvider
 *  scripted: search → invalid draft → repair → valid draft → answer). Judge =
 *  the REAL validator re-run on the created template row. Canary: a wrong
 *  judge expectation must FAIL the suite (metric, not crash). */

const hasButler = (() => { try { require.resolve('@mainactordev/butler'); return true; } catch { return false; } })();

describe.skipIf(!hasButler)('agent authoring eval (mock → real validator judge)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: import('better-sqlite3').Database;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'butler-eval-'));
    process.env['CRUCIBLE_DB_PATH'] = join(dir, 't.db');
    process.env['CRUCIBLE_ARTIFACTS_DIR'] = join(dir, 'artifacts');
    process.env['CRUCIBLE_SILENT'] = '1';
    process.env['CRUCIBLE_WATCHDOG'] = '0';
    process.env['CRUCIBLE_PIN'] = 'cli-test-pin-1';
    delete process.env['BUTLER_PROVIDER_BASE_URL'];
    delete process.env['BUTLER_API_KEY'];
    delete process.env['BUTLER_MODEL'];
    app = await buildApp(process.env);
    db = (app as unknown as { db: { raw: import('better-sqlite3').Database } }).db.raw;
    await app.agent.seedPromise;
    // registry for the app under test
    db.prepare(`INSERT INTO app_screens(app_bundle_id, screen_id, revision, entry_json, states_json, updated_at) VALUES ('com.lionparcel.consumer','checkout-summary',1,'{"navigate":[]}','{"settled":{"all":[{"identifier":"summary_view"}]}}',?)`).run(Date.now());
    db.prepare(`INSERT INTO app_screens(app_bundle_id, screen_id, revision, entry_json, states_json, updated_at) VALUES ('com.lionparcel.consumer','payment-web',1,'{"navigate":[]}','{"loading":{"all":[{"identifier":"web_view"}]}}',?)`).run(Date.now());
  });

  it('eval: ticket → search → draft(repair) → judge on the real row', async () => {
    // ── the scripted agent behavior (what the LIVE provider should emulate) ──
    const DRAFT = app.agent.policy;
    const searchOut = await app.agent.registry.execute('sources.search', { query: 'checkout pay now crash iPad settled' }, { sessionId: 'eval', signal: undefined }, DRAFT);
    expect(searchOut).toContain('LP-1042');

    // first draft: WRONG on purpose (unknown screen) → INVALID, nothing written
    const badYaml = `name: LP-1042 checkout crash regression
app: com.lionparcel.consumer
steps:
  - tap: { on: pay_now_button }
  - expect screen: no-such-screen.loading
`;
    const bad = await app.agent.registry.execute('case.draft.save', { yaml: badYaml }, { sessionId: 'eval', signal: undefined }, DRAFT);
    expect(bad).toMatch(/^INVALID:/);
    expect(bad).toContain('no-such-screen');

    // repair: registry-faithful yaml
    const goodYaml = `name: LP-1042 checkout crash regression
app: com.lionparcel.consumer
folder: Regressions/Checkout
steps:
  - expect screen: checkout-summary.settled
    narrate: Given checkout, the summary reaches settled
  - tap: { on: pay_now_button }
    narrate: When I tap Pay Now
  - expect screen: payment-web.loading
    narrate: Then the payment web view shows loading without crashing
`;
    const good = await app.agent.registry.execute('case.draft.save', { yaml: goodYaml }, { sessionId: 'eval', signal: undefined }, DRAFT);
    const saved = JSON.parse(good) as { templateId: string; status: string };
    expect(saved.status).toBe('draft');

    // ── THE JUDGE: re-run the real validator on the persisted row ──
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(saved.templateId) as Record<string, unknown>;
    expect(row['status']).toBe('draft');
    const yaml = renderTemplateYaml(db, row as never);
    const reparsed = parseCaseYaml(yaml, { hasLoginRecipe: () => true, hasLogoutRecipe: () => true });
    expect(reparsed.ok).toBe(true); // round-trips through the REAL grammar
    // narrate preserved (AC lines ride the case)
    expect(yaml).toContain('narrate');
    // folder resolved-or-created
    const folder = db.prepare('SELECT name FROM folders WHERE id = ?').get(row['folder_id'] as string) as { name: string } | undefined;
    expect(folder?.name).toBe('Checkout');
  });

  it('CANARY: a wrong judge expectation FAILS (metric sensitivity)', async () => {
    // The judge must not rubber-stamp: take the row from the eval above and
    // assert the validator REJECTS a corrupted variant of it.
    const row = db.prepare("SELECT * FROM templates WHERE name LIKE 'LP-1042%'").get() as Record<string, unknown>;
    expect(row).toBeTruthy();
    const yaml = renderTemplateYaml(db, row as never).replace('checkout-summary.settled', 'no-such-screen.settled');
    const reparsed = parseCaseYaml(yaml, { hasLoginRecipe: () => true, hasLogoutRecipe: () => true });
    expect(reparsed.ok).toBe(true); // grammar-level parse passes…
    // …but the REFS gate catches it (the judge consults the registry too):
    const { resolveCaseRefs } = await import('../src/routes/templates.ts');
    const c = parseCaseYaml(yaml, { hasLoginRecipe: () => true, hasLogoutRecipe: () => true }).case as never;
    const refErr = resolveCaseRefs(db, c, 'com.lionparcel.consumer');
    expect(refErr).toContain('no-such-screen');
  });

  it('CANARY (negative control): intentionally-wrong expectation demonstrably fails the judge', () => {
    // If someone breaks the judge to always pass, this assertion flips:
    // parseCaseYaml on a deliberately broken doc MUST fail.
    const broken = parseCaseYaml('name: x\nsteps:\n  - frobnicate: {}\n', {});
    expect(broken.ok).toBe(false);
  });

  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
});

// hoisted import use
void renderTemplateYaml;
