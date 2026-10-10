<script setup lang="ts">
import { computed } from 'vue';
import CmdPalette from './components/CmdPalette.vue';
import { ref, onMounted, reactive, provide } from 'vue';

const me = ref<{ name: string; role: string } | null>(null);
/** RBAC (plan 20261009T102032Z T5): server-computed capability map — the
 *  web NEVER re-derives role logic; it renders what the server says. */
const caps = ref<Record<string, boolean> | null>(null);
async function loadMe(): Promise<void> {
  try {
    const r = await fetch('/api/auth/me');
    const b = await r.json() as { user: { name: string; role: string } | null };
    me.value = b.user;
    const c = await fetch('/api/me/capabilities');
    if (c.ok) caps.value = ((await c.json()) as { capabilities: Record<string, boolean> }).capabilities;
    else caps.value = null;
  } catch { me.value = null; caps.value = null; }
}
provide('caps', caps);
async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
  await router.push('/login');
  me.value = null;
}
onMounted(() => void loadMe());
import { useRoute, useRouter } from 'vue-router';
import { watch } from 'vue';

const route = useRoute();
const router = useRouter();
const isActive = (name: string): boolean => route.name === name;
const isPublic = computed(() => route.meta.public === true);
// fullscreen pages render outside the app shell (own chrome) but stay auth-guarded
const isBare = computed(() => isPublic.value || route.meta.fullscreen === true);
// cheap re-check on route change (login/out navigations refresh the chip)
watch(() => route.fullPath, () => void loadMe());

// ── collapsible nav groups (025-A) ──
interface NavEntry { to: string; label: string; names: string[]; adminOnly?: boolean; supervisorOnly?: boolean; operatorOnly?: boolean }
interface NavGroup { id: string; label: string; items: NavEntry[] }
const navGroups: NavGroup[] = [
  {
    id: 'testing', label: 'testing',
    items: [
      { to: '/', label: 'overview', names: ['overview'] },
      { to: '/suites', label: 'suites', names: ['suites'] },
      { to: '/devices', label: 'devices', names: ['wall'] },
      { to: '/runs', label: 'runs', names: ['runs', 'runDetail'] },
    ],
  },
  {
    id: 'ci', label: 'ci',
    items: [
      { to: '/projects', label: 'projects', names: ['projects'], adminOnly: true },
      { to: '/builds', label: 'builds', names: ['builds'], adminOnly: true },
    ],
  },
  {
    id: 'agent', label: 'agent',
    items: [
      { to: '/agent', label: 'chat', names: ['agentChat'], operatorOnly: true }, // operator+ (the server gates /api/agent/*)
    ],
  },
  {
    id: 'library', label: 'library',
    items: [
      { to: '/templates', label: 'test cases', names: ['templates'] },
      { to: '/screens', label: 'screens', names: ['screens'] },
      { to: '/env', label: 'env', names: ['env'] },
      { to: '/forge', label: 'network', names: ['forge'] },
    ],
  },
  {
    id: 'settings', label: 'settings',
    items: [
      { to: '/users', label: 'users', names: ['users'], supervisorOnly: true }, // supervisor+ (directory + account mgmt)
      { to: '/audit', label: 'audit log', names: ['audit'], supervisorOnly: true },
      { to: '/settings', label: 'configs', names: ['settings'], adminOnly: true },
    ],
  },
];
const collapsed = reactive<Record<string, boolean>>({});
const toggleGroup = (id: string): void => { collapsed[id] = !collapsed[id]; };
const groupHasActive = (g: NavGroup): boolean =>
  g.items.some(it => it.names.some(isActive));
// adminOnly items render for admins only (the route itself stays auth-guarded,
// the API enforces the role); groups that empty out hide entirely
const visibleGroups = computed<NavGroup[]>(() => {
  // RBAC (plan 20261009T102032Z T5): admin sees all; supervisor gains
  // supervisorOnly entries (users, audit); others keep adminOnly hidden.
  // Capability-driven: readUsers covers users/audit visibility.
  const isSupervisor = caps.value?.readUsers === true || me.value?.role === 'admin';
  return navGroups
    .map(g => ({ ...g, items: g.items.filter(it => {
      if (it.adminOnly) return me.value?.role === 'admin';
      if (it.supervisorOnly) return isSupervisor;
      if (it.operatorOnly) return ['admin', 'supervisor', 'operator'].includes(me.value?.role ?? '');
      return true;
    }) }))
    .filter(g => g.items.length > 0);
});
// navigating into a collapsed group expands it (active page must stay visible)
watch(() => route.name, () => {
  for (const g of navGroups) if (groupHasActive(g)) collapsed[g.id] = false;
}, { immediate: true });
</script>

<template>
  <!-- public routes (login) own the full viewport — no app chrome -->
  <router-view v-if="isBare" />
  <div v-else class="app">
    <div class="logo"><img class="logo-mark" src="/icons/lionidas-app-128.png" alt="" width="20" height="20" /> lionidas</div>

    <nav class="sidebar" aria-label="primary">
      <div v-for="g in visibleGroups" :key="g.id" class="nav-grp" :class="{ closed: collapsed[g.id] }">
        <button type="button" class="nav-grp-head" :class="{ on: groupHasActive(g) }" :aria-expanded="!collapsed[g.id]" @click="toggleGroup(g.id)">
          <span class="caret">▾</span>{{ g.label }}
        </button>
        <div v-show="!collapsed[g.id]" class="nav-grp-kids">
          <RouterLink
            v-for="it in g.items" :key="it.to" :to="it.to" class="nav-item"
            :class="{ active: it.names.some(isActive) }"
          >{{ it.label }}</RouterLink>
        </div>
      </div>
      <!-- guide hidden for now (user, 2026-10-08) — re-enable by uncommenting -->
      <!-- <RouterLink to="/guide" class="nav-item nav-guide" :class="{ active: isActive('guide') }">guide</RouterLink> -->
    </nav>

    <div class="topbar">
      <span class="topbar-spacer" />
      <span v-if="me" class="topbar-user" title="signed in">
        <span class="dot"></span>{{ me.name }} · {{ me.role }}
        <button class="btn btn-sm" style="margin-left: 8px;" @click="signOut">sign out</button>
      </span>
      <RouterLink v-else to="/login" class="btn btn-sm" style="text-decoration: none;">sign in</RouterLink>
      <span class="badge" style="border: none; color: var(--color-steel);">⌘K</span>
    </div>

    <main class="main">
      <router-view />
    </main>
    <CmdPalette />
  </div>
</template>
