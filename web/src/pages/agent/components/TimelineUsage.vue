<script setup lang="ts">
/** TimelineUsage — turn cost/context meters (composer-foot bar consumes the
 *  same props; A's turn-meta presentation). */
import { computed } from 'vue';
const props = defineProps<{ cost: number; contextUsed: number; contextWindow: number }>();
const pct = computed(() => (props.contextWindow > 0 ? Math.min(100, Math.round((props.contextUsed / props.contextWindow) * 100)) : 0));
</script>

<template>
  <div class="tl-usage">
    <span class="cost">${{ cost.toFixed(3) }}</span>
    <span class="ctx">ctx {{ pct }}%</span>
    <span class="sr-only">turn cost ${{ cost.toFixed(3) }}, context {{ pct }} percent of {{ contextWindow }}</span>
  </div>
</template>

<style scoped>
.tl-usage { display: inline-flex; gap: 12px; font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 10px; color: var(--ag-ink-dim, #a39d95); padding: 1px 0; align-self: flex-end; }
.cost { color: var(--ag-ink-dim, #a39d95); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>
