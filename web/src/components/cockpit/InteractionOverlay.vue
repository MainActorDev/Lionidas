<script setup lang="ts">
/** InteractionOverlay (sketch 030-B, locked): paints WHERE the system is
 *  interacting on the live cockpit stage — via the SHARED draw fn (same
 *  code as the evidence player; parity by construction). Fed by markers
 *  pushed by the page (WS step.tap → fractions); ages markers here at
 *  1400ms. 404/absent data ⇒ renders nothing. */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { drawInteractionMarker, type MarkerSpec } from '@crucible/shared/interaction-marker';

const props = defineProps<{
  /** fraction coords 0..1 (logical → fraction done by the page) */
  markers: Array<{ id: number; fx: number; fy: number; label: string; kind: 'tap' | 'type' }>;
}>();

const cv = ref<HTMLCanvasElement | null>(null);
const FADE_MS = 1400;
/** birth times by marker id — the page pushes markers; we age them here */
const born = new Map<number, number>();
let raf = 0;

function loop(): void {
  const c = cv.value;
  if (c) {
    const r = c.parentElement?.getBoundingClientRect();
    if (r && c.width !== Math.floor(r.width)) { c.width = Math.floor(r.width); c.height = Math.floor(r.height); }
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, c.width, c.height);
      const now = performance.now();
      for (const m of props.markers) {
        if (!born.has(m.id)) born.set(m.id, now);
        const age = now - born.get(m.id)!;
        if (age > FADE_MS) continue;
        drawInteractionMarker(ctx, { fx: m.fx, fy: m.fy, label: m.label, kind: m.kind, opacity: 1 - age / FADE_MS }, c.width, c.height);
      }
      // prune dead births
      const live = new Set(props.markers.map((m) => m.id));
      for (const k of born.keys()) if (!live.has(k)) born.delete(k);
    }
  }
  raf = requestAnimationFrame(loop);
}
onMounted(() => { raf = requestAnimationFrame(loop); });
onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>

<template>
  <canvas ref="cv" class="ia-overlay"></canvas>
</template>

<style scoped>
.ia-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 5; }
</style>
