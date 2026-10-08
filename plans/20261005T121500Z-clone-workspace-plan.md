# Clone + workspace management — plan

- Source: registry decisions (brainstorm 20261005T071623Z) + user direction
  2026-10-05 ("how does the system clone" → build it). CI build of the .ipa
  rides ON the clone (same workspace) but ships as its own follow-up round —
  this plan delivers the clone/fetch/status seam it needs.
- Status: Ready
- Scope: clone projects into the centralized repos workspace, keep them
  current, surface clone state. OUT: CI build commands, agent ingest, apk.

## Server

1. **`server/src/projects/workspace.ts` (new)**
   - `cloneProject(db, id)` — destination `projectWorkspace(name)` (exists →
     409 WORKSPACE_EXISTS unless `pull: true`); builds the authed URL from
     `projectAuthToken()` at call time:
     - `https://…` host → `https://x-access-token:<tok>@host/path.git`
     - `git@…` ssh → one-shot `GIT_ASKPASS` script in a temp dir (token never
       in argv, never on disk after the call, mode 0700, deleted in finally)
     - no token → plain URL (public repo)
   - `git clone --depth 50 --branch <defaultBranch>` (branch only when set);
     10-min timeout; stderr captured into the error.
   - `pullProject(db, id)` — `git fetch --prune` + `git checkout <branch>` +
     `git reset --hard origin/<branch>` inside the workspace (idempotent
     freshness; never merges).
   - `workspaceStatus(db, id)` — exists? current branch, `git rev-parse
     --short HEAD`, dirty count (`git status --porcelain`), ahead/behind of
     upstream — read-only probe for the UI.
   - Per-project in-flight guard (installApp pattern): concurrent clone of
     the same project returns the running promise.
   - Token hardening (review M1 follow-through): a clone failure that
     includes the URL must redact the token from the returned error
     (`err.replaceAll(tok, '***')`).
2. **Routes** (projects/routes.ts, admin):
   - `POST /api/projects/:id/clone` — body `{ pull?: boolean }` (pull=true on
     an existing workspace = fetch+reset instead of 409).
   - `POST /api/projects/:id/pull` — refresh.
   - `GET /api/projects/:id/workspace` — status.
   - Project list rows gain `workspace: { exists, branch, head, dirty }` via
     one batched probe (cheap for ≤ dozens of projects).
3. **Tests** (`projects-workspace.test.ts`) — fake `git` shim on PATH
   (fakeXcrun pattern): clone writes a marker, assert argv contains the
   authed URL for https+token (and NOT for public), askpass script created
   and deleted for ssh+token, 409 on existing dir, pull runs the three
   commands, status parses, token redaction on failure, in-flight guard.

## Web (projects page, no new sketch round — row anatomy unchanged)

- Row actions column gains: `clone` (or `pull` when the workspace exists) +
  status glyph: `—` never cloned · `⎇ <branch>@<head>` clean · `<branch>*
  <n>` dirty. Errors surface inline under the row.
- Editor's derived-path field stays read-only.

## Verification

- server tests (fake git) + full suites both sides.
- Live drill: real clone of a small public repo into `server/repos/`, status
  row, pull after an upstream-less fetch (no-op ok), 409 on double clone,
  delete project → workspace dir left intact (human data, not ours to rm).

## Out of scope

CI build step, agent ingest, token encryption-at-rest (redaction only),
branch pinning UI beyond default_branch.
