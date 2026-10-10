# 031 C — flat table, role chips (control)

## Variant: minimal diff

### Design stance
Today's page, corrected: keep the flat table, make role a chip with hover-capabilities, add the missing `supervisor` option everywhere, let the supervisor stance disable admin-only controls. Structure alone, no new mechanism — isolates whether grouping is even needed.

### Key choices
- Layout: unchanged single table (sticky thead added)
- Role select + a ⓘ chip whose hover reveals the capability digest (title-attr spirit, CSS popup)
- `supervisor` present in provision + per-row selects; admin-only actions hidden at supervisor stance

### Trade-offs
- Strong at: smallest build; familiar; zero learning cost; honest control variant
- Weak at: does not read as a revamp; role relationships (how many operators? who's pending?) require scanning every row; capability info buried in hovers

### Best for
Shipping the RBAC-truth fixes this week without a structural redesign.
