# Review: @-mention rebuild plan (caret palette + Slack tokens)

- Plan reviewed: `plans/20261013T072312Z-mention-ux-famous-apps-plan.md` @ Ready (created 2026-10-13T09:42:04Z)
- Evidence: Composer.vue:119-290 (current state machine), refs-routes.ts:42-64, config-tools.ts:696 (cases.search), attachments.ts (rev23 store), brainstorm `bc25f13` + operator answers
- Verdict: **Ready for implementation with 3 required edits** (1 High data-loss class, 1 High correctness, 1 Medium) — none blocking direction

## Coverage

Traced both operator answers → completion conditions → stages → acceptance. Audited the sentinel/overlay technique (the riskiest piece) against real-world failure modes, the endpoint design against existing routes, and stage order against house conventions.

## Findings

### MR1 — HIGH — Sentinel characters will corrupt user-visible text
- **Location:** plan §Method (`\u200B@kind:locator\u200B` sentinels).
- **Evidence:** ZERO-WIDTH SPACE (U+200B) is invisible but copyable — users copy chat drafts, IME tools and screen readers trip on it; if a token is left un-parsed (blur path, edge cases list "token stays as raw text"), the draft now contains invisible garbage. Slack/Discord don't use invisible sentinels in the textarea VALUE; they keep the textarea plain and track token RANGES, or use contenteditable.
- **Consequence:** corrupted drafts, unexplainable "phantom characters" in sent messages when parse fails, a11y noise.
- **Correction:** use the **range-tracking approach**: the textarea value holds PLAIN text (e.g. `@CUST-6223` as typed, auto-completed to `@CUST-6223 `); tokens are tracked as `(start, end, kind, locator)` ranges in component state; the overlay renders those ranges as chips; Backspace-as-unit checks ranges; send maps ranges → refs. No invisible characters ever exist. Auto-complete on pick rewrites the visible text (standard autocomplete behavior).
- **Verify:** test asserts textarea value NEVER contains U+200B; token state restores from ranges after reload.

### MR2 — HIGH — "Recent refs restore on reload" contradicts the range model
- **Location:** plan §Validation #3 ("reload — chips restore from message refs") vs §Method (tokens derive from typing).
- **Evidence:** after reload, the composer draft is empty; historical refs live in SENT messages, not the draft. Restoring chips into an empty draft (unprompted) is not Slack behavior and would surprise.
- **Consequence:** either an impossible acceptance check or unwanted UX.
- **Correction:** restate: after reload, the PALETTE's Recent group reflects previously used refs (from the sent-message history + localStorage); the DRAFT itself is not pre-populated. Acceptance: "Recent group shows refs from the prior session after reload."
- **Verify:** acceptance wording updated; test asserts draft stays empty on session open.

### MR3 — MEDIUM — Palette fetch latency budget unrealistic with jira in-path
- **Location:** §Interfaces ("server response < 150ms target (local sources only)") vs jira being a REMOTE API call.
- **Evidence:** the existing jira search is a network round-trip to the Jira instance (300ms–2s in drills); it cannot sit inside a 150ms synchronous budget.
- **Consequence:** either the budget is fiction (test flake) or jira results lag the palette.
- **Correction:** two-tier response: local groups (recent/repos/cases/files) return immediately (<150ms, asserted); the jira group UPDATES the palette asynchronously when it lands (palette row 'searching jira…' → results), debounced client-side. Budget applies to the local tier only.
- **Verify:** endpoint test asserts local-tier latency shape (no jira await in the hot path); component test asserts the async jira group renders late.

### MR4 — LOW — Case ref kind needs butler round-trip accounting
- **Location:** §Stage E ("PipelineRef gains 'case'").
- **Evidence:** butler is pinned by tag; adding a ref kind means a butler change + retag + repin for one string literal. The lionidas-side skill route could equally PASS THROUGH unknown ref kinds as a generic `{kind, locator}` without butler knowing.
- **Correction:** prefer lionidas-local passthrough if PipelineRef is structurally open (verify `PipelineRef` type shape at implementation start); only touch butler if it's a closed union.
- **Verify:** first implementation step in E documents which path was taken and why.

## Non-findings (checked, clean)

- Overlay metrics: identical font/padding/box-sizing to textarea is asserted (common failure); include in component tests.
- Paste/IME guards, email-safe suppression, two-token messages: plan's edge list is sound.
- Deleting the old menu outright (no flag): matches operator's "I don't like it" — no fallback requested.
- Sketch gate BEFORE build: house convention honored (stage F ordering).
- No new deps: consistent with house style.

## Required edits before implementation

1. §Method: replace sentinels with range-tracking (MR1) — this is the plan's biggest correctness fix.
2. §Validation #3 + §C: Recent-group restores, draft stays empty (MR2).
3. §Interfaces: two-tier response, budget on local tier only, async jira group (MR3); note MR4's passthrough-first rule under Stage E.

## What remains to validate during implementation

Spike the overlay/caret measurement early (first hour of B) — if mirror-node measurement proves flaky at the 2px level, the fallback is palette-anchored-above-composer (not caret) which loses nothing structural. Pixel pass via screenshots at the sketch gate; live drill end-to-end at F.
