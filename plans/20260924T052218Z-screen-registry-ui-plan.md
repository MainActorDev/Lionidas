# Plan — Screen Registry UI: Authoring Awareness, Registry Editor, Live Probe

- Source: session 2026-09-24 (chat proposal accepted: "Write the plan for all three slices"); backlog #1 & #3 in `plans/BACKLOG.md`
- Created: 2026-09-24T05:22Z
- Status: Ready (revised 2026-09-24 after review — see reviews/20260924T052218Z-screen-registry-ui-plan-review.md)

## Decision log

- 2026-09-24, operator (session): F3 lost-update mitigation = **revision
  guard** on the registry PUT (not the diff-warning option).
- 2026-09-24, operator (session): F2 completions scoping = **app-scoped**
  (review recommendation accepted: filter to the case's own `app:` bundle;
  show bundle-suffixed entries when the case has no `app:` line).
- 2026-09-24, operator (session, stage 0 gate): sketches reviewed — **A2
  (dedicated /screens page) + B1 (searchable tree list)** picked; B2 not
  taken. Sketches were rebuilt on Axiom tokens before the pick. Stage 0
  complete; stages 1–3 build against A2+B1.
- Branch dependency: **builds on `feat/screen-state-runner`** (PR #1) — the registry API, vocabulary endpoint, and R2 grammar exist only there. If PR #1 merges first, rebase onto main; plan content is identical either way.

## Objective

Make R2 authoring UI-native instead of curl+memorized-yaml. After this arc a
user can: see every registered screen and what its states assert (slice 1),
create/edit screens and states in forms (slice 2), and author states by
picking live elements on a booted sim (slice 3) — then author swap cases with
screen/state autocomplete in the existing editor.

Measurable completion: a user with no curl knowledge can register a new
screen, define a state, and save a swap case that references both — verified
by doing exactly that against the live app during acceptance.

## Confirmed inputs (evidence ledger)

- Registry API exists and round-trips: `GET/PUT /api/apps/:bundle/screens[.yaml]`
  (`server/src/routes/app-screens.ts`; validator in `shared/src/app-screens.ts`
  names offenders precisely — 422s list declared states, the registry endpoint).
- Editor infra exists: `shared/src/yaml-slots.ts` (slot classification),
  `shared/src/yaml-completions.ts` (`buildCompletions`, `EditorVocabulary` with
  OPTIONAL fields as the degradation pattern — `scenarios?`, `variantIds?`),
  `web/src/composables/useYamlEditor.ts`, `web/src/components/CaseEditorPanel.vue`.
- Vocabulary endpoint aggregates per-case data + scenarios:
  `GET /api/templates/vocabulary` (`templates.ts:470`). Does NOT yet know screens.
- Probe infra exists: `POST /api/manual/:id/tree|probe-selector|inspect-sample`
  (`routes/manual.ts:218,298,308`) — manual-session-scoped.
- Crucible UI conventions (user-stated, memory + session): Axiom terminal
  minimal; sketches BEFORE code for UI work; PageHeader two-row system; no
  captions under titles.
- The user is the operator: registry currently holds 1 screen (`home`, 4
  states) for `com.lioparcel.services.consumer.int-dev` — the drill case.

## In scope

1. Slice 1 — authoring awareness (screens panel + editor completions + inline resolution)
2. Slice 2 — registry editor (form CRUD on screens/states/selectors, yaml import/export)
3. Slice 3 — live probe (element → state selector, against a booted sim)

## Out of scope (explicit)

- Recorder emitting R2 verbs (added to BACKLOG as its own entry — open design)
- Screen-state runner changes (verbs, guards — shipped and stable)
- Multi-device/multi-app registry management UX beyond per-app pages
- Android/DeviceAdapter work (backlog #5)

## Stage 0 — Sketches (gate for all UI) — MUST precede code

Per convention. Sketch 2–3 variants for the two real design questions:

a) **Screens panel placement + form**: where it lives (cases page side panel
   vs its own `/screens` page vs per-app section on cases page) and how a
   state's selector-set renders in a form.
b) **Probe interaction**: how "pick a live element" reads (tree list vs
   screenshot with element pick vs both).

Deliverable: `sketches/019-registry-ui/{a,b}/` variants + READMEs; user picks.
No code before the pick.

**Outcome (2026-09-24):** four token-faithful variants (a1 side panel, a2
own page, b1 tree list, b2 screenshot pick — Axiom tokens via shared
tokens.css). **Operator picked A2 + B1.**

## Stage 1 — Slice 1: authoring awareness

**1a. Vocabulary endpoint learns screens.** Extend
`GET /api/templates/vocabulary` with `screens: { screen: string; states: string[]; bundle: string }[]`
aggregated from `app_screens` (all bundles, each entry tagged with its
bundle). Optional field — old callers degrade exactly like `scenarios?` did.
**Scoping rule (review F2, operator-confirmed):** the editor filters screen
completions to the case's own `app:` bundle; when the buffer has no `app:`
line, show all entries suffixed with their bundle. Screen ids are unique
per bundle only — unscoped suggestions would fail save-time validation.

**1b. Slots + completions learn R2 targets.** `yaml-slots.ts`: new slots
`arrive-screen` (after `arrive:` / `refresh:`), `swap-target` (after `swap:`),
`screen-state` (after `expect screen:` — complete `<screen>.<state>` pairs).
**Required parsing work (review F4):** action extraction today is
`/^(\w+)\s*:/` — it cannot match the two-word verb `expect screen`, which
falls into the scalar-expect branch. Extend action recognition to two-word
verbs FIRST (keeping scalar `expect:` behavior intact), or the `screen-state`
slot is unreachable. `yaml-completions.ts`: map the new slots to the new
vocab (app-scoped per 1a). Wire in `useYamlEditor.ts`. Tests: slot
classification for each verb line shape INCLUDING both `expect: x` and
`expect screen: x` forms; completion list contents from a fixture vocab with
two bundles sharing a screen id (scoping pinned); mirror
`yaml-completions.test.ts` style.

**1c. Screens page (read-only, A2).** New `/screens` route + nav entry: one
section per app bundle; per screen a card with entry (plain terms: "tab
Home @ 71,870"), refresh gesture + anchors, states with their selector logic
("label contains Batam" for `{labelContains: Batam}`), and "used by" (cases
referencing the screen, joined from templates). Data: existing registry
API. PageHeader two-row system per convention. Tests: manual verify + gate
(web tests absent — see Validation).

Acceptance 1: typing `expect screen: h` completes `home`; `home.` completes
its states; the panel shows the drill registry without curl. Gate green.

## Stage 2 — Slice 2: registry editor

**2a. Forms.** Screens panel becomes writable per sketch: per-screen form
(id, entry mode + fields, refresh gesture + anchors incl. `back`, states
list with all/any selector rows). Validation client-side pre-submit; server
422s render inline next to the offending field (the validator already names
them — surface, don't reimplement).

**2b. Revision guard on the registry PUT (review F3, operator-confirmed).**
The PUT is total-replace (`DELETE` + reinsert) — two editors, or an editor +
a probe "add as state" (stage 3), would silently destroy one side. Add:
- `app_screens` gains `revision INTEGER NOT NULL DEFAULT 1` (guarded ALTER,
  house pattern; fresh-DB CHECK n/a);
- `GET .../screens` responses carry `revision`; `PUT` accepts `revision` and
  **409s on mismatch** with the server's current registry in the body (the
  editor re-fetches, shows the conflict, user re-applies);
- PUT without a revision field (curl/api scripts) keeps working — only the
  UI sends it (optimistic-concurrency for humans, not a breaking change).
Tests: concurrent-PUT 409 path; PUT without revision succeeds; revision
bumps on every replace.

**2c. Yaml import/export** rides the existing `.yaml` round-trip (textarea
in a modal, same pattern as case editor). Destructive ops (delete screen)
confirm inline (house pattern: window.confirm is the established bar in
EvidenceSheet).

Acceptance 2: register a NEW screen (`tarif-form` — the Cek Tarif screen,
real, reached during the drill) entirely in the UI; break it deliberately
(bad state selector) and see the named 422. Gate green.

## Stage 3 — Slice 3: live probe

**3a. Probe session (B1).** From the screens page with a booted sim: start
(or reuse) a manual session for the device; fetch `/tree`; render the live
element list (label/identifier/type) searchable; select element → proposed
selector → "add as state" appends a state to the open screen form (name
prompted) — dialog shape per sketch b1 (filter + node rows +
identifier-preferred proposal + verify/add). Notes (review F5/F6): the identifier→label proposal preference is
`screen-runner.ts selectorMatches`' order (NOT selector.ts's hittable-preferring
policy) — the proposal helper moves to shared with the F1 move and carries
its own unit test; probe degrades to a clear error state on session expiry
(410 SESSION_NOT_FOUND, observed live) rather than hanging; concurrent
second-session behavior is checked during the build.

**3b. Verify-against-live.** Optional affordance per sketch: run a state's
selector-set against the current tree and show match/no-match. Prerequisite
(review F1): **move `stateHolds` + `selectorMatches` + the `SnapNode` shape
from `server/src/manual/screen-runner.ts` into `shared/src/app-screens.ts`**
(web imports only @crucible/shared); `screen-runner.ts` re-imports from
shared — pure move, behavior pinned by the existing 12 runner tests plus a
new shared-side unit test.

Acceptance 3: with the drill sim booted, author a new state on `home` by
picking a live element, save, and confirm it appears in completions. Gate green.

## Validation (all stages)

- `pnpm run check` full gate after each stage (current baseline 956/956)
- `pnpm run build` (vue-tsc in the web build)
- New unit tests: slots/completions incl. two-word-verb parsing +
  app-scoping fixtures (stage 1), validator-surfacing + revision-guard 409
  paths (stage 2), shared-side stateHolds + selector-proposal preference
  (stage 3)
- Live acceptance per stage as written above (user witnesses or I record
  evidence; live drills are the established proof bar on this project)
- No regression: existing editor completions keep working (the optional-field
  degradation pattern guarantees old vocab responses still render)

## Risks / edges

- Editor is a textarea; completions are word-list-at-cursor. If slot
  detection for the new verb lines proves brittle, fall back to completing
  only after exact prefixes (`expect screen: `, `swap: `) — precision over
  recall; CodeMirror is a separate decision, not smuggled in here.
- Probe needs a booted sim + engine runtime; panel must degrade to "no device
  booted" state honestly (established empty-state pattern).
- Registry is per-bundle; the cases page is not bundle-centric today — the
  sketch decides the grouping (this is sketch question 0a, not a hidden decision).
- `app_screens` has no audit history; if the user wants versioning there it
  is a NEW question (not silently added).

## Rollout

Commits per stage on the working branch (R2 branch until PR #1 merges, then
main); each stage independently shippable; sketches committed under
`sketches/019-registry-ui/`.
