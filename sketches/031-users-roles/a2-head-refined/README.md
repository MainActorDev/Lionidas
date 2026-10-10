# 031 A2 — head-refined (refinement of picked A)

## Variant: aligned grid head + health marks · supervisor parity

### Design stance
Same role-grouped directory as A; the group head rebuilt as an aligned grid so the five heads read as columns of one ledger, each head carrying its group's health. **One uniform view — no stance switch** (user decision 2026-10-10: supervisor has the same users-domain capability as admin).

### What changed vs A
- **Aligned grid head**: `caret | role (90px = 'supervisor') | digest (1fr) | health | count` — digests and counts line up across all groups (verified: every digest starts at x=269 in the drill)
- **Role name upgraded**: uppercase, letter-spaced, paper color — it's the group's identity, was pewter body text
- **Health marks** (anti-bloat: only when non-zero): `N off` (deactivated, ash) · `N pending` (approval, ember) — the admin sees tmpadm/supmade/viewer-one need attention without expanding
- Digest truncates with ellipsis at narrow widths instead of pushing the count off

### Trade-offs
- Strong at: scannability — five groups read as one table's rows; attention marks live on the head
- Weak at: fixed 90px role column wastes a little width vs ragged flow (the price of alignment)

### Best for
The picked direction, refined. This is the build spec for the users page revamp.
