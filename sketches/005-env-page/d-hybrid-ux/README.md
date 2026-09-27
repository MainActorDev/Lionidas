## Variant: Hybrid UX (D) — cards that stay small + a gaps strip + an effective view

### Design stance
Managing env without hassle = (1) never hunt for where a key lives, (2) never wonder what a run
will actually resolve, (3) collapse anything not being worked on. Scope cards as the base, plus
three hassle-killers on top.

### Key choices
- **Gaps strip (top):** keys referenced by cases (`${env.X}` scans of steps/setup) that are set
  nowhere — one-click "set in app…" drafts the var and opens the editor prefilled. The #1 real
  failure (`missing env: DRILL_PHONE`) becomes visible BEFORE a run burns 10 minutes.
- **Collapsed cards with counts:** every scope renders one header row (caret + tag + owner +
  count + "+ var"); only the scope you're in expands. 20 apps = 20 rows, not 20 pages of vars.
- **Search filters, doesn't navigate:** typing hides non-matching scopes AND auto-expands matches
  — find "DRILL_PHONE" across all scopes in one keystroke, then everything collapses back.
- **Effective mode (seg toggle):** pick app (+optional plan) → the exact resolved key→value list
  a run would see, each row badged with which scope supplied it. Answers "did my override take?"
  without mental merge math.
- **In-use awareness:** `used ×N` badge on keys referenced by cases; delete of an in-use key warns.
- Enter-to-add in the inline forms.

### Trade-offs
- Strong at: scales to many apps/plans (collapsed), keeps the setup flow one-click, deletes the
  two classic env mistakes (unset key, wrong-scope surprise)
- Weak at: two modes to learn (though "manage" is the default and sufficient alone); effective
  view needs a case-scan backend feature (usage counts + gap detection)

### Best for
This one. B's shape, C's preview, A's findability — sized right today, grows without bloat.
