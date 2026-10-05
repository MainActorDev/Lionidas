# Project registry — plan

- Source: brainstorm/20261005T071623Z-project-repo-registry.md (all 5 questions + credentials decided)
- Status: Ready
- Scope: projects table + admin CRUD API + packages attribution (`project_id` finally real) + projects page (post-sketch). OUT: agent multi-repo ingest (Q4 deferred), CI build buttons, `.apk`.

## Server

1. **Schema** (`schema.ts`, in migrateM1 + the ALTER list for existing DBs):
   `projects(id TEXT PK, name TEXT NOT NULL UNIQUE, repo_url TEXT NOT NULL,
   local_path TEXT, default_branch TEXT NOT NULL DEFAULT 'main',
   auth_token_hash TEXT, created_at INTEGER, updated_at INTEGER)`.
   Token stored as SHA-256 hex (write-only; api_tokens precedent stores hashes
   not plaintext). NULL = no token.
   Plus `ALTER TABLE packages ADD COLUMN project_id TEXT` — wait: packages are
   FILES not rows; attribution lives read-time via package→project match, or a
   `package_projects(path, project_id)` map table. Simplest honest v1: a
   `package_owner(package_path TEXT PRIMARY KEY, project_id TEXT)` side table
   written when an upload names a project (upload route gains optional
   `project` name query) and rendered by GET /api/packages. Manual drops stay
   unattributed until claimed from the page (a "claim" action on the package
   row, admin-only).
2. **Store** (`server/src/projects/store.ts`): list/get/create/update/delete;
   `auth_set` boolean derived; never returns the hash. Delete guards: no
   package_owner rows may dangle (delete claims with the project).
3. **Routes** (`server/src/projects/routes.ts`, registered in index.ts):
   - `GET /api/projects` — admin only (requireRole('admin')).
   - `POST /api/projects` — {name, repoUrl, localPath?, defaultBranch?, authToken?}; validates repoUrl is a git-ish URL or local path.
   - `PUT /api/projects/:id` — same fields; blank/absent authToken KEEPS the stored one; `clearAuth: true` clears.
   - `DELETE /api/projects/:id` — removes owned package claims too.
   - `POST /api/packages/claim` — admin; {packagePath, projectId} → package_owner upsert. GET /api/packages joins owner name in.
   All admin-gated per Q3.
4. **Tests** (`projects.test.ts`): CRUD round-trip, admin gate (403 for
   operator), token write-only (response never contains it; PUT without token
   keeps; clearAuth clears), claim + package listing attribution, delete-cascade
   of claims.

## Web (after sketch pick — round 027)

- `/projects` page: house list anatomy (PageHeader, hairline rows, inline
  editor), admin-gated (nav item hidden for non-admins — needs the session's
  role, already in App.vue's `me`).
- Picker rows gain the owner label when attributed.
- 3 sketch variants on one axis (editor placement): a-modal / b-inline-row /
  c-split.

## Verification

- server tests green; web check + test; live drill: create/edit/delete a
  project as admin, 403 as operator, claim Debug.ipa, picker shows the owner.

## Out of scope

Agent repo-context changes, CI integration, build buttons, apk.
