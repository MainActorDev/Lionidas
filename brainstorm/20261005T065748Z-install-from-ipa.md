# Install app from .ipa (replace build-dir/DerivedData discovery)

- Source prompt: "On install app, I want to replace the source of the app installation by using .ipa (or .apk later for Android). Instead of using the artifacts/derived data cache." (with /hms-brainstorm-rough-ideas)
- Created: 2026-10-05T06:57:48Z
- Status: Direction selected — ingestion via package dir; CI production phased out of scope (follow-up 2026-10-05)

## Decisions

- **Q1 answered (user, 2026-10-05)**: packages come from an in-project CI that
  produces `.ipa` and/or `.apk`. Ingestion side = the watched-folder contract
  (Option A): CI writes package files into a directory Lionidas scans; browser
  upload stays OUT of scope.
- **CI production itself: out of scope for this round** (agent recommendation,
  accepted implicitly — flagged for explicit confirm at plan time): build the
  ingestion + picker + install chain first against a hand-dropped `.ipa`, then
  land the CI workflow as its own PR. Rationale: the ingestion side is valuable
  and testable standalone; CI drags in signing/scheme/runner specifics and the
  Android toolchain question; the only contract between them is the folder.
- **Contract to define NOW** (so CI can target it later): package dir path
  (`CRUCIBLE_PACKAGES_DIR`, default `<db>/packages/`), layout flat
  (`*.ipa` / `*.apk` at top level), filename carries no required semantics
  (identity always read from the package's own manifest).
- **Q2 answered (user, 2026-10-05)**: REPLACE — `.app` discovery from build
  roots and DerivedData is killed entirely; the picker shows packages only.
  Store `.app` entries and their discovery code paths are removed, not kept
  alongside.
- **Q3 answered (user, 2026-10-05)**: `unchecked` confirmed — no freshness
  gate for package installs/runs; no new comparison invented. Pending gate
  CLOSED; ready for plan → sketch → build.

## Goal and context

Today's install sources are discovered `.app` bundles from repo build outputs
(`CRUCIBLE_BUILD_ROOTS`), Xcode DerivedData, and the Crucible store. The user
wants the install source to become packaged files — `.ipa` now, `.apk` later
when Android arrives — instead of the machine-local build caches. Rationale
(interpretation): a package file is the shippable artifact, portable across
machines/CI, and decouples Lionidas from any developer's local Xcode layout.

## Confirmed inputs and decisions

- User-confirmed: install source becomes `.ipa`; `.apk` is a later extension
  (design should not hardcode iOS-only concepts where avoidable).
- Current chain (verified in code):
  - Discovery: `findArtifacts()` (`server/src/manual/artifacts.ts`) scans build
    roots + DerivedData + store for `.app` dirs; identity via `readBundleIdentity`
    (plutil on `Info.plist` inside the .app directory).
  - Picker UI (3 surfaces): cockpit install modal, DeviceSidebar install card,
    TestCasesPage `choose artifact…` — all fed by `GET /api/devices/:udid/artifacts`.
  - Install: `POST /api/devices/:udid/install` → `importArtifact()` (APFS clone
    into `appsStoreDir()`) → `installApp()` runs `simctl install` directly; store
    paths only, catalog + provenance recorded from the store.
  - Playback path: `alloy_apps install` with `artifactPath` + `srcPath`; the
    STALE_ARTIFACT freshness gate compares artifact vs source tree.
- Technical facts: `simctl install` accepts a `.ipa` path directly. Identity
  (bundle id + version) is readable from a `.ipa` by unzipping
  `Payload/*.app/Info.plist` (one temp-file plutil call — no full extraction
  needed). A `.ipa` has no `srcPath`, so the current freshness gate cannot apply
  to it.

## Exploration

**Where do .ipa files come from?** (the real design fork)

- **Option A — watched drop folder** (server-side): a directory (e.g.
  `CRUCIBLE_IPA_DIR`, default `<db>/packages/`) scanned for `.ipa` files; the
  picker lists them like today's artifacts. User/CI drops files there. Zero new
  upload surface; but getting a file in requires Finder/CLI outside the app.
- **Option B — upload through the browser**: the install modal gets an upload
  affordance; the file lands in the store. Self-contained product (works from
  any client machine), matches "the dashboard owns its inputs" direction; needs
  a multipart/base64 upload route + progress UI (zip-import precedent exists:
  fflate base64 body for screens import).
- **Option C — both**: drop folder for CI + upload for humans. Most surface
  area; can be phased (folder first, upload second).

**Store + install mechanics** (mostly settled regardless of A/B/C):

- Store keeps the `.ipa` FILE (content-addressed or `<bundleId>-<version>-<mtime>.ipa`,
  mirroring today's store naming); discovery of `.app` dirs from build roots and
  DerivedData is REMOVED (user: replace, not add). The store's existing `.app`
  entries can keep working or be migrated — see question 2.
- Install: `simctl install <udid> <ipa>` directly; identity read once at import
  (unzip Info.plist → plutil) and recorded in the catalog; `.apk` later maps to
  its own installer seam (adb), selected by extension.
- Freshness gate: `.ipa` has no srcPath → gate off (`unchecked`), same as today's
  no-src contract. The STALE_ARTIFACT path stays for any remaining `.app` store
  entries if kept.

**UI impact**: the picker modal changes materially (source list = packages; new
upload/drop affordance under B/C) → a sketch round (≥3 variants) runs before
build per the standing gate, once direction is picked.

## Open questions

1. ~~Source of the .ipa files~~ — answered: CI-produced, ingested via the
   watched package dir. CI workflow creation is a separate follow-up.
2. **Replace or coexist** — kill `.app` discovery entirely (pure package
   picker), or keep the store's already-imported `.app`s installable alongside?
   Pure replace is cleaner; coexist preserves last-known-build auto-fix hints
   that currently reference store `.app` paths.
3. **Freshness** — confirm the stale-build gate simply doesn't apply to
   package installs (renders `unchecked`, no gate), rather than inventing a new
   comparison (e.g. build number vs App Store).

## CI follow-up notes (out of scope now, recorded so they survive)

- Simulator truth: a simulator `.ipa` is NOT an App-Store/archive .ipa — it
  must carry simulator-arch binaries, unsigned (xcodebuild -sdk
  iphonesimulator → zip Payload/). Device-signed archives won't install on
  simulators. The CI workflow must build the simulator slice explicitly.
- Android later: `.apk` maps to `adb install`; the ingestion side
  (dir + identity-from-manifest) is shared, the install seam switches by
  extension — the design keeps a `kind: 'ipa' | 'apk'` discriminator for this.
- CI output should COPY (not symlink) into the package dir, or the dir IS the
  CI artifact output — decide at CI time; ingestion treats both the same.

## Next step

Answers to the three questions → plan (pending gate closes) → sketch round for
the changed picker modal → build on a feature branch.
