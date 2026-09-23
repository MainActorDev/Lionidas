# Run Detail Page Revamp — Evidence-Based Direction

- Source prompt: "/hms-design-evidence-based-ux — Brainstorm a UI/UX revamp direction for the run detail page."
- Created: 2026-09-23T10:49:43Z
- Status: Direction selected + follow-ups answered — verdict block hero, auto-collapse trivial sections

## Decisions (user-confirmed)
1. **Verdict block** — failure cause as hero sentence in a verdict block at top (Option A). User: "verdict block if that make sense" (2026-09-23).
2. **Auto-collapse** — steps/network collapse when trivial (≤3 steps / no traffic) with counts on the toggle. User: "yes" (2026-09-23).

## Goal and context

Run detail (`/runs/:id`) is the page you land on from the runs log when something needs judgment: *did the app break, did the environment break, and what should I do next?* The user wants a revamp direction grounded in evidence.

**Interpretation (not user-confirmed):** goal = make the "why did it fail / what happened" judgment fast, and stop rendering dead scaffolding.

## Confirmed inputs and decisions (verified 2026-09-23)

- Page today (`RunDetailPage.vue`, 164 lines): PageHeader (id · ticket · kind · by · timestamp · attach→jira · status) → meta card (device/build/artifact/freshness/launch args) → blocked callout → steps table (#/flow/status/duration/reason) → network table (5 cols, with a "proxy wasn't running" teach-state) → TriagePanel.
- **Steps are coarse**: avg 2.1 steps/run, max 9; all `kind='step'`. Most failed runs have **one skip row** ("blocked by system dialog (not reached)") — the page's biggest table usually carries ~1–3 rows.
- **`ac_results` is empty** (0 rows in DB) — no AC surface exists to design for.
- **Evidence is nearly nonexistent**: 9 screenshots + 8 videos across 724 runs (~2.5% of runs have any). Evidence-heavy designs are data-contradicted.
- Failure notes cluster on **case names** (the `note` column doubles as case label) — e.g. 29× `template:… intl drill`, 28× `tnc`. The "note" is not diagnostic; the real diagnostic lives in step `reason`.
- TriagePanel exists (94 lines) and rides at the bottom; EvidenceSheet exists (228 lines).
- Live behavior: SSE appends running steps + reloads on `run.finished`.

## Exploration

### The core reading (evidence)

The page's visual weight is inverted versus its data: a 5-column steps table (avg 2 rows), a 5-column network table, a meta card with 5 rows — while the *actual* content of most failed runs is **one sentence** (`blocked by system dialog: Allow "Lion Parcel" to use your location?`) plus verdict/context chips. The redesign should invert: verdict + cause first, big; scaffolding (meta, network, steps) collapsed or demoted.

### Option A — Verdict-first report ✅ PROPOSED

Reorganize into a **verdict block** at top: status + case name + the failure sentence rendered as the hero line (not buried in a table cell), device/build/duration context chips, and a **"what to do" hint** (re-run / release engine session / open case / attach Jira). Steps become a collapsed disclosure (`steps · 2`) since they're 1–3 rows; network stays a disclosure too. Blocked runs get the dashed ember treatment inline in the verdict block.

- **Wins:** matches the 3-second judgment ("infra, not app — release and re-run"); kills the empty-table scaffolding; keeps everything reachable one click down.
- **Costs:** T2-ish rewrite of the page body; header stays.

### Option B — Timeline page

Vertical timeline (step nodes, evidence thumbs pinned to nodes, network events interleaved by timestamp).

- **Rejected (data-contradicted):** 2.1 steps avg × 0.03 evidence/run — a timeline needs material to time-lay. Would render as 2 lonely nodes.

### Option C — Split panes (steps left, evidence/network right)

- **Rejected:** same density problem, plus a layout built for evidence we don't have.

### Shared moves (any direction)

- **Case identity**: the run's `template_id` should link to the case (`/templates?case=…`), and the case *name* (already in `note`) belongs in the header desc — today the page title is a raw `run_…` id with no case name anywhere except the steps' flow names.
- **Duration** in the header desc (finished−started), consistent with the runs log page.
- **Attach → Jira** stays (used for the workflow).
- Keep SSE live-appending behavior.

## Open questions

1. **Where should the failure cause live — hero sentence in a verdict block (A), or kept in the steps table but made prominent?** (Changes the whole page shape.)
2. **Should steps/network auto-collapse when trivial** (≤3 steps / no traffic) with a count on the toggle? (Density decision; my recommendation: yes.)

## Next step

Answer the two questions → `hms-plan-from-brainstorm` → sketch 2–3 variants of the chosen direction → implement.
