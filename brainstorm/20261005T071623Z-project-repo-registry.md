# Project/repo registry (CI/CD anchor + agent repo context)

- Source prompt: "in relation to this [the .ipa work], I feel the need that we should implement some kind of project/repo registry. This can be used for CI/CD pipeline and repo context for the build agentic AI." (with /hms-brainstorm-rough-ideas)
- Created: 2026-10-05T07:16:23Z
- Status: Exploring — questions open

## Goal and context

A first-class registry of PROJECTS (repos) in Lionidas. Two named consumers:
(1) CI/CD — the pipeline that builds `.ipa`/`.apk` packages needs to know which
repo, branch/scheme, and settings produce which package; (2) the build agent —
its repo context today is a hardcoded single repo (`repoSource('lionidas-repo')`
boot-seeded from the server's own tree), so multi-project support needs
per-project source registration.

Related, already-decided direction: install sources become CI-produced packages
in a watched dir (brainstorm/20261005T065748Z-install-from-ipa.md — pending
gate closed, ready to build). The registry is the natural anchor that connects
a package to the project that built it.

## Confirmed inputs and decisions

- User-confirmed: a project/repo registry is wanted; its two consumers are
  CI/CD pipeline config and repo context for the build agent.
- Verified current state:
  - No `projects` table (DB tables listed — 38 tables, none project-shaped).
  - Agent repo context: single hardcoded repo (`server/src/agent/sources.ts:11-12`,
    `repoConnector('lionidas-repo', { origin, symbols })`, boot-seed from
    `import.meta.url` root).
  - Server config is env-only (`CRUCIBLE_*` in config.ts) — no persisted
    project settings.
  - `templates` (test cases) already carry `app_bundle_id` — the app identity
    exists; the REPO identity does not.
  - `app_catalog` records installed artifacts per bundle id (path, version).

## Exploration

**What is a project here?** Proposal: a project = one source repo that builds
one or more apps. Minimal fields: `id`, `name`, `repoUrl` (or local path),
default branch, and later: build config (scheme, configuration, sdk), and the
link `project → bundleIds[]` (which apps it produces). The bundle id is the
join key the whole system already speaks (templates, app_catalog, suites are
bundle-locked).

**Where it plugs in (by consumer):**

- CI/CD (future): the pipeline definition lives in the repo itself
  (`.github/workflows` etc.); the registry holds the LIONIDAS-side view —
  which projects exist, where their packages land, which project owns a
  package. Package rows gain `project_id` → the picker can show "lionparcel
  consumer · main · #142" instead of a bare filename.
- Agent: `seedSources` ingests each registered project's repo (replacing the
  single hardcoded connector); the agent's system prompt gains the project
  list ("repos you may reference"). Retrieval stays per-query — no per-project
  isolation needed at first.
- Install chain (the .ipa work, already decided): unchanged mechanically —
  the package dir contract stands; the registry ENRICHES (ownership labels),
  it does not gate.

**Sequencing options:**

- **A — registry first**: land the projects table + CRUD page + agent
  multi-repo seeding, THEN the .ipa ingestion (packages reference
  `project_id` from day one). Clean data model; delays the install swap.
- **B — .ipa first (as planned), registry second**: the install work ships
  standalone (packages unattributed), the registry adds `project_id` + UI
  enrichment later. Fastest to value; one migration later.
- **C — merged**: one branch does both. Big blast radius; couples the picker
  sketch round to a data-model round.

Recommendation: **B** — the .ipa work is decided, scoped, and unblocked; the
registry has open questions below that deserve their own round. Design the
packages store now with a nullable `project_id` column so B costs nothing
later.

## Open questions

1. **Scope of "project"** — one repo = one project? What about monorepos that
   build several apps (multiple bundle ids from one repo — one project with
   many apps, or a project per app)? The bundle-id join argues for one
   project → many bundle ids.
2. **Local path vs remote URL** — does the registry store a local clone path
   (agent + CI run on this machine), a git URL, or both (URL + resolved local
   path)? Today's agent seeds from a LOCAL path.
3. **Who edits it** — a projects page in the dashboard (CRUD, like suites),
   or config-file/env only? Given the "registry is a machine-readable
   rulebook" north star and CI as a consumer, a dashboard CRUD page fits the
   house pattern; but is it user-facing or admin-only?
4. **Agent ingestion depth** — full multi-repo ingest at boot (N repos ×
   symbol chunks), or lazy per-project ingest on first use? Boot time and
   storage scale with repo count.
5. **CI pipeline definition** — where does the actual pipeline config live:
   in the project registry (Lionidas-defined pipelines), or in the repo
   (`.github/workflows` / fastlane), with the registry only tracking
   artifacts? (I lean: pipelines live in the repo; the registry tracks
   projects + packages. Lionidas orchestrates tests, not builds.)

## Next step

Pick sequencing (A/B/C above — I recommend B: proceed to the .ipa plan now,
registry gets its own brainstorm→plan round answering questions 1–5).
