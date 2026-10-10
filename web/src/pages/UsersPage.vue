<script setup lang="ts">
/** Users — role-grouped directory (sketch 031 a2, user decisions 2026-10-10).
 *  Supervisor = admin on the users domain EXCEPT the admin role: highest
 *  assignable is supervisor, admin rows are locked (re-role/delete refused
 *  server-side too). Below supervisor: self view + API tokens. */
import PageHeader from '../components/PageHeader.vue';
import { computed, ref, onMounted } from 'vue';

interface Me { id: string; name: string; email: string; role: string; auth_source: string }
const me = ref<Me | null>(null);
const isAdmin = computed(() => me.value?.role === 'admin');
const isDirectory = computed(() => me.value?.role === 'admin' || me.value?.role === 'supervisor');

// ── self view (below supervisor) + tokens (all roles — account-level) ──
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

// ── directory (supervisor+) ──
interface U { id: string; email: string; name: string; role: string; auth_source: string; active: boolean; approved: boolean; last_login_at: number | null }
const users = ref<U[]>([]);
const err = ref('');
const msg = ref('');
const showForm = ref(false);
const tab = ref<'directory' | 'sessions' | 'log' | 'tokens'>('directory'); // segmented switch — one table at a time
const form = ref({ email: '', name: '', role: 'operator', password: '' });
const creating = ref(false);

// role order + digests (from the rbac matrix, capabilities.ts)
const ROLE_ORDER = ['admin', 'supervisor', 'operator', 'viewer', 'bot'] as const;
const CAPS: Record<string, string> = {
  admin: 'everything · roles · settings · audit',
  supervisor: 'drive · author · any-abort · accounts · audit',
  operator: 'drive · author · own-abort',
  viewer: 'read-only',
  bot: 'engine identity — tokens',
};
const groups = computed(() => ROLE_ORDER
  .map((role) => ({ role, members: users.value.filter((u) => u.role === role) }))
  .filter((g) => g.members.length > 0));
const collapsed = ref(new Set<string>(['bot']));
function toggleGroup(role: string): void {
  const next = new Set(collapsed.value);
  if (next.has(role)) next.delete(role); else next.add(role);
  collapsed.value = next;
}

// the cap: supervisor cannot assign admin, cannot touch admin rows
const canAssignAdmin = computed(() => isAdmin.value);
const assignableRoles = computed(() => canAssignAdmin.value ? ['viewer', 'operator', 'supervisor', 'admin'] : ['viewer', 'operator', 'supervisor']);
const rowLocked = (u: U): boolean => !isAdmin.value && u.role === 'admin';

async function load(): Promise<void> {
  await loadSelf();
  if (!isDirectory.value) return; // below supervisor: self + tokens only
  const r = await fetch('/api/users');
  if (r.status === 403) { err.value = 'directory requires supervisor role'; return; }
  const b = await r.json() as { users: U[] };
  users.value = b.users ?? [];
}

async function create(): Promise<void> {
  err.value = ''; msg.value = '';
  const r = await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form.value) });
  const b = (await r.json()) as { error?: string };
  if (!r.ok) { err.value = b.error ?? 'create failed'; return; }
  msg.value = `${form.value.email} provisioned as ${form.value.role}`;
  form.value = { email: '', name: '', role: 'operator', password: '' };
  await load();
}

async function patch(id: string, body: Record<string, unknown>, note: string): Promise<void> {
  err.value = ''; msg.value = '';
  const r = await fetch(`/api/users/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const b = (await r.json()) as { error?: string };
  if (!r.ok) { err.value = b.error ?? 'update failed'; return; }
  msg.value = note;
  await load();
}

async function removeUser(u: U): Promise<void> {
  if (!window.confirm(`delete ${u.email}? sessions and device pins are removed too`)) return;
  err.value = ''; msg.value = '';
  const r = await fetch(`/api/users/${u.id}`, { method: 'DELETE' });
  const b = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) { err.value = b.error ?? 'delete failed'; return; }
  msg.value = `deleted — ${u.email}`;
  await load();
}

function resetPassword(u: U): void {
  // internal tool, no email flows — new password via prompt
  const pw = window.prompt(`new password for ${u.email} (min 8 chars)`);
  if (pw && pw.length >= 8) void patch(u.id, { password: pw }, `password reset — ${u.email} must sign in again`);
  else if (pw !== null) err.value = 'password too short (min 8)';
}

const when = (t: number | null): string => t ? new Date(t).toLocaleString() : 'never';

// sessions + auth log (supervisor+ — audit capability)
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
  void loadTokens();
});
onMounted(() => {
  void load().then(() => {
    if (isDirectory.value) void loadAccess();
    else tab.value = 'tokens'; // below supervisor: tokens is the only table
  });
});
</script>

<template>
  <div>
    <PageHeader :title="isDirectory ? 'users' : 'your activity'">
      <span class="ph-desc">{{ isDirectory ? 'directory by role · capabilities from the rbac matrix' : `${me?.name ?? ''} · ${me?.email ?? ''}` }}</span>
      <template #actions>
        <span class="badge">{{ me?.role ?? '…' }}</span>
        <button v-if="isDirectory" class="btn btn-primary btn-sm" @click="showForm = !showForm">create user</button>
      </template>
    </PageHeader>

    <!-- provision form: hidden until the header button (sketch 031 a2) -->
    <div v-if="isDirectory && showForm" class="card prov">
      <input v-model="form.email" type="email" placeholder="email" style="min-width: 200px;">
      <input v-model="form.name" placeholder="display name" style="min-width: 140px;">
      <select v-model="form.role">
        <option v-for="r in assignableRoles" :key="r" :value="r">{{ r }}</option>
      </select>
      <input v-model="form.password" type="password" placeholder="starting password (min 8)" style="min-width: 180px;">
      <button class="btn btn-primary btn-sm" :disabled="creating || !form.email || !form.name || form.password.length < 8" @click="creating = true; create().finally(() => { creating = false; })">create</button>
      <button class="btn btn-sm" style="margin-left: auto;" title="close" @click="showForm = false">✕</button>
    </div>

    <!-- segmented switch between the tables (sketch 031 a2 follow-up).
         Below supervisor: tokens only — the tab strip still lands them in one place. -->
    <div class="a2-tabs" style="margin-bottom: var(--s-3);">
      <button v-if="isDirectory" class="a2-tab" :class="{ on: tab === 'directory' }" @click="tab = 'directory'">directory <span class="n">{{ users.length }}</span></button>
      <button v-if="isDirectory" class="a2-tab" :class="{ on: tab === 'sessions' }" @click="tab = 'sessions'">sessions <span class="n">{{ sessions.length }}</span></button>
      <button v-if="isDirectory" class="a2-tab" :class="{ on: tab === 'log' }" @click="tab = 'log'">auth log <span class="n">{{ log.length }}</span></button>
      <button class="a2-tab" :class="{ on: tab === 'tokens' }" @click="tab = 'tokens'">api tokens <span class="n">{{ tokens.length }}</span></button>
    </div>

    <div v-if="err" class="meta-row" style="color: var(--color-ember); margin-bottom: 10px;">{{ err }}</div>
    <div v-if="msg" class="meta-row" style="color: var(--color-fog); margin-bottom: 10px;">{{ msg }}</div>

    <!-- role-grouped directory (sketch 031 a2): the house div-list anatomy
         (screens/cases pattern) — sticky GRID thead, plain-div group heads,
         rows share the same column template. No <table>: group heads and
         rows are siblings in one scroll box. -->
    <div v-if="isDirectory && tab === 'directory'" class="a2-list" style="margin-bottom: var(--s-4);">
      <div class="u-thead">
        <span>user</span>
        <span>role</span>
        <span>source</span>
        <span>status</span>
        <span>last login</span>
        <span style="text-align: right;"></span>
      </div>
      <template v-for="g in groups" :key="g.role">
        <div class="a2-group-head" @click="toggleGroup(g.role)" :title="CAPS[g.role] ?? ''">
          <span class="caret">{{ collapsed.has(g.role) ? '▸' : '▾' }}</span>
          <span class="owner">{{ g.role }}</span>
          <span class="caps">{{ CAPS[g.role] ?? '' }}</span>
          <span class="health">
            <span v-if="g.members.filter(m => !m.active).length" class="dim">{{ g.members.filter(m => !m.active).length }} off</span>
            <span v-if="g.members.filter(m => !m.approved).length" class="warn">{{ g.members.filter(m => !m.approved).length }} pending</span>
          </span>
          <span class="n">{{ g.members.length }}</span>
        </div>
        <div v-for="u in g.members" v-show="!collapsed.has(g.role)" :key="u.id" class="u-row" :class="{ inactive: !u.active }">
          <span class="col-user">
            <span class="u-name">{{ u.name }}<span v-if="u.email === me?.email" class="you">you</span></span>
            <span class="u-email">{{ u.email }}</span>
          </span>
          <span>
            <span v-if="u.role === 'bot'" style="color: var(--color-fog);">bot</span>
            <span v-else-if="rowLocked(u)" class="admin-locked" title="admin accounts — role changes are admin-only">admin</span>
            <select v-else :value="u.role" @change="patch(u.id, { role: ($event.target as HTMLSelectElement).value }, `role updated — ${u.email}`)">
              <option v-for="r in assignableRoles" :key="r" :value="r">{{ r }}</option>
            </select>
          </span>
          <span><span class="badge">{{ u.auth_source }}</span></span>
          <span>
            <span v-if="!u.approved" class="status-pending">pending approval</span>
            <span v-else :style="u.active ? 'font-size: var(--text-caption);' : 'font-size: var(--text-caption); color: var(--color-steel);'">{{ u.active ? 'active' : 'deactivated' }}</span>
          </span>
          <span class="when">{{ when(u.last_login_at) }}</span>
          <span class="u-acts">
            <template v-if="u.role !== 'bot'">
              <button v-if="!u.approved" class="btn btn-sm btn-primary" @click="approve(u.id, true)">approve</button>
              <button class="btn btn-sm" @click="resetPassword(u)">reset pw</button>
              <button class="btn btn-sm" @click="patch(u.id, { active: !u.active }, u.active ? `deactivated — ${u.email}` : `reactivated — ${u.email}`)">{{ u.active ? 'deactivate' : 'reactivate' }}</button>
              <button class="btn btn-sm btn-danger" @click="removeUser(u)">delete</button>
            </template>
            <span v-else style="font-size: 9px; color: var(--color-steel);">tokens</span>
          </span>
        </div>
      </template>
    </div>

    <!-- self view (below supervisor) -->
    <div v-if="me && !isDirectory" style="display: flex; flex-direction: column; gap: var(--s-3);">
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
              <td class="when">{{ when(r.started_at) }}</td>
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
              <td class="when">{{ when(m.started_at) }}</td>
              <td class="when">{{ m.finished_at ? when(m.finished_at) : 'live' }}</td>
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
              <td class="when">{{ when(l.at) }}</td>
              <td><span class="badge">{{ l.event }}</span></td>
              <td class="when">{{ l.detail ?? '' }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="meta-row" style="padding: var(--s-3);">no sign-in history</div>
      </div>
    </div>

    <!-- API tokens (all roles — account-level; cli auth for lionidas) -->
    <div v-if="tab === 'tokens'" class="card" style="padding: var(--s-3); display: flex; flex-direction: column; gap: var(--s-2);">
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
            <td class="when">{{ when(t.created_at) }}</td>
            <td class="when">{{ t.last_used_at ? when(t.last_used_at) : 'never' }}</td>
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

    <template v-if="isDirectory">
      <div class="a2-list" v-if="tab === 'sessions' && sessions.length > 0">
        <table>
          <thead><tr><th>user</th><th>last seen</th><th>expires</th><th style="text-align: right;"></th></tr></thead>
          <tbody>
            <tr v-for="s in sessions" :key="s.id">
              <td>{{ s.name }} <small style="color: var(--color-steel);">{{ s.email }}</small></td>
              <td class="when">{{ when(s.last_seen_at) }}</td>
              <td class="when">{{ new Date(s.expires_at).toLocaleTimeString() }}</td>
              <td style="text-align: right;"><button class="btn btn-sm btn-danger" @click="killSession(s.id)">kill</button></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="a2-list" v-if="tab === 'log' && log.length > 0">
        <table>
          <thead><tr><th>when</th><th>who</th><th>event</th><th>detail</th></tr></thead>
          <tbody>
            <tr v-for="(l, i) in log.slice(0, 30)" :key="i">
              <td class="when">{{ when(l.at) }}</td>
              <td>{{ l.email ?? '—' }}</td>
              <td><span class="badge" :style="l.event === 'login_failed' ? 'color: var(--color-ember);' : ''">{{ l.event }}</span></td>
              <td class="when">{{ l.detail ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.prov { display: flex; gap: var(--s-2); flex-wrap: wrap; align-items: center; padding: var(--s-3); margin-bottom: var(--s-3); }
.u-name { color: var(--color-paper); }
.u-email { font-size: 10px; color: var(--color-steel); }
.you { color: var(--color-ember); font-size: 10px; margin-left: 6px; }
.when { font-size: 10px; color: var(--color-steel); white-space: nowrap; }
.status-pending { color: var(--color-ember); font-size: var(--text-caption); }
.admin-locked { color: var(--color-fog); cursor: default; }
.u-row.inactive { opacity: 0.45; }
/* directory grid (screens/cases anatomy): thead + rows share one template */
.u-thead, .u-row { display: grid; grid-template-columns: minmax(0, 1fr) 120px 80px 150px 130px 250px; gap: var(--s-2); align-items: center; padding: 6px 12px; }
.u-thead { position: sticky; top: 0; z-index: 1; background: var(--color-carbon); border-bottom: 1px solid var(--color-iron); font-size: var(--text-caption); text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-steel); }
.u-row { border-bottom: 1px solid var(--color-iron); font-size: var(--text-body); }
.u-row:hover { background: var(--color-graphite); }
.col-user { display: flex; flex-direction: column; min-width: 0; }
.u-acts { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
/* group head rides the GLOBAL .a2-group-head (components.css) — flex:
   caret + owner + caps (wraps, never ellipsizes) + health + n (auto-right) */
.a2-group-head .caps { color: var(--color-steel); font-size: 10px; letter-spacing: 0.02em; white-space: normal; line-height: 1.5; margin-right: var(--s-2); }
.a2-group-head .health { display: inline-flex; gap: var(--s-2); font-size: 10px; color: var(--color-steel); margin-right: var(--s-2); }
.a2-group-head .health .warn { color: var(--color-ember); }
.a2-group-head .health .dim { color: var(--color-ash); }
.tok-name { flex: 1; background: var(--color-void); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 6px var(--s-2); }
.tok-fresh { display: flex; align-items: center; gap: var(--s-2); border: 1px dashed var(--color-ember); border-radius: var(--r-sm); padding: var(--s-2) var(--s-3); font-size: var(--text-caption); }
.tok-fresh code { font-family: var(--font-mono); color: var(--color-paper); overflow-wrap: anywhere; }
</style>
