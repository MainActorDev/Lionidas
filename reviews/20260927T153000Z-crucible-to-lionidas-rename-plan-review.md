# Review — Crucible → Lionidas rebrand plan (Stage 1)

- Reviewed plan: `plans/20260927T153000Z-crucible-to-lionidas-rename-plan.md`, Status **Ready** (flipped 2026-09-27)
- Evidence: plan + brainstorm `20260927T153000Z`; live repo greps 2026-09-27 (all file:line claims below re-verified this review); icon pack disk inventory; web/vite.config.ts; `web/dist` gitignore check
- Review verdict: **Needs revision** — one High (coverage), one High (acceptance check as written will fail), plus mediums. No blockers requiring operator decisions; all findings are plan edits.

## Traceability summary

Operator requirements → plan coverage: brand rename ✓ (title/wordmark/prose), navbar icon ✓, favicon ✓, login centered icon ✓, repo-rename-last ✓ (stage 7), freeze decisions ✓ (decision log + out-of-scope list). The three-layer model from the brainstorm is honored. Scope boundary visible-identifiers vs frozen-identifiers is explicit and testable.

## Findings

### F1 — High · coverage: ~20 more files carry the brand in prose/visible strings than the plan's prose stage lists

Plan stage 5 lists README.md, GuidePage.vue ×6, DeviceSidebar.vue ×1. Live grep (2026-09-27) shows additionally:
- `DEFERRED.md` (prose, e.g. line 116 "if Crucible ever leaves localhost")
- `docs/**` — 41 files (ADR, research, plans, features) reference Crucible in prose
- `web/src/composables/simdeckChrome.ts`, `web/src/components/CaseEditorPanel.vue`, `web/src/pages/ScreensPage.vue`, `web/src/pages/DrivePage.vue`, `shared/src/case-yaml.ts` — verified to contain crucible in **comments/docstrings** (import-adjacent, no user-visible strings found beyond those already listed)
- `scripts/setup.sh`, `scripts/dev.sh`, `scripts/setup-forge-tls.command`, `scripts/forge-watchdog.sh` — operator-visible script prose + the plist filename `com.crucible.forge-watchdog.plist` (label frozen ✓, but the **file** ships in `scripts/` and its filename is part of the visible repo surface)

Consequence: "replace the brand name" under-delivers; the acceptance grep (F2) then fails or must be weakened. Correction: stage 5 must enumerate the full prose set with a stated rule — **rename in product-facing prose + docs headers; leave frozen identifiers (env vars, cookie, label, package names, junit prefix) untouched; historical plans/reviews/brainstorms/sketches stay as-is (they are dated records)**. Docs older than the rename may keep historical name with no edit — decide and write the rule down. Verify: the acceptance grep whitelisted per the rule passes.

### F2 — High · acceptance check as written cannot pass

Check: "`grep -ri crucible web/src web/index.html README.md` returns only out-of-scope identifiers". False as written: `web/src` contains ~30 files importing from `@crucible/shared/*` (package name frozen — out of scope), so the grep returns dozens of import lines; also `App.vue:35` wordmark will be renamed but `useInspectTree.ts:12` etc. remain. The check needs an explicit whitelist/regex (e.g. only fail on `>[^<]*crucible|"[^"]*crucible[^"]*"` in rendered strings, or a curated list). Consequence: implementer cannot know done. Correction: rewrite the check as a scripted assertion with the frozen-identifier allowlist; verify by running it against the finished tree.

### F3 — Medium · `web/dist/index.html` still says Crucible

`web/dist` is gitignored (verified) but served by whatever last built it; if deployment serves `dist/` (e.g. the LAN host), the old title persists until a rebuild. Correction: add "rebuild (`pnpm run build`) + verify dist/index.html" to stage 6, or state dev-only deployment. Verify: grep dist after build.

### F4 — Medium · favicon path assumption

Plan copies assets to `web/public/icons/` and "rewrites manifest icon src paths". Vite serves `public/` at root; manifest `src` values like `app-icons/...` must become `icons/app-icon-192.png` style, and index.html `<link href>`s must match exactly. Also the manifest `start_url: "/"` and `display: standalone` are fine, but `theme_color`/`background_color` (pack teal/cream) will tint mobile browser chrome while Axiom tokens stay — acceptable per out-of-scope note, but state it explicitly in stage 1 so it's a decision, not an accident. Verify: fetch each linked asset over the dev server → 200.

### F5 — Low · login hero sizing/radius unspecified beyond "~96px"

Axiom house style: hero icons get a consistent corner radius and border? The navbar entry gets border-radius "per platform look" — vague. Correction: pin exact px (e.g. navbar 20×20 radius 4, login 96×96 radius 20) in stage 3/4. Cosmetic; nonblocking.

### F6 — Low · branch name vs merge state

Plan says fresh branch off `main` — correct now that PR #1 merged (`a6dc57c`). No action; noted as verified.

## Human questions

None blocking. One optional preference: should `docs/` historical documents (41 files) be renamed or left as dated records? Default per F1 rule: leave historical, rename living docs (ADR titles are living). Confirm or override.

## Required plan edits

1. Stage 5: full prose enumeration + rename rule (F1)
2. Acceptance check: scripted grep with allowlist (F2)
3. Stage 6: dist rebuild check (F3)
4. Stage 1: manifest path rewrite spec + theme-color note (F4)
5. Stage 3/4: pinned px values (F5)

## What remains to validate during implementation

- Actual rendered favicon in a browser tab (ico/png pickup differs per browser)
- Navbar icon legibility at 20px in both themes
- `pnpm run check` green after edits
- No broken imports (nothing in scope touches import specifiers, but the check run proves it)
