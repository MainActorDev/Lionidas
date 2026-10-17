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
  { path: '/status', name: 'status', readySelector: '.tile' },
  { path: '/agent', name: 'agent', readySelector: '.tl-inner' },
  { path: '/screens', name: 'screens', readySelector: '.a2-group-head' },
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
    { runId: 'r-3', templateId: 'login-flow', status: 'passed', blocked: 0, appVersion: '382', variantId: 'en-US', batchId: 'b-7741', startedAt: ANCHOR - 5 * H, finishedAt: ANCHOR - 5 * H + 75_000 },
    { runId: 'r-4', templateId: 'payment-retry', status: 'failed', blocked: 0, appVersion: '382', variantId: null, batchId: 'b-7741', startedAt: ANCHOR - 6 * H, finishedAt: ANCHOR - 6 * H + 180_000 },
    { runId: 'r-5', templateId: 'search-filters', status: 'passed', blocked: 0, appVersion: '382', variantId: null, batchId: 'b-7741', startedAt: ANCHOR - 8 * H, finishedAt: ANCHOR - 8 * H + 95_000 },
    { runId: 'r-6', templateId: 'login-flow', status: 'passed', blocked: 0, appVersion: '382', variantId: 'id-ID', batchId: 'b-7741', startedAt: ANCHOR - 22 * H, finishedAt: ANCHOR - 22 * H + 66_000 },
  ],
};

import type { Page } from '@playwright/test';

/** status payload — 037-board shape: 7 systems (6 core + conditional canary),
 *  mixed states incl. the sketch's agent-core incident. checkedAt anchored so
 *  the age label ("12s ago") is deterministic. Includes long values, false,
 *  0 and null to pin the detail pane's honesty. */
export const STATUS = {
  checkedAt: ANCHOR - 12_000,
  cached: true,
  systems: [
    { id: 'server', name: 'server', state: 'ok', summary: 'up 4h 12m · v0.1.0', signal: 'both databases readable', rule: 'DB read fails → down',
      detail: { uptime: '4h 12m', version: '0.1.0', 'crucible.db journal': 'wal', 'agent.db journal': 'wal' } },
    { id: 'agent-core', name: 'agent core', state: 'degraded', summary: '1 live turn · 24h: 41 ✓ / 3 ✕', signal: 'zombie 22m · outbox 2', rule: 'zombie idle >15m · outbox backlog >0',
      detail: { 'live turns': 1, 'zombie candidates': 't_aebb8b52 (idle 22m)', 'outbox backlog': '2 effects', '24h completed': 41, '24h failed': 3, '24h aborted': 0 } },
    { id: 'provider-mcp', name: 'provider · mcp', state: 'ok', summary: 'openai-compat · configured model', signal: 'last ok turn 8m ago', rule: 'MCP_PENDING failures in the last hour >0',
      detail: { provider: 'openai-compat', model: 'configured model', 'api key present': true, 'mcp retries 1h': 0, 'last ok turn': '8m ago' } },
    { id: 'llm-backend', name: 'llm backend', state: 'ok', summary: 'api.z.ai · last turn 8.4s', signal: 'burn 24h: 0', rule: 'empty-answer failures in 24h >0',
      detail: { endpoint: 'api.z.ai', 'key present': true, 'spend 24h': '412k tok', 'last turn': '8.4s', 'context burn 24h': 0 } },
    { id: 'engine', name: 'engine', state: 'degraded', summary: '3 devices seen · 1 running · 0 queued', signal: '1 orphan session', rule: 'orphaned manual session >15m → degraded',
      detail: { 'devices seen': 3, 'runs running': 1, 'runs queued': 0, 'orphan sessions': 1, source: 'tables (no live probes)' } },
    { id: 'data-freshness', name: 'data freshness', state: 'unknown', summary: 'run 9d ago · ingest 5d ago', signal: 'run · repo ingest beyond threshold', rule: 'run 7d · ingest 7d · diag 14d',
      detail: { 'last run': '9d ago', 'last case edit': '2d ago', 'last diag payload': '4d ago', 'last repo ingest': '5d ago', 'stale beyond threshold': 'last run, last repo ingest', thresholds: 'run 7d · ingest 7d · diag 14d' } },
    { id: 'build-recipe', name: 'build configs', state: 'ok', summary: '2 projects · build configs honest', signal: 'no config gap detected', rule: 'fallback-lied, unverified generated, or blocked-with-builds → degraded',
      detail: { 'project A detection': 'found:manifest', 'project A recipe': 'manifest rev3', 'project A verified': 'green', 'project B detection': 'derivable', 'project B recipe': 'none', 'project B generated': false, 'a long sentinel value to force wrapping in the detail pane at narrow widths': null } },
  ],
};

/** Agent v2 timeline fixture — every item kind the fold emits, deterministic
 *  timestamps (anchored), one live-looking-but-settled session. Weighted like
 *  the real thing: user asks, tool calls with mixed outcomes, a failed turn,
 *  a queued follow-up, usage, assistant markdown with a code fence. */
const agBase = (ordinal: number, status: string, startedAt: number, durMs = 60_000): { ordinal: number; status: string; startedAt: number; completedAt: number } =>
  ({ ordinal, status, startedAt, completedAt: startedAt + durMs });
export const AGENT_TIMELINE = {
  items: [
    { kind: 'message', id: 'm1', sessionId: 'sess_e2e', turnId: 't1', ...agBase(1, 'completed', ANCHOR - 40 * 60_000), role: 'user', streaming: false, text: 'why did login-flow fail on the last three nightly runs? [cmds: /planning] [refs: case:tpl_login]' },
    { kind: 'mcp_tool_call', id: 'w1', sessionId: 'sess_e2e', turnId: 't1', ...agBase(2, 'completed', ANCHOR - 39 * 60_000, 1_200), toolCallId: 'tc1', name: 'repo.diff', arg: 'ios-consumer 9f2c1ab..HEAD', result: '6 files · +214 −89 · LoginViewModel.swift +142 −12' },
    { kind: 'mcp_tool_call', id: 'w2', sessionId: 'sess_e2e', turnId: 't1', ...agBase(3, 'completed', ANCHOR - 38 * 60_000, 300), toolCallId: 'tc2', name: 'cases.list', arg: 'template = tpl_login', result: '12 cases · 3 failed in last 3 nightlies' },
    { kind: 'usage', id: 'u1', sessionId: 'sess_e2e', turnId: 't1', ...agBase(4, 'completed', ANCHOR - 37 * 60_000), cost: 0.041, contextUsed: 41000, contextWindow: 200000 },
    { kind: 'message', id: 'm2', sessionId: 'sess_e2e', turnId: 't1', ...agBase(5, 'completed', ANCHOR - 37 * 60_000), role: 'assistant', streaming: false, text: 'Three consecutive failures at `step: submit · credentials`. The regression window is `9f2c1ab..HEAD` — the new 0.8s debounce outruns the harness 0.5s submit-wait. Restore 0.3s.', turnMeta: { durationMs: 161_000, cost: 0.041 } },
    { kind: 'message', id: 'm3', sessionId: 'sess_e2e', turnId: 't2', ...agBase(6, 'completed', ANCHOR - 12 * 60_000), role: 'user', streaming: false, text: 'draft the regression cases for the intl target', intent: 'queued' },
    { kind: 'mcp_tool_call', id: 'w3', sessionId: 'sess_e2e', turnId: 't3', ...agBase(7, 'failed', ANCHOR - 5 * 60_000, 24_000), toolCallId: 'tc3', name: 'repo.read', arg: 'LoginShip/ViewModel.swift', result: 'tool exceeded 12s read budget — retried once, failed again', isError: true },
    { kind: 'error', id: 'e1', sessionId: 'sess_e2e', turnId: 't3', ...agBase(8, 'failed', ANCHOR - 4 * 60_000), class: 'provider_error', message: 'turn failed: provider 502 after retry' },
    { kind: 'message', id: 'm4', sessionId: 'sess_e2e', turnId: 't3', ...agBase(9, 'failed', ANCHOR - 4 * 60_000), role: 'assistant', streaming: false, text: 'Partial: the intl target kept 0.3s — one read timed out before the provider dropped.', turnMeta: { durationMs: 61_000, cost: 0.012 } },
  ],
};

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
  // screens page (phase A S6): app registry + case usage join + app states
  const SCREEN_REGISTRIES: Array<{ bundle: string; screens: Array<Record<string, unknown>> }> = [
    { bundle: 'com.his.foodiary.app', screens: [
      { id: 'onboarding', entry: { deepLink: 'foodiary://onboarding' }, refresh: { gesture: 'pull' }, states: { ready: { all: [{ label: 'Get Started' }] } } },
      { id: 'home', entry: { tab: { label: 'Home' } }, states: { landed: { all: [{ labelContains: 'Hi' }] }, empty: { any: [{ label: 'Add your first recipe' }] } } },
    ] },
    { bundle: 'com.lioparcel.services.consumer.int-dev', screens: [
      { id: 'tracking', entry: { tab: { identifier: 'tab_tracking' } }, states: { loaded: { all: [{ labelContains: 'STATUS PENGIRIMAN' }] } } },
    ] },
  ];
  await page.route('**/api/apps/screens', (r) => r.fulfill({ json: { registries: SCREEN_REGISTRIES } }));
  await page.route('**/api/apps/*/screens', (r) => {
    const bundle = decodeURIComponent(new URL(r.request().url()).pathname.split('/')[3] ?? '');
    const reg = SCREEN_REGISTRIES.find((x) => x.bundle === bundle);
    return r.fulfill({ json: { screens: reg?.screens ?? [] } });
  });
  await page.route('**/api/templates', (r) => r.fulfill({ json: { templates: [
    { id: 'tpl_smoke1', name: 'Home renders greeting', appBundleId: 'com.his.foodiary.app' },
    { id: 'tpl_track1', name: 'Tracking detail loads', appBundleId: 'com.lioparcel.services.consumer.int-dev' },
  ] } }));
  await page.route('**/api/apps/*/states', (r) => r.fulfill({ json: { states: [
    { id: 'st_e2e1', stateId: 'fresh_install', label: 'Fresh install', probe: { screen: 'onboarding.ready' }, recipe: { actuator: 'uninstallReinstall' }, verify: { screen: 'onboarding.ready' }, provenance: 'user', revision: 2 },
    { id: 'st_e2e2', stateId: 'logged_in', label: 'Logged in', probe: { screen: 'home.landed' }, recipe: { entry: { tab: { identifier: 'tab_account' } }, steps: [{ tap: { on: 'open_login' } }, { type: { on: 'phone_field', text: '${env.DRILL_PHONE}' } }] }, verify: { screen: 'home.landed', via: 'tab_account' }, provenance: 'import', revision: 1 },
  ] } }));
  // phase B S3: the proposals inbox — one open + one decided; POST accept/
  // reject flip the harness-local copy and re-serve it (edge 9: POST mocks)
  let openProposal = { id: 'sp_e2e1', stateId: 'on_profile_setup', label: 'Arrived: on_profile_setup', probe: { identifier: 'profile_setup_next_button' }, recipe: { steps: [{ tap: { on: 'welcome_get_started_button' } }] }, verify: { identifier: 'profile_setup_next_button' }, rationale: 'proposed from run_e2e (Home renders greeting) — walk = the case\'s 1 grammar-expressible step(s)', sourceRunId: 'run_e2e', status: 'open', createdBy: 'agent' };
  const decidedProposal = { id: 'sp_e2e0', stateId: 'on_dark_mode', label: 'Arrived: on_dark_mode', probe: { identifier: 'dark_toggle' }, recipe: { steps: [{ tap: { on: 'settings_appearance' } }] }, verify: { identifier: 'dark_toggle' }, rationale: 'proposed from run_e2e0', sourceRunId: 'run_e2e0', status: 'rejected', createdBy: 'agent' };
  await page.route('**/api/apps/*/proposals', (r) => r.fulfill({ json: { proposals: [openProposal, decidedProposal] } }));
  await page.route('**/api/states/proposals/sp_e2e1/accept', (r) => {
    openProposal = { ...openProposal, status: 'accepted' };
    return r.fulfill({ json: { stateId: 'st_new', proposal: openProposal } });
  });
  await page.route('**/api/states/proposals/sp_e2e1/reject', (r) => {
    openProposal = { ...openProposal, status: 'rejected' };
    return r.fulfill({ json: { proposal: openProposal } });
  });
  await page.route('**/api/status', (r) => r.fulfill({ json: STATUS }));
  // agent v2 (timeline): sessions list, one session read, the projection
  // LIFO: the specific timeline mock must register AFTER the catch-all so it
  // wins for /timeline; the catch-all serves the v1 session read.
  await page.route('**/api/agent/sessions/**', (r) => r.fulfill({ json: { session: { id: 'sess_e2e', title: 'Check login-flow failures' }, messages: [] } }));
  await page.route('**/api/agent/sessions', (r) => r.fulfill({ json: { sessions: [{ id: 'sess_e2e', title: 'Check login-flow failures', updatedAt: ANCHOR - 4 * 60_000 }] } }));
  await page.route('**/api/agent/sessions/sess_e2e/timeline', (r) => r.fulfill({ json: AGENT_TIMELINE }));
  await page.route('**/api/agent/commands', (r) => r.fulfill({ json: { commands: [] } }));
  await page.route('**/api/agent/models/health', (r) => r.fulfill({ json: { combos: [{ id: 'fast', members: ['glm-4.7', 'glm-4.7-flash'] }], models: [{ id: 'glm-4.7', ok: 3, failed: 0 }, { id: 'claude-sonnet', ok: 2, failed: 0 }] } }));
  await page.route('**/api/agent/models', (r) => r.fulfill({ json: { registry: { defaultCombo: 'fast', models: [{ id: 'glm-4.7', enabled: true, kind: 'openai' }, { id: 'claude-sonnet', enabled: true, kind: 'claude' }] } } }));
  await page.route('**/api/agent/chats', (r) => r.fulfill({ json: { chats: [{ id: 'sess_e2e', title: 'Check login-flow failures', updatedAt: ANCHOR - 4 * 60_000 }, { id: 'sess_2', title: 'Draft regression plan for checkout', updatedAt: ANCHOR - 5 * 3_600_000 }] } }));
  // WS mock: page.route does NOT intercept WebSockets — the agent pages'
  // /api/events connection against the static preview server's dead proxy
  // EPIPEs and the reconnect churn destabilizes captures. routeWebSocket
  // parks it silently (no server frames needed for these fixtures).
  await page.routeWebSocket('**/api/events', () => { /* parked */ });
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
