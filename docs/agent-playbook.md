# Agent playbook — driving Lionidas from the CLI

The canonical workflow an AI agent (or human) follows to operate Lionidas.
Every step is a `lionidas` command — deterministic in/out, `--json` for
machine consumption. Auth once via `lionidas auth login` (browser approval)
or `--token` paste; the PAT rides `~/.lionidas/config.json`.

## The loop

```bash
# 0. orient — apps, booted devices, case tree, env keys, active runs
lionidas context

# 1. ensure the stack (health, node ABI guard; adopts what's running)
lionidas stack up
lionidas stack status          # verify before proceeding

# 2. author a case (yaml from stdin or file)
lionidas case new - <<'YAML'
name: my case
app: com.example.app
steps:
  - tap: { on: home_login_button }
  - expect: { on: dashboard }
YAML

# 3. run + verify — exit codes drive the loop
lionidas case verify "my case" --device <udid> --timeout 300
#   0 = PASS · 1 = case FAILED (read the step lines, triage) · 2 = INFRA
#   (environment — fix and re-run; NOT a case regression)

# 4. triage a failure
lionidas run steps <runId>        # narrated steps + reasons
lionidas run triage <runId> <idx> # reason + evidence refs (phase 3)

# 5. clean state between cases (recipes are app-level; no case cleanup needed)
```

## Conventions

- `--json` on every command for machine parsing; errors exit non-zero with
  `{"error", "code", "hint"}`.
- `<id|name>` resolution everywhere; ambiguity is an error naming candidates.
- Guarded deletes surface the server's named-409 (folder counts, preset
  override rows, scenario consumers) — read them, don't force.
- Secrets are ALWAYS masked in `env list`; the server never returns them.
- Stack lifecycle is supervised: `up` adopts foreign listeners (reports,
  never fights); `down` stops only what it owns.

## Surface map

Phase 1: stack · auth · context · case list/get/run/verify · run
get/steps/abort · env list/set/delete.
Phase 2 (now): case yaml/new/edit/duplicate/delete/export/import/versions ·
folder list/new/rename/move/delete/run · screen list/register/remove/yaml/
import/export/login-flow/logout-flow · suite list/new/get/edit/play/delete.

```bash
# authoring loop (yaml round-trip is the write path)
lionidas case new case.yaml            # validate → import seam (folders auto-created)
lionidas case yaml <id|name>           # read back as yaml
lionidas case edit <id|name> new.yaml  # validate → PUT (422s carry line numbers)
lionidas case export [--out f.zip]     # zip + manifest (ids filter)
lionidas case import f.zip             # binary-safe; renames on collision

# folders: app-scoped trees; guards surface named-409s
lionidas folder new --app <b> --name smoke [--parent <id|path>]
lionidas folder list --app <b>         # indented tree + subtree counts
lionidas folder move <folder|root> --app <b> --cases id1,id2
lionidas folder run <folderId> --device <udid>   # subtree batch, waits, 0/1

# screens + app recipes (screens.yaml = the app definition)
lionidas screen register --app <b> --name s-id --entry <json> --states <json>
lionidas screen yaml <b> > screens.yaml           # export (recipes ride along)
lionidas screen login-flow <b> recipe.yaml        # entry/steps/verify doc
lionidas screen import <b> screens.yaml           # replace registry

# suites: one app's pack; play surfaces named-skips
lionidas suite new --name pack --members id1,id2 --app <b>
lionidas suite play <suiteId> --device <udid>     # drift/deprecated/dead-pins named
```
Phase 3: net presets/scenarios/condition/traffic/mitm · device list/power/
install · run list/triage/evidence · queue · flake.
