# Agent drills — P2 author pipeline (2026-10-10)

Hermetic leg (CI, mock executors) — `test/agent-pipeline.test.ts`:

1. **Knowledge compounding**: run 1 (doc ref `ticket.md`) → page v1; run 2
   (doc ref `pr.md`) → page v2 contains BOTH "Prior knowledge (carried
   forward)" with run 1's ref AND the new ref; the per-run snapshot contains
   only what run 2 saw. Version chain append-only.
2. **Contradiction flagging**: prior "checkout button has no accessibility
   identifier" + new "checkout button now has btn_checkout" → flagged with
   shared subject ("checkout"); unrelated content flags nothing (noise guard).
3. **Pipeline happy path** (mock): `POST /api/agent/pipeline` 201 →
   stages done → knowledge + knowledge-snapshot artifacts listed via
   `/api/agent/artifacts`.
4. **Validation**: empty refs → 400; unknown ref kind → 400 (known set gate);
   jira ref without configured fetch → 422 honest error.
5. **Pause/answer**: answer on a non-paused run → 409.
6. **Auth**: anonymous → 401 on pipeline + artifacts routes.

Live glm leg: deferred to the drill session when the operator runs the real
server with `BUTLER_PROVIDER_*` set (same API path; mock leg proves the
contract, live leg proves the model). Logged here after.
