<script setup lang="ts">
/** OverlayPanel — the reusable supplementary-panel container (sketch
 *  024-overlay-embedded-v2, operator-locked): a card that covers the watcher
 *  rail's CONTENT while open (rail tabs stay visible, dimmed, above it).
 *  Single-slot by construction — the PAGE keeps one `overlay` id; opening
 *  another panel replaces this one. Chrome: icon + uppercase title + status
 *  badge + ✕. Rise-in 180ms, reduced-motion honored. */
defineProps<{
  title: string;
  icon?: string;
  /** ember-filled badge when set; hairline gray otherwise */
  badge?: string | null;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
  <div class="overlay">
    <div class="ov-head">
      <div v-if="icon" class="ov-ico">{{ icon }}</div>
      <span class="ov-title">{{ title }}</span>
      <span v-if="badge" class="ov-badge" :class="{ off: badge.startsWith('·') }">{{ badge }}</span>
      <span class="ov-spacer" />
      <button type="button" class="ov-x" aria-label="close" @click="emit('close')">✕</button>
    </div>
    <div class="ov-body"><slot /></div>
  </div>
</template>

<style scoped>
.overlay { position: absolute; inset: 0; background: var(--color-void, #0d0d0d); z-index: 5; display: flex; flex-direction: column; animation: rise .18s ease; }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .overlay { animation: none; } }

.ov-head { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-bottom: 1px solid var(--color-iron); flex: 0 0 auto; }
.ov-ico { width: 22px; height: 22px; border: 1px solid var(--color-slate); border-radius: var(--r); display: grid; place-items: center; font-size: 11px; color: var(--color-ember); flex: none; }
.ov-title { font-size: var(--text-caption); letter-spacing: .1em; text-transform: uppercase; color: var(--color-paper); }
.ov-badge { font-size: 10px; color: var(--color-carbon); background: var(--color-ember); padding: 1px 6px; border-radius: var(--r); }
.ov-badge.off { background: none; color: var(--color-ash); border: 1px solid var(--color-slate); }
.ov-spacer { flex: 1; }
.ov-x { background: none; border: 1px solid var(--color-iron); color: var(--color-fog); border-radius: var(--r); cursor: pointer; font-size: var(--text-caption); padding: 1px 7px; }
.ov-x:hover { border-color: var(--color-ember); color: var(--color-ember); }
.ov-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
</style>
