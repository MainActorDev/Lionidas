# Lionidas visual direction — round 036

**Status update (2026-10-14, fourth round):** The user extended the brightness rejection to the **white hero verdict card** (“That's including the white hero card ‘Needs attention’. Find another color that fit best”). Applied: the verdict card is now a **carbon panel** (`#1d1a18` fill, ash hairline border) — bone verdict word, warm-granite subtext, pale-stone mono label, orange pulse retained; the dialog confirm button was also converted from bone to carbon with a pale-stone border. A programmatic bright-element scan confirms **zero elements with background lighter than rgb(200,200,200)** remain anywhere, including modals. **factory-sidebar remains the approved visual language** with this all-dark treatment.

**First-round note:** the user earlier supplied the Linear reference (`LINEAR.md`) and prefers **sidebar** navigation — all variants keep the sidebar. The three invented first-round concepts remain below for reference. No direction is final until the user confirms.

## Grounding and data provenance

- Real structure: `web/src/App.vue` supplies navigation, role-sensitive sections, top bar and a central route outlet; `web/src/router.ts` defines the destinations. The previews show the admin navigation set so every section can be compared. In the actual app, visibility is role dependent; these mockups do not implement RBAC.
- Real data *shape and actions*: `web/src/pages/OverviewPage.vue` has a build verdict, pass rate/delta, attention list, coverage and latest runs, plus “run all” and deep links. It caps the glance feed. The mockups retain these concepts.
- **Illustrative, not live data:** 5.18.0 (382), 18 passed, 2 failed, 1 blocked, 3 running, 28 active, 4 not run recently, 86% pass rate, +4% delta, the named cases, devices and account “Alex · admin” are **invented solely to compare the same states** across variants. No authenticated API data was retrieved. Each preview labels this explicitly.
- All clicks are **local simulations**. “Run all” opens a confirmation and then changes a sample verdict/toast. It makes **no API requests and starts no tests**. Navigation names display a preview-only notice rather than changing the browser route. The populated/empty/error selector makes those screen states inspectable.
- `linear-sidebar` uses the user-supplied `LINEAR.md` token values verbatim (colors, Inter Variable with cv01/ss03/zero, radii, hairline inset borders, weights ≤590); the only interpretation is applying that marketing-oriented reference to an app shell with a sidebar (Linear's own site uses a top bar — the user explicitly chose to keep the sidebar).
- `factory-sidebar` uses the user-supplied `FACTORY.md` tokens verbatim — `#101010` canvas, `#1d1a18` carbon lift, warm-gray text ramp, `#eeeeee` bone light-card, Geist 400 (500 only for emphasis), Geist Mono 12px uppercase for labels/nav groups/eyebrows, 3px buttons / 10px cards, hairline dividers, no shadows, and the two functional accents (`#ee6018` signal orange, `#a0ca92` metric green) reserved strictly for status/data — never button fills. Typography is deliberately different from linear-sidebar (Geist vs Inter Variable), answering the "try different typography" correction, and contains zero yellow, answering the accent rejection. The light verdict card is Factory's signature figure/ground move, applied here to the build verdict.

## Concepts

| | Factory sidebar (leading) | Linear sidebar (accent rejected) | Calm Operations | Monitoring Studio | Dense Workbench |
|---|---|---|---|---|---|
| File | [Open](factory-sidebar/index.html) | [Open](linear-sidebar/index.html) | [Open](calm-operations/index.html) | [Open](monitoring-studio/index.html) | [Open](dense-workbench/index.html) |
| Typography | **Geist 400 + Geist Mono uppercase labels** | Inter Variable (rejected per user) | Inter | Inter | Inter |
| Accent strategy | **No accent buttons** — chalk/bone neutral CTAs; orange/green only on status/data | Acid-lime CTA — **user rejected yellow** | Blue primary | Teal/lime signals | Plum accent |
| Canvas | `#101010` obsidian, warm grays, bone light-card verdict | `#08090a`, carbon cards | Light | Dark charcoal/teal | Warm paper |
| Navigation | Grouped sidebar (user-preferred) | Grouped sidebar | Grouped sidebar | Icon rail | Top menus |
| Distinctive move | Light verdict card = the “figure” on dark ground | Inset hairline cards | KPI cards | Signal lane | Inspector pane |

**Recommendation for discussion:** Proceed with **factory-sidebar** — it answers both corrections (different typography, no yellow) while keeping the sidebar and the dark aesthetic from the Linear round. If the light verdict card feels too loud, a variant can render the verdict on carbon instead — say so and it becomes a refinement variant. Awaiting the user's confirmation.

## Compare fairly

Open each HTML file at a wide browser width, then at a narrow phone-sized width. In every variant try: (1) open navigation, (2) the primary Run all action and cancel/confirm, (3) switch the preview state from populated to empty/error and back, (4) tab through the controls. The desktop navigation and page information are the same in each, but the hierarchy and disclosure differ.

### Verification record

**factory-sidebar (2026-10-14, v3 — verdict card darkened):** PASS at 375/768/1024/1440 CSS px. v3 conformance: verdict card is now **carbon `rgb(29,26,24)` with ash border `rgb(61,58,57)`**, verdict word bone, subtext warm granite, label pale stone, orange pulse kept; primary button carbon (from v2). Programmatic scan: **no element in the page has a background above rgb(200,200,200)** — the all-dark treatment is total. Screenshot: `~/.hermes/cache/scratch/lionidas-visual-drill/factory-sidebar-v3-1440.png`.

**linear-sidebar (same drill):** PASS at 375/768/1024/1440 CSS px — no horizontal overflow (doc scroll == clientWidth at every width), primary action fully inside the viewport, no JS errors, zero `/api/` requests; mobile drawer opens/closes with correct `aria-expanded`; empty/error/preview states toggle and retry recovers; confirmation dialog traps focus and the simulated action updates the verdict. Token conformance measured via computed styles: canvas `rgb(8,9,10)`, acid-lime CTA `rgb(228,242,34)` with 6px radius, cards `rgb(15,16,17)` with inset hairline shadow, Inter Variable with `cv01/ss03/zero` enabled, h1 weight 400, active nav uses inset acid-lime marker. Screenshots: `~/.hermes/cache/scratch/lionidas-visual-drill/linear-sidebar-{1440,375}.png`.

**Earlier three concepts (same drill):** PASS at all four widths for overflow/actions/errors/states; a first-pass mobile screenshot artifact (drawer scrim painted during full-page capture) was fixed by moving the scrim to the `.open` state; final screenshots confirmed clean mobile rendering.

These checks are preview validation, not a production accessibility audit or evidence of improved user outcomes.

## After the user's pick

Record the selected direction, refine any hybrid as a new variant, and write a separate implementation plan for semantic tokens, shared shell/navigation and the easiest viable page pilot. Installing shadcn-vue into `web/` or migrating the 21 routes is **outside** this preview approval.
