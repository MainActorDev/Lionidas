# 003 — DeviceSidebar redesign

Grounded in the real component (`web/src/components/DeviceSidebar.vue`, 791 lines):
watch/control modes, pre-session form (operator/app/install), stream canvas +
overlay, type-box, controls row (inspect pill + dpad + release), inspect
drawer, recorder (steps w/ thumbnails, assert box, save-as-template). Axiom
tokens (void/carbon/iron/ember, mono), 420px fixed right sidebar today.

**Pain today:** one cramped column — stream squeezed to ~200px, recorder
below the fold, controls row overloaded (7 buttons inline), inspect drawer
pushes the recorder further down when open.

## Variants (one structural axis apart)

| | A · Tabbed Workbench | B · Wide Cockpit | C · Hover Popovers |
|---|---|---|---|
| Axis | attention separation | spatial separation | stream dominance |
| Width | 420px (unchanged) | ~760px (sidebar widens) | 440px |
| Stream | pinned top, ~55% | left column, tall | dominant, ~75% |
| Tools | tabs: drive / inspect / record — one at a time | all visible, stacked right column | element card floats ON stream; dock below |
| Best for | focus; QA does one thing at a time | power use; everything one glance | fast inspection; minimal chrome |
| Risk | tools hidden behind tabs | layout shift when opening; needs width | popover occludes screen content |

## Shared decisions across all three

- Stream pinned/sticky; footer = lease state (who holds it, how long).
- Inspect boxes + hover chip live on the stream in every variant (they're
  stream annotations, not panel content).
- Recording steps always visible as count badge (dot on tab / "● live" label /
  filmstrip) — never fully hidden.
- Same verbs: drive, inspect, record, release; same element-card fields.

Open each `index.html` — the variants are interactive (toggle inspect, click
boxes, hover chips).
