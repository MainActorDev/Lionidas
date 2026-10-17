# v1 chat decommission plan (Phase 5 step 5)

- Status: default flipped 2026-10-16 — `/agent` → AgentTimelinePage; `/agent-v1` is the legacy escape hatch
- Owner gate: the operator uses `/agent` day-to-day; decommission when the criteria below hold

## Criteria (all required)

1. **Two weeks of daily-driver use** on `/agent` with no v1 fallback visits triggered by defects (spot-check `localStorage` last-session + operator report; there is no telemetry by design).
2. **No open issues** tagged against the v1 Thread/queue/status model that the timeline cannot express.
3. **Live-turn drill green** (the crucible concurrent-multi-chat drill) against the v2 timeline route, run at least once after the flip on the live server.
4. **Skill routing verified live**: at least one `command.run` invocation observed in `butler_turn_events` from a plain-language ask (dynamic-skill-routing brainstorm, 20261016T061611Z).

## Removal checklist (when criteria hold)

- [ ] Delete `AgentChatPage.vue` + `Thread.vue` + `__tests__/AgentChat.test.ts` (port any still-relevant cases to `AgentTimelinePage.test.ts` first)
- [ ] Remove `/agent-v1` route + `agentv1` e2e entry and baselines
- [ ] Drop v1-only CSS from `agent-theme.css` (keep the shared tokens: `--ag-*`, contrast pins, mobile rules)
- [ ] Keep: `ChatSidebar`, `Composer`, `RunPanel`, `markdown.ts`, `highlight.ts`, `agent-routes` queue/resend semantics already re-expressed in v2
- [ ] Verify `regressions.chat.test.ts` / `regressions.composer.test.ts` targets still exist (they pin composer interaction + chat invariants that carry over)

## Known deltas accepted at flip time

- v2 renders items only; identical-resend collapse and per-bubble resend buttons are NOT yet re-implemented on the timeline (fold collapses consecutive identical queued items; resend rides re-sending from the composer). Re-add before decommission if the operator misses them.
- Panel-error rows ride the timeline as error items (v1 used system messages).
