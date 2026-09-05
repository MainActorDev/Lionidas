<script setup lang="ts">
/** Tier 2.2 — tap-overlay canvas for the evidence player. Paints fading
 *  tap markers over the video (same visual language as the live RunPanel
 *  dots), driven by /api/templates/:id/run-taps + video.currentTime.
 *  404/absent data ⇒ renders nothing (plain video, no errors). */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { overlayAt, type OverlayTap, type OverlayMarker } from '@crucible/shared/tap-overlay';

const props = defineProps<{ templateId: string }>();
const canvas = ref<HTMLCanvasElement | null>(null);
const videoEl = ref<HTMLVideoElement | null>(null);

const FADE_MS = 1400;
let taps: OverlayTap[] = [];
let videoStartedAt = 0;
let raf = 0;

function draw(markers: OverlayMarker[]): void {
  const cv = canvas.value;
  if (!cv) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  const r = Math.max(10, Math.round(cv.width * 0.02));
  for (const m of markers) {
    const cx = m.fx * cv.width;
    const cy = m.fy * cv.height;
    ctx.globalAlpha = m.opacity;
    // white ring (visible on any background) + accent dot
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, r * 0.18);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = 'rgb(94, 158, 255)';
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function tick(): void {
  const v = videoEl.value;
  if (v && taps.length > 0 && videoStartedAt > 0) {
    draw(overlayAt(taps, videoStartedAt, v.currentTime * 1000, FADE_MS));
  }
  raf = requestAnimationFrame(tick);
}

/** canvas backing store must track the video's rendered box (fractions
 *  are resolution-independent; backing pixels keep circles crisp) */
function syncSize(): void {
  const cv = canvas.value;
  const v = videoEl.value;
  if (!cv || !v) return;
  const rect = v.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    cv.width = Math.round(rect.width * devicePixelRatio);
    cv.height = Math.round(rect.height * devicePixelRatio);
    cv.style.width = `${rect.width}px`;
    cv.style.height = `${rect.height}px`;
  }
}

watch(() => props.templateId, async (id) => {
  taps = [];
  videoStartedAt = 0;
  try {
    const r = await fetch(`/api/templates/${id}/run-taps`);
    if (!r.ok) return;                       // no anchor / no run ⇒ no overlay
    const b = (await r.json()) as { videoStartedAt: number; taps: OverlayTap[] };
    videoStartedAt = b.videoStartedAt;
    taps = b.taps ?? [];
    requestAnimationFrame(syncSize);
  } catch { /* overlay is best-effort — never block the player */ }
}, { immediate: true });

onMounted(() => { raf = requestAnimationFrame(tick); window.addEventListener('resize', syncSize); });
onBeforeUnmount(() => { cancelAnimationFrame(raf); window.removeEventListener('resize', syncSize); });
</script>

<template>
  <div class="tap-overlay-wrap">
    <video ref="videoEl" class="evidence-shot" controls preload="metadata"
      :src="`/api/templates/${props.templateId}/evidence/video`" @loadedmetadata="syncSize"></video>
    <canvas ref="canvas" class="tap-overlay-canvas" aria-hidden="true"></canvas>
  </div>
</template>

<style scoped>
.tap-overlay-wrap { position: relative; display: inline-block; max-width: 100%; }
.tap-overlay-canvas { position: absolute; inset: 0; pointer-events: none; }
</style>
