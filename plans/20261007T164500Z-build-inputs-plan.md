# Production-grade build inputs — plan

- Source: brainstorm/20261007T153719Z-build-inputs-production-grade.md (all
  Qs closed; manifest IMPLEMENT NOW)
- Scope: generic-engine build-input correctness. No UI redesign, no Android.

## T1 — schema: projects.build_scheme / build_configuration (nullable)

`server/src/db/schema.ts` projects table += two TEXT columns (nullable).
`projects/store.ts`: read in getProject/list; settable via updateProject
(extend the admin PATCH payload + zod-ish validation already in routes).

## T2 — manifest reader `readBuildManifest(ws)` (strict)

New `server/src/projects/manifest.ts`:
- Absent `lionidas.yml` → null.
- Parse (reuse the repo's yaml dep — check server/package.json has `yaml`;
  if not, `js-yaml` is already in the tree via butler? verify; else vendor a
  30-line parser for this two-key schema — NO new deps without need).
- STRICT: only top key `build`; only `scheme`/`configuration` under it;
  string values. Anything else → `MANIFEST_INVALID` (Error with the key name).
- Unit tests: absent, valid, unknown top key, unknown build key, wrong type,
  empty values treated as absent.

## T3 — app-scheme discovery v2 (type-aware) + configs

`builds.ts`:
- `discoverAppSchemes(ws)` → { schemes: string[]; configurations: string[] }
  from `xcodebuild -list -json` + pbxproj scan: read
  `<xcodeproj>/project.pbxproj`, collect productType ==
  `com.apple.product-type.application` target names; intersect with shared
  schemes. Module/framework/test schemes excluded BY TYPE.
- Configurations from the same `-list` payload (`configurations` array).
- Replaces the name heuristic; heuristic code deleted.

## T4 — resolution order + provenance + preflight

`startBuild` flow (generic transport only):
1. manifest = readBuildManifest(ws)
2. proj row values (registry)
3. discovery (only for values still unset)
4. Provenance per input: `manifest|registry|discovered`; first log line +
   new builds column `resolution TEXT` (e.g. `scheme=manifest;
   config=registry`).
5. AMBIGUITY: if discovery finds 2+ app schemes and neither manifest nor
   registry pinned one → build fails `SCHEME_AMBIGUOUS` listing candidates
   (fast, pre-compile).
6. PREFLIGHT (seconds, pre-compile): `xcodebuild -showBuildSettings -scheme
   <s> -sdk iphonesimulator -configuration <c>` (discarding output, checking
   exit) — scheme/config must exist; wrong input dies in seconds not minutes.
7. Repo lane transport: manifest/registry inputs logged, not enforced.

## T5 — routes: discovery endpoint + settable inputs

- `GET /api/projects/:id/build-inputs` (admin) → { appSchemes,
  configurations, pinned: {scheme, configuration}, manifest: {scheme,
  configuration} | null, resolution preview } — feeds the pickers.
- `PATCH /api/projects/:id` already exists; extend payload with
  build_scheme/build_configuration (validated: non-empty strings or null).

## T6 — BuildsPage ▶ build… modal v2

Pick-a-project modal becomes pick-project → (if inputs ambiguous) pick
scheme/config step: dropdowns fed by /build-inputs, preselected by
manifest > registry > discovered; "remember" checkbox writes the registry
columns (admin intent, provenance becomes `registry`). Builds row shows
`scheme · config` and provenance chip (manifest/set/auto).

## T7 — repo-shape probe (minimal, iOS-only now)

`probeRepoShape(ws)` at clone time → project row column `repo_shape TEXT`
(`xcodegen|xcodeproj|workspace|unknown`). Generic engine branches on it
(xcodegen generate step only for xcodegen shape; `-workspace` when a
workspace exists — Jenkins precedence: workspace > project). Unknown shape →
fail fast `UNSUPPORTED_REPO_SHAPE` naming what was found. Android/web shapes
are future probes, not built now.

## Verification

- Unit: manifest (6 cases), discovery v2 (fake pbxproj fixtures),
  resolution order (3 provenance paths), SCHEME_AMBIGUOUS, preflight
  rejection, repo-shape branches, MANIFEST_INVALID paths.
- Existing suites stay green: server 1263+, web 37+.
- Live drill: no manifest → build #14 discovered+preflight OK; add a
  `lionidas.yml` (scheme pinned Staging) to the clone → build #15 shows
  `manifest` provenance and Staging config in the artifact name; wrong
  scheme in manifest → preflight fails in seconds with the named error.
- `pnpm --filter server typecheck && pnpm --filter server test`; web
  typecheck+test; drill via API + UI.

## Risks

- pbxproj parsing: regex for productType lines is stable (xcodegen emits
  them); guard with fallback to scheme-name heuristic + warning log if
  pbxproj unreadable — never crash discovery.
- showBuildSettings on intl repo ~5-10s warm: acceptable preflight cost;
  skipped when transport=repo-lane.
- Configurations for xcodegen repos include non-app configs (release) —
  picker lists all; gate stays artifact-level.
