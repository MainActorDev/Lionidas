<script setup lang="ts">
/** Phase 5 step 4 slice 2 — the v2 agent chat page (parallel-run at /agent-v2).
 *  Renders ONLY TurnItems from GET /timeline (the UI-owns-no-turn-state
 *  direction): live deltas arrive as coalesced agent.turn.item snapshots that
 *  REPLACE an item's text; turn end refetches the projection. The v1 POST
 *  messages route still carries sends (contract-first: transport swap is a
 *  later step). Composer interaction model, queue semantics, sidebar, run
 *  panel are reused unchanged. */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import ChatSidebar from './components/ChatSidebar.vue';
import Timeline from './components/Timeline.vue';
import Composer from './components/Composer.vue';
import RunPanel from './components/RunPanel.vue';
import type { Ref as PipelineRef } from './components/Composer.vue';
import type { TurnItem, TimelineResponse } from './components/timelineTypes';
import './agent-theme.css';

interface Me { id: string; name: string; email: string; role: string }

const route = useRoute();
const me = ref<Me | null>(null);
const sessionId = ref<string | null>(null);
const title = ref('new chat');
const items = ref<TurnItem[]>([]);
const liveTurn = ref<{ turnId: string; startedAt: number } | null>(null);
/** interim bridge (plan §2.8): the in-flight SEND is local UI state (the v1
 *  POST holds the request); turn truth itself rides items + liveTurn. */
const sending = ref(false);
const queue = ref<Array<{ id: number; text: string; refs: PipelineRef[]; appBundle: string; commands: string[] }>>([]);
let queueSeq = 0;
const sidebar = ref<InstanceType<typeof ChatSidebar> | null>(null);
const panel = ref<InstanceType<typeof RunPanel> | null>(null);
const composer = ref<InstanceType<typeof Composer> | null>(null);
let ws: WebSocket | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pendingAiTitle = false;

const isOperator = computed(() => me.value?.role === 'admin' || me.value?.role === 'supervisor' || me.value?.role === 'operator');
/** live = a turn is truthfully active (server-reported), not just our POST */
const live = computed(() => liveTurn.value !== null || sending.value);

// ── data ────────────────────────────────────────────────────────────────
async function loadMe(): Promise<void> {
  const r = await fetch('/api/auth/me');
  if (r.ok) me.value = ((await r.json()) as { user: Me }).user;
}

async function openSession(id: string): Promise<void> {
  composer.value?.resetDraft();
  sessionId.value = id;
  localStorage.setItem('agent.lastSession', id);
  await loadTimeline();
  void panel.value?.refresh();
}

async function loadTimeline(): Promise<void> {
  if (!sessionId.value) return;
  const r = await fetch(`/api/agent/sessions/${sessionId.value}/timeline`);
  if (!r.ok) {
    // honest failure: a dead route/stale server must not read as "no messages"
    items.value = [{ kind: 'error', id: `tl-${Date.now()}`, sessionId: sessionId.value, turnId: null, ordinal: 0, status: 'failed', startedAt: Date.now(), completedAt: Date.now(), class: 'provider_error', message: `timeline unavailable (HTTP ${r.status}) — is the server current?` }];
    liveTurn.value = null;
    return;
  }
  const b = (await r.json()) as TimelineResponse;
  items.value = b.items;
  liveTurn.value = b.liveTurn ?? null;
  if (!titleIsCustom()) title.value = 'chat';
  // sidebar titles stay authoritative; page title shown in header pill
}
function titleIsCustom(): boolean { return title.value !== 'new chat' && title.value !== 'chat'; }

async function newChat(): Promise<void> {
  composer.value?.resetDraft();
  const r = await fetch('/api/agent/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: null, userId: me.value?.id ?? null }) });
  if (r.ok) {
    const b = (await r.json()) as { session: { id: string } };
    sessionId.value = b.session.id;
    title.value = 'new chat';
    items.value = [];
    liveTurn.value = null;
    void sidebar.value?.load();
  }
  if (sessionId.value) localStorage.setItem('agent.lastSession', sessionId.value);
}

// ── send (v1 transport; v2 render) ─────────────────────────────────────
async function send(text: string, refs: PipelineRef[], appBundle: string, commands: string[] = [], model?: string): Promise<void> {
  const cmdNote = commands.length ? ` [cmds: ${commands.join(' ')}]` : '';
  const refNote = refs.length ? ` [refs: ${refs.map((r) => `${r.kind}:${r.locator}`).join(', ')}]` : '';
  if (live.value) {
    queue.value = [...queue.value, { id: ++queueSeq, text, refs, appBundle, commands }];
    return; // visible queue — nothing displaced
  }
  if (!sessionId.value) await newChat();
  const sid = sessionId.value!;
  sending.value = true;
  maybeAutoTitle(text);
  try {
    const r = await fetch(`/api/agent/sessions/${sid}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `${text}${cmdNote}${refNote}`, ...(commands.length ? { commands } : {}), ...(model ? { model } : {}) }) });
    if (!r.ok) { /* fold renders the failure on refetch */ }
  } finally {
    sending.value = false;
    await loadTimeline(); // the projection IS the truth — no client-side bubble math
    settleAiTitle();
    void sidebar.value?.load();
    drainQueue();
  }
}

function drainQueue(): void {
  const head = queue.value[0];
  if (!head || live.value) return;
  queue.value = queue.value.slice(1);
  void send(head.text, head.refs, head.appBundle, head.commands);
}
function queueSendNow(id: number): void {
  const item = queue.value.find((q) => q.id === id);
  if (!item || live.value) return;
  queue.value = queue.value.filter((q) => q.id !== id);
  void send(item.text, item.refs, item.appBundle, item.commands);
}
function queueEdit(id: number): void {
  const item = queue.value.find((q) => q.id === id);
  if (!item) return;
  queueDelete(id);
  composer.value?.loadDraft?.(item.text, item.refs, item.commands);
}
function queueDelete(id: number): void {
  queue.value = queue.value.filter((q) => q.id !== id);
}

function maybeAutoTitle(text: string): void {
  if (title.value !== 'new chat' || text.trim().length < 4) return;
  const stripped = text.replace(/^\s*(please\s+)?(draft|write|create|make|generate|prepare)\s+/i, '').slice(0, 48).trim();
  if (!stripped) return;
  const nice = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  title.value = nice;
  pendingAiTitle = true;
  if (sessionId.value) void fetch(`/api/agent/sessions/${sessionId.value}/title`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: nice }) });
}
function settleAiTitle(): void {
  if (!pendingAiTitle || !sessionId.value) return;
  pendingAiTitle = false;
  void fetch(`/api/agent/sessions/${sessionId.value}/ai-title`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }) }).then((r) => (r.ok ? r.json() : null)).then((j: { title?: string } | null) => {
    if (j?.title) { title.value = j.title; void sidebar.value?.load(); }
  }).catch(() => {/* keep regex title */});
}

async function onRenamed(id: string, t: string): Promise<void> {
  await fetch(`/api/agent/sessions/${id}/title`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: t }) });
  if (id === sessionId.value) title.value = t;
  void sidebar.value?.load();
}
async function onDeleted(id: string): Promise<void> {
  const r = await fetch(`/api/agent/sessions/${id}`, { method: 'DELETE' });
  if (r.ok) {
    if (id === sessionId.value) { sessionId.value = null; title.value = 'new chat'; items.value = []; localStorage.removeItem('agent.lastSession'); }
    void sidebar.value?.load();
  }
}

async function abortTurn(): Promise<void> {
  if (!sessionId.value) return;
  await fetch(`/api/agent/sessions/${sessionId.value}/abort`, { method: 'POST' });
  await loadTimeline();
}

/** attachment flow (v1 parity): @attachment → hidden file input; upload on
 *  SELECT; the composer chips it. Paste/drop ride the same upload. */
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
async function uploadAttachment(file: File): Promise<void> {
  const fd = new FormData();
  fd.append('file', file, file.name);
  try {
    const r = await fetch('/api/agent/attachments', { method: 'POST', body: fd });
    const b = (await r.json()) as { id?: string; fileName?: string; error?: string };
    if (!r.ok || !b.id) {
      items.value = [...items.value, { kind: 'error', id: `att-${Date.now()}`, sessionId: sessionId.value ?? '', turnId: null, ordinal: Number.MAX_SAFE_INTEGER, status: 'failed', startedAt: Date.now(), completedAt: Date.now(), class: 'provider_error', message: `attachment failed: ${b.error ?? r.status}` }];
      return;
    }
    composer.value?.addAttachmentChip(b.id, b.fileName ?? file.name);
  } catch (e) {
    items.value = [...items.value, { kind: 'error', id: `att-${Date.now()}`, sessionId: sessionId.value ?? '', turnId: null, ordinal: Number.MAX_SAFE_INTEGER, status: 'failed', startedAt: Date.now(), completedAt: Date.now(), class: 'provider_error', message: `attachment failed: ${(e as Error).message}` }];
  }
}
function onPaste(e: ClipboardEvent): void {
  const f = e.clipboardData?.files?.[0];
  if (f) { e.preventDefault(); void uploadAttachment(f); }
}
function onDrop(e: DragEvent): void {
  const f = e.dataTransfer?.files?.[0];
  if (f) { e.preventDefault(); void uploadAttachment(f); }
}

// ── model picker (unchanged contract) ───────────────────────────────────
interface ModelOptionUi { id: string; kind: 'combo' | 'model'; label?: string; members?: string[]; healthy?: boolean }
const modelOptions = ref<ModelOptionUi[]>([]);
const modelSel = ref('');
async function loadModels(): Promise<void> {
  try {
    const r = await fetch('/api/agent/models/health');
    if (!r.ok) return;
    const b = (await r.json()) as { combos: Array<{ id: string; members: string[] }>; models: Array<{ id: string; ok: number; failed: number }> };
    const reg = await (await fetch('/api/agent/models')).json() as { registry?: { defaultCombo: string; models: Array<{ id: string; enabled: boolean; kind: string }> } | null };
    if (!reg.registry) return;
    const health = new Map(b.models.map((m) => [m.id, m.ok > 0 && m.failed === 0 ? true : m.failed > 0 && m.ok === 0 ? false : undefined]));
    modelOptions.value = [
      ...b.combos.map((c) => ({ id: c.id, kind: 'combo' as const, members: c.members })),
      ...reg.registry.models.filter((m) => m.enabled && m.kind !== 'mock').map((m) => { const h = health.get(m.id); return { id: m.id, kind: 'model' as const, ...(h !== undefined ? { healthy: h } : {}) }; }),
    ];
    if (!modelSel.value) modelSel.value = reg.registry.defaultCombo;
  } catch { /* picker hidden on failure */ }
}

// ── live updates (coalesced snapshots + turn end) ───────────────────────
let wsRetries = 0;
function connectWs(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/events`);
  ws.onopen = () => { wsRetries = 0; };
  ws.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data as string) as { type: string; payload: Record<string, unknown> };
      if (!sessionId.value || e.payload['sessionId'] !== sessionId.value) return;
      if (e.type === 'agent.turn.item') {
        // REPLACE semantics: the snapshot is the full text-so-far for that item
        const itemId = String(e.payload['itemId'] ?? '');
        const text = String(e.payload['text'] ?? '');
        const done = e.payload['done'] === true;
        applySnapshot(itemId, text, done);
      } else if (e.type === 'agent.turn' && (e.payload['type'] === 'turn.end' || e.payload['type'] === 'turn.error')) {
        void loadTimeline(); // projection is truth
      }
    } catch { /* non-json frame */ }
  };
  ws.onclose = () => {
    // exponential backoff with a cap — a dead proxy (static preview) must not
    // become a 3s reconnect churn that fights the browser/screenshot loop
    if (wsRetries >= 5) return;
    wsRetries += 1;
    setTimeout(connectWs, Math.min(30_000, 3_000 * 2 ** (wsRetries - 1)));
  };
}
function applySnapshot(itemId: string, text: string, done: boolean): void {
  const idx = items.value.findIndex((i) => i.id === itemId);
  if (idx === -1) {
    // first sighting during a live turn: a streaming assistant message
    items.value = [...items.value, { kind: 'message', id: itemId, sessionId: sessionId.value ?? '', turnId: null, ordinal: Number.MAX_SAFE_INTEGER, status: 'running', startedAt: Date.now(), completedAt: null, role: 'assistant', streaming: !done, text }];
    return;
  }
  const cur = items.value[idx]!;
  if (cur.kind !== 'message') return;
  const next = [...items.value];
  next[idx] = { ...cur, text, streaming: !done, ...(done ? { status: 'completed', completedAt: Date.now() } : {}) };
  items.value = next;
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => { void panel.value?.refresh(); }, 10_000);
}

onMounted(() => {
  void loadModels();
  void loadMe();
  const qRun = route.query['run'];
  if (typeof qRun === 'string' && qRun) runId.value = qRun;
  // restore the last-open chat; else auto-open the most recent session so a
  // fresh browser lands on real content instead of an empty timeline
  const last = localStorage.getItem('agent.lastSession');
  if (last) void openSession(last);
  else {
    void (async () => {
      try {
        const r = await fetch('/api/agent/sessions');
        if (!r.ok) return;
        const b = (await r.json()) as { sessions?: Array<{ id: string }> };
        const first = b.sessions?.[0]?.id;
        if (first) void openSession(first);
      } catch { /* sidebar stays the entry point */ }
    })();
  }
  connectWs();
  startPolling();
});
onBeforeUnmount(() => { ws?.close(); if (pollTimer) clearInterval(pollTimer); });

// test seam: the page's projection logic is the interesting surface
defineExpose({ send, applySnapshot, loadTimeline, queueSendNow, queueEdit, queueDelete, abortTurn });

const runId = ref<string | null>(null);
function onPanelError(m: string): void {
  // panel errors ride the timeline as a synthetic error item (visible, honest)
  items.value = [...items.value, { kind: 'error', id: `panel-${Date.now()}`, sessionId: sessionId.value ?? '', turnId: null, ordinal: Number.MAX_SAFE_INTEGER, status: 'failed', startedAt: Date.now(), completedAt: Date.now(), class: 'provider_error', message: m }];
}
</script>

<template>
  <div v-if="me && !isOperator" class="denied">
    <div class="d-card">
      <div class="d-t">operator role required</div>
      <div class="d-s">the agent chat is available to operators and above. you are signed in as {{ me.role }}.</div>
    </div>
  </div>
  <div v-else class="ag-root v2-root">
    <ChatSidebar ref="sidebar" :me="me" :active-id="sessionId" @select="openSession" @new-chat="newChat" @renamed="onRenamed" @deleted="onDeleted" />
    <div class="mid">
      <div class="head">
        <h1>{{ title }}</h1>
        <span v-if="sessionId" class="pill">{{ sessionId.slice(0, 12) }}</span>
        <span v-if="liveTurn" class="pill live">● live</span>
      </div>
      <Timeline :items="items" empty-title="no messages yet" empty-description="ask about cases, runs, or draft new tests…" />
      <div v-if="queue.length" class="queue" aria-label="queued messages">
        <div v-for="q in queue" :key="q.id" class="q-item">
          <span class="qt">{{ q.text }}</span>
          <button type="button" @click="queueEdit(q.id)">edit</button>
          <button type="button" :disabled="live" @click="queueSendNow(q.id)">send now</button>
          <button type="button" @click="queueDelete(q.id)">✕</button>
        </div>
      </div>
      <div class="composer-zone" @paste="onPaste" @drop="onDrop" @dragover.prevent>
        <Composer ref="composer" :busy="live" :model-options="modelOptions" :model="modelSel" @model-change="(m: string) => { modelSel = m; }" @send="send" @abort="abortTurn" @open-attachment="openAttachmentPicker" />
      </div>
    </div>
    <RunPanel v-if="runId" ref="panel" :run-id="runId" @error="onPanelError" />
  </div>
</template>

<style scoped>
.v2-root { display: flex; height: 100%; min-height: 0; min-width: 0; width: 100%; max-width: 100%; overflow: hidden; }
.mid { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.head { display: flex; align-items: baseline; gap: 10px; padding: 14px 24px 12px; border-bottom: 1px solid var(--ag-line, #2a2a2a); min-width: 0; }
.head h1 { font-size: 14px; font-weight: 500; color: var(--ag-ink, #eae6e1); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
.pill { font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 10px; color: var(--ag-ink-dim, #a39d95); border: 1px solid var(--ag-line, #2a2a2a); border-radius: 2px; padding: 2px 6px; }
.pill.live { color: var(--color-ember, #ee6018); border-color: rgba(238, 96, 24, .4); }
.queue { padding: 0 24px 8px; max-width: 820px; margin: 0 auto; width: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; }
.q-item { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ag-ink-dim, #a39d95); border: 1px dashed var(--ag-line, #2a2a2a); border-radius: 2px; padding: 6px 10px; }
.q-item .qt { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.q-item button { font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 10px; color: var(--ag-ink-dim, #a39d95); background: none; border: none; cursor: pointer; }
.q-item button:hover:not(:disabled) { color: var(--ag-ink, #eae6e1); }
.q-item button:disabled { opacity: .4; cursor: default; }
.denied { height: 100%; display: grid; place-items: center; }
.d-card { border: 1px solid var(--color-iron, #2a2724); border-radius: 2px; padding: 16px 20px; background: var(--ag-surface, #1d1a18); text-align: center; }
.d-t { font-size: 14px; margin-bottom: 8px; color: var(--ag-ink, #eae6e1); }
.d-s { font-size: 12px; color: var(--ag-ink-dim, #a39d95); }
@media (max-width: 900px) { .v2-root :deep(.runpanel) { display: none; } }
/* mobile: the chat column needs the width — hide the session sidebar under
 * 900px (sketch 042-A: rail hides, chat fills; the app shell's own nav
 * collapses independently). Fresh v2-only rule; v1 layout untouched. */
@media (max-width: 900px) {
  .v2-root :deep(.sb) { display: none; }
  .v2-root .head { padding: 12px 16px; }
  .v2-root .queue { padding: 0 16px 8px; }
}
/* the composer zone owns horizontal shrink: the legacy .composer sizes
 * against its parent — a 100%-width min-width:0 wrapper keeps the flex
 * chain from flooring on its content at narrow viewports. */
.composer-zone { width: 100%; min-width: 0; padding: 0 16px 14px; box-sizing: border-box; }
</style>
