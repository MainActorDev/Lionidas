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

/** fixed audit rows — deterministic, seeded like a real page: 16 rows across
 *  three day groups, all event classes, MEDIUM-LONG details in most rows.
 *  Fixture weight matters: visual thresholds (maxDiffPixelRatio 0.002) need
 *  enough rendered structure that a layout break (e.g. rows stop stretching)
 *  moves >0.2% of pixels. With only a few short rows, a broken grid can
 *  sneak under threshold (measured: 7 rows → 0.137% diff = MISS;
 *  16 weighted rows → comfortably over). Keep rows ≥ 14 with real lengths. */
const EVENTS = ['login', 'run_play', 'rbac_denied', 'build_trigger', 'logout', 'run_abort', 'case_edit', 'manual_take_control', 'login_failed', 'role_changed', 'device_action', 'password_changed'] as const;
const DETAILS = [
  'session opened · web · 10.14.88.2',
  'case login-flow on iPhone 16 · b-7741 · variant en-US · passed in 42s',
  'users: list — denied for operator (role below supervisor)',
  'project prj_6035c50f-2a0b by admin — triggered from cockpit after merge of feat/recipe-onboarding into develop, build 382',
  'session closed after 4h 12m',
  'aborted after 34s (operator) — device reclaimed for manual session',
  'steps 4→7 edited on case login-flow (added OTP verification step)',
  'device iPhone 16 · manual control 90s · 3 screenshots captured',
  'bad password · web · 10.14.88.9',
  'role operator → supervisor by a.pratama',
  'screenshot batch (12) uploaded to evidence store',
  'self password change (no reset token)',
];
const EMAILS = ['a.pratama@lionparcel.com', 'ci-bot@lionparcel.com', 'n.wijaya@lionparcel.com', null] as const;
export const AUDIT_ROWS = Array.from({ length: 16 }, (_, i) => ({
  id: i + 1,
  at: ANCHOR - (i * 5 + (i % 3)) * 1_800_000, // ~5h apart, 3 day-groups
  email: EMAILS[i % 4],
  user_id: EMAILS[i % 4] ? `u_${i % 4}` : null,
  event: EVENTS[i % EVENTS.length],
  detail: DETAILS[i % DETAILS.length],
}));

/** Scroll-state fixture: long enough to engage sticky headers even at 900px.
 *  Keep the normal page snapshots on AUDIT_ROWS; only the scroll test uses this. */
export const AUDIT_SCROLL_ROWS = Array.from({ length: 48 }, (_, i) => ({
  ...AUDIT_ROWS[i % AUDIT_ROWS.length]!,
  id: i + 1,
  at: ANCHOR - i * H,
}));

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
export async function installMocks(page: Page, auditRows = AUDIT_ROWS): Promise<void> {
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
    const filtered = auditRows.filter((x) =>
      (!actor || (x.email ?? '').includes(actor)) &&
      (!q || `${x.email ?? ''} ${x.event} ${x.detail}`.toLowerCase().includes(q)));
    r.fulfill({ json: { events: filtered, total: filtered.length, page: pg, pageCount: 1 } });
  });
}
