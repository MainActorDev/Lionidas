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
</script>

<template>
  <Collapsible class="work-row" :class="statusClass">
    <CollapsibleTrigger class="wr-head" :aria-label="`tool ${name}, ${statusLabel}`" :disabled="!hasDetail">
      <span class="wr-sym" aria-hidden="true">⏵</span>
      <span class="wr-name">{{ name }}</span>
      <span v-if="arg" class="wr-arg">{{ arg }}</span>
      <span v-if="!hasDetail" class="wr-dur">{{ statusLabel }}</span>
      <span class="wr-chevron" aria-hidden="true" data-chevron></span>
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
  color: var(--color-ash, #a39d95); padding: 3px 0; text-align: left;
  background: none; border: none; cursor: pointer;
}
.wr-head:disabled { cursor: default; }
.wr-head:focus-visible { outline: 1px solid var(--color-ember, #ee6018); outline-offset: 2px; }
.wr-sym { color: var(--color-dim, #6b665e); width: 14px; flex: none; }
.st-run .wr-sym { color: var(--color-ember, #ee6018); }
.st-ok .wr-name { color: var(--color-sage, #a0ca92); }
.st-err .wr-name { color: var(--color-danger, #d97a6a); }
.st-run .wr-name { color: var(--color-fg, #eae6e1); }
.wr-name { color: var(--color-fg, #eae6e1); flex: none; }
.wr-arg { color: var(--color-dim, #6b665e); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.wr-dur { margin-left: auto; color: var(--color-dim, #6b665e); font-size: 10px; flex: none; }
.wr-chevron { margin-left: auto; color: var(--color-dim, #6b665e); font-size: 10px; }
.wr-head:not(:disabled) .wr-chevron::after { content: '›'; display: inline-block; transition: transform .15s; }
.work-row[data-state="open"] .wr-chevron::after { transform: rotate(90deg); }
.wr-body { padding-left: 22px; }
.wr-detail { display: flex; gap: 8px; font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 11px; color: var(--color-dim, #6b665e); padding: 2px 0; }
.wr-text { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.wr-err .wr-text { color: var(--color-danger, #d97a6a); }
.wr-status { font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 10px; padding-left: 22px; }
.st-ok.wr-status { color: var(--color-sage, #a0ca92); }
.st-err.wr-status { color: var(--color-danger, #d97a6a); }
.st-run.wr-status { color: var(--color-ember, #ee6018); }
.st-off.wr-status { color: var(--color-dim, #6b665e); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>
