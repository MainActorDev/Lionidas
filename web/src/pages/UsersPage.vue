<script setup lang="ts">
/** Users (admin): provision local accounts, set roles, reset passwords, deactivate.
 *  Standardization: full .main width, content-sized table, shared primitives. */
import PageHeader from '../components/PageHeader.vue';
import { computed, ref, onMounted } from 'vue';

// Non-admins get a SELF view: own profile + own activity (runs, manual sessions,
// logins) — the same page, scoped to their identity by the server.
interface Me { id: string; name: string; email: string; role: string; auth_source: string }
const me = ref<Me | null>(null);

// API tokens (CLI auth)
const tokens = ref<Array<{ id: string; name: string; created_at: number; last_used_at: number | null }>>([]);
const newTokenName = ref('');
const creatingToken = ref(false);
const freshToken = ref('');
const cliApproveCode = ref(new URLSearchParams(location.search).get('code') ?? '');
async function loadTokens(): Promise<void> {
  try {
    const r = await fetch('/api/auth/tokens');
    if (r.ok) tokens.value = await r.json();
  } catch { /* panel degrades silently */ }
}
async function createToken(): Promise<void> {
  creatingToken.value = true;
  freshToken.value = '';
  try {
    const r = await fetch('/api/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: newTokenName.value.trim() }) });
    const b = (await r.json()) as { token?: string; error?: string };
    if (b.token) { freshToken.value = b.token; newTokenName.value = ''; await loadTokens(); }
  } finally { creatingToken.value = false; }
}
function copyFreshToken(): void { void navigator.clipboard?.writeText(freshToken.value); }
async function revokeToken(id: string): Promise<void> {
  if (!window.confirm('revoke this token? the CLI using it will fail auth')) return;
  await fetch(`/api/auth/tokens/${id}`, { method: 'DELETE' });
  await loadTokens();
}
async function approveCli(): Promise<void> {
  const r = await fetch('/api/auth/cli/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: cliApproveCode.value }) });
  if (r.ok) cliApproveCode.value = '';
}
const isAdmin = computed(() => me.value?.role === 'admin');
interface ActRun { id: string; ticket_key: string | null; kind: string; status: string; started_at: number; finished_at: number | null }
interface ActManual { id: string; udid: string; run_id: string | null; operator: string; started_at: number; finished_at: number | null }
interface ActLogin { at: number; event: string; detail: string | null }
const myRuns = ref<ActRun[]>([]);
const myManual = ref<ActManual[]>([]);
const myLogins = ref<ActLogin[]>([]);
async function loadSelf(): Promise<void> {
  try {
    const r = await fetch('/api/me/activity');
    if (!r.ok) return;
    const b = await r.json() as { me: Me; runs: ActRun[]; manual: ActManual[]; logins: ActLogin[] };
    me.value = b.me; myRuns.value = b.runs ?? []; myManual.value = b.manual ?? []; myLogins.value = b.logins ?? [];
  } catch { /* best effort */ }
}

interface U { id: string; email: string; name: string; role: string; auth_source: string; active: boolean; approved: boolean; last_login_at: number | null }
const users = ref<U[]>([]);
const pendingCount = computed(() => users.value.filter((u) => !u.approved).length);
const err = ref('');
const msg = ref('');
const form = ref({ email: '', name: '', role: 'operator', password: '' });
const creating = ref(false);

async function load(): Promise<void> {
  await loadSelf();
  if (!isAdmin.value) return; // non-admin: self view only, no user list
  const r = await fetch('/api/users');
  if (r.status === 403) { err.value = 'admin role required'; return; }
  const b = await r.json() as { users: U[] };
  users.value = b.users ?? [];
}

async function create(): Promise<void> {
  err.value = ''; msg.value = '';
  const r = await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form.value) });
  const b = await r.json() as { error?: string };
  if (!r.ok) { err.value = b.error ?? 'create failed'; return; }
  msg.value = `${form.value.email} provisioned as ${form.value.role}`;
  form.value = { email: '', name: '', role: 'operator', password: '' };
  await load();
}

async function patch(id: string, body: Record<string, unknown>, note: string): Promise<void> {
  err.value = ''; msg.value = '';
  const r = await fetch(`/api/users/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const b = await r.json() as { error?: string };
  if (!r.ok) { err.value = b.error ?? 'update failed'; return; }
  msg.value = note;
  await load();
}

function resetPassword(u: U): void {
  // admin sets a new password via prompt — internal tool, no email flows
  const pw = window.prompt(`new password for ${u.email} (min 8 chars)`);
  if (pw && pw.length >= 8) void patch(u.id, { password: pw }, `password reset — ${u.email} must sign in again`);
  else if (pw !== null) err.value = 'password too short (min 8)';
}

const when = (t: number | null): string => t ? new Date(t).toLocaleString() : 'never';

// sessions + auth log (admin)
interface Sess { id: string; name: string; email: string; created_at: number; expires_at: number; last_seen_at: number }
const sessions = ref<Sess[]>([]);
interface LogRow { at: number; email: string | null; event: string; detail: string | null }
const log = ref<LogRow[]>([]);
async function loadAccess(): Promise<void> {
  try {
    const [s1, l1] = await Promise.all([fetch('/api/sessions'), fetch('/api/auth/log')]);
    if (s1.ok) sessions.value = ((await s1.json()) as { sessions: Sess[] }).sessions ?? [];
    if (l1.ok) log.value = ((await l1.json()) as { log: LogRow[] }).log ?? [];
  } catch { /* best effort */ }
}
async function approve(id: string, on: boolean): Promise<void> {
  await fetch(`/api/users/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved: on }) });
  await load();
  await loadAccess();
}

async function killSession(id: string): Promise<void> {
  await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  await loadAccess();
}
onMounted(() => {
  void loadTokens(); if (isAdmin.value) void loadAccess(); });

onMounted(() => void load());
</script>

<template>
  <div>
    <PageHeader :title="isAdmin ? 'users' : 'your activity'">
      <span class="ph-desc">{{ isAdmin ? 'provisioned accounts · roles gate what a person can touch' : `${me?.name ?? ''} · ${me?.email ?? ''}` }}</span>
      <template #actions>
        <span class="badge">{{ me?.role ?? '…' }}</span>
      </template>
    </PageHeader>

    <!-- non-admin self view -->
    <div v-if="me && !isAdmin" style="display: flex; flex-direction: column; gap: var(--s-3);">
      <div class="section-label"><span>your runs</span></div>
      <div class="card table-wrap" style="padding: 0;">
        <table v-if="myRuns.length">
          <thead><tr><th>run</th><th>ticket</th><th>kind</th><th>status</th><th>started</th></tr></thead>
          <tbody>
            <tr v-for="r in myRuns" :key="r.id">
              <td><RouterLink :to="`/runs/${r.id}`" style="font-family: monospace;">{{ r.id.slice(0, 10) }}</RouterLink></td>
              <td>{{ r.ticket_key ?? '—' }}</td>
              <td>{{ r.kind }}</td>
              <td>{{ r.status }}</td>
              <td style="font-size: 10px; color: var(--color-steel);">{{ when(r.started_at) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="meta-row" style="padding: var(--s-3);">no runs yet</div>
      </div>

      <div class="section-label"><span>your manual sessions</span></div>
      <div class="card table-wrap" style="padding: 0;">
        <table v-if="myManual.length">
          <thead><tr><th>session</th><th>device</th><th>app</th><th>started</th><th>ended</th></tr></thead>
          <tbody>
            <tr v-for="m in myManual" :key="m.id">
              <td style="font-family: monospace;">{{ m.id.slice(0, 10) }}</td>
              <td style="font-family: monospace;">{{ m.udid.slice(0, 12) }}</td>
              <td><RouterLink v-if="m.run_id" :to="`/runs/${m.run_id}`" style="font-family: monospace;">{{ m.run_id.slice(0, 10) }}</RouterLink><span v-else>—</span></td>
              <td style="font-size: 10px; color: var(--color-steel);">{{ when(m.started_at) }}</td>
              <td style="font-size: 10px; color: var(--color-steel);">{{ m.finished_at ? when(m.finished_at) : 'live' }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="meta-row" style="padding: var(--s-3);">no manual sessions yet</div>
      </div>

      <div class="section-label"><span>your sign-in history</span></div>
      <div class="card table-wrap" style="padding: 0;">
        <table v-if="myLogins.length">
          <thead><tr><th>when</th><th>event</th><th>detail</th></tr></thead>
          <tbody>
            <tr v-for="(l, i) in myLogins" :key="i">
              <td style="font-size: 10px; color: var(--color-steel);">{{ when(l.at) }}</td>
              <td><span class="badge">{{ l.event }}</span></td>
              <td style="font-size: 10px; color: var(--color-steel);">{{ l.detail ?? '' }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="meta-row" style="padding: var(--s-3);">no sign-in history</div>
      </div>
    </div>

    <div v-if="err" class="meta-row" style="color: var(--color-ember); margin-bottom: 10px;">{{ err }}</div>
    <div v-if="msg" class="meta-row" style="color: var(--color-fog); margin-bottom: 10px;">{{ msg }}</div>

        <!-- API tokens (CLI auth — plan 20260930T092035Z): create/revoke lion_ PATs.
         Plaintext shown ONCE at creation. Also approves CLI login codes. -->
    <div class="section-label" style="margin-top: var(--s-4);"><span>api tokens · cli access</span></div>
    <div class="card" style="padding: var(--s-3); display: flex; flex-direction: column; gap: var(--s-2);">
      <div style="display: flex; gap: var(--s-2); align-items: center;">
        <input v-model="newTokenName" placeholder="token name (e.g. laptop, ci)" class="tok-name">
        <button class="btn btn-sm" :disabled="creatingToken || !newTokenName.trim()" @click="createToken">{{ creatingToken ? 'creating…' : 'create token' }}</button>
      </div>
      <div v-if="freshToken" class="tok-fresh">
        <span>copy now — shown once:</span>
        <code>{{ freshToken }}</code>
        <button class="btn btn-sm" @click="copyFreshToken">copy</button>
      </div>
      <table v-if="tokens.length" style="width: 100%;">
        <thead><tr><th>name</th><th>created</th><th>last used</th><th></th></tr></thead>
        <tbody>
          <tr v-for="t in tokens" :key="t.id">
            <td>{{ t.name }}</td>
            <td style="font-size: 10px; color: var(--color-steel);">{{ when(t.created_at) }}</td>
            <td style="font-size: 10px; color: var(--color-steel);">{{ t.last_used_at ? when(t.last_used_at) : 'never' }}</td>
            <td style="text-align: right;"><button class="btn btn-sm btn-danger" @click="revokeToken(t.id)">revoke</button></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="meta-row">no tokens — the CLI's `lionidas auth login` will ask you to approve a code here</div>
      <div v-if="cliApproveCode" class="tok-fresh" style="border-color: var(--color-ember);">
        <span>CLI login request:</span>
        <code>{{ cliApproveCode }}</code>
        <button class="btn btn-sm btn-primary" @click="approveCli">approve</button>
        <button class="btn btn-sm" @click="cliApproveCode = ''">dismiss</button>
      </div>
    </div>

    <template v-if="isAdmin">
    <div class="card" style="padding: var(--s-3); margin-bottom: var(--s-3);">
      <div class="section-label" style="margin-bottom: var(--s-2);">provision a user</div>
      <div style="display: flex; gap: var(--s-2); flex-wrap: wrap; align-items: center;">
        <input v-model="form.email" type="email" placeholder="email" style="min-width: 200px;" />
        <input v-model="form.name" placeholder="display name" style="min-width: 140px;" />
        <select v-model="form.role">
          <option value="viewer">viewer</option>
          <option value="operator">operator</option>
          <option value="admin">admin</option>
        </select>
        <input v-model="form.password" type="password" placeholder="starting password (min 8)" style="min-width: 180px;" />
        <button class="btn btn-primary btn-sm" :disabled="creating || !form.email || !form.name || form.password.length < 8" @click="creating = true; create().finally(() => { creating = false; })">create</button>
      </div>
    </div>

    <div class="card table-wrap" style="padding: 0;">
      <table>
        <thead>
          <tr>
            <th>user</th><th>role</th><th>source</th><th>status</th><th>last login</th><th style="text-align: right;">actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id" :style="{ opacity: u.active ? 1 : 0.5 }">
            <td>
              <div style="color: var(--color-paper);">{{ u.name }}</div>
              <div style="font-size: 10px; color: var(--color-steel);">{{ u.email }}</div>
            </td>
            <td>
              <select :value="u.role" :disabled="u.role === 'bot'" @change="patch(u.id, { role: ($event.target as HTMLSelectElement).value }, `role updated — ${u.email}`)">
                <option value="viewer">viewer</option>
                <option value="operator">operator</option>
                <option value="admin">admin</option>
                <option value="bot" disabled>bot</option>
              </select>
            </td>
            <td><span class="badge">{{ u.auth_source }}</span></td>
            <td>
                <span v-if="!u.approved" class="badge" style="color: var(--color-ember);">pending approval</span>
                <span v-else>{{ u.active ? 'active' : 'deactivated' }}</span>
              </td>
            <td style="font-size: 10px; color: var(--color-steel);">{{ when(u.last_login_at) }}</td>
            <td style="text-align: right; white-space: nowrap;">
              <template v-if="u.role !== 'bot'">
                <button v-if="!u.approved" class="btn btn-sm btn-primary" @click="approve(u.id, true)">approve</button>
                <button v-else-if="u.auth_source === 'jira'" class="btn btn-sm" :style="{ marginLeft: '6px' }" @click="approve(u.id, false)">revoke</button>
                <button class="btn btn-sm" :style="{ marginLeft: u.approved && u.auth_source !== 'jira' ? '0' : '6px' }" @click="resetPassword(u)">reset pw</button>
                <button class="btn btn-sm" :style="{ marginLeft: '6px' }" @click="patch(u.id, { active: !u.active }, u.active ? `deactivated — ${u.email}` : `reactivated — ${u.email}`)">
                  {{ u.active ? 'deactivate' : 'reactivate' }}
                </button>
              </template>
              <span v-else style="font-size: 9px; color: var(--color-steel);">pipeline</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    </template>

    <template v-if="isAdmin">
    <div class="section-label" style="margin-top: var(--s-4);"><span>active sessions</span></div>
    <div class="card table-wrap" style="padding: 0;" v-if="sessions.length > 0">
      <table>
        <thead><tr><th>user</th><th>last seen</th><th>expires</th><th style="text-align: right;"></th></tr></thead>
        <tbody>
          <tr v-for="s in sessions" :key="s.id">
            <td>{{ s.name }} <small style="color: var(--color-steel);">{{ s.email }}</small></td>
            <td style="font-size: 10px; color: var(--color-steel);">{{ when(s.last_seen_at) }}</td>
            <td style="font-size: 10px; color: var(--color-steel);">{{ new Date(s.expires_at).toLocaleTimeString() }}</td>
            <td style="text-align: right;"><button class="btn btn-sm btn-danger" @click="killSession(s.id)">kill</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="section-label" style="margin-top: var(--s-4);"><span>auth log</span></div>
    <div class="card table-wrap" style="padding: 0;" v-if="log.length > 0">
      <table>
        <thead><tr><th>when</th><th>who</th><th>event</th><th>detail</th></tr></thead>
        <tbody>
          <tr v-for="(l, i) in log.slice(0, 30)" :key="i">
            <td style="font-size: 10px; color: var(--color-steel);">{{ new Date(l.at).toLocaleString() }}</td>
            <td>{{ l.email ?? '—' }}</td>
            <td><span class="badge" :style="l.event === 'login_failed' ? 'color: var(--color-ember);' : ''">{{ l.event }}</span></td>
            <td style="font-size: 10px; color: var(--color-steel);">{{ l.detail ?? '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    </template>
  </div>
</template>

<style scoped>
.tok-name { flex: 1; background: var(--color-void); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 6px var(--s-2); }
.tok-fresh { display: flex; align-items: center; gap: var(--s-2); border: 1px dashed var(--color-ember); border-radius: var(--r-sm); padding: var(--s-2) var(--s-3); font-size: var(--text-caption); }
.tok-fresh code { font-family: var(--font-mono); color: var(--color-paper); overflow-wrap: anywhere; }
</style>
