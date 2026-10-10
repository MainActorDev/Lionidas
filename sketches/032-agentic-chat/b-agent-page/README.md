# 032 B — agent page

## Variant: dedicated agent surface (runs + knowledge + artifacts)

### Design stance
A first-class page in the sidebar ("agent"): run list left, selected run's stage rail + question banner + artifacts right. Chat lives inside the run detail. The house two-pane pattern (wall, projects).

### Key choices
- Layout: runs list (`.a2-list`) + detail column; tabs for runs/knowledge
- Stage rail horizontal with per-stage state (v3 · 1 conflict / ✓ 1 answer / running / pending)
- Question banner is a persistent card while `awaiting_answer` — impossible to miss, answers inline
- New-run form: app bundle + ref chips + start (revealed by the header button)
- Artifacts card links the versioned knowledge page, scope doc, draft cases

### Trade-offs
- Strong at: run history + state at a glance; questions unmissable; scales to many runs/apps; knowledge browsing has a home
- Weak at: you LEAVE the cases page to drive the agent; drafts are viewed elsewhere; more clicks for a quick single run

### Best for
The operator managing agent work as first-class objects — closer to how runs/builds pages already work.
