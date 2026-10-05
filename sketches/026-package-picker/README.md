# 026 — package picker

The install-app picker after the packages direction (server shipped: `GET
/api/packages` → `{dir, packages[]}` with `{path,bundleId,version,kind,mtimeMs,sizeBytes,projectId}`;
`POST /api/devices/:udid/install {packagePath}`). `.app` discovery is gone —
the picker lists CI-dropped package files.

One axis: how the list is organized. All variants: Axiom tokens, graphite
modal, kind chip (`ipa` ember / `apk` neutral), version + age columns,
packages-dir line under the title, apk rows selectable but the install button
reads `android later` (422 APK_UNSUPPORTED today).

| dir | stance |
|---|---|
| `a-flat-list/` | all packages, freshest first — the API's natural order |
| `b-grouped-by-app/` | bundle-id group heads (house `.a2-group-head` rhythm), newest within each |
| `c-latest-first-split/` | two sections: latest-per-app (highlighted, ember version) + earlier builds |

Empty state (shared contract): `no packages yet — drop .ipa files in <dir>`
(the real configured dir, shipped by the API payload).

Data honesty: demo rows are realistic filenames; the real identity (bundle,
version) comes from each package's manifest, so a mis-named file still groups
correctly under B.

Brainstorm: `brainstorm/20261005T065748Z-install-from-ipa.md` · plan/review:
`plans/`+`reviews/` 073000Z pair. Server side committed on
`feat/install-from-packages` (a5cbc50).
