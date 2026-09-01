<script setup lang="ts">
import { computed } from 'vue';
import CmdPalette from './components/CmdPalette.vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const title = computed(() => (route.meta.title as string | undefined) ?? 'crucible');
const isActive = (name: string): boolean => route.name === name;
</script>

<template>
  <div class="app">
    <div class="logo"><span class="logo-mark" /> crucible</div>

    <nav class="sidebar">
      <div class="nav-group">
        <div class="nav-group-label">testing</div>
        <RouterLink to="/" class="nav-item" :class="{ active: isActive('suite') }">suite</RouterLink>
        <RouterLink to="/devices" class="nav-item" :class="{ active: isActive('wall') }">devices</RouterLink>
        <RouterLink to="/runs" class="nav-item" :class="{ active: isActive('runs') || isActive('runDetail') }">runs</RouterLink>
      </div>
      <div class="nav-group">
        <div class="nav-group-label">quality</div>
        <RouterLink to="/baselines" class="nav-item" :class="{ active: isActive('baselines') }">approvals</RouterLink>
        <RouterLink to="/flakes" class="nav-item" :class="{ active: isActive('flakes') }">flaky tests</RouterLink>
        <RouterLink to="/templates" class="nav-item" :class="{ active: isActive('templates') }">test cases</RouterLink>
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
      <span class="topbar-title">{{ title }}</span>
      <span class="topbar-spacer" />
      <span class="badge" style="border: none; color: var(--color-steel);">⌘K</span>
    </div>

    <main class="main">
      <router-view />
    </main>
    <CmdPalette />
  </div>
</template>
