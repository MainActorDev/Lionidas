# Review — Device cockpit page plan

- Plan reviewed: `plans/20261002T061158Z-device-cockpit-plan.md` (Ready, commit `6b2b8e4`)
- Evidence: plan + both closed brainstorms + the locked spec (`sketches/022-cockpit-final2-single-switch/` incl. README) + sources read 2026-10-02: `web/src/router.ts`, mounts of DeviceSidebar (WallPage.vue:305, DeviceRail.vue:4, DrivePage.vue), `web/package.json` (scripts; NO vitest in web devDeps), `server/src/routes/manual.ts` route inventory, crucible skill web-UI conventions + drive-panel references (session-lost class, tap-mapping chain, both-drive-surfaces rule).
- **Verdict: Ready for implementation (rev 2)** — F1–F6 all applied (operator took both recommendations: vitest+@vue/test-utils added in S1; chat context auto-prepends). F2's split landed: round 1 deletes only /drive+DrivePage, DeviceSidebar survives for WallPage. Original findings retained below for traceability.
- *(Original verdict, superseded: Needs revision — F1 unbuildable test strategy, F2 sidebar blast radius.)*

## Traceability

Locked-spec → plan: T1 menubar ✓ (condition 2), switcher + single spacious stage ✓ (3, 4), watch|chat rail ✓ (5, 6), env drawer ✓ (7), deletion ✓ (8). Operator decisions all carried verbatim in the decision log. Reusable containers promoted to S1 per "side panel container should be reusable" ✓.

## Findings

### F1 — HIGH — The plan's component-test strategy cannot run: web has NO test runner

- Evidence: `web/package.json` scripts = dev/build/typecheck/lint/check only; `vitest` absent from devDependencies (checked 2026-10-02). The plan's S1 promises "mount tests / usage tests (vitest + vue test utils if present — verify; else…)"; the "else" branch is unspecified and the fallback would silently become no tests.
- Consequence: S1's acceptance check is unbuildable as written; either tests get dropped silently (violating the plan's own TDD claim) or the stage stalls mid-build.
- Correction (decision required, pick one): **(a) add vitest + @vue/test-utils to web devDeps in S1** (one-time infra commit; ~2 deps; hermetic component tests; recommended — the server already runs vitest so the toolchain is familiar); or (b) drop component tests and replace with a DOM-assertion drill script (tsx + happy-dom? — also a new dep, worse); or (c) verify visually only (weakest — contradicts "TDD where testable").
- Verify: S1 first commit adds the runner and a failing-then-green mount test for WatcherPanel; `pnpm -C web test` exists and passes.

### F2 — HIGH — DeviceSidebar deletion blast radius is understated: WallPage.vue:305 and DeviceRail.vue:4 ALSO mount it

- Evidence: DeviceSidebar is imported by DeviceRail.vue (comment: "mechanics mirror… in DeviceSidebar") and rendered by WallPage.vue:305 with lease-display/run-active props; DrivePage imports it too. The plan says "DeviceSidebar drive affordances removed from wherever it mounts (wall page keeps its non-drive parts)" — but DeviceSidebar is ~1,286 lines mixing stream preview, manual-drive controls, inspect tools, and recording→template save (line 521+). "Remove affordances" from a shared 1.3k-line component while WallPage keeps using it is a refactor of WallPage's sidebar, not a deletion.
- Consequence: S5 as written either breaks the wall page or hides a significant refactor inside a "deletion" stage — scope surprise mid-build.
- Correction: S5 splits into two explicit steps: (1) **CockpitPage replaces DrivePage + `/drive`** (DrivePage.vue deleted; DeviceRail keeps working — it consumes DeviceSidebar, which stays FOR NOW); (2) **WallPage sidebar follow-up**: decide separately whether the wall sidebar links to `/cockpit?udid=` (recommended, cheap) or gets slimmed. The plan must state that DeviceSidebar survives round 1 and its removal is its own future arc.
- Verify: `pnpm -C web build` green with WallPage untouched; `/drive` 404s; nav routes to `/cockpit`.

### F3 — MEDIUM — Chat tab auth + session lifecycle unspecified

- Evidence: `/api/agent/*` requires operator session/cookie; the plan says "PAT/session auth via the existing authed fetch layer" — the web app authenticates via the login session cookie (same-origin), which DOES work for the conversation API. But the conversation API creates agent sessions server-side keyed by nothing device-related; the plan's "device-context footer" claims the agent "sees what you see" — nothing in round 1 sends device context to the agent (the parked `device.state.get` tool is out of scope).
- Consequence: the footer text overpromises; user asks "what's on my screen" and the agent can't know.
- Correction: round-1 chat footer shows context as UI-only annotation (no agent claim), OR the first message auto-prepends a context line (device id + screen state) into the user's message text — cheap, honest, no server change. Plan should pick (recommend the prepend; it makes the context REAL).
- Verify: chat drill shows the context line in the sent message; agent answer references the device.

### F4 — MEDIUM — Logs section data source needs naming (run-steps ≠ device logs)

- Evidence: plan says logs render "run_steps narrate/reason stream + forge traffic" — true and available, but these are LIONIDAS run logs, not DEVICE logs (the operator asked for "device run logs"). Parking `simctl log stream` is right for round 1, but the section must be LABELED honestly ("run activity", not "device logs") or the gap will read as a bug.
- Correction: S3 labels the section per what it shows; the plan's out-of-scope note gains one line: device-log streaming is the parked server work, round-1 section = run activity + traffic hits.
- Verify: rail section header matches rendered content; no "logs" label over non-log data.

### F5 — LOW — Screen-state chip resolution order unspecified

- Evidence: stage chip shows `screen · home/world-sg` in the sketch; deriving it needs live AX → match against the app's registry states — the inspect-mode machinery does AX capture, but a passive "current screen" resolver may not exist as a cheap call.
- Consequence: S2 could stall inventing a resolver.
- Correction: S2 ships the chip from the cheapest honest source: (1) last run's arrival screen if a run is active, (2) manual session's screen if the inspect data flows, (3) `—` placeholder otherwise. Plan states the fallback ladder.
- Verify: chip renders one of the three sources; never a fabricated state.

### F6 — LOW — Router/nav specifics

- `/drive` → `/cockpit` redirect (old muscle memory) vs plain removal; nav title case ("cockpit" per router meta convention seen: 'manual control'). Minor; plan should just say: remove `/drive`, add `/cockpit` with meta `{ title: 'cockpit' }`, no redirect (internal-only tool).

## Required plan edits for rev 2

1. F1: pick test strategy (recommend adding vitest+@vue/test-utils in S1).
2. F2: split S5; DeviceSidebar survives round 1; WallPage untouched or link-only.
3. F3: chat context = auto-prepend line (recommended) — decide.
4. F4: rename section honestly + out-of-scope line.
5. F5: chip fallback ladder stated.
6. F6: router specifics.

## What remains for implementation to validate

Everything execution-shaped: the five-state visual comparison, stream performance with the rail live-updating, chat message flow end-to-end, and the deletion refactor safety net (`pnpm build`) — reviewed on paper here, proven at S-gates.
