<script setup lang="ts">
/** DeviceSwitcher — CHROME-STYLE browser tabs, one per device. Active tab
 *  lifts out of the strip (rounded top + flared ears) and connects to the
 *  content below; inactive tabs sit flat until hovered. Ember dot = live.
 *  Tab ✕ = close: release session + shut the device down (page handles). */
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
      <span class="dot" />
      <span class="tname">{{ d.name }}</span>
      <span class="sub">{{ d.sub }}</span>
      <button
        type="button" class="tabx" :title="`release + shut down ${d.name}`"
        v-if="d.sub !== 'restarting'"
        :disabled="d.udid === closingUdid"
        @click.stop="emit('close', d.udid)"
        @keydown.enter.stop="emit('close', d.udid)"
      >{{ d.udid === closingUdid ? '⋯' : '✕' }}</button>
    </div>
    <span class="spacer" />
  </div>
</template>

<style scoped>
/* the tab well: darkest band; the divider is NOT a border-bottom (that
 * would strike through the active tab) — the content area's own top edge
 * draws it, and the active tab covers it where it connects */
.switchstrip { display: flex; align-items: flex-end; gap: 4px; padding: 8px 10px 1px; background: var(--color-void); min-height: 46px; }

.stab {
  position: relative;
  display: flex; align-items: center; gap: 8px;
  max-width: 200px;
  padding: 9px 8px 9px 14px;
  border: none; border-radius: 10px 10px 0 0;
  background: transparent;
  color: var(--color-fog);
  font-size: var(--text-caption);
  cursor: pointer;
  transition: background .12s ease, color .12s ease;
}
.stab:hover { background: var(--color-graphite); color: var(--color-paper); }
.stab:focus-visible { outline: 1px solid var(--color-accent); outline-offset: -1px; }
.stab.closing { opacity: .55; }

/* active tab: lifted, connected to the content below (covers the strip line) */
.stab.active {
  background: var(--color-carbon);
  color: var(--color-paper);
  margin-bottom: -1px;
  z-index: 1;
  box-shadow: inset 0 1px 0 var(--color-slate);  /* the lit top edge only — no outline box */
}
/* Chrome's flared ears: 14px quarter-discs OUTSIDE the tab's bottom
 * corners — the tab's surface flows outward into the divider line */
.stab.active::before, .stab.active::after {
  content: '';
  position: absolute;
  bottom: -1px;
  width: 14px; height: 14px;
  pointer-events: none;
  z-index: 2;
}
.stab.active::before {
  left: -14px;
  background: radial-gradient(circle 14px at 0 0, transparent 13.5px, var(--color-carbon) 13.75px);
}
.stab.active::after {
  right: -14px;
  background: radial-gradient(circle 14px at 100% 0, transparent 13.5px, var(--color-carbon) 13.75px);
}

.stab .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-steel); flex: 0 0 auto; }
.stab.live .dot { background: var(--color-ember); }
.stab .tname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.stab .sub { color: var(--color-steel); font-size: 10px; white-space: nowrap; flex: 0 0 auto; }
.stab.active .sub { color: var(--color-accent); }

/* close: quiet circle, brightens on tab hover (Chrome behavior) */
.tabx {
  font-family: inherit;
  display: grid; place-items: center;
  width: 18px; height: 18px; line-height: 1;
  background: none; border: none; border-radius: 50%;
  color: var(--color-steel); cursor: pointer; font-size: 11px; padding: 0;
  flex: 0 0 auto;
}
.stab:hover .tabx { color: var(--color-fog); }
.tabx:hover:not(:disabled) { background: var(--color-iron); color: var(--color-paper); }
.tabx:disabled { cursor: default; }

.spacer { flex: 1; }
</style>
