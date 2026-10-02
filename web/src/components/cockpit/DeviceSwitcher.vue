<script setup lang="ts">
/** DeviceSwitcher — one tab per device; ONE spacious device at a time (locked
 *  sketch). Ember dot = live activity; switching moves view AND control. */
export interface SwitcherDevice { udid: string; name: string; sub: string; live: boolean }
defineProps<{ devices: SwitcherDevice[]; activeUdid: string }>();
const emit = defineEmits<{ (e: 'switch', udid: string): void }>();
</script>

<template>
  <div class="switchstrip">
    <div
      v-for="d in devices" :key="d.udid"
      class="stab" :class="{ active: d.udid === activeUdid, live: d.live }"
      role="tab" :aria-selected="d.udid === activeUdid" tabindex="0"
      @click="emit('switch', d.udid)"
      @keydown.enter="emit('switch', d.udid)"
    >
      <span class="dot" />{{ d.name }} <span class="sub">{{ d.sub }}</span>
    </div>
    <span class="spacer" />
    <span class="note">one device spacious · switching moves view + control</span>
  </div>
</template>

<style scoped>
.switchstrip { display: flex; align-items: center; gap: 10px; padding: 8px var(--s-4); border-bottom: 1px solid var(--color-iron); background: var(--color-carbon); }
.stab { display: flex; align-items: center; gap: 8px; border: 1px solid var(--color-iron); border-radius: var(--r); padding: 5px 10px; cursor: pointer; font-size: var(--text-caption); color: var(--color-ash); }
.stab:hover { border-color: var(--color-slate); color: var(--color-paper); }
.stab:focus-visible { outline: 1px solid var(--color-ember); outline-offset: 1px; }
.stab.active { border-color: var(--color-ember); color: var(--color-paper); background: var(--color-graphite); }
.stab .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-steel); }
.stab.live .dot { background: var(--color-ember); }
.stab .sub { color: var(--color-steel); font-size: 10px; }
.stab.active .sub { color: var(--color-ember); }
.spacer { flex: 1; }
.note { font-size: 10px; color: var(--color-steel); }
</style>
