<script setup lang="ts">
/** P3 agent chat page (sketch b1-warm, plan 20261010T211500Z rev 2).
 *  Three columns: sidebar / thread+composer / run panel. Conversations =
 *  butler sessions; runs = P2 pipeline; live updates = agent.workflow events
 *  over /api/events WS with a 10s polling fallback. Web-only (review F1). */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import ChatSidebar from './components/ChatSidebar.vue';
import Thread from './components/Thread.vue';
import Composer from './components/Composer.vue';
import RunPanel from './components/RunPanel.vue';
import type { Ref as PipelineRef } from './components/Composer.vue';
import './agent-theme.css';

interface Me { id: string; name: string; email: string; role: string }
interface Msg { role: 'user' | 'assistant' | 'system'; text: string; refs?: Array<{ kind: string; name: string }>; toolTrace?: string; status?: string; aborted?: boolean }

const route = useRoute();
const me = ref<Me | null>(null);
const sessionId = ref<string | null>(null);
const title = ref('new chat');
const messages = ref<Msg[]>([]);
/** R2-fix: per-session turn state — UI behavior must not leak across chats.
 *  Each session keeps its own sending/streaming/tools/run slot; the template
 *  refs below are computed views of the ACTIVE session's state. */
interface ToolStop { name: string; arg?: string; result?: string; isError?: boolean; live: boolean }
interface TurnState { sending: boolean; streaming: string | null; toolStops: ToolStop[]; runId: string | null }
const turnStates = ref<Record<string, TurnState>>({});
const turn = (sid: string | null): TurnState => {
  if (!sid) return { sending: false, streaming: null, toolStops: [], runId: null };
  turnStates.value[sid] ??= { sending: false, streaming: null, toolStops: [], runId: null };
  return turnStates.value[sid]!;
};
const cur = computed<TurnState>(() => turn(sessionId.value));
const sending = computed(() => cur.value.sending);
const streaming = computed<string | null>(() => cur.value.streaming);
const toolStops = computed<ToolStop[]>(() => cur.value.toolStops);
const runId = computed<string | null>(() => cur.value.runId);
const setTurn = (mut: (t: TurnState) => void): void => {
  if (!sessionId.value) return;
  const t = turn(sessionId.value);
  mut(t);
  turnStates.value = { ...turnStates.value };
};
// rev8 #2: single-slot queue — one pending send waits for the live turn
// (the server 409s concurrent turns anyway; this makes the wait invisible)
const queued = ref<{ text: string; refs: PipelineRef[]; appBundle: string } | null>(null);
const sidebar = ref<InstanceType<typeof ChatSidebar> | null>(null);
const panel = ref<InstanceType<typeof RunPanel> | null>(null);
const composer = ref<InstanceType<typeof Composer> | null>(null);
let ws: WebSocket | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const isOperator = computed(() => me.value?.role === 'admin' || me.value?.role === 'supervisor' || me.value?.role === 'operator');

// localStorage binding (plan F2): sessionId → runId
function bindRun(sess: string, run: string): void {
  const m = JSON.parse(localStorage.getItem('agentRunBySession') ?? '{}') as Record<string, string>;
  m[sess] = run;
  localStorage.setItem('agentRunBySession', JSON.stringify(m));
}
function boundRun(sess: string): string | null {
  const m = JSON.parse(localStorage.getItem('agentRunBySession') ?? '{}') as Record<string, string>;
  return m[sess] ?? null;
}

async function loadMe(): Promise<void> {
  const r = await fetch('/api/auth/me');
  if (r.ok) me.value = ((await r.json()) as { user: Me }).user;
}

async function openSession(id: string): Promise<void> {
  composer.value?.resetDraft();
  sessionId.value = id;
  localStorage.setItem('agent.lastSession', id); // rev9 E2
  const r = await fetch(`/api/agent/sessions/${id}`);
  if (!r.ok) return;
  const b = (await r.json()) as { session: { title: string | null }; messages: Array<{ role: string; content: string | null }> };
  title.value = b.session.title ?? (title.value === 'new chat' ? id : title.value);
  // rev9: a user message followed by NO assistant text = aborted/lost turn → distinct + resend
  const rows = b.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.content ?? '').trim());
  const out: Msg[] = [];
  for (const m of rows) {
    if (m.role === 'user') {
      const next = rows[rows.indexOf(m) + 1];
      const unanswered = !next || next.role === 'user';
      out.push({ role: 'user', text: m.content ?? '', aborted: unanswered });
    } else {
      out.push({ role: 'assistant', text: m.content ?? '' });
    }
  }
  messages.value = out;
  setTurn((t) => { t.runId = boundRun(id); });
  void panel.value?.refresh();
}

async function newChat(): Promise<void> {
  composer.value?.resetDraft();
  // create the butler session up-front so the run binds immediately
  const r = await fetch('/api/agent/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: null, userId: me.value?.id ?? null }) });
  if (r.ok) {
    const b = (await r.json()) as { session: { id: string } };
    sessionId.value = b.session.id;
    title.value = 'new chat';
    messages.value = [];
    setTurn((t) => { t.runId = null; });
    void sidebar.value?.load();
  }
  if (sessionId.value) localStorage.setItem('agent.lastSession', sessionId.value); // rev9 E2
}

/** fix #8 — once per chat: derive a human title from the first user message. */
function maybeAutoTitle(text: string): void {
  if (title.value !== 'new chat' || text.trim().length < 4) return;
  const stripped = text
    .replace(/^\s*(please\s+)?(draft|write|create|make|generate|prepare)\s+/i, '')
    .replace(/^(test|check|verification)\s+cases?\s*/i, '')
    .replace(/\s+(test|check|verification)\s+cases?\s*$/i, '')
    .replace(/\s+(for|of|from|about)\s+/i, ' ')
    .trim()
    .slice(0, 48)
    .trim();
  if (!stripped) return;
  const nice = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  title.value = nice; // instant client-side title; the AI name lands after the turn
  pendingAiTitle = true;
  // persist the regex title immediately so any refetch (E1) keeps it
  if (sessionId.value) void fetch(`/api/agent/sessions/${sessionId.value}/title`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: nice }) });
}

/** fires once the first turn RESOLVES — the server then has the user message
 *  to name from (calling earlier raced the message POST → 400). */
let pendingAiTitle = false;
function settleAiTitle(): void {
  if (!pendingAiTitle || !sessionId.value) return;
  pendingAiTitle = false;
  void fetch(`/api/agent/sessions/${sessionId.value}/ai-title`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }) }).then((r) => (r.ok ? r.json() : null)).then((j: { title?: string } | null) => {
    if (j?.title) { title.value = j.title; void sidebar.value?.load(); }
  }).catch(() => {/* keep regex title */});
}

/** rev5 #6 — user rename persists to the session row. */
async function onRenamed(id: string, t: string): Promise<void> {
  await fetch(`/api/agent/sessions/${id}/title`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: t }) });
  if (id === sessionId.value) title.value = t;
  void sidebar.value?.load();
}

/** rev5 #7 — delete: server cascades messages; notes/artifacts/runs stay. */
async function onDeleted(id: string): Promise<void> {
  const r = await fetch(`/api/agent/sessions/${id}`, { method: 'DELETE' });
  if (r.ok) {
    if (id === sessionId.value) { sessionId.value = null; title.value = 'new chat'; messages.value = []; localStorage.removeItem('agent.lastSession'); }
    void sidebar.value?.load();
  }
}

async function send(text: string, refs: PipelineRef[], appBundle: string): Promise<void> {
  if (sending.value) {
    // #2: max one queued — a newer send replaces the older queued one
    if (queued.value) messages.value = messages.value.filter((m) => m.text !== queued.value?.text || m.role !== 'user');
    queued.value = { text, refs, appBundle };
    messages.value = [...messages.value, { role: 'user', text, refs: refs.map((r) => ({ kind: r.kind, name: r.locator })) }];
    return;
  }
  if (!sessionId.value) await newChat();
  const sid = sessionId.value!;
  setTurn((t) => { t.sending = true; });
  setTurn((t) => { t.streaming = null; });
  setTurn((t) => { t.toolStops = []; }); // rev15
  const prettyRefs = refs.map((r) => ({ kind: r.kind, name: r.locator }));
  messages.value = [...messages.value, { role: 'user', text, refs: prettyRefs }];
  const flightIdx = messages.value.length - 1; // the user bubble just appended
  maybeAutoTitle(text);
  try {
    // R2-fix3: refs alone no longer silently start the AUTHOR pipeline — a chat
    // turn with refs is a CHAT turn (refs recorded in the message; the agent
    // reads them via jira.get / repo tools). Pipelines start explicitly
    // (/author, /breakdown) or from the run panel.
    // kind-tagged so the model knows HOW to read each ref (jira.get / case.yaml.get /
    // repo.read) — bare locators made the model guess and it went hunting the DB
    const refNote = refs.length ? ` [refs: ${refs.map((r) => `${r.kind}:${r.locator}`).join(', ')}]` : '';
    {
      const r = await fetch(`/api/agent/sessions/${sid}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `${text}${refNote}` }) });
      if (r.ok) {
        // butler contract: { turn: { ok, answer?, error? } } — the request can
        // succeed while the turn failed (outcome carries the verdict)
        const b = (await r.json()) as { turn?: { ok?: boolean; answer?: string; error?: string; code?: string } };
        const t = b.turn;
        if (t?.answer) messages.value = [...messages.value, { role: 'assistant', text: t.answer }];
        else if (t?.error) {
          const aborted = t.code === 'ABORTED' || /abort/i.test(t.error);
          if (aborted) markAborted(flightIdx);
          // keep any partial stream as a visible (muted) assistant bubble, then the verdict
          if (streaming.value) messages.value = [...messages.value, { role: 'assistant', text: streaming.value }];
          messages.value = [...messages.value, { role: 'system', text: aborted ? 'turn aborted' : `turn failed: ${t.error}` }];
        }
        else messages.value = [...messages.value, { role: 'system', text: 'turn returned no answer' }];
      } else {
        messages.value = [...messages.value, { role: 'system', text: 'turn failed' }];
      }
    }
  } finally {
    setTurn((t) => { t.sending = false; });
    setTurn((t) => { t.streaming = null; }); // rev12: never leave a frozen stream bubble
    settleAiTitle(); // rev14: AI title after the turn — no more 400 race
    void sidebar.value?.load();
    const q = queued.value;
    if (q) {
      queued.value = null;
      void send(q.text, q.refs, q.appBundle); // single-slot: fire the waiting message
    }
  }
}

/** rev9: mark the user bubble whose turn was aborted (distinct style + resend). */
function markAborted(idx: number): void {
  if (idx < 0 || idx >= messages.value.length) return;
  const m = messages.value[idx]!;
  if (m.role !== 'user') return;
  messages.value = [...messages.value.slice(0, idx), { ...m, aborted: true }, ...messages.value.slice(idx + 1)];
}

/** rev9: resend an aborted user message as a fresh turn. */
function resend(msg: Msg): void {
  messages.value = messages.value.filter((x) => x !== msg);
  void send(msg.text, (msg.refs ?? []).map((r) => ({ kind: r.kind as PipelineRef['kind'], locator: r.name })), '');
}

/** rev20b: panel errors surface as system messages. */
function onPanelError(m: string): void {
  messages.value = [...messages.value, { role: 'system', text: m }];
}

/** rev20b: slash skill — one profile as a single-stage workflow (run panel shows it). */
async function runSkill(command: string | string[], ask: string, refs: PipelineRef[] = []): Promise<void> {
  if (!sessionId.value) await newChat();
  const sid = sessionId.value!;
  messages.value = [...messages.value, { role: 'user', text: `${Array.isArray(command) ? command.join(' ') : command} ${ask}`, ...(refs.length ? { refs: refs.map((r) => ({ kind: r.kind, name: r.locator })) } : {}) }];
  setTurn((t) => { t.sending = true; });
  try {
    const r = await fetch('/api/agent/skill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, ask, appBundle: appBundleHint(), sessionId: sid, refs: refs.map((x) => ({ kind: x.kind, locator: x.locator })) }) });
    const b = (await r.json()) as { run?: { runId?: string; status?: string }; answer?: string; error?: string };
    if (!r.ok || !b.run?.runId) {
      messages.value = [...messages.value, { role: 'system', text: `skill failed: ${b.error ?? r.status}` }];
      return;
    }
    const rid = b.run?.runId; if (rid) setTurn((t) => { t.runId = rid; });
    bindRun(sid, b.run.runId);
    panel.value?.open(); // workflow started — surface the panel even if it was collapsed
    void panel.value?.refresh();
    // the ANSWER is the response — a regular assistant bubble, not a bare run note
    if (b.answer) messages.value = [...messages.value, { role: 'assistant', text: b.answer }];
    messages.value = [...messages.value, { role: 'system', text: `${command} run ${b.run.status ?? 'started'} — ${b.run.runId}` }];
  } finally {
    setTurn((t) => { t.sending = false; });
  }
}
function appBundleHint(): string { return ''; }

/** rev23 F2: @attachment → hidden file input; upload on SELECT, chip via composer addRef */
let attachInput: HTMLInputElement | null = null;
function openAttachmentPicker(): void {
  attachInput?.remove();
  attachInput = document.createElement('input');
  attachInput.type = 'file';
  attachInput.style.display = 'none';
  attachInput.addEventListener('change', () => { const f = attachInput?.files?.[0]; if (f) void uploadAttachment(f); });
  document.body.appendChild(attachInput);
  attachInput.click();
}

/** upload on select; on success the page asks the composer to chip it (single-select per plan) */
async function uploadAttachment(file: File): Promise<void> {
  const fd = new FormData();
  fd.append('file', file, file.name);
  try {
    const r = await fetch('/api/agent/attachments', { method: 'POST', body: fd });
    const b = (await r.json()) as { id?: string; fileName?: string; error?: string };
    if (!r.ok || !b.id) {
      messages.value = [...messages.value, { role: 'system', text: `attachment failed: ${b.error ?? r.status}` }];
      return;
    }
    composer.value?.addAttachmentChip(b.id, b.fileName ?? file.name);
  } catch (e) {
    messages.value = [...messages.value, { role: 'system', text: `attachment failed: ${(e as Error).message}` }];
  }
}

/** rev23 F2: paste/drop on the page → straight to an attachment chip */
function onPaste(e: ClipboardEvent): void {
  const f = e.clipboardData?.files?.[0];
  if (f) { e.preventDefault(); void uploadAttachment(f); }
}
function onDrop(e: DragEvent): void {
  const f = e.dataTransfer?.files?.[0];
  if (f) { e.preventDefault(); void uploadAttachment(f); }
}

/** rev8 #1: abort the live turn — partial transcript is persisted server-side. */
async function abortTurn(): Promise<void> {
  if (!sessionId.value) return;
  const r = await fetch(`/api/agent/sessions/${sessionId.value}/abort`, { method: 'POST' });
  if (!r.ok) messages.value = [...messages.value, { role: 'system', text: 'abort failed — turn may have finished' }];
  // the in-flight send() still resolves (aborted outcome) and flushes any queue
}

// ── live updates: agent.workflow events; 10s poll fallback while a run is active ──
function connectWs(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/events`);
  ws.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data as string) as { type: string; payload: { runId?: string; sessionId?: string; type?: string; detail?: unknown } };
      if (e.type === 'agent.workflow' && e.payload.runId && e.payload.runId === runId.value) {
        // rev23: stream the stage turn live — the same growing bubble as chat
        const wt = e.payload.type;
        if (wt === 'workflow.turn.delta' && typeof e.payload.detail === 'object' && e.payload.detail !== null) {
          const d = (e.payload.detail as { delta?: string }).delta;
          if (d) setTurn((t) => { t.streaming = (streaming.value ?? '') + d; });
        } else if (wt === 'workflow.turn.tool') {
          const d = e.payload.detail as { phase?: string; name?: string; arg?: string; result?: string; isError?: boolean };
          const stop: ToolStop = { name: d.name ?? 'tool', live: d.phase !== 'result' };
          if (d.arg !== undefined) stop.arg = d.arg;
          if (d.result !== undefined) stop.result = d.result;
          if (d.isError !== undefined) stop.isError = d.isError;
          setTurn((t) => { t.toolStops = [...toolStops.value.filter((t) => t.live), stop]; });
        } else if (wt === 'workflow.stage_done' || wt === 'workflow.done') {
          if (streaming.value) { setTurn((t) => { t.streaming = null; }); setTurn((t) => { t.toolStops = []; }); }
        }
        void panel.value?.refresh();
      }
      // rev9 E1: a turn just ENDED on the open chat (any client) → refetch so
      // the answer/abort state appears without a manual reload
      if (e.type === 'agent.turn' && e.payload.sessionId === sessionId.value
          && (e.payload.type === 'turn.end' || e.payload.type === 'turn.error')
          && sessionId.value) {
        setTurn((t) => { t.streaming = null; }); // rev10: bubble completes via refetch
        setTurn((t) => { t.toolStops = []; }); // rev15: rail retires with the turn
        void openSession(sessionId.value);
      }
      // rev10: live delta → grow the streaming bubble (tool-trace lines are
      // dropped here — the rail renders them from turn.tool events; keeping
      // both duplicated every call)
      if (e.type === 'agent.turn' && e.payload.sessionId === sessionId.value && e.payload.type === 'turn.delta') {
        const d = (e.payload as { detail?: { delta?: string } }).detail?.delta ?? '';
        if (d.includes('\u23f5') || d.includes('\u23bf') || (streaming.value ?? '').endsWith('\n') && d.trim() === '') return;
        setTurn((t) => { t.streaming = (streaming.value ?? '') + d; });
      }
      // rev15: structured tool events → timeline stops
      if (e.type === 'agent.turn' && e.payload.sessionId === sessionId.value && e.payload.type === 'turn.tool') {
        const t = (e.payload as { detail?: { phase?: string; name?: string; arg?: string; result?: string; isError?: boolean } }).detail ?? {};
        if (t.phase === 'call') {
          const stop: ToolStop = { name: t.name ?? 'tool', live: true };
          if (t.arg !== undefined) stop.arg = t.arg;
          setTurn((ts) => { ts.toolStops = [...ts.toolStops.filter((x) => !(x.live && x.name === t.name)), stop]; });
        } else if (t.phase === 'result') {
          const i = toolStops.value.findIndex((x) => x.live && x.name === t.name);
          const patch: ToolStop = { name: t.name ?? 'tool', live: false };
          if (t.result !== undefined) patch.result = t.result;
          if (t.isError !== undefined) patch.isError = t.isError;
          if (i >= 0) {
            const arr = [...toolStops.value];
            const cur = arr[i]!;
            const merged: ToolStop = { name: cur.name, live: false };
            if (cur.arg !== undefined) merged.arg = cur.arg;
            if (patch.result !== undefined) merged.result = patch.result;
            if (patch.isError !== undefined) merged.isError = patch.isError;
            arr[i] = merged;
            setTurn((t) => { t.toolStops = arr; });
          } else {
            setTurn((t) => { t.toolStops = [...toolStops.value, patch]; });
          }
        }
      }
    } catch { /* non-json frame */ }
  };
  ws.onclose = () => { setTimeout(connectWs, 3_000); };
}
function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => { if (runId.value) void panel.value?.refresh(); }, 10_000);
}

onMounted(() => {
  void loadMe();
  const qRun = route.query['run'];
  if (typeof qRun === 'string' && qRun) { setTurn((t) => { t.runId = qRun; }); }
  // rev9 E2: restore the last-open chat so a mid-flight reload lands back on it
  const last = localStorage.getItem('agent.lastSession');
  if (last) void openSession(last);
  connectWs();
  startPolling();
});
onBeforeUnmount(() => { ws?.close(); if (pollTimer) clearInterval(pollTimer); });
</script>

<template>
  <div v-if="me && !isOperator" class="denied">
    <div class="d-card">
      <div class="d-t">operator role required</div>
      <div class="d-s">the agent chat is available to operators and above. you are signed in as {{ me.role }}.</div>
    </div>
  </div>
  <div v-else class="ag-root">
    <ChatSidebar ref="sidebar" :me="me" :active-id="sessionId" @select="openSession" @new-chat="newChat" @renamed="onRenamed" @deleted="onDeleted" />
    <div class="mid">
      <Thread :messages="messages" :title="title" :live="panel?.live ?? false" :waiting="sending && !streaming" :streaming="streaming" :tool-stops="toolStops" :session-id="sessionId" @resend="resend">
        <div class="mid-inner" @paste="onPaste" @drop="onDrop" @dragover.prevent>
          <Composer ref="composer" :busy="sending" @send="send" @abort="abortTurn" @skill="runSkill" @open-attachment="openAttachmentPicker" />
        </div>
      </Thread>
    </div>
    <RunPanel ref="panel" @error="onPanelError" :run-id="runId" />
  </div>
</template>

<style scoped>
.mid { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; min-height: 0; }
.denied { height: 100%; display: grid; place-items: center; }
.d-card { border: 1px solid var(--color-iron); border-radius: var(--r-sm); padding: var(--s-4) var(--s-5); background: var(--color-carbon); text-align: center; }
.d-t { font-size: var(--text-heading-sm); margin-bottom: var(--s-2); }
.d-s { font-size: var(--text-caption); color: var(--color-fog); }
</style>
