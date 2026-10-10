<script setup lang="ts">
/** Audit log (RBAC T3/T5, plan 20261009T102032Z): who did what, when —
 *  supervisor+ (server-gated; the nav hides the entry below supervisor).
 *  Paged, filterable by actor/event; the API is the same auth_log the
 *  account-mutation trail writes to, now covering runs/builds/cases/drive
 *  and RBAC denials. */
import { onMounted, ref } from 'vue';

interface AuditRow { id: number; at: number; email: string | null; user_id: string | null; event: string; detail: string }
const rows = ref<AuditRow[]>([]);
const hasMore = ref(false);
const loading = ref(false);
const err = ref('');
const fActor = ref('');
const fEvent = ref('');
const before = ref<number | null>(null);

const EVENT_CLASSES: Array<{ label: string; events: string[] }> = [
  { label: 'auth', events: ['login', 'login_failed', 'logout', 'session_killed'] },
  { label: 'accounts', events: ['approved', 'unapproved', 'role_changed', 'active_changed', 'password_changed', 'bot_token_rotated'] },
  { label: 'runs', events: ['run_play', 'run_abort'] },
  { label: 'cases', events: ['case_create', 'case_edit', 'case_delete'] },
  { label: 'devices', events: ['manual_take_control', 'manual_release', 'device_action', 'build_trigger'] },
  { label: 'rbac', events: ['rbac_denied'] },
];

async function load(reset = true): Promise<void> {
  if (reset) { before.value = null; rows.value = []; }
  loading.value = true; err.value = '';
  try {
    const q = new URLSearchParams();
    if (fActor.value) q.set('actor', fActor.value);
    if (fEvent.value) q.set('event', fEvent.value);
    if (before.value) q.set('before', String(before.value));
    q.set('limit', '50');
    const r = await fetch(`/api/audit?${q}`);
    if (!r.ok) { err.value = r.status === 403 ? 'supervisor role required' : `load failed (${r.status})`; return; }
    const b = (await r.json()) as { events: AuditRow[]; hasMore: boolean };
    rows.value = reset ? b.events : [...rows.value, ...b.events];
    hasMore.value = b.hasMore;
    if (b.events.length) before.value = b.events[b.events.length - 1]!.at;
  } catch { err.value = 'load failed'; } finally { loading.value = false; }
}

function applyFilters(): void { void load(true); }

function fmtTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function eventClass(ev: string): string {
  return EVENT_CLASSES.find((c) => c.events.includes(ev))?.label ?? 'other';
}

onMounted(() => void load(true));
</script>

<template>
  <div class="page audit">
    <header class="head">
      <h1>audit log</h1>
      <p class="sub">who did what, when — auth, accounts, runs, cases, devices, denials</p>
    </header>

    <div class="filters">
      <input v-model="fActor" class="f-in" placeholder="actor (email contains…)" @keydown.enter="applyFilters" />
      <select v-model="fEvent" class="f-sel" @change="applyFilters">
        <option value="">all events</option>
        <optgroup v-for="c in EVENT_CLASSES" :key="c.label" :label="c.label">
          <option v-for="e in c.events" :key="e" :value="e">{{ e }}</option>
        </optgroup>
      </select>
      <button class="m-btn" type="button" @click="applyFilters">filter</button>
    </div>

    <p v-if="err" class="err">{{ err }}</p>

    <table class="tbl" v-if="rows.length">
      <thead>
        <tr><th>when</th><th>actor</th><th>event</th><th>detail</th></tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id">
          <td class="mono when">{{ fmtTime(r.at) }}</td>
          <td class="mono actor">{{ r.email ?? '—' }}</td>
          <td><span class="chip" :class="eventClass(r.event)">{{ r.event }}</span></td>
          <td class="detail">{{ r.detail }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else-if="!loading && !err" class="empty">no audit rows match</p>

    <button v-if="hasMore" class="m-btn more" type="button" :disabled="loading" @click="load(false)">
      {{ loading ? 'loading…' : 'load more' }}
    </button>
  </div>
</template>

<style scoped>
.audit { max-width: 980px; }
.head h1 { font-size: 18px; letter-spacing: .02em; margin: 0; }
.sub { color: var(--color-fog); font-size: 12px; margin: 4px 0 16px; }
.filters { display: flex; gap: 8px; margin-bottom: 14px; }
.f-in, .f-sel { background: var(--color-carbon); border: 1px solid var(--color-line); border-radius: var(--r); color: var(--color-ink); font-size: 12px; padding: 6px 10px; }
.f-in { flex: 1; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.tbl th { text-align: left; color: var(--color-fog); font-weight: 500; padding: 6px 10px; border-bottom: 1px solid var(--color-line); }
.tbl td { padding: 6px 10px; border-bottom: 1px solid var(--color-line); vertical-align: top; }
.mono { font-family: var(--font-mono); font-size: 11px; }
.when { color: var(--color-fog); white-space: nowrap; }
.actor { white-space: nowrap; }
.chip { font-family: var(--font-mono); font-size: 10px; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--color-line); }
.chip.rbac { border-color: var(--color-ember); color: var(--color-ember); }
.chip.runs, .chip.cases, .chip.devices { border-color: var(--color-slate); }
.detail { color: var(--color-ink); }
.empty { color: var(--color-fog); font-size: 12px; }
.more { margin-top: 12px; }
.err { color: var(--color-ember); font-size: 12px; }
</style>
