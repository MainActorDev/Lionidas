# @-mention UX rebuild — caret-anchored palette + Slack-style inline chips — PLAN

- Source brainstorm: `brainstorm/20261013T072312Z-mention-ux-famous-apps.md` (commit `bc25f13`)
- Created: 2026-10-13T09:42:04Z
- Status: **Ready** — both open questions answered by operator (decision log)

## Decision log (operator, 2026-10-13)

1. **Inline chips = YES, Slack-style.** Operator: "1, Slack-style seems good." Chips render as tokens AT THE CARET inside the composer; Backspace removes them as units; no chip rail below the input.
2. **Mentionables = YES to Lionidas-native entities.** Operator: "2. Yess" — test cases/suites are mentionable alongside Jira/repos/files.

Both decisions verified feasible against existing machinery: refs endpoints (`refs-routes.ts:42-64`), `cases.search` tool (`config-tools.ts:696`), attachment store listing (rev23).

## Objective and completion conditions

The @ flow matches the famous-app convergent pattern (brainstorm §Exploration). Done when:

1. Typing `@` in the composer opens ONE palette at the caret within 150ms; typing after `@` filters it live (query = token text from `@` to caret); the composer NEVER loses focus.
2. The palette shows grouped, fuzzy-scored results: **Recent** (previously used refs, session-first), **Jira**, **Repos** (commits/PRs across ALL registered repos), **Cases** (Lionidas test cases/suites via cases.search), **Files** (session attachments). Honest state rows (unconfigured/loading) render as locked rows.
3. Keyboard-first: ↑/↓ move, Enter picks, Esc closes, Backspace on the @ token closes the palette; click works for mouse users.
4. Picking inserts a **Slack-style inline token** at the caret: visually a chip INSIDE the text flow, a single Backspace-removable unit, and it serializes into the send payload exactly as today's `refs` array (no backend contract change).
5. Attachments get a `+` button in the composer (paste/drop unchanged); `@` still finds ALREADY-ATTACHED files by name for in-prompt reference.
6. The old two-level family menu + repo wizard + in-menu search box are DELETED (not kept behind a flag).
7. Regression: /planning skill with refs, run panel, streaming, per-session state all still work; web suite green.

## Scope

**In:** Composer.vue rewrite of the @ state machine (family/pickers/repo-pick levels → single palette + inline tokens); new `inline-token` sub-component (textarea overlay technique — see Method); new server endpoint `GET /api/agent/refs/search?q=` (merges jira + repo commits/PRs + cases + attachment names, capped, grouped); Recent-refs memory (localStorage per session, no server change); `+` attachment button; tests (component + endpoint); live drill.

**Out:** mentioning arbitrary knowledge pages / notes (future); changing the `refs` wire contract; mobile layout; the slash-command menu (already ChatGPT-style, untouched).

## Method (the inline-token technique)

Textarea cannot render rich content. The technique (review MR1 — RANGE-TRACKING, not sentinels):
- The textarea value holds PLAIN TEXT ONLY — exactly what the user sees/typed, no invisible characters ever (U+200B-class sentinels are FORBIDDEN: they corrupt drafts, trip IME/screen readers, and leak into sent messages when parsing fails).
- Tokens are `(start, end, kind, locator, title)` RANGES in component state.
- A transparent-text overlay `<div>` with identical metrics sits behind the textarea and renders those ranges as chip spans.
- Picking from the palette rewrites the visible text at the caret (standard autocomplete: insert `@Title ` and record the range).
- Backspace-as-unit: keydown interception — caret at a range start deletes to range end.
- Send maps live ranges → refs; text is already clean.
- Avoids contenteditable entirely (no IME/undo nightmares); worst case degrades to plain @text (honest, visible).

**Palette positioning:** anchored above the caret via the overlay's caret coordinates (mirror-node measurement — no new deps).

## Interfaces

```
GET /api/agent/refs/search?q=<fuzzy>&sessionId=<sid>
→ { groups: [
    { kind: 'recent', rows: [{ id, title, meta, kind, locator }] },
    { kind: 'jira', rows: [...] | { state: 'unconfigured'|'loading'|'error', msg } },
    { kind: 'repo', rows: [{ title: 'sha subject', meta: 'repo · branch', locator: 'repo/sha' }] },
    { kind: 'case', rows: [{ title: 'case name', meta: 'suite · status', locator: 'case:id' }] },
    { kind: 'file', rows: [{ title: 'filename', meta: 'attachment size', locator: 'att:id' }] },
  ], cacheHint: 30s }
```
TWO-TIER response (review MR3): the LOCAL tier (recent/repos/cases/files — all local: git, SQL, store) returns synchronously, budget < 150ms, asserted in tests; the JIRA tier (a remote API call, 300ms–2s) is ASYNC — the palette renders a 'searching jira…' row that fills in when the group lands (separate `/refs/search/jira` fetch, client-side). Caps: 4 rows/group, 16 total. Debounce 200ms client-side. The < 150ms budget applies to the local tier ONLY.

**Case refs are a NEW ref kind** → butler `PipelineRef` gains `'case'` (the skill pipeline passes them through; the agent system prompt documents the `case.get`-equivalent — cases are already readable via `case.yaml.get` tooling).

## Stages

### A — Server: unified search endpoint
`refs/search` in refs-routes.ts; jira (existing fetch), repos (local git log across reposRoot, matched by sha-prefix/message fuzzy), cases (SQL LIKE on name/key), files (attachment store). Tests: grouped shape, caps, unconfigured-jira honest row, empty-q returns recent+top groups. **Note:** repos/commits search is sha-prefix + message substring (fast local git); full cross-repo fuzzy on message bodies is capped at 200 commits/repo recent window.
### B — Composer: palette state machine + caret anchoring
Replace AtLevel machine with: `atOpen`, `atTokenRange` (start..caret), debounced fetch, grouped rows model, keyboard nav, Esc/Backspace close, click pick. Position: mirror-node caret measurement. DELETE family/repo-pick levels + in-menu search box.
### C — Inline tokens (Slack-style)
Range-tracking model + overlay renderer + Backspace-as-unit + send-time range→refs mapping. Recent-refs memory (localStorage, keyed by session, max 8) feeds the palette's Recent group ONLY — the draft is never pre-populated.
### D — Attachments `+` button + cleanup
`+` button opens existing picker; `@` Files group lists session attachments by name. Remove `open-attachment` family branch.
### E — Case refs end-to-end
Case refs: FIRST check whether lionidas' PipelineRef is structurally open (`{kind, locator}` passthrough, no butler change) — prefer that; only extend butler's union if it is closed, and then retag+repin (review MR4). System-prompt line ("@-mentioned cases arrive as case: refs — read via case.yaml.get"). The decision (which path + why) is documented in the implementation commit. Tests + drill.
### F — Sketch gate (BEFORE B implementation), live drill (after E)
Per house convention: 2–3 sketch variants of palette + inline chip styling (tokens.css/Axiom) — operator picks, THEN B/C/D/E build to the chosen sketch. Final: live drill (type @, pick jira + case + file, send with /planning, follow-up), suites, PR.

## Edge cases bound into stages

- `@` at start vs mid-sentence: token = from `@` to caret; word-char before `@` suppresses the palette (email-safe).
- Two tokens in one message: both parse; overlay renders both; Backspace removes nearest-first.
- Palette open + composer blur: palette closes, token stays as raw text (recoverable).
- Network error mid-search: palette shows the honest error row (existing pattern), prior rows kept.
- Paste containing `@text`: does NOT trigger the palette (only typing does).
- IME composition: palette suppressed during composition events.
- Recent refs pointing at deleted entities: row renders with meta "gone" and picking it shows an inline notice, not a dead chip.

## Validation & acceptance

1. Component tests: palette open/filter/nav/pick; token insert/remove-as-unit; send payload contains refs + clean text; blur/paste/IME safety.
2. Endpoint tests: grouping, caps, honest states, case/fuzzy shapes.
3. Live drill: `@CUST-6` → pick ticket → `@733e` → pick commit → `@login` → pick case → send with /planning; follow-up question; reload → the DRAFT stays empty and the palette's Recent group shows the previously used refs (review MR2 — no draft pre-population).
4. Suites: web, server, tsc ×2. No new npm deps.

## Rollout

Fresh branch `feat/mention-palette` off main. Sketch gate at F-start (variants approved before build). Single PR; human merge.
