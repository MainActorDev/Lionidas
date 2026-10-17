# The orange accent — does it fit the whole app?

- Source prompt: "I think I kind don't see that the orange accent color is fit in the whole app"
- Created: 2026-10-17T11:27:20Z
- Status: Approved — mono chrome + vermilion signal (user, this session: "Mono. failures/degraded not orange but some other color that you see fit", then "Approved" on the rendered preview)

## Goal and context

The user feels the orange accent (`--color-ember` / `--status-orange` / `#ee6018`) doesn't sit well across the app. This is a design-token and semantic question, not a bug: the feeling is that orange is everywhere and something about that reads off.

**The root tension (verified in code):** the token file itself says the orange is a *status* color — `tokens.css:27` reads "**Status accents — DATA/STATUS ONLY, never fills**", with ember annotated as "Signal orange — live status, failures, active marks". In practice the app drifted far from that contract:

- `--color-ember` referenced across **64 files**
- **45 uses as a FILL** (`background: var(--color-ember…)`) — the exact thing the token comment forbids: `+ new chat` button, send button, new-chat tab, selected states
- **195 uses as text color** (links, active labels, chips, focus states, running markers)
- **112 border uses** (focus rings, active pills, live badges, stop button)

So the signal color became the primary interactive accent. Two plausible sources of the "doesn't fit" feeling:

1. **Semantic overload** — errors ALSO read orange (`--color-err` = the same orange). A filled orange button is visually the same family as a failure state. On a test-harness where failures are constant content, orange chrome competes with orange data everywhere.
2. **Temperature/volume** — #ee6018 is a hot saturated orange. At 45 fills + ~200 text uses on warm-dark backgrounds it dominates the warm gray/carbon palette instead of punctuating it.

Interpretation (not confirmed): the user wants either less orange overall, a different accent, or orange confined to where it means something.

## Confirmed inputs and decisions

- User statement: orange accent doesn't feel like it fits the whole app. (verbatim, this session)
- Token contract: ember = status accent, "DATA/STATUS ONLY, never fills" (`web/src/styles/tokens.css:27-31`).
- Verified usage: 64 files; 45 fill uses; 195 text-color uses; 112 border uses (grep of `web/src`, this session).
- Errors and live-status share the same orange (`--color-err: var(--status-orange)`).
- The app is otherwise warm-neutral: carbon/graphite surfaces, bone text, sage (ok) and gold (warn/queue) as the only other accents.

## Exploration

### Option A — Restraint pass (orange stays, fills go)
Keep #ee6018 exactly, but enforce the original token contract: no fills. Buttons become hairline/ghost (border + orange text) or neutral; orange keeps meaning live/active/failure. ~45 fill sites → borders/text.
- **Fits when:** the issue is volume/heat, not the hue itself.
- **Tradeoff:** primary buttons lose punch; "send"/"new chat" become quieter. Cheapest (CSS-only sweep, baselines regen). Zero semantic change.

### Option B — Split the roles: neutral interactive accent + orange-as-signal
Introduce a neutral accent for interactive chrome (bone/chalk interactive: white primary buttons, hairline emphasis — the Linear/Vercel dark-app pattern), and demote orange strictly to status: live dots, failures, running markers, queued gold stays. Orange *means* something again.
- **Fits when:** the semantic overload is the real problem — orange reads as "error/danger" on primary buttons.
- **Tradeoff:** biggest sweep (touches every interactive state across 64 files) but all token-level. The app loses its most recognizable brand mark from chrome; brand orange survives in status + logo.

### Option C — Keep the accent role, change the hue
Keep an orange-family accent for interactions but tune the temperature: softer terracotta/amber (e.g. #d97a4a range) or promote the existing gold `#d9b06a` to accent. Errors keep a distinct hot orange.
- **Fits when:** the hue's saturation on warm-dark is the irritant; the user still wants a warm accent.
- **Tradeoff:** new hue must be contrast-checked (axe 4.5:1 on tinted backgrounds — we already fought this once with the /cmd chip at #ee6018→4.17:1); risks feeling washed-out; touches all baselines but is one-token change.

### Weak premise to challenge
"Accent must be a color at all." The strongest dark developer tools (Linear, Vercel, GitHub dark) use *neutrals* for chrome and reserve color for status. Lionidas is a test harness — status IS the content. That argues for B.

### Proposed direction (not accepted — awaiting user)
**B**, executed as a two-step: first A's restraint pass (fast, reversible), then introduce the neutral interactive accent. Rationale: it fixes both suspected causes at once, returns the token system to its documented contract, and lets failures/live-states pop again. The chat's agent-moments (live cursor, running meta) keep orange deliberately — the "agent is working" glow stays brand-orange even as buttons go neutral.

## Open questions

1. ~~What feels off~~ **ANSWERED: the hue itself (too hot) — Option C selected** (user, this session). Volume/semantics were not the trigger.
2. WHICH warm hue — terracotta (still orange-family, softer) or gold (moves the accent away from orange entirely)? Contrast data (computed WCAG ratios vs the three app surfaces):

   | Candidate | canvas #101010 | carbon #1d1a18 | tinted #262220 |
   |---|---|---|---|
   | ember current `#ee6018` | 5.73 | 5.21 | 4.75 |
   | terracotta `#d97a4a` | 6.19 | 5.63 | 5.13 |
   | terracotta deep `#c96a3d` | 5.09 | 4.63 | 4.21 ✗ (tinted < 4.5) |
   | amber `#d99a52` | 7.88 | 7.17 | 6.53 |
   | gold (existing warm) `#d9b06a` | 9.39 | 8.55 | 7.78 |

   All candidates except terracotta-deep pass 4.5:1 on every surface (ember itself passes; the earlier 4.17:1 chip failure was a different pairing). Terracotta keeps the brand recognizable; gold abandons orange entirely and collides with the existing queue/warn gold `#d9b06a` (would need the warn accent re-homed).
3. Do fills return, or does C ride along with A's restraint (hue change + fill cleanup in one sweep)? Default proposal: hue change only — minimal diff, evaluate the new hue as-is before sweeping fills.

## Next step

Pick the hue (Q2 — terracotta `#d97a4a` recommended: warm-family, all-surface 4.5:1+, no collision with warn-gold). Then a plan: one-token change (`--status-orange` values in theme.css dark+light) + all-page baseline regen + axe re-run + three-surface side-by-side (overview, runs, agent chat) light/dark for sign-off.
