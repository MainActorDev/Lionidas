# Rename Crucible → Lionidas — deep analysis

- Source prompt: "replacing the brand name 'Crucible' into 'Lionidas' … deep and thorough analysis what would it take … No room for error here." + icon-pack placement tasks (navbar icon, favicon, login hero icon)
- Created: 2026-09-27T15:30:00Z
- Status: Direction selected

## Goal and context

User wants the product rebranded from **Crucible** to **Lionidas**, with the shipped icon pack (`~/Downloads/Lionidas-Icon-Pack`) supplying the visual identity: an app icon in the navbar replacing the current CSS triangle, favicon set for the website, and the app icon above the login form, centered. "No room for error" = the rename must be exhaustive and class-aware, not a blind `sed`.

The rename is a **display/brand rename by default, not a storage-break rename**. That distinction drives everything below.

## Confirmed inputs and decisions

- Icon pack inventory (verified on disk): app-icons 64/128/192/256/512/1024 (opaque squares); favicons 16/24/32/48/64/128/256 transparent + favicon.ico multi-size + apple-touch-icon 180 opaque; mascot; avatars; masters (all 1254px); README + site.webmanifest (name "Lionidas", theme #397D94, bg #FFF8EC)
- Current brand surfaces (verified by grep):
  - `web/index.html` title "Crucible"; no favicon links at all today
  - `web/src/App.vue:35` navbar `<div class="logo"><span class="logo-mark" /> crucible</div>`
  - `web/src/styles/layout.css:27` `.logo .logo-mark` = 14px ember triangle (clip-path "crucible vessel")
  - `web/src/pages/LoginPage.vue` brand row: `.mark` + `crucible` + `internal · LAN`
  - README.md `# Crucible`; GuidePage prose ×6; DeviceSidebar comment ×1
  - 51 distinct `CRUCIBLE_*` env vars across server/web/shared src
  - Package names: `crucible`, `@crucible/server`, `@crucible/web`, `@crucible/shared`
  - Live identifiers: `crucibleAlloy()` (7 call sites), `crucible_session` cookie, `x-crucible-agent` header, `crucible.json` config path, `crucible.db` filename (4 refs + on-disk file), junit `crucible.{id}` class prefix
  - Git remote `MainActorDev/Crucible.git`; directory name `ai/crucible`
  - Alloy integration reads gitignored `~/.alloy/crucible.json` (user's machine has it live)

## Exploration

### What "rename" has to mean — three layers

1. **Human-visible brand (must change, zero risk):** UI strings, page title, README, guide prose, login card. This is the actual ask.
2. **Wire/storage identifiers (must NOT change casually):** session cookie name, agent header, db filename, `~/.alloy/crucible.json`, env-var prefix, junit class prefix. Renaming these **logs everyone out**, orphans the existing `crucible.db`, breaks the live Alloy config file, breaks every operator's shell profile / launchd / scripts that export `CRUCIBLE_*`, and invalidates junit history diffs. "No room for error" is precisely why these should stay stable in the same change (or be migrated explicitly with dual-read windows).
3. **Code identifiers (cosmetic, safe anytime):** `crucibleAlloy()` → rename to neutral (`alloyClient()`) or leave. Zero runtime effect.

The error-proof move: **rebrand layer 1 fully, freeze layer 2, decouple layer 3 later if desired.** Mixing layers in one sed is where renames go wrong.

### Findings that shape execution

- **The icon pack is raster-only.** The navbar needs a small crisp mark; `app-icons/lionidas-app-128.png` (opaque square) renders at the 14–24px navbar slot with the mask/rounded look the platform expects. The pack has no SVG; using the 128px PNG at 2× for a ~64px-effective slot is the correct-size choice. Favicon: ship the pack's full favicon set + `favicon.ico` + apple-touch + the webmanifest per the README's snippet, into `web/public/`, and add the standard `<link>` set to `index.html`.
- **Login hero:** the "app icon above the forms, centered" = `app-icons/lionidas-app-192.png` (the README's own PWA/icon usage size; 192 is the touch-scale crisp size for a ~96px rendered hero). Replaces the current `.mark` row; keep the `internal · LAN` sub and wordmark text (now `lionidas`).
- **Colors:** the pack's own theme colors (#397D94 teal, #FFF8EC cream) are NOT the app's Axiom tokens. Do not repaint the design system in this change — the icons carry the identity; token theming is a separate decision if wanted later.
- **51 env vars:** all stay `CRUCIBLE_*` (layer 2). A comment noting the prefix is now legacy-brand is enough.
- **Repo/dir rename:** `MainActorDev/Crucible.git` → `Lionidas.git` and the local dir are **operator decisions** (breaks remotes, gitstatus, scripts, muscle memory). Out of scope unless explicitly ordered; flagged in open questions.

### Proposed execution (small, verifiable)

Stage 1 — assets + visible brand (this is the whole user-visible change):
1. Copy `app-icons/`, `favicons/`, `site.webmanifest` → `web/public/icons/` (flat, path-adjusted)
2. `index.html`: title → `Lionidas`; add favicon link set (ico + 32/16 png + apple-touch + manifest)
3. `App.vue` navbar: `<img>` with the 128 app icon (sized ~20px, border-radius per platform look) + text `lionidas`; retire the `.logo-mark` triangle CSS
4. `LoginPage.vue`: centered app icon (192) above the form fields, wordmark below it, keep `internal · LAN`
5. README title line; GuidePage + DeviceSidebar prose
6. Verify: `pnpm run check` + browser eyeball of navbar/login/tab icon

Stage 2 (optional, separate): neutral-ize code identifiers (`crucibleAlloy` → `alloyClient`), cookie/header aliases with dual-read, env-prefix alias `LIONIDAS_*` with `CRUCIBLE_*` fallback.

## Open questions

1. **Repo + directory rename** (`github.com/MainActorDev/Crucible` → `Lionidas`, `ai/crucible` → `ai/lionidas`)? Breaks remote URLs, local scripts, and the pre-push hook path — operator call, default **no** in this change.
2. **Env prefix migration** (`CRUCIBLE_*` → `LIONIDAS_*` with read-fallback)? Default **no**: 51 vars, zero user benefit today.
3. **DB filename** `crucible.db` → keep (default) or rename with a boot-time move? Default keep.

## Next step

Approve Stage 1 scope (visible brand + icons + favicon + login hero). Then execute in one branch, verify with `pnpm run check` + live browser check of the three surfaces (navbar, tab, login).
