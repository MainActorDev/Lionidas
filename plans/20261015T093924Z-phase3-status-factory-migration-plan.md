# Phase 3 — Factory system status migration — implementation plan

- Source brainstorm: `brainstorm/20261015T093924Z-phase3-status-factory-migration.md` (updated after the user's “C” answer)
- Visual contract: `sketches/038-status-factory/c-system-board/index.html` (the user chose **C**; A/B are comparison evidence only)
- Prior status contract: `plans/20261014T062902Z-system-status-page-plan.md`, implemented in `server/src/routes/status.ts` and `web/src/pages/StatusPage.vue`
- Status: **Ready for self-review and human approval; not authorized for production implementation yet**

## Decision and outcome

The user's choice “C” selects the **system board**: a compact overall health band, a responsive tile for each returned subsystem, and the selected subsystem's complete observations and rule below the tiles. The existing app shell remains intact. The page answers what is broken and how recent the observation is; sample values in the sketch do not become hard-coded product facts. The next Phase 3 route added to the self-hosted visual/a11y harness is `/status`.

The migration is done when the real `/api/status` payload (six core systems, sometimes a seventh build-config card) renders without lost facts or false freshness, the selected tile and detail agree, the screenshot composition matches C at desktop/mobile, keyboard and screen-reader semantics work, and the web and targeted status-server checks pass.

## Evidence and boundaries

**Confirmed:** Factory dark tokens are locked (`web/src/styles/tokens.css`, `theme.css`); `App.vue` already owns the 224px sidebar/56px topbar, `system → status` nav and operator gate; `router.ts` owns `/status`; the existing page polls every 15s while visible and exposes `checkedAt`/`cached`. `server/src/routes/status.ts` emits an ordered `systems` array from tables (no live probes) and conditionally adds `build-recipe` when the projects table exists. `web/src/pages/__tests__/StatusPage.test.ts` covers the old split page. The web E2E harness currently mocks only `/` and `/audit` (`web/e2e/routes.ts`).

**Verified QA defect, not a supposition:** the light capture currently removes `.dark` *before* mount in `visual.spec.ts:24–26`, then `App.vue:32–37` adds it again. A browser probe after mount measured `dark: true`, `--background: #101010`; removing the class after mount changed the token to `#fafafa`. Existing “light” snapshots are dark false-greens. Correcting the harness and reviewing its existing-route light baselines is part of this phase's QA work, not a new light-mode feature.

**Scope in:** additive status presentation fields needed by C; new production status page; router swap; removal of the superseded page; status tests; deterministic `/status` route fixture and state captures; light-test correction for migrated routes. **Out:** changing status thresholds/state rules, live provider/simulator probes, new alerts/charts/refresh actions, App shell/nav redesign, activating a user-facing light toggle, or migrating other pages.

## Data contract — one owner for reasons and rules

C depicts a short **signal** on every tile and a **degrades when** rule for the selected system. Today's `StatusCard` has neither; `summary` alone omits real degraded causes (e.g. zombie/outbox) and only `data-freshness` includes thresholds in `detail`. Rendering invented reasons or duplicating threshold policy in the browser would violate the page's honesty requirement. Therefore, as a bounded technical consequence of C, extend `StatusCard` in `server/src/routes/status.ts` with required `signal: string` and `rule: string` and populate them in the same six existing calculation branches and the conditional build-config branch. This is **additive**: preserve `id`, `name`, `state`, `summary`, `detail`, `checkedAt`, `cached`, order, RBAC and cache behavior; do not add new probes or change health rules.

- `signal` summarizes only facts already computed for that card. For degraded/down, name the measured cause(s): zombie age/backlog, MCP retry count, context-burn count, orphan sessions, stale labels, DB-read failure, or build-config gap. Never echo raw exception text into the tile signal (it may contain paths or sensitive context). For ok/unknown, use an honest short existing fact (e.g. no backlog, last successful turn, zero burn, or the card's summary), not a claim of live reachability.
- `rule` is the existing status rule expressed in words from the server's own constants/branch: zombie idle >15m, outbox >0, MCP retries within 1h, empty-answer failures within 24h, orphan session >15m, run/ingest 7d and diagnostics 14d, DB read failure, or the build-config gap conditions. Do not copy thresholds into web constants.
- In `server/test/status-routes.test.ts`, assert both fields for healthy, degraded, down, and optional canary paths, the unchanged state transitions, no secret values in either field, and a cached response retaining its original `checkedAt`/content. Keep the six-card minimal fixture and exercise a projects-table fixture separately for seven cards.

This additive contract is a proposal for the **human plan gate**: if the user wants zero server changes, revise the selected C mockup/data contract before implementation rather than silently removing tile signals or per-system rules.

## Screen and interaction contract (C, 1:1 composition)

1. Keep the real `App.vue` sidebar, brand, menu and topbar. The page occupies `.main` full width with its existing padding; remove the old page's extra `.pg` padding, bright status fills, shadows, weight 700 and legacy split-panel composition. Use Factory theme variables, Geist/Geist Mono, hairlines and status-only orange/green. No extra caption below the title or fabricated telemetry.
2. Header: `system status` + count from `systems.length`, hairline divider. Status band: overall severity (`down` > `degraded` > all `ok` > `unknown`), count of down/degraded systems, an explicit unknown count when present, and `checkedAt` age with a `cached` label when true. Colors never convey state alone; use the state word and dot. No manual refresh button appears in C.
3. Board: render the API array in order as interactive, semantic tile **buttons** (a composite control with `aria-pressed`, `aria-controls`, visible focus, pointer/keyboard selection). Each shows name, state dot + text, summary and server `signal`. Use three equal columns on wide desktop, two on tablet, one at ≤760px; constrain each flexible track/child to prevent horizontal overflow and wrap long values. `Button`/`Badge` default chrome is not forced onto the tile if it changes C's approved shape; the tile itself is a semantic native button, and the existing shadcn theme tokens style the page.
4. Selection: on first successful payload, choose the first `down` system, else the first `degraded`, else the first `unknown`, else the first card (C's shown incident state). Preserve the selected id across polls while present; if it disappears, reapply that priority. Keep tile `aria-pressed` and detail in sync. Selecting a tile updates full `detail` pairs and `rule`, including false, zero and null (`—`), without ellipsizing underlying data. A region with polite live announcement identifies the new selection. On mobile, pointer selection scrolls the detail beneath the 56px sticky topbar; keyboard activation moves focus to the detail heading so it can be read immediately. Respect reduced motion. The default mobile detail may begin below the first viewport, as in C; do not conceal that trade-off by shortening the tile list.
5. Existing fetch/poll lifecycle remains: one initial request, 15s interval only while visible, immediate reload on returning to a visible tab, teardown on unmount. `checkedAt` is the server's observation time, never `Date.now()` of the latest poll. On a network/5xx refresh failure after earlier success, label the last payload as stale and show a visible alert; on 403, hide previously authorized data. Empty arrays render an honest neutral state, not seven placeholders. Avoid a late older response overwriting newer data (request generation or cancellation); test this race without changing server caching.

## Implementation order and files

| Stage | Change | Proof before next stage |
|---|---|---|
| 0 — harness truth | In `web/e2e/visual.spec.ts`, remove the pre-mount light-class script; after route mount/ready, remove `.dark` for light captures. Assert both the class and computed `--background` token for dark/light, then regenerate and **visually review** the existing `/` and `/audit` light baselines. Keep dark baselines unchanged. | An intentional dark-class reintroduction makes the light assertion fail; reviewed screenshots and axe in both themes, not merely green counts. |
| 1 — server contract | Add `signal`/`rule` to `StatusCard`, populate each branch using already-derived facts and server constants; no state/threshold/probe changes. Update targeted status route tests. | Node 24, bounded Vitest (`--maxWorkers=2`) for `status-routes.test.ts` and `status.test.ts`; `server` typecheck/lint. |
| 2 — production page | Create `web/src/pages/StatusBoardPage.vue` from C's full page-content composition, preserving the real shell. Swap only `/status`'s component import in `web/src/router.ts`. After tests/parity, remove superseded `StatusPage.vue`. Replace its old split-layout tests with board-focused render/lifecycle tests; no concurrent legacy panel left mounted. | Vue typecheck/build + tests for six/seven cards, overall severity, selected details/rules, cached age, hidden-tab polling, 403/network/empty and selection removal. |
| 3 — E2E and parity | Add a deterministic status fixture in `web/e2e/routes.ts` (`checkedAt` relative to `ANCHOR`, seven illustrative cards and the new fields). Add `/status` to `ROUTES`; capture initial and selected-incident states at 375/1440 in dark/light. Test tile keyboard activation, selected/detail consistency, no horizontal overflow and axe; drill at 768/1024 too. Compare actual rendered page to C with vision on desktop/mobile; inspect any updated baseline rather than auto-accept. | `pnpm --filter web check` green; targeted server checks green; screenshots demonstrate real light/dark tokens and the selected C composition. |
| 4 — handoff | Review changed files, status card integrity, accessibility and diff scope; present test receipts and screenshots. | Human verification before merge; no push/PR/merge without a separate request. |

## Edge-case table

| Situation | Required behavior | Check |
|---|---|---|
| Six systems or optional seventh canary | Count and tile list follow payload; no hard-coded six/seven | Server fixtures + web render test |
| Down and degraded together; unknown mixed with ok | Overall `down` wins; `degraded` next; unknown is not silently called ok | Web unit cases |
| `checkedAt` older than latest poll; `cached=true`; future-skewed timestamp | Show actual observation age and cached/stale truth, not “live”; a future timestamp says clock mismatch rather than a negative age | Fixed clock E2E + unit |
| Prior selection disappears on refresh | Select a valid unhealthy/first tile; no blank detail or stale `aria-pressed` | Web unit case |
| Long detail values, null, false and 0 | Wrap full text; null only becomes `—`; false/0 remain visible | Unit + 375 screenshot/overflow |
| Network/5xx after valid payload | Error visible; last known data explicitly stale | Unit and E2E error-state check |
| 403 after role change | Hide prior sensitive details; show operator-only message | Unit |
| Hidden tab, tab return, unmount | No hidden polling; immediate visible reload; timer/listener cleaned | Fake-timer unit tests |
| Overlapping requests | Older response cannot replace newer observation | Deferred-response unit test |
| Mobile tile selected by pointer or keyboard | Selected-state detail reachable, focus/scroll honest, no content under topbar | Browser drill 375 + reduced-motion mode |
| Light capture after App mount | `.dark` absent and background `#fafafa`; dark remains `#101010` | E2E assertion and visual baseline diff |

## Acceptance and handoff

- Exact composition: C's board, tile semantics, selected-detail and threshold line at desktop/mobile; no unsupported `signal`/`rule` text or dead controls. The sketch is a **selected-state** visual oracle; the normal route baseline may differ when first payload selects a different system.
- All state and cache facts come from the actual API, including optional canary; no live probes, secrets, or duplicated threshold constants in the browser.
- `pnpm --filter web check` succeeds (typecheck/build/lint/unit/visual+axe); targeted server status tests, typecheck and lint succeed under Node 24 with bounded workers. Do not call targeted status tests the full server suite; disclose pre-existing unrelated failures if a full run is attempted.
- Browser checks at 375/768/1024/1440 include keyboard, both themes and reduced motion. Vision-inspect the changed C states; the false-green light baselines are replaced only after reviewed diffs. No GitHub Actions or paid service is required.
- **Approval gate:** user choice C authorizes this plan's composition, not automatic execution of the additive API contract or code changes. Implement only after this Ready plan's self-review is accepted by the human.
