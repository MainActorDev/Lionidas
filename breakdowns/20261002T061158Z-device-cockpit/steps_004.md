# Step 4 — Chat tab (agent conversation on the cockpit)

- **Status:** Ready
- **Plan:** rev 2, Stage S4, condition 6; review F3 (context auto-prepend)
- **Repo:** Step 3 head · **Depends on:** Step 3 (rail shell)

## Outcome

The rail's **chat** pane: transcript, tool-call chips, device-context footer, composer — wired to the existing `/api/agent/sessions*` conversation API, live via `agent.turn` bus events.

## Implementation

### 4a. Conversation state (page-level composable `useAgentChat.ts`)

- Lazy session create on first send: `POST /api/agent/sessions` → `{session:{id}}` (shape pinned in agent-routes tests); messages via `POST /api/agent/sessions/:id/messages {content}` → `{turn:{ok, answer, …}}` (outcome carries the verdict — a failed turn is still a 200; render `turn.error` honestly).
- Persist sessionId in the page (not localStorage round 1 — switching devices starts FRESH context; note in UI).
- **F3 context prepend**: on the FIRST message of a conversation, auto-prepend `[context] device: <name> · screen: <state|—> · scenario: <id|none> · app: <bundle|—>` before the user's text (single combined content string). Later messages don't repeat it.

### 4b. Transcript UI

- Rows: user (right, slate border), agent (left) with model label from `/api/auth/me`? — no: label plain `agent`; tool-call chips rendered from the answer text where the agent includes them (round 1: render the `answer` markdown-ish text; tool chips appear when the agent emits its `tools used` footer — no parsing complexity).
- `agent.turn` bus events for the ACTIVE session → typing/live indicator (◆ thinking) while a turn runs (events carry sessionId — filter).
- Provider-unconfigured honest answer renders as normal text (it already says so).

### 4c. Composer + footer

- Input + send; Enter sends; disabled while a turn is in flight (honest — the API is synchronous).
- Footer (F3): `context: <dev> · <screen> · <scenario> — prepended to your first message` (true statement).

## Verification (TDD + live)

- Mount tests: fixture transcript renders; send calls the create-then-message sequence (mock fetch, assert the context prepend on message 1 and its absence on message 2); turn-in-flight disables composer; error turn renders the error row.
- Live drill (provider configured via server/.env): ask "what's my active scenario" with the context line prepended → agent answers about countries-sg correctly (grounded by the context, proving F3); screenshot the chat pane.

```bash
cd web && pnpm test && pnpm build
```

## Completion gate

- [ ] Context prepend proven live (agent answers with device/scenario awareness)
- [ ] In-flight disable + honest error rendering pinned
- [ ] Commit(s) pushed
