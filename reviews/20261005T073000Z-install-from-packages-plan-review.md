# Review — install-from-packages plan

- Plan: plans/20261005T073000Z-install-from-packages-plan.md
- Verdict: **Ready for implementation** (4 findings folded into the build)
- Scope: replace `.app` discovery with a package dir; CI + registry out of scope; `unchecked` freshness confirmed.

## Findings

- **[H1|High] The runner's STALE_ARTIFACT path breaks silently, not loudly.**
  Plan §5 said "left as dead-safe legacy OR removed". Wrong frame: grep shows
  `spec.artifactPath && spec.srcPath` has NO live caller once the UI routes are
  gone (runTemplatePlayback callers pass neither for UI plays — the branch
  exists for API callers that name a build). Killing discovery does not remove
  the API seam. Build decision: KEEP the runner branch (an API caller naming
  artifactPath+srcPath still gets the freshness gate), but its importArtifact
  provenance write must switch to recording the given path as-is (no store
  import — the store is gone). The branch becomes: install from the given
  path, record that path. Test `alloy.runner.test.ts:154` continues to pin it.
- **[M1|Medium] `unzip` availability.** The plan's identity read shells `unzip -p`.
  macOS ships unzip; CI Linux too. But `plutil` is macOS-only — the plan's
  stdin plutil for the plist INSIDE the ipa inherits the same constraint the
  codebase already has (readBundleIdentity uses plutil). No new constraint
  introduced; note for the future Android/Linux port: swap to a JS plist
  reader then. No change required now.
- **[M2|Medium] install-route test harness reuses `appPath` naming.** The
  existing tests plant `.app` dirs and POST `appPath`. The new contract is
  `packagePath` inside packagesDir. All 8 install tests + artifacts discovery
  test rewrite to: plant a fixture `.ipa` in a temp packagesDir (Payload/
  X.app/Info.plist → zip), POST `packagePath`. `plantArtifact` helper becomes
  `plantPackage`. The discovery test (GET /artifacts) becomes GET /api/packages
  over the temp dir. artifacts.test.ts (81 lines pinning findArtifacts/
  importArtifact/appsStoreDir) is DELETED with the module — its scope ends
  with discovery.
- **[L1|Low] Empty-state honesty in the picker.** The web empty state must name
  the actual configured dir (resolved server-side, shipped in the packages
  payload as `dir`), not a guessed default — an operator pointing
  CRUCIBLE_PACKAGES_DIR elsewhere sees the truth. `GET /api/packages` returns
  `{ dir, packages }`.

## Verified during review

- Bundle-id join key claim: templates.app_bundle_id, app_catalog.bundle_id,
  suites bundle-lock — all confirmed by earlier greps.
- `simctl install` accepts .ipa directly — documented Apple behavior; will be
  exercised live in the drill with a real fabricated ipa.
- No other importer of findArtifacts/importArtifact beyond routes/manual.ts,
  alloy/runner.ts, and the two test files (grep over server/src + server/test).
- The playback APP_NOT_INSTALLED hint path (lastArtifactFor) needs zero
  changes — it reads app_catalog rows the new install writes.
- Plan's test plan covers: identity read, list, apk listing, route guards
  (400 outside dir, 422 apk, 409 not booted). Added by this review: in-flight
  409 already covered by existing test (kept).

## Residual risk

Moderate-low. The install path is well-guarded by tests; the web swap waits
on the sketch pick. Old store `.app` files on disk are untouched (deliberate:
no destructive cleanup in this PR).
