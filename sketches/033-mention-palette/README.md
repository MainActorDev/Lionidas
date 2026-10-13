# Sketch 033: @-mention palette + Slack-style chips — 3 variants

Common to all: caret-anchored single palette (no family menu, no repo wizard), query = text after `@`, keyboard-first, chips as inline tokens in the composer. Variants differ in DENSITY and how loudly rows announce their kind.

## Variant A — Quiet groups
- **Stance:** recency-tiered list with uppercase group labels (RECENT / JIRA / CASES); kind is a small glyph; async jira row visible ("searching jira…"); chips are ember-tinted with tiny kind prefix.
- **Strong at:** orienting across many kinds; the Recent tier earns its space; async jira honesty is visible.
- **Weak at:** group headers add height; two visual systems (glyphs + labels).
- **Best for:** mixed-source workflows where provenance matters.

## Variant B — Verbose command
- **Stance:** kind-first — tinted KIND PILL leads each row, two-line rows with subtitles (author, suite, branch), search field echoed in the palette header, chips carry × close buttons.
- **Strong at:** richest context per row (you know WHAT a thing is before picking); × on chips is discoverable; matches the operator-grade density of Lionidas tables.
- **Weak at:** tallest palette; slowest to scan; header search field flirts with the "modal search box" the operator disliked.
- **Best for:** power users authoring test specs who want detail upfront.

## Variant C — Compact flat
- **Stance:** Cursor/Linear-flavored — no group headers at all; kind is a 3-letter muted prefix (jira/repo/case/file); one-line rows; match highlighted with ember underline; borderless tinted chips; tiny footer with keys.
- **Strong at:** fastest scan; smallest footprint; feels most like the famous apps; least chrome between typing and picking.
- **Weak at:** no recency tier visible; subtitles lost (less context per row); at 16 rows flat lists blur.
- **Best for:** chat-speed reference picking.

## Head-to-head

| Dimension | A Quiet groups | B Verbose command | C Compact flat |
|---|---|---|---|
| Density | medium | low | high |
| Scan speed | medium | slow | fast |
| Kind clarity | medium (glyphs) | high (pills) | medium (prefix) |
| Per-row context | medium | high | low |
| Famous-app feel | Linear-ish | unique (Lionidas) | Cursor/Linear |
| Palette height | tall | tallest | shortest |

**My take:** **C for the palette behavior, B's two-line rows for jira/repo rows only** (subtitles carry ticket status / commit author — genuinely useful), and A's Recent tier as C's top section when no query is typed. That hybrid = compact rows + selective subtitles + recency tier. Pure B is the weakest fit (density mismatch with a chat surface).
