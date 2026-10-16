<script setup lang="ts">
/** MessageBubble — one message item in the timeline (Phase 5 step 4).
 *  Directional grouping per ai-elements `Message` (is-user/is-assistant),
 *  markdown via the house renderer (escape-first, never trusted markup),
 *  streaming = coalesced snapshot + cursor. */
import { computed } from 'vue';
import { renderMarkdown } from '../markdown';

const props = defineProps<{
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  intent?: 'queued' | 'steering';
  status?: 'completed' | 'failed' | 'cancelled' | 'running';
}>();

const html = computed(() => renderMarkdown(props.text));
</script>

<template>
  <div class="bubble" :class="[`is-${role}`, status === 'failed' ? 'is-failed' : '', status === 'cancelled' ? 'is-cancelled' : '']">
    <div class="body">
      <!-- eslint-disable-next-line vue/no-v-html — house renderer escapes-first (markdown.ts) -->
      <div class="txt" v-html="html"></div>
      <span v-if="streaming" class="cursor" aria-hidden="true"></span>
      <span v-if="streaming" class="sr-only">response streaming</span>
    </div>
    <span v-if="intent" class="intent" :class="`intent-${intent}`">{{ intent }}</span>
    <span v-if="status === 'failed'" class="badge">failed</span>
    <span v-else-if="status === 'cancelled'" class="badge badge-off">aborted</span>
  </div>
</template>

<style scoped>
.bubble { display: flex; flex-direction: column; max-width: 85%; min-width: 0; }
.is-user { align-self: flex-end; }
.is-assistant { align-self: flex-start; max-width: 100%; }
.is-user .body {
  background: var(--ag-surface, #1d1a18); border: 1px solid var(--ag-line, #2a2a2a);
  border-radius: 2px; padding: 9px 13px; font-size: 13px; min-width: 0;
}
.is-assistant .body { font-size: 13.5px; color: var(--ag-ink, #eae6e1); min-width: 0; }
.is-failed .body, .is-cancelled .body { opacity: .85; }
.txt { min-width: 0; overflow-wrap: anywhere; }
.txt :deep(p) { margin: 0 0 8px; }
.txt :deep(p:last-child) { margin-bottom: 0; }
.txt :deep(code) {
  font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 12px;
  background: var(--ag-surface, #1d1a18); border: 1px solid #232120; border-radius: 2px; padding: 1px 5px;
}
.cursor {
  display: inline-block; width: 7px; height: 13px; margin-left: 3px;
  background: var(--color-ember, #ee6018); vertical-align: text-bottom; animation: agblink .9s infinite;
}
@keyframes agblink { 50% { opacity: 0; } }
.intent { font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 10px; color: var(--color-gold, #d9b06a); margin-top: 4px; }
.intent-steering { color: var(--color-ember, #ee6018); }
.badge { font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 10px; color: var(--color-danger, #d97a6a); margin-top: 4px; }
.badge-off { color: var(--ag-ink-dim, #a39d95); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>
