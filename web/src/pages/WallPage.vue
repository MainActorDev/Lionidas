<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useSessionStore } from '../stores/session.ts';

const session = useSessionStore();
const health = ref<{ version: string; uptimeMs: number } | null>(null);

onMounted(async () => {
  await session.ping();
  if (session.serverOk) {
    try {
      const res = await fetch('/api/health');
      health.value = await res.json();
    } catch { /* serverOk already false-pathed */ }
  }
});
</script>

<template>
  <main class="wall">
    <header class="wall-head">
      <h1>Crucible</h1>
      <span class="mono" v-if="health">server {{ health.version }} · up {{ Math.round(health.uptimeMs / 1000) }}s</span>
      <span v-else-if="session.serverOk === false" class="down">server unreachable — start it: pnpm dev</span>
    </header>

    <!-- M0 placeholder — M1 renders real device tiles here -->
    <section class="tiles">
      <article class="tile empty-state">
        <strong>No devices yet</strong>
        <p>M1 connects Alloy: live simulator tiles, lease badges, run status.</p>
      </article>
    </section>
  </main>
</template>

<style scoped>
.wall { padding: var(--s6); height: 100%; }
.wall-head { display: flex; align-items: baseline; gap: var(--s3); margin-bottom: var(--s6); }
.wall-head h1 { font-size: var(--text-base); font-weight: 600; margin: 0; }
.down { color: var(--fail); font-size: var(--text-sm); }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--s3); }
.tile {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: var(--s4);
}
.empty-state strong { display: block; margin-bottom: var(--s1); }
.empty-state p { margin: 0; color: var(--fg-dim); font-size: var(--text-sm); }
</style>
