# 031 B — roster × capability matrix

## Variant: permission center

### Design stance
Flat roster on the left, the live capability matrix (from `capabilitiesFor()`) on the right; clicking a person highlights their role's column — pick a person, see their powers at a glance.

### Key choices
- Layout: split grid — roster table + fixed matrix panel (collapses to one column under 980px)
- Matrix rows are the REAL capability names with ● / ◆(own vs any) / – marks; scoped abort/delete rendered honestly
- Selection state drives the highlight (default: you)

### Trade-offs
- Strong at: answers "what exactly can a supervisor do that an operator can't?" with zero clicks; the matrix is literally the truth source
- Weak at: introduces a SECOND table pattern the four settled list pages don't have; roster actions (reset pw, deactivate) have no home in this mock — they'd crowd the table or need a panel; role changes are hidden behind selection

### Best for
Onboarding new admins, auditing the matrix itself — a reference surface more than a management surface.
