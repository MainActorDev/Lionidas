<script setup lang="ts">
/** AppNav — the ONE nav source (Phase 2 Task 2): rendered by the desktop
 *  sidebar <aside> and the mobile shadcn Sheet alike. RBAC visibility lives
 *  in App.vue (visibleGroups) and arrives as a prop — this component only
 *  renders groups/links and manages group collapse state. */
import { reactive, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { Component } from 'vue';

interface NavEntry { to: string; label: string; names: string[]; adminOnly?: boolean; supervisorOnly?: boolean; operatorOnly?: boolean }
interface NavGroup { id: string; label: string; items: NavEntry[] }

const props = defineProps<{ groups: NavGroup[] }>();

const route = useRoute();
const isActive = (name: string): boolean => route.name === name;
const groupHasActive = (g: NavGroup): boolean => g.items.some(it => it.names.some(isActive));

const collapsed = reactive<Record<string, boolean>>({});
const toggleGroup = (id: string): void => { collapsed[id] = !collapsed[id]; };
// navigating into a collapsed group expands it (active page must stay visible)
watch(() => route.name, () => {
  for (const g of props.groups) if (groupHasActive(g)) collapsed[g.id] = false;
}, { immediate: true });
</script>

<template>
  <nav v-for="g in groups" :key="g.id" class="nav-grp" :class="{ closed: collapsed[g.id] }" :aria-label="g.label">
    <button type="button" class="nav-grp-head" :class="{ on: groupHasActive(g) }" :aria-expanded="!collapsed[g.id]" @click="toggleGroup(g.id)">
      <span class="caret" aria-hidden="true">▾</span>{{ g.label }}
    </button>
    <div v-show="!collapsed[g.id]" class="nav-grp-kids">
      <RouterLink
        v-for="it in g.items" :key="it.to" :to="it.to" class="nav-item"
        :class="{ active: it.names.some(isActive) }"
      >{{ it.label }}</RouterLink>
    </div>
  </nav>
  <!-- guide hidden for now (user, 2026-10-08) — re-enable by uncommenting -->
  <!-- <RouterLink to="/guide" class="nav-item nav-guide" :class="{ active: isActive('guide') }">guide</RouterLink> -->
</template>
