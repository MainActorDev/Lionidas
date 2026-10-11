# 032 A2 — conventional chat (ChatGPT/Claude layout)

## Variant: the familiar chat anatomy, Axiom-skinned

### Design stance
Don't reinvent the chat wheel (operator direction 2026-10-10): the layout everyone already knows — conversation sidebar + single scrolling thread + one composer — with Lionidas' agent semantics mapped onto it. Zero learning cost; the novelty lives entirely in what the agent says and attaches.

### Key choices (ChatGPT/Claude conventions → Lionidas meaning)
- **Conversation sidebar** ("+ new chat", per-run threads with sub-labels: app · state · age) → each author-pipeline run IS a conversation
- **Thread anatomy**: avatar+name header per message; assistant messages full-width prose (no bubbles); user messages carry an **attachments row** (`◈ DEMO-101`, `△ PR #482`, `▤ spec.md`) — the refs
- **Thin status line** instead of a stepper: `knowledge ✓ · plan ✓ · breakdown ✓ · author…` with a pulsing dot — pipeline state without dashboard chrome
- **Collapsed tool traces** (`▸ read screens registry · searched notes…`) — Claude's "used tool" pattern, expandable later
- **Question = inline form card** (ember border, textarea, `answer & continue`) — reads as part of the reply, resumes the pipeline
- **Created drafts = file-card** (`◈ drafts created · 5` with rows + folders) — ChatGPT's generated-file card; links into the cases page
- **Composer**: rounded box, attachment chips above the textarea, ◈ attach button, ↑ send; `enter` sends

### Trade-offs
- Strong at: instant familiarity; conversation history as first-class; questions/drafts read naturally in flow; smallest cognitive load
- Weak at: run-state visibility is thinner than a dashboard (accepted — status line + sidebar sub-labels carry it); many parallel runs means many conversations (sidebar scroll)

### Best for
The operator direction: this IS the chat. Keep the house tokens/type; borrow the layout wholesale.
