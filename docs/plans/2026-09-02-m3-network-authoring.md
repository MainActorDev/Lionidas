# M3 — Network Authoring UI (preset editor + scenario manager)

Date: 2026-09-02 · Status: SHIPPED 2026-09-03 (fd3f134 + 81fc6ed + 12a5d54) — all tasks T0–T5 done and live-verified; T6's proxy drill superseded by the API+browser drills (match-test proves serving state; full-app proxy drill = first real QA use).
Closes: the "API-only" admission on the network page (last unstarted milestone surface)

---

## What is this plan about? (plain English)

Today, Crucible can *run* tests under fake network conditions, but *creating or
changing* those fakes requires typing terminal commands. The network page even
says so: presets with bodies, delays and sequences, and scenario management
are "API-only".

This plan gives that power to the dashboard:

- **Preset editor** — click a preset (or a captured request), change what the
  fake response returns: status code, body text, a delay ("pretend the API is
  slow"), throttling, or hard failures ("pretend the connection died").
  Includes a "test this pattern" button that answers *"would this preset match
  this URL?"* using the exact same matcher the proxy uses.
- **Scenario manager** — a named list of fake endpoints ("tariff API down",
  "slow network") that can be created, renamed, edited and deleted in the
  browser. Scenarios are what you pick when running a test case; the network
  selector there already exists.

No new proxy engine work — the server already accepts almost all of it. This
is mostly API glue that's missing (edit/delete for scenarios, in-place preset
editing, writing body text) plus two UI surfaces.

When done, the full loop — record a test, author the failure mode, replay
under it — lives entirely in clickable UI.

---

## Grounding (verified against code 2026-09-02)

| Fact | Where |
|---|---|
| Preset wire shape (status/headers/bodyPath/delayMs/seq/failure/throttleKbps, match kinds exact/glob/regex, guards, longest-pattern-wins) | `server/src/forge/matcher.ts` `Preset`, `matchPreset` |
| DB: `presets`, `scenarios(name UNIQUE, launch_arg, immutable_since)`, `scenario_overrides(scenario_id, preset_id, enabled)` | `server/src/db/schema.ts:79-108` |
| Presets CRUD: POST (create/replace, **hash id — no stable-id update**), GET, DELETE. No PATCH. | `server/src/forge/routes.ts:21-61` |
| Scenario routes: POST create (+members), GET list, POST :id/activate. **No rename/delete/membership editing.** | `routes.ts:63-105` |
| ⚠ activate route maps rows→spec INLINE (duplicate of `presetRowToSpec`) — the exact B8 drift class; must route through the shared mapper | `routes.ts:91-103` vs `matcher.ts:99` |
| Bodies are FILES at `body_path` under `forgeStateService().bodiesDir` (B6 data dir) — editing body text = writing that file | `routes.ts:259-265`, `forge/state.ts` |
| Every preset/mode change MUST call `syncPresetsToMitm()` — DB alone serves nothing | skill + `routes.ts:46,54` |
| Pattern tester exists: `POST /api/forge/match-test` (same matcher, reasons included) | `routes.ts:118+` |
| Playback consumes scenarios: `POST /api/templates/:id/play {scenarioId}` — presets loaded at PLAY time (data, not snapshot) | `manual/playback.ts:176-186` |
| TemplatesPage already has the run-time scenario picker (`network: live \| <scenario>`) | TemplatesPage.vue |
| Scenarios get `immutable_since` stamped on first activation — a soft "has been used" marker, nothing enforces it | `routes.ts:85` |
| UI conventions: shared primitives only (.btn/.chip/.card/.meta-row/.status-*), no page-local color dialects; guide ships WITH the feature | skill §Web UI conventions |

**Verified during plan self-review (2026-09-02, code-read — not assumed):**

| Claim checked | Verdict |
|---|---|
| `clearScenario()` service seam exists for scenario-delete cleanup | ✅ `forge/state.ts:39,99` — plan's "verify or add" resolved: exists |
| FK cascade deletes `scenario_overrides` when a scenario is deleted | ✅ in PROD — `openDb` sets `PRAGMA foreign_keys = ON` (`db/client.ts:13`). ⚠ BUT raw in-memory test DBs don't get the pragma unless they go through `openDb` — T1 tests must either open via `openDb(':memory:')` or set the pragma themselves, or the cascade silently won't fire and the test lies |
| The activate route's direct `forgeState.presets = …` assignment is redundant once the service composes | ❌ **NOT redundant — plan corrected.** `compose()` writes the state FILE only; the IN-PROCESS proxy serves from `forgeState.presets`, which ONLY the activate route updates. Dropping the assignment (as the draft permitted) would break the in-process proxy under scenario activation. Correct fix: move BOTH the spec mapping (via `presetRowToSpec`) AND the `forgeState.presets` update INTO `forgeStateService.activateScenario()` — one owner, both consumers |
| `presets.sha256` has consumers that PATCH must keep consistent | ➖ written everywhere, read NOWHERE (search: zero readers). Recompute on PATCH anyway (one hash, keeps the column honest for future consumers) |
| Saved plans / run dialogs reference scenarios by stable id (rename-safe) | ✅ `plans.scenario_id`, queue spec `scenarioId` — ids, not names. Delete leaves a dangling id → playback's member SELECT returns empty → run proceeds on live traffic (fail-open, acceptable); the delete-confirm dialog in T3 says so |
| `gcTrafficBodies` could reap a preset's edited body file | ✅ safe — GC touches only the `traffic_bodies` TABLE (DB blobs), never `preset-bodies/` files on disk |
| Playback's scenario activation updates BOTH proxy consumers | ❌ **second latent instance found**: `playback.ts:184` calls the service (state FILE only) — during a scenario run the addon serves scenario presets but the IN-PROCESS proxy still serves DB presets (`forgeState.presets` untouched). Same class as the route bug; the `activateScenario(rows)` signature change fixes BOTH call sites at once, and `clearScenario()` (restore path, `playback.ts:347`) must likewise reset the in-process presets |

---

## Design decisions (settled in this plan)

1. **PATCH-in-place, stable id.** The editor must edit the row's existing id —
   the hash-id INSERT would fork a copy on every save while scenario
   memberships keep pointing at the stale original (the failure the editor
   exists to prevent). New route `PATCH /api/forge/presets/:id`.
2. **Bodies stay files.** The editor loads a body via a new read route and
   saves via a new write route (tmp+rename atomic, B4a pattern) into the same
   `bodiesDir`. No DB blob duplication, no path churn — `body_path` keeps
   pointing at the same file. A preset that had no body can gain one (file
   created, `body_path` set).
3. **Scenarios are data, not snapshots — surface it.** Membership edits apply
   on next play (consistent with subflows/templates philosophy). Because a
   scenario may already be referenced by saved plans and past runs,
   `immutable_since` renders as a "used by runs before" hint + confirm on
   membership changes, never a block.
4. **One editor, two entries.** "Edit preset" opens the same modal from the
   presets table and from a captured request's detail pane (prefilled from
   the traffic row; save = create-new preset, then optionally add to a
   scenario).
5. **Matcher is never re-implemented in the UI.** The editor's "test pattern"
   button calls `/api/forge/match-test` — one matcher, zero drift.
6. **seq editor = JSON textarea with validate-on-save** (v1). Sequences are
   rare; a bespoke list editor is milestone-territory polish. Validate parses
   `Array<{status, delayMs?, bodyPath?}>` before save.
7. **No scenario activation from the manager** beyond what exists — the
   scenario's job is to be PICKED at run time (or activated ad-hoc via the
   existing route from the network page header, unchanged).

---

## Tasks

### T0 — Server: preset read/update + body write
- `GET /api/forge/presets/:id` → full row **plus decoded body** (`{ text,
  contentType, bytes }` reading `body_path`, null when absent) — the editor's
  load.
- `PATCH /api/forge/presets/:id` → updates provided columns (method,
  path_pattern, match, status, headers, delay_ms, throttle_kbps, failure,
  seq_json, created_by='editor'); recomputes `sha256`. Unknown id → 404.
  Calls `syncPresetsToMitm()`.
- `PUT /api/forge/presets/:id/body` → body text (UTF-8) written to
  `bodiesDir/<presetId>.body` (create if none, tmp+rename), sets
  `body_path`, optional `contentType` → merges into `headers_json`
  content-type. Binary bodies (non-UTF8/oversized >256KB) → 415 honest error.
  `syncPresetsToMitm()`.
- Tests (vitest, in-memory `migrateM1` db): patch keeps id + updates column;
  body write round-trips (read route returns written text); content-type
  merge; 404 path; sync called (spy/observable via state file).

### T1 — Server: scenario CRUD + membership
- `PATCH /api/forge/scenarios/:id` (name — keep UNIQUE collision → 409,
  description, launch_arg).
- `DELETE /api/forge/scenarios/:id` (cascades overrides via FK; also clears
  any active override if it was this scenario's — via
  `forgeStateService().clearOverride()`-equivalent; verify service seam
  exists, else add).
- `GET /api/forge/scenarios/:id` → scenario + members `[{preset_id, enabled,
  method, path_pattern, status}]`.
- `PUT /api/forge/scenarios/:id/members` → replace-set semantics
  `[{presetId, enabled}]` (idempotent, single writer).
- **Fix the B8 violation (corrected by self-review)**: move the spec mapping
  AND the in-process `forgeState.presets` update INTO
  `forgeStateService.activateScenario(presetRows)` — change its signature to
  accept DB ROWS, map through `presetRowToSpec` internally, and update BOTH
  the state file (compose) and `deps.forgeState.presets` (what the in-process
  proxy serves from). The route shrinks to a lookup + one service call.
  ⚔ Do NOT simply delete the route's `forgeState.presets` assignment:
  `compose()` writes the state FILE only — the in-process proxy reads
  `forgeState.presets`, which nothing else updates. Same for `clearScenario()`
  (T1 delete): it must also reset `deps.forgeState.presets` to DB presets,
  else a delete-mid-activation leaves the in-process proxy serving ghosts.
- Tests: rename collision 409; delete cascades — **open the in-memory DB via
  `openDb(':memory:')` (or `PRAGMA foreign_keys = ON` manually)**, else the FK
  cascade silently doesn't fire and the test lies; members replace-set;
  activate still writes the state file with scenario presets AND updates
  in-process `forgeState.presets` (assert BOTH — the self-review catch);
  scenario delete mid-activation clears the in-process proxy's ghost presets.

### T2 — Web: preset editor modal
- `web/src/components/PresetEditorModal.vue` (model after `NewRunModal.vue`
  structure). Fields: method (select: GET/POST/…/*), path pattern + match
  kind (segmented control exact/glob/regex), status (number), delay ms,
  throttle kbps, failure (none/timeout/reset/malformed), headers (JSON
  textarea, validated), body (mono textarea; load from GET :id; save via PUT
  body), seq (JSON textarea, validated, collapsed behind disclosure).
- **"test pattern"** button → `match-test` → result chip: `✓ preset <id>
  (exact)` or `no match` (uses `.status-*` word classes, no new colors).
- Entry points: presets table row action `edit`; traffic detail pane `edit
  preset` when `matched_preset_id` set (alongside existing "served by" text).
- Conventions: shared primitives only; `grep -rn 'color-[a-z]*( *, *#)' src/`
  empty; disclosure pattern like TemplatesPage env.

### T3 — Web: scenario manager section (network page)
- New card on ForgePage between presets and traffic: `scenarios · N` with
  self-explanatory subtitle ("a scenario is a named set of presets you pick
  when running a test case").
- Rows: name · presets count · `used` hint when `immutable_since` · hover
  actions (gradient-fade pattern): edit membership, rename, delete
  (confirm — mentions saved plans reference it by name).
- Membership editor (inline expansion or modal): checkbox list of ALL presets
  (method + path + status shown), per-member enable toggle; save →
  `PUT members` replace-set.
- Create flow: name + description → `POST /api/forge/scenarios` → opens
  membership editor empty.
- Empty state: numbered steps (create scenario → check presets into it → pick
  it on the test cases page when playing).

### T4 — Guide + honesty
- Network guide section: replace the "API-only" admission with the authoring
  loop (preset editor, scenarios, run-time picker); each control's meaning in
  meta-row cards (delay, failure modes, match kinds).
- Network page: delete the "API-only" sentence from the presets card subtitle
  and the empty-state copy that claims it.

### T5 — Gates
- Server: `pnpm typecheck && pnpm lint && pnpm vitest run` (Node v24 PATH).
- Web: `npx vue-tsc --noEmit && npx vite build`.
- Playwright layout audit (per skill): column alignment ±1px, pairwise cell
  overlap, overflow at 1280 + 900, real-hover on row actions, vision pass on
  screenshots for legibility ("N presets" grammar, clipped labels).

### T6 — Live drill (real app, then CLEAN UP)
1. Start stack (`scripts/dev.sh`), start proxy, `route sims`, restart a sim,
   launch LP app.
2. Capture traffic → save-as-preset → **edit it in the UI** (delay 2000ms,
   edited body) → hit the endpoint from the app → traffic row shows the fake
   (latency ~2s, edited body in detail pane).
3. Create scenario "tariff slow" in UI → check 2 presets in → run a template
   with `network: tariff slow` → run-detail network tab shows attributed fake
   traffic.
4. `match-test` from the editor on a real captured URL.
5. **Drill hygiene (rule)**: `POST /api/forge/sim-routing {"enabled":false}`
   + stop proxy + verify `scutil --proxy` disabled + strict (no `-k`)
   internet 200 through nothing — before ending the session.

---

## Pitfalls carried in (from skill — each bit someone already)

- `exactOptionalPropertyTypes`: spread-conditional fields from row→spec —
  cast `NonNullable<...>` where needed (B8 lesson).
- Every CRUD end-state MUST `syncPresetsToMitm()` — a DB write alone serves
  nothing.
- Inline `//` comments inside `.run()` argument lists swallow args (batch-6
  live hit) — comments above the call, always.
- Bound placeholders AND literals against the column list; `PRAGMA
  table_info` before hand-written UPDATEs.
- Vue: no `watch(..., {immediate:true})` forward-referencing later consts
  (TDZ blank page); template refs in v-for arrive as arrays.
- Commit gating on the verify's OWN exit code, never a piped one.
- Playwright: synthetic `dispatchEvent(mousemove)` ≠ `:hover` — use the real
  hover tool.

## Self-review (executed against this plan)

- *(a) mentally executed the drill against test data*: T6 step 2 requires a
  captured row with `res_sha` AND no `matched_preset_id` — save-as-preset
  409s otherwise; drill text now says capture fresh traffic first. ✔
- *(b) both ends of every data-flow link*: editor load needs GET :id WITH
  body — added to T0 (a GET without body would render an empty editor and
  look like data loss). Membership editor needs preset list — GET /presets
  exists (SELECT *). Replace-set needs the full member list back — GET :id
  members added. ✔
- *(c) re-read code for claimed behavior*: `INSERT OR REPLACE` + hash id
  confirmed create-only (routes.ts:26-29); `immutable_since` confirmed
  unenforced (only written, never read); match-test confirmed existing. ✔
- *(d) consumer verified*: plans reference scenarios via the saved page state
  (scenarioId) and playback loads members at play time — so rename is safe
  for FUTURE plays and past runs keep their evidence; delete breaks saved
  plans' picker → confirm dialog mentions it. ✔
- *(e) backward compat*: PATCH adds a new route (no normalize-at-write
  change); existing POST /presets untouched for API users. ✔

## Out of scope (deliberate)

- Preset duplication/clone button; scenario import/export; seq list-editor
  UI (JSON textarea v1); per-scenario mode override (mode stays global);
  anything in DEFERRED.md — entries stay parked behind their triggers.
