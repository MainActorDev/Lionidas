<script setup lang="ts">
import { computed } from 'vue';
import CmdPalette from './components/CmdPalette.vue';
import { ref, onMounted } from 'vue';

const me = ref<{ name: string; role: string } | null>(null);
async function loadMe(): Promise<void> {
  try {
    const r = await fetch('/api/auth/me');
    const b = await r.json() as { user: { name: string; role: string } | null };
    me.value = b.user;
  } catch { me.value = null; }
}
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
</script>

<template>
  <!-- public routes (login) own the full viewport — no app chrome -->
  <router-view v-if="isBare" />
  <div v-else class="app">
    <div class="logo"><img class="logo-mark" src="/icons/lionidas-app-128.png" alt="" width="20" height="20" /> lionidas</div>

    <nav class="sidebar">
      <div class="nav-group">
        <div class="nav-group-label">testing</div>
        <RouterLink to="/" class="nav-item" :class="{ active: isActive('overview') }">overview</RouterLink>
        <RouterLink to="/suites" class="nav-item" :class="{ active: isActive('suites') }">suites</RouterLink>
        <RouterLink to="/devices" class="nav-item" :class="{ active: isActive('wall') }">devices</RouterLink>
        <RouterLink to="/cockpit" class="nav-item" :class="{ active: isActive('cockpit') }">cockpit</RouterLink>
        <RouterLink to="/runs" class="nav-item" :class="{ active: isActive('runs') || isActive('runDetail') }">runs</RouterLink>
      </div>
      <div class="nav-group">
        <div class="nav-group-label">quality</div>
        <RouterLink to="/baselines" class="nav-item" :class="{ active: isActive('baselines') }">approvals</RouterLink>
        <RouterLink to="/flakes" class="nav-item" :class="{ active: isActive('flakes') }">flaky tests</RouterLink>
        <RouterLink to="/templates" class="nav-item" :class="{ active: isActive('templates') }">test cases</RouterLink>
        <RouterLink to="/screens" class="nav-item" :class="{ active: isActive('screens') }">screens</RouterLink>
        <RouterLink to="/env" class="nav-item" :class="{ active: isActive('env') }">env</RouterLink>
        <RouterLink to="/monitoring" class="nav-item" :class="{ active: isActive('monitoring') }">monitoring</RouterLink>
      </div>
      <div class="nav-group">
        <div class="nav-group-label">access</div>
        <RouterLink to="/users" class="nav-item" :class="{ active: isActive('users') }">users</RouterLink>
      </div>
      <div class="nav-group">
        <div class="nav-group-label">network</div>
        <RouterLink to="/forge" class="nav-item" :class="{ active: isActive('forge') }">network</RouterLink>
      </div>
      <div class="nav-group">
        <div class="nav-group-label">help</div>
        <RouterLink to="/guide" class="nav-item" :class="{ active: isActive('guide') }">guide</RouterLink>
      </div>
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
