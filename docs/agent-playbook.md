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

Phase 1 (now): stack · auth · context · case list/new/get/edit/run/verify ·
run get/steps/abort · env list/set/delete.
Phase 2 (next): case yaml/duplicate/delete/export/import/versions · folder
list/new/move/rename/delete/run · screen list/register/login-flow/logout-flow/
import/export · suite list/new/play/delete.
Phase 3: net presets/scenarios/condition/traffic/mitm · device list/power/
install · run list/triage/evidence · queue · flake.
