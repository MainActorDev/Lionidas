# Refs rework — @-mention picker (jira / repo / attachment)

- Source prompt: "Now, let's making some adjustments to the 'refs' behavior. 1. the user can only use refs via the '@' or mention. 2. The available refs are '@jira', '@repo', '@attachment'. 3. '@jira' opens a menu with a search bar first, so user can search their intended Jira ticket (epic/story/subtask). We might need to register Jira token in configs. Or Jira MCP to claude-cli -> '@jira:{ticket_number}'. 4. '@repo' opens a menu with the list of registered repos in lionidas; when chosen, also opens commits/PRs (segmented) with search; '@repo:{project_name}/{commit_or_PR}'; might want to use gh; think about branch selection for commits. 5. '@attachment' opens the attachment picker; becomes '@attachment:{file_name}'. All tools must be registered in lionidas as internal tools (do we already have this?). Brainstorming task — think of everything; happy path, sad path, edge cases; suggestions open."
- Created: 2026-10-11T13:41:38Z
- Status: Direction selected

## Goal and context

Replace the current free-typed "＋ refs" picker (kind + raw locator string) with an **@-mention system** in the composer: typing `@` opens a picker; only three ref families exist — jira, repo, attachment — each with its own search/select flow. Selected refs render as capsule chips (`@jira:LP-1042`) inside the input line, next to the command chip from rev 22. The pipeline (knowledge compile) already consumes `PipelineRef{kind, locator, note}` — the rework is upstream of that contract: it changes how refs are FOUND and VALIDATED, not how they compile.

**Answer to "do we already have internal tools?"** — Yes, the mechanism exists: the agent registry (`buildToolRegistry` + config/draft tools, ~41 tools, policy-gated, MCP-mounted). Anything the agent needs to RESOLVE a ref at runtime should be a registry tool. What does NOT exist yet: Jira live search (a `jiraConnector` exists in butler, fixture-tested only, env-gated), GitHub commit/PR fetch via `gh` (not in the registry), and an attachments store (nothing today).

## Confirmed inputs and decisions

- PR #33 merged; work continues on main (new branch).
- Refs ONLY via @ mention — the free-typed picker goes away.
- Three families: @jira, @repo, @attachment with the flows described.
- Capsule format after selection: `@jira:{ticket}` / `@repo:{project}/{commit-or-PR}` / `@attachment:{file_name}`.
- All new capabilities land as Lionidas internal registry tools (policy class: read for fetch/search; the attachment upload is a route, not an agent tool).
- Jira credentials: a Jira token must be registered in configs (server-side env per the secrets policy — never via UI/chat). Existing seams: `JIRA_TOKEN` env already read by secrets.ts; butler `jiraConnector` takes baseUrl/project/authHeader/jql.

## Exploration

### A. UX flow (composer)

Same anatomy as the slash menu (rev 21/22 — menu, ↑↓, Enter, Esc, click), extended to two-level pickers:

- `@` → family menu: @jira / @repo / @attachment (with descriptions).
- `@jira` → search-first menu: type to search (server-side JQL query, debounced ~300ms), rows show `KEY-123 · title · type badge (Epic/Story/Subtask)`. Select → chip `@jira:KEY-123`.
- `@repo` → level 1: registered repos (from `sources`/repo registry — today `server/repos/` holds ios-consumer, ios-consumer-intl). Select → level 2: segmented Commits | PRs + search box (server queries `gh api` per repo, default branch unless a branch is picked — see edge cases). Select → chip `@repo:{project}/{sha-short}` or `@repo:{project}/PR-123`.
- `@attachment` → OS file picker (accept any file; size cap). Upload happens on SELECT (not on send) so the capsule is real: chip `@attachment:{file_name}` backed by an uploaded artifact id. Paste/drag-drop of images could shortcut straight to an attachment chip (suggestion).
- Multiple refs compose: several chips in one input; send assembles `PipelineRef[]` (kinds: jira / github-commit / github-pr / doc — attachment maps to `doc` with the artifact path, OR a new `attachment` kind; recommend NEW kind for honesty in the pipeline's compile step).
- Backspace-on-empty removes the last chip (standard token-input); ✕ per chip.

### B. Backend seams

1. **Jira search** — new registry tool `jira.search {query}` (read class): JQL `text ~ "query"` (or key prefix match), via butler's jiraConnector or direct fetch with the env token. The UI's menu ALSO needs search — reuse the tool through an operator-gated HTTP route `GET /api/agent/refs/jira?q=` that calls the same registry function (one implementation, two transports; consistent with how MCP + HTTP both exist today).
2. **Repo commits/PRs** — registry tool `repo.list` (from the sources table / repos dir), `repo.commits {project, branch?}` and `repo.pulls {project}` shelling to `gh api` (gh is authenticated on this machine; on servers a GITHUB_TOKEN env — the repo already has CRUCIBLE_GITHUB_TOKEN in the secrets list). Branch selection: commits menu defaults to the repo's default branch with a small branch dropdown (gh api branches); PRs are branch-agnostic so no dropdown there.
3. **Attachments** — `POST /api/agent/attachments` (multipart, operator-gated, size cap ~10MB, stored under artifacts/attachments with content hash) → `{id, fileName}`. Registry tool `attachment.get {id}` (read) returns extracted text (markdown/text passthrough; PDFs via pdf tooling later — v1: text/markdown/images with a filename+hash manifest for everything else). Chip carries the id; send maps to ref kind `attachment`.
4. **Pipeline compile** — extend `PipelineRef` kinds with `attachment`; compileKnowledge reads attachment text from the store. jira/github kinds already compile.

### C. Happy path (end-to-end)

1. User types `@` → picks jira → types "login validation" → rows appear → Enter on LP-1042 → chip.
2. Types `@` again → repo → ios-consumer → PRs tab → picks #482 → chip.
3. Attaches a screenshot via `@attachment` → file picker → upload → chip.
4. Sends: message + 3 chips → 3 PipelineRefs → knowledge compile merges ticket text + PR diff + attachment into the versioned page → gated pipeline runs (manual handoff).

### D. Sad paths / edge cases (must handle)

- **No Jira token configured** → @jira menu shows an honest empty state: "Jira not configured — set JIRA_TOKEN on the server" (mirrors the mock-provider honesty pattern). Never a spinner-forever.
- **Jira search returns nothing / rate-limited / 401** → "no tickets matched" / "Jira unreachable (401)" rows; retry affordance. Zero-result ≠ error.
- **Ticket key pasted directly** (`@jira:LP-1042` typed) → resolve-on-blur: if the key validates against search-by-key, chip it; else inline hint "unknown ticket" (no auto-chip).
- **Repo not registered** → @repo level-1 only lists registered repos; typing an unregistered name shows nothing (no free-text repo refs — that's the point of the picker).
- **Branch ambiguity for commits** → default branch first; explicit branch dropdown; the chip stays `{project}/{sha}` — the SHA pins the content regardless of branch (branch only scoped the LIST). Document that in the menu subtitle.
- **gh unauthenticated / repo not found / private repo** → honest error row; PR/commit lists degrade to empty-with-reason.
- **Attachment too large / unsupported type** → reject at picker with size/type toast; nothing partial uploads.
- **Attachment deleted before send** (edge) → chip validation on send; if the artifact id 404s, drop with a system note.
- **Duplicate refs** → de-dup chips by (kind, locator).
- **Ref count cap** → e.g. 8 chips; picker closes beyond it with a hint (context bloat guard).
- **Paste containing `@jira:LP-1` as plain text** → treated as ordinary text (only picker-originated chips are refs) — same registered-only rule as rev 22 slash commands.
- **Offline mode** → all three pickers show honest unavailable states; chat still works.

### E. Security / policy

- All three search/fetch tools = read class → DRAFT policy allows them; act-class unchanged.
- Attachments content NEVER auto-executes; they compile as knowledge text only.
- Jira token & GitHub token: env-only (secrets policy), never echoed to the client beyond "configured: true/false".
- `gh` invocations: fixed argv (no user input in shell position), timeout, output size cap.

### F. Sizing & order

1. Composer @-menu + family picker + chip plumbing (reuses slash-menu code) — M
2. Attachments (route + store + tool + picker) — M (self-contained, no external deps)
3. Jira search (route + tool + menu, env-gated) — M
4. Repo commits/PRs (gh + tools + two-level menu + branch dropdown) — L
5. PipelineRef kind + compile for attachment — S
Total ≈ 2–3 focused sessions. Ship in that order (attachments first = zero external config needed to demo the full chip UX).

## Open questions

None — all answered 2026-10-11:
1. Attachments: NEW `attachment` ref kind (honest pipeline compile).
2. Branch selection: SEARCHABLE branch picker seeded with the top-3 active branches (avoids long lists); full search over branches beyond the seed.
3. Jira auth: server env `JIRA_TOKEN` (secrets policy).
4. Paste/drag-drop to attach: IN v1 — pasting an image goes straight to an attachment chip.

## Next step

Plan → implement on a fresh branch off main, in order: F1 composer @-menu + chips → F2 attachments (route/store/tool/picker/paste) → F3 Jira search (env-gated route+tool+menu) → F4 repo two-level menu with the searchable branch picker (top-3 active seed) → F5 pipeline `attachment` kind + compile.
