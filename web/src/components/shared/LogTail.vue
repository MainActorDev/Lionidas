<script setup lang="ts">
/** LogTail — compact scrolling rows (sketch .logtail). kind: hit → ember,
 *  err → paper, default ash. NOT device logs by default — label the section
 *  for what it shows (review F4). */
defineProps<{ rows: Array<{ ts: string; text: string; kind?: 'hit' | 'err' }> }>();
</script>

<template>
  <div class="logtail">
    <div v-for="(r, i) in rows" :key="i"><span class="t">{{ r.ts }}</span> <span :class="r.kind ?? ''">{{ r.text }}</span></div>
  </div>
</template>

<style scoped>
.logtail { font-size: 10px; line-height: 1.6; color: var(--color-ash); background: var(--color-void); border: 1px solid var(--color-iron); border-radius: var(--r); padding: 8px; max-height: 140px; overflow-y: auto; }
.t { color: var(--color-steel); }
.err { color: var(--color-paper); }
.hit { color: var(--color-ember); }
</style>
