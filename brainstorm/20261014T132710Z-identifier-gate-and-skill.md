# Hard identifier gate + an identifier-implementation skill — brainstorm

- Source prompt: "I want to hard block test cases creation if each identifiers needed for the steps are not implemented. Which I want you to create a new skill to implement those identifiers in the codebase. But we'll need the best workflow for this… think of everything thoroughly."
- Created: 2026-10-14T13:27:10Z
- Status: Exploring

## Goal and context

Two coupled features:
1. **The gate** — case creation (`case.draft.save` / validation) REFUSES any case whose steps use an `identifier:` selector that does not exist in the app's codebase. Labels/`labelContains`/coordinates stay allowed (they resolve at runtime against the live hierarchy) — the gate covers only identifiers, which are compile-time-verifiable.
2. **The skill** — when the gate trips, a workflow that IMPLEMENTS the missing identifiers in the iOS codebase (SwiftUI `.accessibilityIdentifier(...)` / UIKit `accessibilityIdentifier = ...`), so authoring unblocks by fixing the app, not by falling back to worse selectors.

Direct statements (confirmed): hard block (not warn); the block is per-identifier-needed-by-steps; the fix path is a new skill that edits the app repo; "best workflow" wanted before building; think through everything.

Interpretations (not confirmed): the gate applies at the MCP tool boundary (`case.draft.save`, `case.validate`) and the matching REST route; "skill" means a Lionidas-side workflow (like /planning → /breakdown → /author) possibly with a slash command (e.g. `/implement-identifiers`), not a Hermes skill.

## Confirmed inputs and decisions (code-verified facts)

- Selectors today: `on:` accepts identifier (snake_case regex), exact label, `labelContains`+`ignoreCase`, `type`; coordinates as x/y (`shared/src/case-yaml.ts:19,368`). A plain string is an identifier IFF it matches `^[a-z][a-z0-9_]*$` — so the gate must inspect both plain strings and `{identifier: …}` mapping form.
- `resolveCaseRefs` (templates.ts:213) validates screens/recipes/scenarios refs today — **no identifier existence check exists**. The natural seam for the gate.
- Identifier evidence source: repo ingestion (`butler_documents` chunks) — `.accessibilityIdentifier`/`accessibilityIdentifier` strings exist in ingested Swift sources (the system prompt already tells the model to search them). No structured index exists today; the oracle needs one (grep-per-check would be both slow and false-positive-prone: comments, string literals, non-UI code).
- App↔repo mapping: `repo.apps` MCP tool exists (bundle ids per registered repo) — enough to know WHICH repo to search/edit for a bundle.
- The app repos are iOS (ios-consumer etc.); adding an identifier is a one-line SwiftUI modifier or UIKit assignment at a specific view — but landing it requires a branch, build, PR, and the app team's merge (house rule: PRs create-only, human merge).
- Existing rhythm to reuse: `/planning → /breakdown → /author` command pipeline with per-command tool narrowing (`orderCommands`/`toolsFor`), selector-trust notes (kind selector-trust, scope app/screen), and the MCP tool surface (repo_read/repo_tree/…). PR #42 just fixed the array-param seam, so bulk tools now work over MCP.

## Exploration

### A. The gate — where and how hard

**Oracle: a per-app identifier INDEX, not grep.**
Build `app_identifiers(bundle, identifier, evidence: file/symbol/kind, indexed_at)` from repo ingest: scan Swift chunks for `.accessibilityIdentifier("…")` / `accessibilityIdentifier = "…"` / `Identifier("…")`-style calls, extracting the string literal + location. Re-index on ingest refresh. The gate = one indexed lookup per identifier used by the case's steps (+ setup steps, + screen registry entries' navigate `on:` selectors — same rule, one place).
- Where: inside `resolveCaseRefs` (both REST and MCP paths flow through it) + `case.validate` gets the same answer automatically. Error must be verbatim-actionable: `INVALID: step 3 uses identifier "btn_pay_now" which does not exist in <repo> code (indexed N files; last sync X ago). Use /implement-identifiers to add it, or switch to label/coordinates (last resort).`
- Staleness honesty: if the index is older than the repo's HEAD (or > N days), the gate says so in the error instead of silently blocking on stale data (the stale-ingest bug class from earlier sessions).

**Escape hatches (must exist, else the gate deadlocks authoring):**
- label/labelContains selectors remain ungated (runtime-verifiable only);
- an explicit override for cases that intentionally target not-yet-shipped builds? RECOMMEND NO in v1 — a hard block is the point; if the identifier isn't in code, the case can't pass on any build. Instead: the case stays unsaved and the ask becomes "implement the identifier first," which is exactly the workflow below.

### B. The skill — workflow options

**Option 1 — slash command `/implement-identifiers` (recommended).**
A fourth pipeline command (order 4, after author) the user (or the blocked /author flow itself) invokes with the missing identifiers list:
1. **Confirm targets**: skill lists each missing identifier → proposed Swift location (from screen registry + repo search for the nearest view code) → proposed modifier line. User confirms scope (all / pick).
2. **Branch + implement**: for each identifier, repo_read the target view, insert `.accessibilityIdentifier("id")` at the right control (matching by label text or view structure), commit to `feat/identifiers-<case-slug>`.
3. **Build-gate**: compile the app scheme (xcodebuild) — an identifier in the wrong place still compiles, but a syntax error must not land.
4. **PR**: create-only PR to the app repo, body = the case ids this unblocks + the selector-trust notes it retires. Human merges (house rule).
5. **After merge**: re-ingest the repo → index updates → gate passes → the case saves.
Tool narrowing: needs repo WRITE tools (new: repo_branch, repo_edit, repo_commit, repo_pr) — currently the agent has read-only repo tools + Bash is hard-denied. This is the biggest new surface; gate it behind the command (only during /implement-identifiers) and draft-permission.
- Fits: matches the existing command pipeline; the human stays in the loop at exactly the right points (confirm scope, merge PR); works with the merge-then-reindex reality.
- Cost: repo write tools + build invocation are genuinely new machinery; PR-then-wait-for-merge means the case isn't saved until later (the flow must support "park the case, resume when identifiers land").

**Option 2 — agent edits via worktree, no slash command (auto-offer).**
When /author trips the gate, the same turn automatically switches to implementing identifiers.
- Rejected: mixes two permission domains (test-authoring vs app-editing) in one turn; no confirmation point; violates the plan→approve rhythm.

**Option 3 — code-gen request ticket (no agent edits).**
Gate trips → skill files a Jira/GitHub issue per missing identifier with proposed locations, app team implements.
- Fits orgs where agents must not touch app code. But the user explicitly asked the skill to IMPLEMENT identifiers in the codebase — this is the fallback, not the ask.

**Recommended: Option 1** with Option 3 as a mode (`--ticket`) if the app repo turns out to be hands-off.

### C. The loop closure (why this design)

Gate → skill → PR → merge → re-ingest → index → gate passes → case saves. The case should be **parkable**: /author saves a draft-with-blocked-markers (or keeps the yaml in a note) and, once the index shows the identifiers, a single "resume" completes the save. Without parking, a hard gate means lost authoring work whenever it trips — the difference between a gate and a wall.

### D. Edge cases (the "think of everything" pass)

1. **Identifier exists in code but on the wrong control** — index can't prove correctness, only existence. Accept: existence-gate v1; correctness is caught at playback/triage. Say so in the skill output.
2. **Case targets TWO apps** (steps across bundles?) — grammar pins one app per case; gate per case's app.
3. **Dynamic identifiers** (string-built, e.g. `"\(prefix)_btn"`) — index misses them; gate would false-block. Mitigation: index also records `accessibilityIdentifier(` with non-literal args as `dynamic` evidence, and the gate accepts a dynamic marker with a warning in the error text (or a note-based override scoped to that identifier with evidence link). Needs a decision.
4. **Repo not ingested / index empty** — gate must distinguish "no index" from "identifier missing": no index → INVALID with "run sources ingest first" (honest, actionable), never a silent pass OR a blind block.
5. **Setup steps + screen entries** also use selectors — gate them identically (one validator, three call sites).
6. **Identifier conventions** — the skill should propose names following the app's existing convention (mine the index for the dominant pattern: `btn_`, `home_`, etc.) so identifiers land consistent, not agent-quirky.
7. **Build gates on this machine** — xcodebuild for ios-consumer takes real time; the skill should compile ONLY when edits landed (not per identifier) and stream progress.
8. **Two cases needing the same identifier** — skill dedupes; one PR covers all currently-missing identifiers for the app.
9. **Merge conflicts / upstream moved** — branch from fresh develop; if PR conflicts, re-run the skill step (idempotent: skips identifiers already in index).
10. **Multi-repo apps** — bundle maps to one repo today; if that changes, the index keys by bundle and the skill edits whichever repo provides the bundle.

## Decisions (user, this round)

1. Repo write: **YES — agent may branch/edit/PR the app repo**, with "the best possible and safer workflow" (detailed walkthrough follows; hard confirmation stop before any write, per-identifier commits, compile gate, create-only PR).
3. Skill home: **Lionidas slash command** (pipeline order 4).
4. Naming convention: **recommend-only** (mined from the app's dominant pattern, shown in the proposal, never enforced by the gate).
2. Dynamic identifiers: *explained to user this round — decision pending; default pass-with-note + mandatory selector-trust note.*

## Design pivot (user, this round): no repo.edit tool — the claude CLI edits, host does git

"I still don't trust your repo.edit tool. Why not let claude do it?" — correct call.
The claude-cli harness already runs under `--permission-mode acceptEdits` with
Read/Grep/Glob allowed and Bash hard-denied: it IS a code editor, natively.
Rebuilding edit-through-MCP would be a worse copy of a battle-tested tool.

REVISED division of labor for /implement-identifiers:
- HOST (lionidas, no model access to these): git worktree add -b feat/identifiers-<slug>
  from origin/develop; after the turn: per-identifier commits, xcodebuild compile gate,
  push, gh PR create (create-only), worktree cleanup. The model NEVER touches git.
- CLI (claude, spawned with cwd = the worktree): native Read/Grep/Glob to find the right
  views, native Edit to insert .accessibilityIdentifier(...) lines, MCP lionidas tools
  still mounted for case/screen context. Its only new capability is editing files inside
  a throwaway worktree — no shell, no push, no main-checkout access (different path).
- Worktrees (user suggestion, adopted): isolation per turn, parallel turns per repo,
  cleanup = git worktree remove; failure = discard worktree, nothing ever happened.

Requires: claude-cli provider gains a per-spawn `cwd` option (small butler change —
spawn opts only). Phase II shrinks from "4 custom write tools" to "provider cwd seam +
host worktree/git driver + command spec".

## Open questions

1. **Repo write permission** — is the agent allowed to branch/edit/PR the ios-consumer repo directly (Option 1), or must it be ticket-mode first (Option 3) with write-mode later? This is an org-policy decision bigger than code.
2. **Dynamic identifiers (edge 3)** — accept `dynamic` evidence as a pass-with-note, or hard-block until made literal? Affects how often the gate false-trips.
3. **Skill home** — Lionidas slash command (recommended) vs Hermes skill? The former keeps the workflow inside the same agent session that authored the case (context reuse: it already knows the intended controls).
4. **Identifier naming convention enforcement** — should the skill/gate RECOMMEND or ENFORCE a convention (block non-conforming new identifiers)?

## Next step

Answer the four questions (defaults if silent: 1 = write-mode with per-run confirmation, 2 = pass-with-note + mandatory selector-trust note, 3 = Lionidas slash command `/implement-identifiers` as pipeline order 4, 4 = recommend-only). Then plan → review → implement in three stages: (I) identifier index + gate (with staleness honesty), (II) repo write tools + the command skill, (III) case parking + resume + the index-refresh loop.
