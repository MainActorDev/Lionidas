## Variant B: Inspector drawer

### Design stance
Evidence as an inspection, not an interruption: a right-side drawer over the still-visible case table; lanes become a scannable status LIST, not tabs.

### Key choices
- Layout: fixed 420px right drawer (transform slide-in), page stays usable behind
- Lanes: one row per world — status mark, variant name, its env delta (COUNTRY=Singapore), shot count, timestamp. The list IS the answer to "which worlds exist and how did each do"
- Selected lane gets a 2px ember inset rail (same language as the app's existing list selection)
- Media: one shot at a time with a compact step pager (← name 1/2 →) beneath
- COMPARE mode: two lanes side-by-side at the same step — the only true A/B world diff of the three variants
- Footer: video button, run id, device

### Trade-offs
- Strong at: overview-first (status list before media), env-delta visibility, side-by-side world compare, table context preserved
- Weak at: shot is small (420px drawer); one drawer = one case's evidence at a time

### Best for
The variant-heavy workflow: "why did my pass in sg/my but the legacy run fail?" — list, then compare.
