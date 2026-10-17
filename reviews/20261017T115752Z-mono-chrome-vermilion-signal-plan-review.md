# Self-review — mono chrome + vermilion signal plan

- Reviewed: `plans/20261017T115752Z-mono-chrome-vermilion-signal-plan.md`
- Reviewer: agent (self), 2026-10-17 — human gate follows this.

## Traceability

- Every decision traces to a logged user statement or computed fact. The one inferred item — concrete chrome-accent hexes `#d9d5cf`/`#2a2622` — is derived from the approved preview's mapping (bone L≈0.80, graphite L≈0.31) and flagged as derived, not user-quoted. Acceptable: user approved the *rendered look*, not hex literals.
- The Factory-rule amendment ("no bright/white fills" → "no pure-white fills, bone allowed") is stated openly instead of silently applied. ✔

## Risks checked

1. **Token-name reuse (`--status-orange` now vermilion)** — no mechanical churn, but the NAME lies. Mitigated by comment updates; renaming would touch 277 sites for zero visual gain. Accepted.
2. **Sweep completeness** — the plan's own gate ("zero UNCLASSIFIED lines", "no raw hexes remain") is objectively checkable by grep. ✔
3. **Baseline blast radius** — every e2e baseline changes; plan says full regen explicitly (past stale-dist false-green lesson encoded). ✔
4. **axe risk** — vermilion + bone values pre-verified ≥4.5:1 on all three surfaces both themes; light-theme tinted worst case 4.78. ✔
5. **agentv1 legacy** — still baselined in e2e; included in sweep scope so it can't drift. ✔

## Gaps found (fixed in place)

- Initial draft omitted cockpit (fullscreen route) — added to scope.
- Initial draft didn't grep raw hexes (components may bypass tokens) — inventory stage now covers it.

## Verdict

Ready for the human gate. No open questions blocking; the classification rules are the only judgment surface, and they're auditable line-by-line via the committed inventory.
