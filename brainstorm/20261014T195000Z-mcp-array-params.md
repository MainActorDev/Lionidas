# MCP bridge type-blindness — array/object tool params die at the boundary

- Source prompt: "check this chat session (sess_e2e40228-1ba). What's wrong with it?" + the standing directive to think through every interaction/edge case, not just fix reported symptoms
- Created: 2026-10-14T19:50:00Z
- Status: Direction selected

## Goal and context

The user reports sess_e2e40228-1ba's latest `/author` turn failed ("0 cases saved; blocked at the screen registry tool") — and separately challenges why the chat feature keeps producing homework despite the "think of everything" instruction. Forensics below; this brainstorm covers the found defect, its blast radius, and the systemic gap it exposes.

Direct statements (confirmed): the directive to enumerate every interaction/edge case is standing; "we are way past UI/UX bugs"; the session must be diagnosed.

## Confirmed inputs and decisions (forensics, all reproduced)

**What happened in the session (event log):**
1. `t_e829d652-bc9` (Oct 14 18:18, /author "Create those testcases"): the model called `screens.draft.save` **6 times** — every attempt failed: 1× "revision is required", then 5× "registry must be a non-empty list of screens".
2. The turn burned **298,324 tokens** (contextUsed 286,207 — over the 200k window), ran 300s, streamed 938 chunks of narration while fumbling shapes, saved 3 notes, validated one case yaml, then honestly reported the block.
3. Follow-up turn explained "missing: screens account + edit-profile" — the model correctly diagnosed the tool as the blocker, even narrating: "The screens tool rejects every payload shape with the same verbatim error — that's a tool-side gate I can't yaml my way past."

**Root cause (reproduced live against the real MCP server):**
- `server/src/agent/mcp-stdio.ts:81` `schemaToZod()` maps ONLY enum/number/string: **every array, object, and boolean parameter becomes `z.string()`**.
- Probe: `tools/call screens.draft.save {screens:[{id:"account",…}]}` → `MCP error -32602: Invalid input: expected string, received array at screens`. The tool never executed once.
- The tool handler itself (`config-tools.ts:756`) is correct — it reads `args['screens']` and passes it to `validateRegistry`, which handles arrays fine (verified directly).

**Blast radius (55 array/object/boolean params across the registry):** `screens.draft.save.screens`, `scenario.draft.save.presetIds`, `scenario.members.set.members`, `preset.*.seq`, `case.move.templateIds`, `suite.draft.*.members(+variantIds)` — i.e. **every bulk/write tool** has been dead over MCP while single-string tools (reads, case.draft.save with yaml strings) worked, masking the bug.

**Why tests missed it:** MCP bridge tests cover the protocol shape, and tool tests call `registry.execute` directly (in-process) — the zod seam between them is exercised by neither. The only full-path MCP test uses string-only tools.

**Why the model's retries made it worse:** the -32602 arrives as an opaque INVALID; the model (correctly per its contract) tried YAML strings, wrapped objects, `screen_id` keys — each shape failing identically, burning a quarter of the context window.

## Exploration

### Fix layers

1. **The bridge (root fix)**: extend `schemaToZod` to the full JSON-Schema subset the registry actually uses: `array` (of string|object, recursing one level), `object` (recurse), `boolean`. Fallback for unknown shapes: `z.any()` (permissive) — never `z.string()`. A wrong-but-passing value then hits the tool's own verbatim validation, which produces actionable errors instead of protocol rejections.
2. **Contract test (the class-killer)**: a test that enumerates ALL registered tools, walks their JSON-Schema parameters, and for every array/object/boolean param round-trips a representative value through the REAL MCP server (spawn mcp-stdio.sh, initialize, tools/call with a valid-typed arg, assert the error is NOT -32602/type-mismatch). This turns "every tool param type" into a checked matrix — the exact discipline the user demands.
3. **Error fidelity**: the MCP wrapper should distinguish protocol-level (-32602) from tool-level (INVALID:) in its text so the model stops retrying shape permutations against protocol errors. (Smaller; belongs to the same fix.)
4. **Model-side guardrail (optional)**: system prompt note that identical repeated INVALIDs on different shapes = tool-side issue, stop early. Cheap insurance; the model already did ~the right thing at attempt 6.

### Why "homework keeps appearing" — the systemic answer

- Each past round fixed what was observable in ONE layer's tests; the seams between layers (provider↔MCP↔registry, UI↔WS↔durable log) had no tests crossing them. This bug lived exactly on such a seam for weeks while every layer stayed green.
- "Think of everything" applied to *interactions* produced the matrix rounds; it was never applied to *interface contracts* (tool param types) — a different axis of the same discipline.
- Remediation: cross-layer contract tests (fix layer 2 above) + adding "interface matrix" to the review checklist: enumerate every parameter type × transport (in-process, MCP, ACP) and pin one passing round-trip per cell.

## Open questions

1. Include the streaming-prefix-on-return fix (the earlier analysis: seed the bubble from durable chunks on session reopen) in the same round, or separate PR? (Both are chat-trust bugs; different layers.)
2. `z.any()` fallback vs strict rejection for unknown JSON-Schema keywords: permissive keeps tools callable; strict catches schema drift. Recommend permissive + the contract test.

## Next step

Fix `schemaToZod` (arrays/objects/booleans + recursive objects, `z.any()` fallback), add the all-tools param-type contract test, re-run the session's exact failing call live, then answer Q1 (bundle streaming-prefix fix or not). The "homework" meta-answer lands as the interface-matrix review rule.
