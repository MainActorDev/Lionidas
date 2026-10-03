<script setup lang="ts">
/** WatcherPanel — the REUSABLE tabbed rail container (operator: "side panel
 *  container should be reusable"). Tab strip + slot panes; the cockpit is
 *  consumer #1. Styling verbatim from the locked sketch (.railtabs/.rtab),
 *  tokens only, scoped — no globals (layout.css .app lesson). */
defineProps<{
  tabs: Array<{ id: string; label: string }>;
  active: string;
}>();
const emit = defineEmits<{ (e: 'switch', id: string): void }>();
</script>

<template>
  <div class="rail">
    <div class="railtabs">
      <div
        v-for="t in tabs" :key="t.id"
        class="rtab" :class="{ active: t.id === active }"
        role="tab" :aria-selected="t.id === active" tabindex="0"
        @click="emit('switch', t.id)"
        @keydown.enter="emit('switch', t.id)"
      >{{ t.label }}</div>
    </div>
    <div class="railbody">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.rail { background: var(--color-carbon); border-left: 1px solid var(--color-iron); display: flex; flex-direction: column; min-height: 0; }
.railtabs { display: flex; border-bottom: 1px solid var(--color-iron); }
.rtab { flex: 1; padding: 8px 0; text-align: center; font-size: var(--text-caption); color: var(--color-ash); cursor: pointer; border-bottom: 2px solid transparent; text-transform: uppercase; letter-spacing: .08em; }
.rtab:hover { color: var(--color-paper); }
.rtab.active { color: var(--color-paper); border-bottom-color: var(--color-ember); }
.rtab:focus-visible { outline: 1px solid var(--color-ember); outline-offset: -1px; }
.railbody { position: relative; flex: 1; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; }
</style>
