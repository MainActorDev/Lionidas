<script setup lang="ts">
/** Users (admin): provision local accounts, set roles, reset passwords, deactivate.
 *  Standardization: full .main width, content-sized table, shared primitives. */
import { computed, ref, onMounted } from 'vue';

interface U { id: string; email: string; name: string; role: string; auth_source: string; active: boolean; approved: boolean; last_login_at: number | null }
const users = ref<U[]>([]);
const pendingCount = computed(() => users.value.filter((u) => !u.approved).length);
const err = ref('');
const msg = ref('');
const form = ref({ email: '', name: '', role: 'operator', password: '' });
const creating = ref(false);

async function load(): Promise<void> {
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
onMounted(() => void loadAccess());

onMounted(() => void load());
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">users</div>
        <div class="page-desc">provisioned accounts · roles gate what a person can touch</div>
      </div>
      <span class="badge">admin</span>
    </div>

    <div v-if="err" class="meta-row" style="color: var(--color-ember); margin-bottom: 10px;">{{ err }}</div>
    <div v-if="msg" class="meta-row" style="color: var(--color-fog); margin-bottom: 10px;">{{ msg }}</div>

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
  </div>
</template>
