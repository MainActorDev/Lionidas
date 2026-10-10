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
interface Msg { role: 'user' | 'assistant' | 'system'; text: string; refs?: Array<{ kind: string; name: string }>; toolTrace?: string; status?: string }

const route = useRoute();
const me = ref<Me | null>(null);
const sessionId = ref<string | null>(null);
const title = ref('new chat');
const messages = ref<Msg[]>([]);
const sending = ref(false);
const sidebar = ref<InstanceType<typeof ChatSidebar> | null>(null);
const panel = ref<InstanceType<typeof RunPanel> | null>(null);
const runId = ref<string | null>(null);
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
  sessionId.value = id;
  const r = await fetch(`/api/agent/sessions/${id}`);
  if (!r.ok) return;
  const b = (await r.json()) as { session: { title: string | null }; messages: Array<{ role: string; content: string | null }> };
  title.value = b.session.title ?? id;
  messages.value = b.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.content ?? '' }));
  runId.value = boundRun(id);
  void panel.value?.refresh();
}

async function newChat(): Promise<void> {
  // create the butler session up-front so the run binds immediately
  const r = await fetch('/api/agent/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: null, userId: me.value?.id ?? null }) });
  if (r.ok) {
    const b = (await r.json()) as { session: { id: string } };
    sessionId.value = b.session.id;
    title.value = 'new chat';
    messages.value = [];
    runId.value = null;
    void sidebar.value?.load();
  }
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
  title.value = nice;
  if (sessionId.value) void fetch(`/api/agent/sessions/${sessionId.value}/ai-title`, { method: 'POST' }).then((r) => (r.ok ? r.json() : null)).then((j: { title?: string } | null) => {
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
    if (id === sessionId.value) { sessionId.value = null; title.value = 'new chat'; messages.value = []; }
    void sidebar.value?.load();
  }
}

async function send(text: string, refs: PipelineRef[], appBundle: string): Promise<void> {
  if (!sessionId.value) await newChat();
  const sid = sessionId.value!;
  sending.value = true;
  const prettyRefs = refs.map((r) => ({ kind: r.kind, name: r.locator }));
  messages.value = [...messages.value, { role: 'user', text, refs: prettyRefs }];
  maybeAutoTitle(text);
  try {
    // deterministic rule (plan F4): refs ⇒ pipeline + chat turn; else chat only
    if (refs.length) {
      if (!appBundle) { messages.value = [...messages.value, { role: 'system', text: 'app bundle required to start a run — attach it in the composer' }]; return; }
      const pr = await fetch('/api/agent/pipeline', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appBundle, refs }) });
      const pb = (await pr.json()) as { runId?: string; error?: string };
      if (!pr.ok || !pb.runId) {
        messages.value = [...messages.value, { role: 'system', text: `pipeline refused: ${pb.error ?? pr.status}` }];
        return;
      }
      runId.value = pb.runId;
      bindRun(sid, pb.runId);
      void panel.value?.refresh();
      // the chat turn (records the intent in the conversation)
      await fetch(`/api/agent/sessions/${sid}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `${text} [refs: ${refs.map((r) => r.locator).join(', ')}]` }) });
    } else {
      const r = await fetch(`/api/agent/sessions/${sid}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text }) });
      if (r.ok) {
        const b = (await r.json()) as { answer?: string };
        messages.value = [...messages.value, { role: 'assistant', text: b.answer ?? '(no answer)' }];
      } else {
        messages.value = [...messages.value, { role: 'system', text: 'turn failed' }];
      }
    }
  } finally {
    sending.value = false;
    void sidebar.value?.load();
  }
}

// ── live updates: agent.workflow events; 10s poll fallback while a run is active ──
function connectWs(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/events`);
  ws.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data as string) as { event: string; payload: { runId?: string } };
      if (e.event === 'agent.workflow' && e.payload.runId && e.payload.runId === runId.value) void panel.value?.refresh();
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
  if (typeof qRun === 'string' && qRun) { runId.value = qRun; }
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
      <Thread :messages="messages" :title="title" :live="panel?.live ?? false" :waiting="sending">
        <Composer :busy="sending" @send="send" />
      </Thread>
    </div>
    <RunPanel ref="panel" :run-id="runId" />
  </div>
</template>

<style scoped>
.mid { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; min-height: 0; }
.denied { height: 100%; display: grid; place-items: center; }
.d-card { border: 1px solid var(--color-iron); border-radius: var(--r-sm); padding: var(--s-4) var(--s-5); background: var(--color-carbon); text-align: center; }
.d-t { font-size: var(--text-heading-sm); margin-bottom: var(--s-2); }
.d-s { font-size: var(--text-caption); color: var(--color-fog); }
</style>
