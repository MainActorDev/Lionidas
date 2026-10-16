# 043 — Chat page revamp — three stances

Scope: EVERYTHING not yet rebuilt in the Phase-5 revamp — the composer chrome, the session list, and the page frame. The timeline body (turn rail, work rows, bubbles, meta) is done (042-A parity, `d1fda0f`) and stays as the shared thread grammar across all three.

## A — Command desk (`a-command-desk/`)

**Stance: launcher-first.** No session sidebar at all — sessions are a horizontal TAB STRIP under the topbar; the composer is a full-width COMMAND BAR pinned at the TOP (like a launcher/omnibox), thread scrolls beneath it. Model chips sit between bar and thread.

- Strong at: fastest ask→answer loop (type before you even look at history); screen real-estate all thread; mobile-friendly by nature (strip scrolls).
- Weak at: composer at top fights 40 years of chat muscle memory; queue items live at the bottom, far from the input; tabs hide session previews.
- Best for: operator-as-power-user who lives in the box.

## B — Split stage (`b-split-stage/`)

**Stance: cockpit.** 240px session rail with RICH rows (title + last-message preview + live), centered thread, composer as a fixed STAGE at the thread foot, plus a slim right TELEMETRY strip (this-turn meters: elapsed/cost/context bar, tool roll-up, session totals).

- Strong at: the most information-dense; live turn telemetry always visible (042-B's inspector idea, slimmed); session previews make switching informed; composer stays where chats live.
- Weak at: three columns is the busiest frame; telemetry column competes with the thread at 1024–1200px; most implementation surface of the three.
- Best for: long agentic turns where watching cost/context/tools matters.

## C — Flow (`c-flow/`)

**Stance: invisible chrome.** No session rail — a `⌘K chats` switcher pill in the header; ONE centered 720px column; the composer is a WHISPER BAR that expands on focus (model chips + hints reveal only while typing). User turns get a hairline left border instead of the rail.

- Strong at: purest reading/writing experience; zero furniture at rest; trivially responsive (already one column); the most "modern chat client" feel.
- Weak at: session discovery hides behind a keyboard convention; telemetry invisible; expansion animation is another motion surface to get right.
- Best for: treat-the-chat-as-a-document sessions; keyboard-first operators.

## Head-to-head

| | A command desk | B split stage | C flow |
|---|---|---|---|
| Ask speed | **fastest** | fast | fast |
| Session switching | tabs (visible, no previews) | **rail + previews** | ⌘K (hidden) |
| Live telemetry | — | **always visible** | — |
| Thread space | most | medium | most (at rest) |
| Mobile | native | columns collapse | native |
| Implementation risk | low (rearrange) | medium (telemetry feed) | low + motion |
| Muscle memory | fights it | **matches it** | matches it |

**My take:** B is the strongest for Lionidas' actual usage — long agentic turns where the telemetry strip (cost/context/tools) earns its column, and session previews genuinely help switching; it keeps the composer at the bottom where every chat app puts it. C is the runner-up if you want minimal and don't care about visible telemetry. A's top-command-bar is the boldest but the riskiest against habit.

All three keep: the shipped thread grammar (rail turns, ⏵ work rows, chips, meta lines, queue slots), Factory tokens, scoped CSS.
