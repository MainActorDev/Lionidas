# 007 · DeviceSidebar → A (Rail Swap)

**Picked by user 2026-09-13.** Replaces the stacked sidebar sections beside the
simulator stream with the A2 rail pattern: 44px icon rail + one swap panel.

## Design stance
One panel at a time; the rail is the only navigation. Groups mirror the
existing sidebar's context:

- **session** — session (take control / finish) · install app
- **inspect** — inspect · measure (the shipped A2 inspector panels)
- **record** — recorder (live steps, pause, save template)
- **actions** — screenshot · copy spec (instant; panel shows last outcome)

## Token compliance (Axiom, per `web/src/styles/tokens.css`)
- surfaces void/carbon/graphite/iron, text steel→paper, ONE ember accent
- JetBrains Mono everywhere, 12px body rows, 10px uppercase section heads
- 2px radius, hairline borders, no shadows, badge = bordered pill (no fills)
- rail mechanics identical to shipped `InspectTools.vue` (32px tools, 6px
  hover radius, ember `on` = border + 12% mix fill, hover tooltips + kbd)

## Interaction contract (for implementation)
- rail click → panel swaps; `i`/`m`/`r` shortcuts; Esc = back to inspect?
  (decide at impl)
- inspect tool ON = the shipped inspector panel (Layout/Type/Paint/Element)
- screenshot/copy are instant actions — panel shows the last outcome + a
  repeat button, not a form
- empty states per panel (no selection, no session, no recording)

## Rejected
- **B persistent stack** — accordion kept every section visible; status
  glanceable but loses the one-tool focus.
- **C mode surface** — horizontal tabs under stream + status strip; stream
  first, but abandons the rail identity the user asked for.
