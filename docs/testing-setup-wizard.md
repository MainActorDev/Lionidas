# Testing the first-run setup wizard (/setup)

This guide tests PR #22 in an isolated instance. Your real data
(`server/crucible.db`) is never touched.

**One rule: use port 9231 for test instances.** The web UI proxies `/api`
to port 9230 — if a test server occupies 9230, the UI shows the test
instance's (empty) data and *looks* like your data vanished. It didn't;
the real server was just not the one answering. When you finish testing,
restart your real server (below).

## 1. Start a fresh test instance

```bash
mkdir -p /tmp/lionidas-test
cd <repo>/server

CRUCIBLE_DB_PATH=/tmp/lionidas-test/crucible.db \
CRUCIBLE_REPOS_DIR=/tmp/lionidas-test/repos \
CRUCIBLE_PACKAGES_DIR=/tmp/lionidas-test/packages \
CRUCIBLE_PORT=9231 \
CRUCIBLE_SMOKE=0 CRUCIBLE_WATCHDOG=0 \
npm run dev
```

The console prints the claim token — and no password:

```
[setup] first-run setup is OPEN — claim this instance at /setup
[setup] claim token (from this console only): xxxx-xxxx-xxxx-xxxx
```

## 2. Happy path (browser)

Vite (port 5230) proxies `/api` to 9230, so for browser testing point it
at the test instance instead: start vite with
`CRUCIBLE_API_TARGET=http://127.0.0.1:9231 npm run dev -w web` (or use
curl for the API checks in §3 and skip the browser part).

1. Open the app unauthenticated. On an unclaimed instance you land on
   **/setup** automatically.
2. Fill email, name, password (min 8), and the token from the console.
3. **Claim this instance** → login page with `?notice=setup-complete`.
4. Sign in → you are admin.
5. **Settings** → **READINESS**: expect ~5/7 — honest ✗ for unset tokens,
   ◌ skip for smoke. **run checks again** re-probes.

## 3. Security checks (curl, against 9231)

| Check | Command | Expect |
|---|---|---|
| Window open | `curl -s localhost:9231/api/setup/state` | `{"needsSetup":true,...}` |
| Wrong token | POST `/api/setup/admin` with token `0000-…` | 403 |
| Cross-origin | same POST with `Origin: http://evil.example` | 403 |
| Non-JSON body | `content-type: text/plain` | 415 |
| Rate limit | 11 rapid POSTs | 429 |
| After claim | GET `/api/setup/state` | 404 |

POST shape: `{"email":"you@example.com","name":"You","password":"min-8-chars","token":"xxxx-xxxx-xxxx-xxxx"}`

## 4. The upgrade path (existing install)

This proves "install again ≠ data loss". Copy the REAL db (safe — a copy):

```bash
mkdir -p /tmp/lionidas-test
cp <repo>/server/crucible.db /tmp/lionidas-test/copy.db
# start the test server with CRUCIBLE_DB_PATH=/tmp/lionidas-test/copy.db
```

Expected: setup window **never opens** (T0 backfill stamps the copy at
boot), `/api/setup/state` → 404, login with your normal account works,
all runs/builds visible. The stamp travels with the DB.

## 5. Lockout recovery (CLI)

```bash
# server stopped or running — CLI writes to the DB directly
cd <repo>/server
CRUCIBLE_DB_PATH=/tmp/lionidas-test/crucible.db \
npm run cli -- admin reset-password you@example.com
```

Prints a one-time password; sign in with it. The wizard never reopens.

## 6. Headless / legacy mode

- `CRUCIBLE_PIN=<pw>` set at boot → admin hash minted directly, setup
  stamped complete (no window ever).
- `CRUCIBLE_SETUP_MODE=off` → wizard disabled entirely; seeding returns
  to the old generate-and-print behavior (legacy installs only).

## 7. Clean up and restore your real server

```bash
rm -rf /tmp/lionidas-test
# if your real server was displaced from port 9230:
cd <repo>/server && npm run dev   # default env = real crucible.db
```

## What is being tested (summary)

- Claim token: printed to console only; required by POST; LAN peers
  cannot claim a fresh instance.
- Window closes permanently after claim; restart keeps it closed.
- T0 backfill: existing installs never see the wizard on upgrade.
- Data: wizard state lives in `schema_meta` keys; user data is never
  modified outside the claim transaction.
