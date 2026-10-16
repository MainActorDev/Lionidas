# 042 — Agent chat rebuild — three stances

All three render the SAME turn-item fixture (2 user turns, 1 queued, tool calls with ok/err/live states, markdown answer with swift fence, live streaming cursor, caret @-palette, model chips, multi-slot queue) in Factory tokens. They differ on the work-log treatment — the core design question of the rebuild.

## A — Session rail (`a-session-rail/`)

**Stance: terminal-session register.** Persistent session rail left; turns as left-bordered groups with dot markers; work rows inline under each turn (⏵ name arg / ⎿ detail expandable); assistant prose in sans with mono code.

- Strong at: continuity with the migrated pages' quiet register; turn grouping makes multi-turn provenance obvious; scales down to mobile cleanly (rail hides).
- Weak at: turn chrome costs vertical space; less glanceable than a flat ledger for long tool runs.
- Best for: the operator who treats chat as one of several Lionidas surfaces and wants consistency.

## B — Ledger stream (`b-ledger-stream/`)

**Stance: log-first instrument.** No session rail (chats menu dropdown); the thread IS a mono ledger — timestamped rows, `⏵`/`⎿` tool rows, `›`/`‹` message rows, hairline separators between turns; 300px inspector column (turn items, usage meters, provider chain).

- Strong at: t3code's model rendered literally — one flat stream, item kinds distinguished by row grammar; dense (long agentic turns stay compact); usage/context meters always visible; timestamps give the audit register.
- Weak at: sans prose in a mono ledger needs the row-grammar discipline to stay readable; inspector column competes with wide code fences at 1024–1200px.
- Best for: reading long agentic turns as an instrument log; matches /audit + /status ledger grammar already shipped.

## C — Worklog cards (`c-worklog-cards/`)

**Stance: collapsed summary-first.** Session rail left (as A); each turn's tool activity collapsed into ONE card row ("2 tool calls · repo.diff, cases.list · 1.5s") with a status dot; expand for the ⏵/⎿ lines; chat bubbles classic user-right / assistant-left.

- Strong at: quietest thread — one row per work burst instead of N tool rows; classic chat affordances; failed/late tools still visible on the card head at a glance.
- Weak at: hides per-call granularity behind an extra click (t3code shows rows inline); card heads summarize, which can lie when tool sets are heterogeneous; most vertical chrome of the three.
- Best for: chat-first users who care about answers, with tools as expandable provenance.

## Head-to-head

| Dimension | A session rail | B ledger stream | C worklog cards |
|---|---|---|---|
| Density | medium | high | low |
| Tool-call glanceability | row-per-call | row-per-call + timestamps | summary card, expand |
| Turn provenance | explicit groups | hairline separators | bubbles |
| Usage/context visibility | none shown | inspector column | none shown |
| Mobile degradation | clean (rail hides) | inspector hides, ledger holds | clean (rail hides) |
| Consistency w/ shipped pages | high | highest (/audit,/status ledger grammar) | medium |
| Implementation risk | low | medium (inspector column) | low |

**My take:** B is the most honest rendering of the turn-item model we're building (flat stream, audit register, usage meters) and matches the ledger grammar already shipped on /audit and /status. A is the safe pick if B's mono-ledger prose feels too instrument-like. C risks hiding exactly the tool-call detail the rebuild exists to surface.
