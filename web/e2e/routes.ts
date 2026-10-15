/** Route table + API mocks for the visual/a11y e2e suite.
 *  SINGLE SOURCE for what gets tested and what data the pages see — the
 *  spec file only iterates this. When Lionidas' own web engine replaces the
 *  Playwright runner, this file survives; only visual.spec.ts is rewritten.
 *
 *  Determinism contract (review H1/M1): every timestamp is anchored to a
 *  fixed epoch (2026-10-15T09:00:00Z minus offsets), so day-grouping,
 *  relative times, and rendered text are identical on every machine.
 *  The spec runs with locale en-GB + timezone UTC. */

export const ANCHOR = Date.UTC(2026, 9, 15, 9, 0, 0); // 2026-10-15T09:00:00Z
const H = 3_600_000;
const D = 86_400_000;

export interface FixtureRoute {
  /** route path to visit */
  path: string;
  /** unique name for snapshot files */
  name: string;
  /** wait until this selector exists (content-loaded predicate) */
  readySelector: string;
}

export const ROUTES: FixtureRoute[] = [
  { path: '/', name: 'overview', readySelector: '.kpi, .page' },
  { path: '/audit', name: 'audit', readySelector: '.row' },
];

/** fixed audit rows — two day groups, all event classes, stable ids/times.
 *  Row 4's detail is deliberately LONG (the real-world case that broke the
 *  ledger: content-driven overflow past the container when rows don't
 *  stretch). Keep it long. */
export const AUDIT_ROWS = [
  { id: 1, at: ANCHOR - 2 * H, email: 'a.pratama@lionparcel.com', user_id: 'u_a', event: 'login', detail: 'session opened · web · 10.14.88.2' },
  { id: 2, at: ANCHOR - 4 * H, email: 'ci-bot@lionparcel.com', user_id: 'u_bot', event: 'run_play', detail: 'case login-flow on iPhone 16 · b-7741' },
  { id: 3, at: ANCHOR - 6 * H, email: 'n.wijaya@lionparcel.com', user_id: 'u_n', event: 'rbac_denied', detail: 'users: list — denied for operator' },
  { id: 4, at: ANCHOR - 9 * H, email: 'a.pratama@lionparcel.com', user_id: 'u_a', event: 'build_trigger', detail: 'project prj_6035c50f-2a0b-4c8d-9e1f-7a2b by admin — triggered from cockpit after merge of feat/recipe-onboarding into develop, build 382, artifacts uploaded to the package registry' },
  { id: 5, at: ANCHOR - 26 * H, email: 'a.pratama@lionparcel.com', user_id: 'u_a', event: 'logout', detail: 'session closed' },
  { id: 6, at: ANCHOR - 30 * H, email: 'ci-bot@lionparcel.com', user_id: 'u_bot', event: 'run_abort', detail: 'aborted after 34s (operator)' },
  { id: 7, at: ANCHOR - 40 * H, email: null, user_id: null, event: 'login_failed', detail: 'bad password · web · 10.14.88.9' },
];

/** overview payload mirrors the drill shape (fixed numbers, no Date.now) */
export const OVERVIEW = {
  health: {
    status: 'failed', passed: 18, failed: 2, blocked: 1, running: 3,
    passRate: 0.86, delta: 0.04, previousBatch: 'b-7741', buildLabel: '382',
    lastRunAt: ANCHOR - 2 * H, lastSuccessfulAt: ANCHOR - 26 * H,
  },
  attention: [],
  coverage: { active: 28, draft: 2, deprecated: 1, variants: 6, executedInRange: 24, notRunRecently: 4 },
  latestRuns: [
    { runId: 'r-1', templateId: 'login-flow', status: 'passed', blocked: 0, appVersion: '382', variantId: null, batchId: 'b-7741', startedAt: ANCHOR - 2 * H, finishedAt: ANCHOR - 2 * H + 60_000 },
    { runId: 'r-2', templateId: 'checkout-flow', status: 'failed', blocked: 0, appVersion: '382', variantId: null, batchId: 'b-7741', startedAt: ANCHOR - 3 * H, finishedAt: ANCHOR - 3 * H + 240_000 },
  ],
};

import type { Page } from '@playwright/test';

/** Register ALL API mocks BEFORE navigation (review H1: the router guard
 *  fetches /api/auth/me on every nav and bounces to /login otherwise). */
export async function installMocks(page: Page): Promise<void> {
  await page.route('**/api/auth/me', (r) => r.fulfill({ json: { user: { name: 'QA Harness', role: 'admin' } } }));
  await page.route('**/api/me/capabilities', (r) => r.fulfill({ json: { capabilities: { readUsers: true } } }));
  await page.route('**/api/setup/state', (r) => r.fulfill({ status: 404, body: '{}' }));
  await page.route('**/api/runs**', (r) => r.fulfill({ json: { runs: [], total: 0 } }));
  await page.route('**/api/devices', (r) => r.fulfill({ json: { devices: [] } }));
  await page.route('**/api/plans', (r) => r.fulfill({ json: { plans: [] } }));
  await page.route('**/api/overview', (r) => r.fulfill({ json: OVERVIEW }));
  await page.route('**/api/audit**', (r) => {
    const u = new URL(r.request().url());
    const pg = Math.max(1, Number.parseInt(u.searchParams.get('page') ?? '1', 10) || 1);
    const actor = u.searchParams.get('actor') ?? '';
    const q = (u.searchParams.get('q') ?? '').toLowerCase();
    const filtered = AUDIT_ROWS.filter((x) =>
      (!actor || (x.email ?? '').includes(actor)) &&
      (!q || `${x.email ?? ''} ${x.event} ${x.detail}`.toLowerCase().includes(q)));
    r.fulfill({ json: { events: filtered, total: filtered.length, page: pg, pageCount: 1 } });
  });
}
