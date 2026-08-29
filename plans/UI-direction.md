# UI Direction — Crucible

**Status: DECIDED (2026-08-30).** Direction **C — dual-mode** · Reference: **Linear**
· Chrome language: **English only** · Wall ships **both modes** (ambient + focused;
final pick after live use).

## 1. The two registers

One design system, two temperatures — matched to the two moments:

| Register | Surfaces | Temperature |
|---|---|---|
| **Control** | Device wall · live run view · traffic inspector · queue | Dark |
| **Archive** | AC matrix · triage deep-read · baseline approvals · run history · artifacts | Light |

Grafana/New Relic precedent: consoles dark, reports light. Same tokens, same
components; only surfaces swap.

## 2. Linear-derived principles (what we borrow, concretely)

1. **Speed is a feature**: no spinner where a skeleton works; route transitions
   < 100ms; keyboard-first (⌘K command palette from M2, `j/k` list navigation,
   `Enter` opens, `Esc` backs).
2. **Restraint**: one accent color, borders over shadows, no gradients, motion
   only to explain change (step lands → 150ms fade-in, nothing bounces).
3. **Both-theme parity as discipline**: every component defined in tokens that
   flip cleanly — prevents "dark mode afterthought" rot.
4. **Text hierarchy does the work**: 3 font sizes per screen max; machine data
   (hashes, UDIDs, latency, JSON) always monospace, dimmed one step below prose.
5. **Dense by default, breathable where reading matters** (matrix compact,
   triage spacious).

## 3. Tokens (M0 ships these as CSS custom properties)

```css
/* type */
--font-sans: -apple-system, 'Inter', system-ui, sans-serif;
--font-mono: 'SF Mono', ui-monospace, monospace;
--text-xs: 11px; --text-sm: 13px; --text-base: 15px;  /* Linear-ish compact scale */
/* space: 4px grid (4/8/12/16/24/32) · radius: 6px cards, 4px controls */
/* dark control surface */
--bg: #08090a;  --surface: #101113;  --border: #1f2023;
--fg: #f7f8f8;  --fg-dim: #9a9ba0;  --accent: #5e6ad2;  /* Linear indigo */
/* light archive surface */
--bg: #fbfbfc;  --surface: #ffffff;  --border: #e8e8ea;
--fg: #17181a;  --fg-dim: #6f7076;  --accent: #5e6ad2;
/* status (identical in both themes; shape-coded for accessibility) */
--pass: #4cb782;  --fail: #e5484d;  --amber: #f5a524;  --skip: #9a9ba0;
/* shapes: pass ●  fail ▲  amber ◆  skip ○ — color never the only signal */
```

## 4. The wall — both modes (user decides after living with them)

- **Ambient** (glance from across the room): full-bleed dark grid, tiles carry
  ONLY device name + status light + lease badge; failed runs breathe (slow pulse);
  zero chrome. Auto-scales to any display; screensaver-legal.
- **Focused** (you came to work): same grid + last-run line per tile, queue depth,
  action row (Watch / Take control / Run), filters, ⌘K entry. One toggle
  (`A` key), persisted per browser.
Both render from identical state — a mode is a stylesheet, not a page.

## 5. Screen → register map

| Screen | Register | Notes |
|---|---|---|
| WallPage | dark | ambient + focused modes |
| RunDetail (live) | dark | step timeline = light-stream on dark; screenshots inline |
| Traffic inspector (Forge) | dark | monospace rows, status-colored |
| MatrixPage | light | compact density; the signed-off checklist feel |
| TriagePage | light | spacious; evidence-first: proof above prose |
| BaselinesPage | light | approvals queue; before/after images side-by-side |
| RunsPage / Artifacts | light | tables, keyboard-navigable |
| DrivePage (M3) | dark | cockpit; big touch targets |

## 6. Component inventory (v1 — grows per phase)

`StatusDot(●▲◆○)` · `Tile` · `LeaseBadge` · `StepTimeline` · `StepCard` ·
`ACMatrix` (+cell) · `EvidenceViewer` (image / diff slider / video w/ range) ·
`KVTable` (hashes/args) · `QueueList` · `FilterBar` · `EmptyState` (never a dead
end — every empty state names the next action) · `CmdPalette` (M2).

## 7. Non-style rules

- English-only chrome; ticket/AC text renders verbatim from metadata (any language).
- Never lie with color: amber = changes-pending (needs judgment), gray = no
  automated coverage or quarantined — distinct shapes, tooltips state the reason.
- Freshness/staleness warnings are visual first-class (banner chip + mono
  evidence row), never hidden in tooltips.
- Evidence links always deep-link to the exact artifact + time offset.
