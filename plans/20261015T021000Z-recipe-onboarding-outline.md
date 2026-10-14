# Recipe Onboarding Gate — Registration, Recipes-as-Data, and AI for the Long Tail

- Source prompt: "Should the system [gate recipe state] when a user registers a new repo or project? Should we use AI too? This should work for any kind of iOS projects. Show me the outline of the plan."
- Created: 2026-10-15T02:10Z
- Status: SUPERSEDED by 20261015T021000Z-recipe-onboarding-plan.md (READY, review gate next)
- Sessions: identifier-gate/compile-gate arc (sess_e157cc04-da8 forward), PR #424 line

## The problem in one paragraph

Registering a project today is a silent hope: no recipe → discovery fallback guesses a scheme, and the first truth anyone hears is a failed (or falsely-green) build minutes later. The recipe itself lives as git-invisible files inside someone else's repo (`.lionidas/`, excluded via `info/exclude`), which produced this session's entire pitfall class: invisible to worktrees, silently missing for six days, machine-config-dependent safety. Meanwhile onboarding an unfamiliar repo shape (CocoaPods, Tuist, secret xcconfigs) is pure archaeology — five compile attempts for intl.

## Non-negotiable principles (decided in-session)

1. **A silent fallback is a lying build.** Registration is the one moment a human is watching — recipe state must be explicit.
2. **AI proposes, never disposes.** Model output is a diff (structured recipe data + evidence), behind a HARD STOP confirmation. Never silent self-healing; never a model-granted green light.
3. **xcodebuild is the only oracle.** Green = the build ran green.
4. **Secrets are a human gate.** Missing certs, private spec-repo creds, gitignored xcconfigs → "blocked: needs X from you", never AI-synthesized.
5. **Generic schema, any iOS project.** Recipe = transport + scheme + config + ordered prepare steps (arbitrary shell). The schema doesn't care what a step does. Two live archetypes must both work: intl (xcodegen+SPM+scipio) and consumer (CocoaPods+committed pbxproj).

## Slices (each independently shippable, in order)

### Slice 1 — Registration-time detection + honest three-state report (deterministic)
- New module `projects/recipe-detect.ts`: classify a registered repo's workspace into
  - **found**: `lionidas.yml` at root or `.lionidas/`, or repo-lane (`scripts/build-sim.sh` / fastlane `build_sim`) → report source + parsed recipe
  - **derivable**: detector can produce a complete recipe (exactly one app scheme after generation where the archetype demands it, configurations readable) → propose auto-written minimal recipe marked `generated: true — review me`
  - **blocked**: name the exact blockers (scheme ambiguous N ways, `Podfile` without installed pods, xcodegen/Tuist ungenerated, missing xcconfig paths, needs-secrets) — each with the file/line evidence
- Archetype detector (pattern files, no reasoning): committed `.xcodeproj` / `.xcworkspace`, `Podfile`, `project.yml` (xcodegen), `Project.swift` (Tuist), `Package.swift` (SPM app), fastlane lanes
- Registration API + UI: registration response carries the three-state report; the Projects page renders it (green / "generated — review" / red-with-blockers)
- Status canary consumes the same detection (replaces the current recipe card's ad-hoc probe)
- Gates: unit tests with fixture repos per archetype; live check against both real repos

### Slice 2 — Recipes as data, out of the repo (the structural fix)
- New `recipes` storage (server-side, keyed by project): transport, scheme, configuration, ordered prepare declarations, `generated` flag, provenance (who/what wrote it, when, from what evidence)
- Per-project prepare scripts live server-side (`server/recipes/<project>/prepare-*.sh`), versioned in the Lionidas repo — not inside the target repo
- Build engine + compile gate receive the recipe explicitly from the host; deprecate the in-repo `.lionidas/` read (import once from intl, keep repo-committed `lionidas.yml` as an override that wins — the repo speaking for itself)
- Worktree overlay carry + pathspec exclusion become dead code paths for new projects (keep for legacy until migrated)
- Migration: intl's `.lionidas/` imports into the store; `ios-consumer` gets its first recipe (CocoaPods archetype: `pod install` prepare step)
- Gates: build engine tests against fixture recipes; a green compile gate run per real repo post-migration

### Slice 3 — Verify build at registration (turn state into a verdict)
- One-click "verify build" on the Projects page (and auto-offered at registration when derivable): runs the existing compile-only gate (no `.ipa`, ~5 min), stores the verdict + timestamp on the project
- Project status semantics: `recipe: verified <date>` / `generated, unverified` / `blocked` — the canary upgrades from "recipe present" to "recipe last proven at T"
- Weekly scheduled verify-build: REJECTED by user (2026-10-15) — on-demand verify only; the 'unverified/stale' badge is the nag. No scheduler ships

### Slice 4 — AI seat: proposal + diagnosis for the long tail (uses slices 1–3)
- Trigger A — **unclassifiable or blocked repo**: registration hands the repo to the model through the existing editor/proposal seam (`/implement-identifiers` pattern): read repo → proposal table (archetype read, scheme choice, prepare chain, xcconfig/secret findings — each row with file:line evidence) → HARD STOP → on confirm, writes a structured recipe (slice-2 store), `provenance: ai+user`
- Trigger B — **verify build fails**: the failure log goes to the model for a diagnosis proposal (root cause + the exact prepare/config change, evidence-cited) → same stop gate → applied as a recipe revision, then re-verify (bounded retries, human between each)
- Both rides the existing cwd/proposal/confirm machinery — no new seams; butler stays workflow-agnostic
- Explicitly out of scope: AI touching secrets, AI deciding green, silent recipe mutation

## What success looks like

- Register any of our two real repos fresh → three-state report in seconds, zero silent fallbacks
- A third, unfamiliar repo (Tuist or Pods demo fixture): detection or AI proposal produces a recipe; verify build proves it; every claim in the proposal cites a file:line
- The status page never again shows "passed" for a build that didn't use its recipe

## Decisions locked (user, 2026-10-15)

1. Recipe storage: SEPARATE `recipes` table (revision rows; migrate `projects.build_scheme`/`build_configuration`)
2. Detector fixtures: one per archetype, derived from REAL repo shapes (intl + consumer first two); detector tests also run against both live repos — not fixtures only
3. Prepare scripts: IN our repo (`server/recipes/<project>/`), trust enforced by verdict — no recent green verify ⇒ 'unverified' on status
4. Weekly verify scheduler: NO — on-demand only

## Risks / open questions (to resolve in the reviewed plan)

- Recipe storage vs `projects` table columns (separate table likely; migration of `buildScheme`/`buildConfiguration`)
- Server-side prepare scripts are per-machine knowledge too — same trap one level up? (No: they live in OUR repo, versioned and reviewed — but the plan should say so explicitly)
- The archetype detector's fixture matrix is the real test cost; keep fixtures minimal but one per archetype
- ~~Weekly verify-build scheduling~~ — decided: NO scheduler (user, 2026-10-15)
