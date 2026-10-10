# 032 B1-warm — the split, corrected dark

## Variant: b1 with the two measured problems fixed

### What was wrong (measured, not guessed)
1. **Pure black canvas (#000)** — Claude-dark uses warm charcoal; black crushes layer separation (panel rgba(17,17,17,.6) vanished into it) and makes glows the only depth cue.
2. **Type hierarchy** — mono 14px prose + 9px #606060 metadata = everything loud, nothing readable (secondary text measured ~3:1, under the 4.5:1 floor).

### The corrections
- Canvas: `#161513` warm charcoal; surfaces `#211f1c`, raised `#2a2724`, warm hairlines `#3a3630` — layers separate by VALUE now, not shadows
- Text ramp: ink `#f2efe9` (15.9:1) · secondary `#c9c3b8` (9–10:1) · metadata `#9a948c` (6.1:1 — all above floor)
- Typography: **Inter (sans) for prose at 15px/1.7** — mono stays for chips/labels/machine text; serif for titles + agent questions; sizes floored at 11px (was 9)
- Ember lifted `#e06a35` to sit warm on warm

### Verified
Contrast ratios measured in-browser per tier (see commit); all interactions (collapse pill, answer flow, tabs) intact.
