<script setup lang="ts">
/** SideDrawer — left slide-over (sketch .drawer). Content v-if'd (absent from
 *  DOM when closed); reduced-motion honored; close via ✕ or the close event. */
defineProps<{ open: boolean; title: string; width?: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
  <div v-if="open" class="drawer" :style="width ? { width } : undefined">
    <h3><span>{{ title }}</span><button class="x" aria-label="close" @click="emit('close')">✕</button></h3>
    <div class="body"><slot /></div>
  </div>
</template>

<style scoped>
.drawer { position: absolute; inset: 0 auto 0 0; width: 264px; background: var(--color-carbon); border-right: 1px solid var(--color-slate); z-index: 25; display: flex; flex-direction: column; animation: slide 160ms ease; }
@keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(0); } }
@media (prefers-reduced-motion: reduce) { .drawer { animation: none; } }
.drawer h3 { font-size: var(--text-caption); text-transform: uppercase; letter-spacing: .08em; color: var(--color-ash); padding: var(--s-3); border-bottom: 1px solid var(--color-iron); display: flex; justify-content: space-between; align-items: center; }
.x { background: none; border: 1px solid var(--color-iron); color: var(--color-fog); border-radius: var(--r); cursor: pointer; font-size: var(--text-caption); padding: 0 6px; }
.x:hover { border-color: var(--color-slate); color: var(--color-paper); }
.body { padding: var(--s-3); overflow-y: auto; flex: 1; }
</style>
