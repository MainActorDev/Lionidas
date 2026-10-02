<script setup lang="ts">
/** DeviceSwitcher — browser-style tabs, one per device; ONE spacious device
 *  at a time. Ember dot = live activity; switching moves view AND control.
 *  Tab ✕ = close tab: releases any manual session and shuts the device down
 *  (handled by the page). ✕ click never switches the tab. */
export interface SwitcherDevice { udid: string; name: string; sub: string; live: boolean }
defineProps<{ devices: SwitcherDevice[]; activeUdid: string; closingUdid?: string }>();
const emit = defineEmits<{
  (e: 'switch', udid: string): void;
  (e: 'close', udid: string): void;
}>();
</script>

<template>
  <div class="switchstrip">
    <div
      v-for="d in devices" :key="d.udid"
      class="stab" :class="{ active: d.udid === activeUdid, live: d.live, closing: d.udid === closingUdid }"
      role="tab" :aria-selected="d.udid === activeUdid" tabindex="0"
      @click="emit('switch', d.udid)"
      @keydown.enter="emit('switch', d.udid)"
    >
      <span class="dot" /><span class="tname">{{ d.name }}</span> <span class="sub">{{ d.sub }}</span>
      <button
        type="button" class="tabx" :title="`release + shut down ${d.name}`"
        :disabled="d.udid === closingUdid"
        @click.stop="emit('close', d.udid)"
        @keydown.enter.stop="emit('close', d.udid)"
      >{{ d.udid === closingUdid ? '⋯' : '✕' }}</button>
    </div>
    <span class="spacer" />
  </div>
</template>

<style scoped>
.switchstrip { display: flex; align-items: center; gap: 10px; padding: 8px var(--s-4); border-bottom: 1px solid var(--color-iron); background: var(--color-carbon); }
.stab { display: flex; align-items: center; gap: 8px; border: 1px solid var(--color-iron); border-radius: var(--r); padding: 5px 6px 5px 10px; cursor: pointer; font-size: var(--text-caption); color: var(--color-ash); }
.stab:hover { border-color: var(--color-slate); color: var(--color-paper); }
.stab:focus-visible { outline: 1px solid var(--color-ember); outline-offset: 1px; }
.stab.active { border-color: var(--color-ember); color: var(--color-paper); background: var(--color-graphite); }
.stab.closing { opacity: .55; }
.stab .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-steel); flex: 0 0 auto; }
.stab.live .dot { background: var(--color-ember); }
.stab .tname { white-space: nowrap; }
.stab .sub { color: var(--color-steel); font-size: 10px; white-space: nowrap; }
.stab.active .sub { color: var(--color-ember); }
.tabx { font-family: inherit; display: grid; place-items: center; width: 18px; height: 18px; line-height: 1; background: none; border: none; border-radius: var(--r); color: var(--color-steel); cursor: pointer; font-size: 11px; padding: 0; flex: 0 0 auto; }
.tabx:hover:not(:disabled) { background: var(--color-iron); color: var(--color-paper); }
.tabx:disabled { cursor: default; }
.spacer { flex: 1; }
</style>
