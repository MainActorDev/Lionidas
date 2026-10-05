# Install from packages (.ipa) — plan

- Source: brainstorm/20261005T065748Z-install-from-ipa.md (all three questions answered; gate closed) + sequencing decision B (brainstorm/20261005T071623Z, user pick)
- Status: Ready
- Scope: replace `.app` artifact discovery (build roots + DerivedData + store) with a package dir of `.ipa`/`.apk` files. CI production of packages and the project registry are OUT of scope (follow-ups). `unchecked` freshness confirmed.

## Objective

The install picker on all three surfaces (cockpit modal, DeviceSidebar card, test-cases choose-artifact) lists CI-droppable package files; install runs `simctl install` on the `.ipa` directly; `.app` discovery code is deleted.

## Server changes

1. **`server/src/manual/packages.ts` (new)**
   - `packagesDir(): string` — `CRUCIBLE_PACKAGES_DIR` ?? `dirname(dbPath)/packages`, resolved absolute (same absoluteness rule as appsStoreDir).
   - `interface PackageInfo { path, bundleId, version, kind: 'ipa'|'apk', mtimeMs, sizeBytes }`.
   - `readIpaIdentity(path)` — `unzip -p <ipa> 'Payload/*.app/Info.plist'` → `plutil -convert json -o - -` (stdin) → bundleId/version; null on any failure (callers skip the row).
   - `listPackages()` — scan packagesDir for `*.ipa`/`*.apk`; identity for ipas; apks listed with `bundleId: null, version: null` (manifest parse lands with Android); freshest first. Partial files (still being copied by CI) read as unreadable identity → skipped naturally; a file-size stability re-check is NOT added (mtime ordering suffices; CI copies are atomic-enough for v1 and the honest failure is a picker row that disappears on refresh).
   - Nullable `project_id` on PackageInfo from day one (registry later; always null this round).
2. **Routes (`routes/manual.ts`)**
   - `GET /api/packages` — `{ packages: listPackages() }` (device-independent; replaces `/api/devices/:udid/artifacts`, which is deleted).
   - `POST /api/devices/:udid/install` — body `{ packagePath }`; must resolve inside `packagesDir()` (400 otherwise — the route never installs arbitrary paths); `kind === 'apk'` → 422 `APK_UNSUPPORTED` ("lands with Android"); booted/busy guards unchanged; `simctl install <udid> <ipa>`; catalog records the package path + version.
3. **`app-install.ts`** — `installApp` takes a pre-read identity (route owns package identity; the old `readBundleIdentity` dir-based read stops applying).
4. **Delete `.app` discovery** — `artifacts.ts` loses `findArtifacts`, `scan`, `scanDir`, `listStoreArtifacts`, `defaultBuildRoots`, `importArtifact`; `appsStoreDir` stays only if still referenced (runner provenance switches to recording the package path directly, no import). Old store `.app` FILES stay on disk (untouched); they simply stop being discovered.
5. **Runner/playback** — unchanged behavior: `APP_NOT_INSTALLED` pre-check + `lastArtifactFor` hint now surface the last package path (catalog rows written by the new install). The `spec.artifactPath && spec.srcPath` branch can no longer fire from the UI (no srcPath source exists); left as dead-safe legacy for API callers, OR removed if tests show no caller — decide at build with a grep.
6. **Tests** — `packages.test.ts`: fixture `.ipa` built in-test (`mkdir Payload/X.app; write Info.plist; zip`) → identity read, list, apk listing, install route guards (path-outside-dir 400, apk 422, not-booted 409). Update tests pinning the old artifacts route/discovery.

## Web changes (AFTER sketch pick — round 026)

- Three surfaces swap `/api/devices/:udid/artifacts` → `/api/packages`; row shape `{path,bundleId,version,kind,mtimeMs,sizeBytes}`; kind chip `ipa`/`apk`; empty state names the packages dir (one line, anti-bloat).
- Guide text: "missing app" section's "build folders, DerivedData, or store" wording → packages dir.
- Sketch variants (one axis — how the package list is organized): a-flat / b-grouped-by-app / c-recent-plus-history.

## Verification

- `pnpm --filter server test` (Node 24.20), `pnpm --filter web check` + `test`.
- Live drill: fabricate a real `.ipa` from an existing store `.app` (`mkdir Payload && cp -R && zip`), drop in packagesDir, pick + install on a booted simulator via the UI, verify catalog row + launch. Purge drill data after.
- Layout drill for the modal (3 widths, no h-scroll) + vision pass.

## Out of scope

CI workflow, project registry (`project_id` stays null), .apk install path, freshness for packages (unchecked, confirmed).
