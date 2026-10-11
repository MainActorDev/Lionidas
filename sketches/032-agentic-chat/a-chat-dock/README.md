# 032 A — agent dock

## Variant: chat dock beside any page

### Design stance
The agent is a SIDE PANEL (right dock, collapsible to a rail glyph): you keep working in the cases/runs list while the pipeline runs beside you. Chat + stage stepper + composer with reference chips live in one 420px column.

### Key choices
- Layout: fixed right dock over the normal shell; collapse = 44px strip
- Stage strip at the dock top (knowledge/plan/breakdown/author) mirrors the pipeline live
- Planner questions render inline as answerable message cards (input + resume button right in the thread)
- Composer supports `@jira KEY`, `@pr #N`, `/pipeline` — references are first-class chips, attached docs removable
- Draft cases land in the page BEHIND the dock (the list you're looking at)

### Trade-offs
- Strong at: agent-as-companion; questions answered in flow; minimal navigation
- Weak at: no dedicated home for run history/knowledge browsing; chat width limits artifact reading; a second run needs the dock to switch context

### Best for
Operators who draft cases while watching the pipeline — the "pair with the agent" feel.
