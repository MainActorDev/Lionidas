<script setup lang="ts">
/** WorkRow — one tool/command call in the timeline (Phase 5 step 4).
 *  Semantics follow ai-elements `Tool` (Collapsible trigger = whole header,
 *  status ALWAYS visible on the header, parameters/result sections) styled
 *  in the house Axiom language (⏵/⎿ rows, mono, hairline — sketch 042-A). */
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { computed } from 'vue';

const props = defineProps<{
  name: string;
  arg?: string;
  result?: string;
  isError?: boolean;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  durationMs?: number | null;
}>();

const statusLabel = computed(() => {
  switch (props.status) {
    case 'running': return 'running';
    case 'completed': return props.isError ? 'error' : 'done';
    case 'failed': return 'error';
    case 'cancelled': return 'cancelled';
    case 'interrupted': return 'interrupted';
  }
});
const statusClass = computed(() => {
  switch (props.status) {
    case 'running': return 'st-run';
    case 'completed': return props.isError ? 'st-err' : 'st-ok';
    case 'failed': return 'st-err';
    case 'cancelled': return 'st-off';
    case 'interrupted': return 'st-off';
  }
});
const firstResultLine = computed(() => (props.result ?? '').split('\n').find((l) => l.trim()) ?? '');
const hasDetail = computed(() => Boolean(props.arg || props.result));
const durLabel = computed(() => {
  const ms = props.durationMs;
  if (ms === null || ms === undefined) return null;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  const r = Math.round(s);
  return r < 60 ? `${r}s` : `${Math.floor(r / 60)}m ${r % 60}s`;
});
</script>

<template>
  <Collapsible class="work-row" :class="statusClass">
    <CollapsibleTrigger class="wr-head" :aria-label="`tool ${name}, ${statusLabel}`" :disabled="!hasDetail">
      <span class="wr-sym" aria-hidden="true">⏵</span>
      <span class="wr-name">{{ name }}</span>
      <span v-if="arg" class="wr-arg">{{ arg }}</span>
      <span v-if="durLabel" class="wr-dur">{{ durLabel }}</span>
      <span v-else-if="!hasDetail" class="wr-dur">{{ statusLabel }}</span>
    </CollapsibleTrigger>
    <CollapsibleContent v-if="hasDetail" class="wr-body">
      <div v-if="result !== undefined" class="wr-detail" :class="{ 'wr-err': isError }">
        <span class="wr-sym" aria-hidden="true">⎿</span>
        <span class="wr-text">{{ result }}</span>
      </div>
      <div v-if="arg" class="wr-detail wr-args">
        <span class="wr-sym" aria-hidden="true">⎿</span>
        <span class="wr-text">{{ arg }}</span>
      </div>
      <span class="sr-only">status: {{ statusLabel }}</span>
    </CollapsibleContent>
    <span v-else class="wr-status" :class="statusClass" aria-hidden="true">{{ statusLabel }}</span>
  </Collapsible>
</template>

<style scoped>
.work-row { margin: 2px 0; }
.wr-head {
  display: flex; align-items: baseline; gap: 8px; width: 100%;
  font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 12px;
  color: var(--ag-ink-dim, #a39d95); padding: 3px 0; text-align: left;
  background: none; border: none; cursor: pointer;
}
.wr-head:disabled { cursor: default; }
.wr-head:focus-visible { outline: 1px solid var(--color-accent); outline-offset: 2px; }
.wr-sym { color: var(--ag-ink-dim, #a39d95); width: 14px; flex: none; }
.st-run .wr-sym { color: var(--color-ember, #e06f5d); }
.st-ok .wr-name { color: var(--color-sage, #a0ca92); }
.st-err .wr-name { color: var(--color-danger, #d97a6a); }
.st-run .wr-name { color: var(--ag-ink, #eae6e1); }
.wr-name { color: var(--ag-ink, #eae6e1); flex: none; }
.wr-arg { color: var(--ag-ink-dim, #a39d95); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.wr-dur { margin-left: auto; color: var(--ag-ink-dim, #a39d95); font-size: 10px; flex: none; }
.wr-head:not(:disabled) .wr-arg { padding-right: 8px; }
.wr-chevron { margin-left: auto; color: var(--ag-ink-dim, #a39d95); font-size: 10px; }
.wr-head:not(:disabled) .wr-chevron::after { content: '›'; display: inline-block; transition: transform .15s; }
.work-row[data-state="open"] .wr-chevron::after { transform: rotate(90deg); }
.wr-body { padding-left: 22px; }
.wr-detail { display: flex; gap: 8px; font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 11px; color: var(--ag-ink-dim, #a39d95); padding: 2px 0; }
.wr-text { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.wr-err .wr-text { color: var(--color-danger, #d97a6a); }
.wr-status { font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 10px; padding-left: 22px; }
.st-ok.wr-status { color: var(--color-sage, #a0ca92); }
.st-err.wr-status { color: var(--color-danger, #d97a6a); }
.st-run.wr-status { color: var(--color-ember, #e06f5d); }
.st-off.wr-status { color: var(--ag-ink-dim, #a39d95); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>
