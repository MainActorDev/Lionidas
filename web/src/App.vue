<script setup lang="ts">
import { computed } from 'vue';
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
        <div class="nav-group-label">live</div>
        <RouterLink to="/" class="nav-item" :class="{ active: isActive('wall') }">wall</RouterLink>
        <RouterLink to="/runs" class="nav-item" :class="{ active: isActive('runs') || isActive('runDetail') }">runs</RouterLink>
      </div>
      <div class="nav-group">
        <div class="nav-group-label">diagnostics</div>
        <RouterLink to="/forge" class="nav-item" :class="{ active: isActive('forge') }">forge</RouterLink>
      </div>
      <div class="nav-group">
        <div class="nav-group-label">verify</div>
        <RouterLink to="/baselines" class="nav-item" :class="{ active: isActive('baselines') }">baselines</RouterLink>
        <RouterLink to="/flakes" class="nav-item" :class="{ active: isActive('flakes') }">flakes</RouterLink>
      </div>
    </nav>

    <div class="topbar">
      <span class="topbar-title">{{ title }}</span>
      <span class="topbar-spacer" />
    </div>

    <main class="main">
      <router-view />
    </main>
  </div>
</template>
