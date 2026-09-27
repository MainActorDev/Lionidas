# Plan (Pending) — Crucible → Lionidas rebrand, Stage 1 visible brand + icons

- Source brainstorm: `brainstorm/20260927T153000Z-crucible-to-lionidas-rename.md` (2026-09-27T15:30:00Z)
- Created: 2026-09-27T15:45:00Z
- Status: **Ready** — all scope questions resolved (see Decision log)

## Confirmed facts (with sources)

**From the operator's request (2026-09-27, verbatim intent):**
- Replace the brand name "Crucible" with "Lionidas"
- Use `/Volumes/berkakyo/Users/berkamain/Downloads/Lionidas-Icon-Pack`: pick the correct-size app icon for the navbar (replacing the current one), the favicon for the website favicon
- Show the app icon above the login form, centered
- "No room for error here"

**Verified in the repo (grep, 2026-09-27):**
- `web/index.html`: `<title>Crucible</title>`, no favicon/link/manifest tags, empty `web/public/`
- `web/src/App.vue:35`: `<div class="logo"><span class="logo-mark" /> crucible</div>`
- `web/src/styles/layout.css:27`: `.logo .logo-mark` = 14px ember triangle (clip-path)
- `web/src/pages/LoginPage.vue`: brand row `.mark` + `crucible` + `internal · LAN`; fields follow
- Prose brand: README.md title; GuidePage.vue ×6; DeviceSidebar.vue ×1 (comment)
- 51 distinct `CRUCIBLE_*` env vars; cookie `crucible_session`; header `x-crucible-agent`; db `crucible.db` (on disk); `~/.alloy/crucible.json`; junit prefix `crucible.{id}`; `crucibleAlloy()` ×7
- Git remote `MainActorDev/Crucible.git`; dir `ai/crucible`

**Verified in the icon pack (disk + README + vision check):**
- app-icons: opaque squares 64/128/192/256/512/1024
- favicons: transparent 16/24/32/48/64/128/256 + favicon.ico (multi-size) + apple-touch-icon 180
- site.webmanifest: name "Lionidas", theme #397D94, bg #FFF8EC, icons 192/512
- README recommends 128 for small UI, 192 for touch/PWA, favicon set at site root
- Vision check: mascot (lion + helmet, cream bg) reads clearly as a colorful mark at 20px

## Decision log

- **2026-09-27, operator:** repo + directory rename happens **last, after everything else**. Recorded as final stage.
- 2026-09-27, operator question: risks + safe replacement paths for env prefix / db filename / cookie+header. Analysis below.
- **2026-09-27, operator:** items 2–4 **frozen** (env prefix, db filename, cookie/header/launchd label stay as-is; the risk/safe-path table is retained for a possible future purge change). Plan flipped to Ready on this decision.
- **2026-09-27, operator:** historical docs follow the review recommendation — dated records (docs/research, docs/plans, brainstorm/, plans/, reviews/, sketches/) stay untouched; living prose (README, DEFERRED, scripts, ADR/feature headings) renamed. Review F1–F5 folded (rev 2).

## Risk + safe-replacement analysis (grounded in live machine state, 2026-09-27)

Live operator state discovered: `com.crucible.forge-watchdog` **is loaded in launchd** (plist `~/Library/LaunchAgents/com.crucible.forge-watchdog.plist`); `server/crucible.db` exists; `CRUCIBLE_PIN` seeds first-boot users; shell profiles carry **0** `CRUCIBLE_*` exports.

The universal failure mode is **silent default fallback**, not a crash: `CRUCIBLE_DB_PATH` unset → resolves `./crucible.db` relative to cwd → new empty DB → *looks like total data loss*.

| # | Change | Real risk (grounded) | Safe replacement path |
|---|---|---|---|
| 2 | `CRUCIBLE_*` → `LIONIDAS_*` (51 vars) | Any external surface exporting the old prefix (CI, launchd later, docs, muscle memory) silently falls back to defaults — worst case the empty-DB illusion above. Watchdog opt-out `CRUCIBLE_WATCHDOG=0` stops being honored. | **Dual-read alias window:** helper `env(k) = LIONIDAS_k ?? CRUCIBLE_k`; both prefixes work; emit deprecation line when the old one fires; drop old reads only after a release with zero hits. Mechanical, testable per-var. |
| 3 | `crucible.db` → `lionidas.db` | Boot with no migration creates a fresh empty DB (users/cases "vanish"); artifacts store root (`dirname(db)/apps`) re-anchors — harmless — but the old file orphans. | **Boot-time move:** if new path absent and old present → `rename()` + one `.bak` copy, log the move, then bounce the watchdog in the same change. Or keep the name forever (invisible surface). |
| 4a | cookie `crucible_session` | Every active session logs out once (re-login). No data risk. | **Dual-read regex alternation** `(?:lionidas_session|crucible_session)=`, write the new name only. Sessions survive; old cookie dies on next Set-Cookie. |
| 4b | header `x-crucible-agent` | It is self-generated from BOOT_SECRET (roles.ts:37) and consumed by CLI/agent callers — an older CLI would 403 as agent. | Same dual-read on the server; ship CLI in lockstep. |
| 4c | launchd label `com.crucible.forge-watchdog` (+ plist filename) | Renaming the label without `bootout` leaves TWO watchdogs. | `launchctl bootout` old → install new label → verify `launchctl list` shows exactly one. One-command verification. |

All four have cheap, verifiable safe paths; none *require* changing (all invisible).

## Resolved scope questions

1. Repo/dir rename — **last, after everything else** (operator). Final stage below.
2. Env prefix `CRUCIBLE_*` — **frozen** (operator accepted the risk/safe-path analysis; table retained for any future purge).
3. DB filename `crucible.db` — **frozen**.
4. Cookie / agent header / launchd label — **frozen**.

## Objective

Rebrand every human-visible surface from "Crucible" to "Lionidas" using the shipped icon pack, with zero behavioral change: no storage, auth, env, or wire identifier is touched (decision log above). Complete when the three surfaces (navbar, browser tab, login screen) show the new identity, all visible prose is renamed, and `pnpm run check` is green.

## In scope

- Icon assets into `web/public/` (app icon 128 + 192, favicon set + .ico + apple-touch 180, site.webmanifest with adjusted icon paths)
- `web/index.html`: `<title>Lionidas</title>` + full favicon `<link>` set + manifest link
- `web/src/App.vue` navbar: `<img>` app-icon-128 at ~20px (border-radius per platform look) replacing `.logo-mark`; wordmark text `lionidas`; retire the triangle CSS in `web/src/styles/layout.css`
- `web/src/pages/LoginPage.vue`: centered app-icon-192 above the fields, wordmark below it, keep `internal · LAN`
- Prose: README.md title + tagline line, GuidePage.vue ×6, DeviceSidebar.vue ×1 comment
- Verification: `pnpm run check`; live browser check of navbar, tab favicon, login page

## Out of scope (frozen per decision log)

- `CRUCIBLE_*` env prefix, `crucible.db`, `crucible_session`, `x-crucible-agent`, launchd label, junit prefix, `crucibleAlloy()` identifiers, package names `@crucible/*`
- Axiom token re-theming (pack's teal/cream stays in the icons only)

## Stages

1. **Assets** — copy `app-icons/lionidas-app-128.png`, `lionidas-app-192.png`, `lionidas-app-512.png`, `favicons/*` (all sizes + .ico + apple-touch), `site.webmanifest` → `web/public/icons/`; rewrite manifest icon `src` to `/icons/lionidas-app-192.png` + `/icons/lionidas-app-512.png` (absolute root paths — vite serves public/ at root); keep `name: Lionidas`; **decision:** keep pack `theme_color #397D94` / `background_color #FFF8EC` (tint only mobile/PWA chrome; Axiom tokens untouched); verify pixel sizes with `sips`.
2. **HTML shell** — title, favicon links (.ico any / 32 / 16 / apple-touch / manifest).
3. **Navbar** — App.vue: `<img src="/icons/lionidas-app-128.png" width="20" height="20">`, `border-radius: 4px`, replacing `.logo-mark`; wordmark `lionidas`; delete the triangle clip-path block in layout.css.
4. **Login** — LoginPage.vue: centered hero above the fields — `<img src="/icons/lionidas-app-192.png" width="96" height="96">`, `border-radius: 20px`, `margin: 0 auto`; wordmark `lionidas` + `internal · LAN` row beneath; retire the 12px ember-dot `.mark` CSS.
5. **Prose** — full set with the rename rule (operator-confirmed 2026-09-27):
   - **Rule:** rename in living product prose; leave dated records as-is; never touch frozen identifiers.
   - Living prose to rename: `README.md` (title + tagline), `web/src/pages/GuidePage.vue` ×6, `web/src/components/DeviceSidebar.vue` ×1 comment, `DEFERRED.md` (prose refs), `scripts/setup.sh`, `scripts/dev.sh`, `scripts/setup-forge-tls.command`, `scripts/forge-watchdog.sh`, ADR titles + living feature docs in `docs/adr/` + `docs/features/` where the name appears in a heading.
   - Dated records left untouched: `docs/research/*`, `docs/plans/*`, `brainstorm/*`, `plans/*`, `reviews/*`, `sketches/*` (dated artifacts — historical by design).
   - Frozen identifiers never touched: `CRUCIBLE_*` env vars, `crucible_session`, `x-crucible-agent`, `com.crucible.forge-watchdog` label AND plist filename (frozen until the repo-rename stage decides), `@crucible/*` package imports, `crucibleAlloy()`, junit prefix, `crucible.db`.
6. **Verify** — `pnpm run check` green; `pnpm run build` then `grep -ci crucible web/dist/index.html` returns 0 (dist serves the old title until rebuilt — gitignored, rebuild is the fix); browser: navbar icon + wordmark, tab favicon, login hero centered; no console errors.
7. **(Later, separate operator instruction)** repo/dir rename — NOT part of this change's PR.

## Acceptance checks

- `web/index.html` title is Lionidas; favicon set + manifest linked; `web/public/icons/` contains the assets
- Navbar renders the lion icon (no ember triangle anywhere), wordmark reads lionidas
- Login shows the app icon centered above the form
- Scripted visible-string check passes: `grep -rniE '>\s*[^<]*crucible|"[^"]*crucible[^"]*"' web/src web/index.html README.md` filtered against the frozen allowlist (`@crucible/shared` imports, `CRUCIBLE_*` env names, `com.crucible.forge-watchdog`, junit/cookie/db identifiers) returns zero lines; paste the output in the PR body
- `pnpm run check` exit 0
- Commit on a fresh branch off `main` (e.g. `feat/lionidas-brand`), push, PR — per house workflow (PR create-only; human merges)
