## Option 1 — Inline editor (closest twin)

### Stance
The suites page IS the test-cases page, with suite nouns. Same header, same summary glyphs,
same `⌘F` search, same 7-column row grid (evidence column dropped — suites carry none directly).
Clicking a row opens the member editor **inline below the row** — exactly the yaml-panel motion.

### The modification
The inline editor is a member-rows panel instead of a yaml textarea: ordered rows of
`[#] [case ▾] [variant chips] [↑ ↓ ✕]`, bundle scope shown as a lock badge in the panel header.
Creating: `+ suite` asks for the bundle first, then the same panel opens empty.

### Trade-offs
+ Zero new UI vocabulary — if you can edit a case, you can edit a suite
+ Editor sits in context; the list keeps scrolling under you (prev/next hopping like the yaml panel)
− Long member lists push the table down while editing (same as yaml panel on cases)
− One editor open at a time

### Best for
Muscle-memory parity: the two pages feel like one system.
