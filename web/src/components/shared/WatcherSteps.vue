<script setup lang="ts">
/** WatcherSteps — step rows with ✓/◆/◌ states + optional meter (sketch .s/.meter).
 *  Symbols-not-colors: state is the symbol; ember marks live. */
defineProps<{
  steps: Array<{ text: string; state: 'done' | 'live' | 'todo' }>;
  meter?: { value: number; max: number; label?: string };
}>();
</script>

<template>
  <div class="steps">
    <div v-for="(s, i) in steps" :key="i" class="s" :class="s.state">{{ s.text }}</div>
    <div v-if="meter" class="meter">
      <span class="track"><span class="fill" :style="{ width: (100 * meter.value / Math.max(meter.max, 1)) + '%' }" /></span>
      <span>{{ meter.label ?? `${meter.value}/${meter.max}` }}</span>
    </div>
  </div>
</template>

<style scoped>
.steps { font-size: 11px; }
.s { display: flex; gap: 6px; padding: 2px 0; color: var(--color-ash); }
.s.done { color: var(--color-fog); }
.s.done::before { content: "✓"; color: var(--color-paper); }
.s.live { color: var(--color-ember); }
.s.live::before { content: "◆"; }
.s.todo::before { content: "◌"; }
.meter { display: flex; gap: 6px; align-items: center; font-size: 10px; color: var(--color-ash); margin-top: 4px; }
.meter .track { flex: 1; height: 3px; background: var(--color-iron); position: relative; }
.meter .fill { position: absolute; inset: 0 auto 0 0; height: 3px; background: var(--color-ember); }
</style>
