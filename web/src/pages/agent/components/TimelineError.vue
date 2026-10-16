<script setup lang="ts">
/** TimelineError — honest verdict row for failed/aborted/empty turns. */
defineProps<{ className: string; message: string }>();
</script>

<template>
  <div class="tl-error" :class="className === 'aborted' ? 'is-off' : 'is-err'" role="status">
    <span class="sym" aria-hidden="true">{{ className === 'aborted' ? '·' : '✕' }}</span>
    <span class="msg">{{ message }}</span>
  </div>
</template>

<style scoped>
.tl-error { display: flex; gap: 8px; align-items: baseline; font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 11px; padding: 2px 0; }
.is-err .msg { color: var(--color-danger, #d97a6a); }
.is-err .sym { color: var(--color-danger, #d97a6a); }
.is-off .msg { color: var(--color-dim, #6b665e); }
.is-off .sym { color: var(--color-dim, #6b665e); }
</style>
