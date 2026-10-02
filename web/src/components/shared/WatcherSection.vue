<script setup lang="ts">
/** WatcherSection — collapsible section inside a rail pane (sketch .sect).
 *  h3 + meta + collapse toggle (+/–) + body slot. */
import { ref } from 'vue';
const props = defineProps<{ title: string; meta?: string }>();
const collapsed = ref(false);
const toggle = (): void => { collapsed.value = !collapsed.value; };
void props;
</script>

<template>
  <div class="sect" :class="{ closed: collapsed }">
    <h3 @click="toggle">
      <span>{{ title }} <span v-if="meta" class="meta">{{ meta }}</span></span>
    </h3>
    <div class="body"><slot /></div>
  </div>
</template>

<style scoped>
.sect { border-bottom: 1px solid var(--color-iron); }
.sect > h3 { font-size: var(--text-caption); text-transform: uppercase; letter-spacing: .08em; color: var(--color-ash); padding: var(--s-2) var(--s-3); display: flex; justify-content: space-between; cursor: pointer; user-select: none; }
.sect > h3::after { content: "–"; color: var(--color-steel); }
.sect.closed > h3::after { content: "+"; }
.sect > h3 .meta { color: var(--color-steel); text-transform: none; }
.sect.closed .body { display: none; }
.body { padding: 0 var(--s-3) var(--s-3); }
</style>
