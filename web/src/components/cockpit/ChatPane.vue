<script setup lang="ts">
/** ChatPane (S4): agent conversation on the cockpit rail. Uses the existing
 *  /api/agent/sessions* conversation API. F3: the FIRST message of a
 *  conversation auto-prepends a [context] line (device/screen/scenario) so
 *  'agent sees what you see' is literally true. Turn-in-flight disables the
 *  composer (the API is synchronous). */
import { computed, nextTick, ref, watch } from 'vue';

const props = defineProps<{ udid: string; deviceName: string; screenState: string; scenario: string | null }>();

interface Msg { role: 'user' | 'agent'; text: string }
const msgs = ref<Msg[]>([]);
const draft = ref('');
const busy = ref(false);
const error = ref('');
const sessionId = ref<string | null>(null);
const logEl = ref<HTMLElement | null>(null);

const contextLine = computed((): string =>
  `[context] device: ${props.deviceName} · screen: ${props.screenState} · scenario: ${props.scenario ?? 'none'}`);

// fresh conversation per device switch (round-1 rule, noted in UI)
watch(() => props.udid, () => { sessionId.value = null; msgs.value = []; error.value = ''; });

async function ensureSession(): Promise<string> {
  if (sessionId.value) return sessionId.value;
  const r = await fetch('/api/agent/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error(`session create failed (${r.status})`);
  const b = await r.json() as { session?: { id?: string }; id?: string };
  const id = b.session?.id ?? b.id;
  if (!id) throw new Error('no session id in response');
  sessionId.value = id;
  return id;
}

async function send(): Promise<void> {
  const text = draft.value.trim();
  if (!text || busy.value) return;
  draft.value = '';
  busy.value = true; error.value = '';
  const isFirst = msgs.value.length === 0;
  msgs.value.push({ role: 'user', text });
  await scrollDown();
  try {
    const sid = await ensureSession();
    const content = isFirst ? `${contextLine.value}\n${text}` : text;
    const r = await fetch(`/api/agent/sessions/${encodeURIComponent(sid)}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
    });
    if (!r.ok) throw new Error(`turn failed (${r.status})`);
    const b = await r.json() as { turn?: { ok?: boolean; answer?: string; error?: string } };
    if (b.turn?.ok) msgs.value.push({ role: 'agent', text: b.turn.answer ?? '(empty answer)' });
    else msgs.value.push({ role: 'agent', text: `turn failed: ${b.turn?.error ?? 'unknown'}` });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
    await scrollDown();
  }
}

async function scrollDown(): Promise<void> { await nextTick(); if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight; }
</script>

<template>
  <div class="chat">
    <div ref="logEl" class="chatlog">
      <div v-for="(m, i) in msgs" :key="i" class="msg" :class="m.role">
        <div v-if="m.role === 'agent'" class="who">agent</div>
        <div class="txt">{{ m.text }}</div>
      </div>
      <div v-if="busy" class="thinking">◆ thinking…</div>
      <div v-if="!msgs.length" class="empty">ask the agent — it can read cases/runs/scenarios, not play</div>
    </div>
    <div class="ctxnote">context: {{ deviceName }} · {{ screenState }} · {{ scenario ?? 'none' }} — prepended to your first message</div>
    <div class="chatarea">
      <input v-model="draft" :disabled="busy" placeholder="ask the agent…" @keydown.enter.prevent="send" />
      <button type="button" class="primary" :disabled="busy || !draft.trim()" @click="send">send</button>
    </div>
    <div v-if="error" class="err">{{ error }}</div>
  </div>
</template>

<style scoped>
.chat { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.chatlog { flex: 1; overflow-y: auto; padding: var(--s-3); display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.msg { max-width: 92%; border: 1px solid var(--color-iron); border-radius: var(--r); padding: 6px 8px; font-size: var(--text-caption); line-height: 1.45; white-space: pre-wrap; }
.msg.user { align-self: flex-end; border-color: var(--color-slate); }
.msg.agent { align-self: flex-start; }
.msg .who { color: var(--color-accent); font-size: 10px; margin-bottom: 2px; }
.thinking { color: var(--color-ember); font-size: var(--text-caption); padding: 0 var(--s-3); }
.empty { color: var(--color-steel); font-size: var(--text-caption); padding: var(--s-3); }
.ctxnote { font-size: 9px; color: var(--color-steel); padding: 0 var(--s-3) var(--s-2); }
.chatarea { border-top: 1px solid var(--color-iron); padding: var(--s-2) var(--s-3); display: flex; gap: 6px; }
.chatarea input { flex: 1; background: var(--color-void); border: 1px solid var(--color-slate); color: var(--color-paper); font-family: inherit; font-size: var(--text-caption); padding: 6px 8px; border-radius: var(--r); outline: none; }
.chataree input:focus, .chatarea input:focus { border-color: var(--color-accent); }
.chatarea button { font-family: inherit; background: var(--color-accent); border: 1px solid var(--color-accent); color: #101010; font-weight: var(--weight-bold); font-size: var(--text-caption); padding: 4px 12px; border-radius: var(--r); cursor: pointer; }
.chatarea button:disabled { opacity: .5; cursor: default; }
.err { color: var(--color-paper); font-size: var(--text-caption); padding: var(--s-1) var(--s-3); }
</style>
