# @-mention UX — learn from the major agentic chat apps

- Source prompt: "I still don't like the UI/UX behavior of the mention '@' feature. Including how we can choose reference and so on. We should learn from other famous agentic chat apps." (+ skill invocation; PR #36 merged, on main)
- Created: 2026-10-13T07:23:12Z
- Status: Direction selected — research-backed proposal; 2 questions open before plan

## Goal and context

The user has now complained about the @-mention flow TWICE (first: search should live inside the dropdown — fixed mechanically in R2; now: the whole choose-a-reference *behavior* still feels wrong). The goal is a reference-picker UX that matches what people know from Claude.ai / ChatGPT / Cursor / Linear — not incremental polish of our current two-level menu.

## Confirmed inputs and decisions

1. Operator: the "@" feature's UI/UX behavior is still not liked, including reference choosing broadly. Learn from famous agentic chat apps. (verbatim intent)
2. PR #36 merged; we are on `main` — next work branches fresh.
3. Current implementation facts (verified in `Composer.vue:119-290`, 511 lines):
   - Two-level state machine: family menu (`@jira`/`@repo`/`@attachment`) → per-family picker (`AtLevel: closed|family|jira|repo|repo-pick|attachment`).
   - Jira: separate search input inside menu header, debounced live search, honest state rows (unconfigured/loading/error/hint).
   - Repo: THREE steps — pick repo → segment strip (commits|pulls) → branch strip → rows; filter box per level.
   - Multi-select: chips accumulate (`pickedKeys`), re-click unselects, menu stays open.
   - Attachments EXIT the menu entirely (`open-attachment` → different flow).
4. Prior operator complaints (session history): "@jira should show the search bar inside its dropdown, not using the chat input as search" (fixed R2); chips leaking across sessions (fixed); capsule overflow (fixed).

## Exploration — what the famous apps actually do (patterns, from public UX)

- **Claude.ai**: typing `@` opens ONE flat command-palette-style list; typing CONTINUES IN THE CHAT INPUT and filters that list (search-in-place, not a separate box); recent items first; Enter picks; Esc closes; chips are inline tokens in the input.
- **ChatGPT (@ in composer)**: same — the mention query rides the text caret position; the menu is a lightweight list directly above the caret; no level-2 navigation; attaching files is a SEPARATE button, not an @ family.
- **Cursor (@ files/@ docs)**: one palette, grouped results (recent / files / folders), fuzzy match, arrow keys, multi-select via shift or repeated @-mentions; each mention becomes a token chip.
- **Linear (mention anything)**: unified palette across issues/docs/people; recency-weighted; keyboard-first.
- **Slack/Discord (the origin of @-mention UX)**: typing filters INSIDE the same input; the menu is a suggestion strip, not a modal flow; selection completes the token inline.

**The convergent pattern (all five):**
1. ONE palette, not a family-then-picker hierarchy.
2. The QUERY IS THE TEXT AFTER `@` in the composer — not a separate search input inside the menu. (We moved the search INTO the menu to satisfy an earlier complaint — that fix was about not abusing the whole chat input as the query; the industry answer is narrower: the query is the text from `@` to the caret.)
3. Recency-first ordering, fuzzy matching, grouped sections.
4. Chips are tokens living IN the composer text area, removable with Backspace, not a separate chip rail.
5. Attachments never ride the @ flow — they're a `+`/paperclip button.

**Where our implementation diverges (the actual complaints, mapped):**
- Two-level family menu = an extra Enter before any real item (the apps have zero pre-step).
- Separate in-menu search box = focus leaves the composer; feels modal (the earlier fix traded one wrong for another; the caret-anchored query is the right answer).
- Repo flow needs 3+ interactions before a commit row appears.
- Chips live in a rail below the input, detachable from the text that caused them.
- Attachments awkwardly bolted into @.

## Proposed direction (NOT yet accepted)

**Rebuild as a single caret-anchored palette** (Claude.ai/Cursor style), in one pass on a fresh branch:

1. **Query = text from `@` to caret** in the composer. Typing filters live; the composer never loses focus. (This supersedes the in-menu search box with the narrower, standard behavior — the earlier complaint "not using the chat input as search" is still honored: only the @-token text is the query, never the whole input.)
2. **One flat grouped list**: Recent (chips + prior refs), Jira, Repos (top repos + recent commits/PRs), Files (attachments, matching by name) — fuzzy-scored, capped ~12 rows, keyboard-first (↑↓ Enter Esc), click for mouse users.
3. **Repo drill-down collapses into the list**: typing `@733e2` fuzzy-matches a commit across ALL registered repos (server-side search endpoint — we already have repo.commits machinery); typing `@CUST-62` hits Jira directly. No repo→segment→branch wizard; the branch strip becomes a filter affordance only when >50 rows.
4. **Chips become inline tokens** at the caret in the textarea (like Slack): Backspace removes them as units; they serialize into the send payload exactly as today.
5. **Attachments leave @**: `+` button in the composer (paperclip) opens the file picker/paste/drop as today; `@attachment` remains as a *search over already-attached* files for reference-in-prompt.
6. Keep the honest state rows (unconfigured/loading/error) as palette rows — they worked.

**Why this direction:** it matches the operator's instinct ("learn from famous apps"), deletes a whole interaction level, and each element maps 1:1 to a pattern users already know. Cost: a rewrite of the @ state machine in Composer (the families/pickers/repo wizard), a new server-side unified search endpoint (`/api/agent/refs/search?q=` merging jira + repos + files), and inline-token rendering in the textarea (contenteditable overlay or chip-before-caret insert — needs a small spike).

**Alternatives considered:** (a) keep two-level but polish (rejected — still nonstandard, the complaint is structural); (b) adopt a library (floating-ui + cmdk) — attractive (cmdk IS the pattern) but adds deps; house style has been dependency-free and our menu needs are modest; revisit if the spike stumbles.

## Open questions

1. **Inline chips in the textarea** (Slack-style tokens) vs **chip rail below** (current): inline is the famous-app pattern but is the biggest technical lift (textarea can't render rich content; needs contenteditable or overlay trickery). Rail-with-recency is 80% of the win for 20% of the cost. Which does the operator want?
2. **Scope of the unified search server endpoint**: jira+repos+files now (recommended — all machinery exists), or also cases/suites (Lionidas-native entities) as mentionables? The latter is powerful (mention a test case into the chat) but widens the round.

## Next step

Answer the two questions → `hms-plan-from-brainstorm` → review → implement on a fresh branch off main. A UI sketch (sketch skill, 2–3 variants of the palette) precedes implementation per house convention for UI work.
