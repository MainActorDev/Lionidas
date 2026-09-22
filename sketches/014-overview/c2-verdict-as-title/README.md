## Variant C2 — verdict-as-title (C + hierarchy fix, take 1)

### Design stance
The verdict IS the page title. "overview" demotes to a 13px steel label in the chrome row — no size contest.

### Key choices
- Chrome: `overview · batch · builds · 7d` one quiet meta line, run-all button right
- Verdict word: 32px paper — now 2.5× the label, unambiguous dominance
- No page-title row at all: siblings have chrome; this page's title is the answer

### Trade-offs
- Strong at: cleanest hierarchy; the eye lands on "failed" in <100ms
- Weak at: breaks page-title parity — every other page opens with a 20px title row (sidebar ⌘F navigation, muscle memory)

### Best for
If the overview is THE landing answer, its title is the verdict, full stop.
