# 031 A — role-grouped directory

## Variant: role-grouped directory (house anatomy)

### Design stance
Role IS the structure: the settled grouped-list anatomy (one `.a2-list` box, one sticky thead, `.a2-group-head` per role) with each head carrying a terse capability digest — the RBAC matrix made visible without a new table pattern.

### Key choices
- Layout: single bordered table, collapsible per-role groups (bot collapsed by default), sticky thead
- Role column in rows replaced by the group head (the app-column rule from the settled system)
- Stance switch (admin ⇄ supervisor) toggles the admin-only controls: role selects, approve, delete, admin-role creation — the boundary is visible, not silent
- Provision form includes `supervisor` (missing today)

### Trade-offs
- Strong at: 13 real accounts read as 5 clear buckets; supervisor stance is native; converges with the four settled list pages
- Weak at: role of a specific person is one scan-step away (inside a group); more DOM than a flat table

### Best for
The admin/supervisor managing "who has what power" — role-first questions answered by the shape of the page.
