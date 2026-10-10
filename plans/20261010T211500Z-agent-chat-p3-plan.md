# Agent chat surface (P3) — build plan

- Source: sketch round 032, picked **`b1-warm`** (artifacts-split + collapsible dock + corrected warm dark) — operator 2026-10-10 "Okay go with b1 warm"
- Depends on: P2 shipped (PR #31 — pipeline API, artifacts, events all live)
- Status: **Ready**
- Repo: Lionidas · Branch: `feat/agent-chat-p3` (cut)
- Palette authority: `sketches/032-agentic-chat/b1-warm/index.html` IS the spec; values codified as an **agent-scoped palette layer** (user-authorized departure from house tokens, this feature only)

## Decision log

| # | Decision | Source |
|---|---|---|
| W1 | Layout = artifacts-split with collapsible right panel (b1-warm): Claude-referenced sidebar (search/New/recents/account) + thread + run-workspace panel that collapses to a floating ember pill while a run is live | operator pick |
| W2 | **Agent-scoped palette**: warm charcoal `#161513` canvas, surfaces `#211f1c`/`#2a2724`, hairlines `#3a3630`, ink `#f2efe9`/`#c9c3b8`/`#9a948c`, ember `#e06a35`; contrast tiers measured ≥6:1. NOT global tokens — a scoped CSS layer under `web/src/pages/agent/agent-theme.css`, applied only on `/agent` | operator "out-of-the-box a little from the design tokens" + b1-warm approval |
| W3 | Typography: Inter (sans) prose 15px/1.7; mono for chips/ids/labels; Georgia serif for the agent's questions + view titles; min size 11px | b1-warm (measured fix) |
| W4 | Chat = conversation over the EXISTING conversation API (`/api/agent/*`); starting a run from chat = attach refs + send, which calls `POST /api/agent/pipeline`. The planner's question (pipeline `awaiting_answer`) renders as the in-panel question card; answering = `POST :id/answer` + `POST :id/resume` | P2 API surface |
| W5 | Panel docks right on `/agent`; collapse state persists per user (localStorage); while any run is `running`/`awaiting_answer`, the floating pill shows | b1 interaction |

## Objective

An operator opens `/agent`: Claude-familiar chat — history sidebar, thread, composer with reference chips and executor picker — sends "draft cases for DEMO-101" with refs attached, watches the run's stages in the warm workspace panel (knowledge version + contradiction flags, plan, breakdown, author), answers the planner's question inline, and sees drafts land (linked into `/templates`). All state from the real P2 API; no new server endpoints except conversation-listing (see C2).

## Completion conditions

1. **C1 Route + shell.** `/agent` route, sidebar nav entry `agent` (operator+ gating mirrors server: viewers don't see it), page = 3-column flex (sidebar 232 / thread flex / panel 380). Page replaces nothing; new surface only. App shell test updated (nav count).
2. **C2 Conversations.** Server: `GET /api/agent/conversations` + `GET /api/agent/conversations/:id/messages` (operator-gated; butler sessions from the agent storage, newest first, title = first user message; **new route file, no server core changes beyond it**). Web: sidebar (search filter, New, recents with `app · state · age` sub-labels, account footer = me). Selecting a conversation loads its thread.
3. **C3 Thread + composer.** Messages render per b1-warm anatomy (user = right rounded bubble + refs row; agent = orb avatar + prose + tool-trace line + status flow). Composer: textarea (enter sends, shift+enter newline), `＋ refs` opens the ref picker (kind jira/github-pr/github-commit/doc/repo + locator, chips removable), executor pill (from `/api/agent/capabilities`-style env config — falls back to the server default; **display-only in P3**), send = the round ember button, disabled until text.
4. **C4 The run workspace panel.** Tabs `pipeline` / `artifacts`:
   - pipeline: vertical stage flow (knowledge v + conflicts / plan / breakdown / author) fed by `GET /api/agent/pipeline/:id` polled on `agent.workflow` events (the WS bus event from P2); stage rows show live results as they land
   - the question card when `status=awaiting_answer` (ember wash, serif question, textarea, skip/answer buttons) → `POST :id/answer` then `POST :id/resume`
   - artifacts: knowledge page (latest version body, contradiction lines ember-flagged, version + supersedes), snapshot, drafts list linking to `/templates`
   - collapse `»` → panel width 0; floating ember pill `● run live — open panel` when any watched run is active; pill and panel persist via localStorage
5. **C5 Send → run wiring.** With refs attached and the message mentioning drafting (or an explicit `/pipeline` prefix), send does BOTH: posts the chat turn (conversation API) AND `POST /api/agent/pipeline {appBundle, refs}`; the new run id binds to the conversation (client-side map in P3: `conversation.pipelineRunId` stored on the conversation's metadata note; server-side binding deferred to P4 backlog). Errors (422 honest messages) render as agent-visible system lines.
6. **C6 Palette + typography layer.** `agent-theme.css` with the W2/W3 values as CSS vars (`--ag-*`), scoped to the page root; contrast spot-checked in the component test (computed styles assert canvas + ink tiers).
7. **C7 Tests.** Web: page mounts (mock fetch), conversation list renders + search filters, refs → chips → send calls pipeline POST (fetch spy), question card → answer calls both endpoints, panel collapse/pill toggle, theme vars applied. Server: conversations routes (operator gate, shape). Gates: `vue-tsc` 0, web suite green, server suite green (1409+2).
8. **C8 Live drill** on the real server (mock executor): login operator → `/agent` → attach fixture doc ref → send → watch stages advance via events (no reload) → answer question → drafts panel lists the drafts → open one in `/templates`. Screenshots into the PR; logged in `docs/agent-pipeline-drills.md`.

## Out of scope (P3)

- Streaming token-by-token rendering (turn-level updates only — the bus emits per-hop)
- Server-side conversation↔run binding (client map now; backlog)
- Executor picker actually switching executors (display-only; env still decides — P5)
- a11y inspector (P4), claude-cli live (P5)
- Mobile/narrow layouts (desktop-first like the rest of the app)

## Architecture

```
web/src/pages/agent/
  AgentChatPage.vue        the 3-column shell + state orchestration
  agent-theme.css          W2/W3 palette + type layer (--ag-* scoped vars)
  components/
    ChatSidebar.vue        search / New / recents / account footer
    Thread.vue             message list (user/agent/tool-trace/status)
    Composer.vue           textarea + ref chips + executor pill + send
    RefPicker.vue          the ＋ popover: kind + locator rows
    RunPanel.vue           tabs: pipeline flow / artifacts
    QuestionCard.vue       the awaiting_answer card
    StageFlow.vue          vertical node flow w/ live results
server/src/agent/
  conversation-routes.ts   GET conversations + messages (operator-gated)
```

Data: existing endpoints (`/api/agent/*` conversation turns, `/api/agent/pipeline*`, `/api/agent/artifacts*`, `/api/auth/me`) + the 2 new read-only conversation routes. Live updates: `agent.workflow` events over the existing `/api/events` WS (page subscribes on mount).

## Stage order

1. S1 `agent-theme.css` + route + shell skeleton (C1, C6)
2. S2 conversation routes (server) + sidebar + thread read (C2, part C3)
3. S3 composer + ref picker + send→run wiring (C3, C5)
4. S4 run panel + question card + events + collapse/pill (C4)
5. S5 tests + live drill + PR (C7, C8)

## Edge cases (planned)

- Pipeline POST 422 (e.g. jira not configured) → system line with the honest error, refs preserved
- Run completes while panel closed → pill turns to "done — open" state, no auto-open
- Question answered out-of-band (API) → panel refreshes on next event, no double-answer (409 handled as info line)
- Conversation with no run → panel shows the empty state ("attach refs and send to start a run")
- WS drop → polling fallback every 10s while a run is active
