# Lionidas in CI

The `lionidas` CLI executes template suites against a running Lionidas server
and reports machine-readable results. One execution path: the server (and its
wall) stay the source of truth; the CLI is a client.

## Exit-code contract

| Code | Meaning | Typical cause |
|---|---|---|
| 0 | every run passed | — |
| 1 | app failure | an expect didn't match, a step failed honestly |
| 2 | infrastructure / config | device busy, stream gate, timeout, empty suite, server unreachable |

Reviewers can distinguish "the app broke" (1) from "the harness broke" (2)
in the exit code alone. A mixed batch (some failed + infra) exits 1 — the
app failure is the actionable signal.

## Usage

```
lionidas run [--tags smoke] [--app <bundle>] [--udid <udid> | --boot <udid>]
             [--env KEY=VAL ...] [--junit out.xml] [--json] [--timeout 900]
```

- `--boot` boots the device first (idempotent; already-booted is OK)
- `--udid`/`--boot` are the ONLY device selectors — never auto-picked
- `CRUCIBLE_URL` env (default `http://127.0.0.1:9230`)
- `--junit` writes one `<testcase>` per template run; failures embed the
  failing step, the run note (dialog-handling audit), evidence path, run URL

Repo-local invocation (until the bin is packaged):

```
cd lionidas/server && node --import tsx src/cli/index.ts run --boot <udid> --junit results.xml
```

## GitHub Actions (macOS runner sketch)

```yaml
jobs:
  smoke:
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: xcodebuild -downloadPlatform iOS   # runtime for the sim
      - name: boot simulator
        run: xcrun simctl boot "iPhone 16" || true
      - name: start lionidas stack
        run: cd lionidas && ./scripts/dev.sh start
      - name: run smoke suite
        run: cd lionidas/server && node --import tsx src/cli/index.ts run
             --boot "$SIM_UDID" --tags smoke --junit results.xml
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: results, path: results.xml }
```

The JUnit XML renders natively in GitHub's test annotations; evidence
screenshots/videos live under `server/artifacts/` on the runner — upload
that directory when a run fails.
