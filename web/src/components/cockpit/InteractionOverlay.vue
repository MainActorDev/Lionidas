<script setup lang="ts">
/** InteractionOverlay (sketch 030-B, locked): paints WHERE the system is
 *  interacting on the live cockpit stage — crosshair guides + ring + a step
 *  label chip, fading over ~1400ms (same timing as the evidence overlay).
 *  Fed by WS `step.tap` events (logical coords → canvas fractions via
 *  logicalW/H) and `step.started` labels; draws on its own transparent
 *  canvas layered over the stream canvas (pointer-events: none — the stage
 *  keeps click/hover for manual drive + inspect). 404/absent data ⇒ this
 *  renders nothing. */
import { onBeforeUnmount, onMounted, ref } from 'vue';

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
        const alpha = 1 - age / FADE_MS;
        const x = m.fx * c.width;
        const y = m.fy * c.height;
        // full-bleed guides (quiet)
        ctx.strokeStyle = `rgba(234,110,52,${alpha * 0.35})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(c.width, y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, c.height); ctx.stroke();
        // center ring + dot
        ctx.strokeStyle = `rgba(234,110,52,${alpha})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(234,110,52,${alpha})`; ctx.fill();
        // type gets a caret tick (typing lands at a spot)
        if (m.kind === 'type') ctx.fillRect(x - 1, y - 12, 2, 24);
        // label chip — never offscreen
        const label = m.label;
        ctx.font = '10px ui-monospace, Menlo, monospace';
        const w = ctx.measureText(label).width + 12;
        let lx = x + 14; if (lx + w > c.width) lx = x - 14 - w;
        let ly = y - 24; if (ly < 30) ly = y + 16;
        ctx.fillStyle = `rgba(0,0,0,${0.7 * alpha})`;
        ctx.fillRect(lx, ly, w, 16);
        ctx.strokeStyle = `rgba(234,110,52,${alpha * 0.6})`;
        ctx.lineWidth = 1;
        ctx.strokeRect(lx, ly, w, 16);
        ctx.fillStyle = `rgba(238,238,238,${alpha})`;
        ctx.fillText(label, lx + 6, ly + 11.5);
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
