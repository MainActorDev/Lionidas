<script setup lang="ts">
/** Evidence-player interaction overlay — the SAME 030-B visual as the live
 *  cockpit via the shared draw fn (crosshair guides + ember ring + label
 *  chip `tap · <step name>`). Driven by /api/templates/:id/run-taps +
 *  video.currentTime; aging/fade by overlayAt (1400ms).
 *
 *  Timing precision (plan 20261009T000000Z): anchor = engine-measured
 *  first frame when present (video_anchor_ms) else the legacy start stamp;
 *  operator fine-align via per-run overlay_offset_ms (◀/▶ buttons, PATCHed,
 *  also seeds the per-device default) closes the player-side last mile.
 *  Tick rides requestVideoFrameCallback when available (draws on presented
 *  frames) with rAF fallback + redraw on seeked/play (rVFC never fires on
 *  seek — review F4). 404/absent data ⇒ renders nothing (plain video). */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { overlayAt, type OverlayTap } from '@crucible/shared/tap-overlay';
import { drawInteractionMarker } from '@crucible/shared/interaction-marker';

const props = defineProps<{ templateId: string; variant?: string }>();
const canvas = ref<HTMLCanvasElement | null>(null);
const videoEl = ref<HTMLVideoElement | null>(null);
const alignBusy = ref(false);
const offsetInfo = ref<{ ms: number; source: 'run' | 'device' } | null>(null);

const FADE_MS = 1400;
let taps: OverlayTap[] = [];
let anchor = 0;
let offsetMs = 0;
let runId = '';
let stepNames = new Map<number, string>();
let raf = 0;

function draw(playheadMs: number): void {
  const cv = canvas.value;
  if (!cv) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  // offset shifts the playhead: positive = markers later, negative = earlier
  const markers = overlayAt(taps, anchor, playheadMs - offsetMs, FADE_MS);
  // parity with the live overlay (InteractionOverlay): metrics are tuned in
  // CSS px and the live canvas is CSS-sized. The earlier cv.height/550 scale
  // read the BACKING height (syncSize bakes in devicePixelRatio), so the
  // factor double-counted DPR — markers rendered ~1.5x the live overlay's
  // at typical player heights ("kinda zoomed"). Scale by DPR only and draw
  // in CSS dimensions: pixel-identical to live at the same rendered size.
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.scale(dpr, dpr);
  for (const m of markers) {
    const name = m.idx != null ? (stepNames.get(m.idx) ?? null) : null;
    drawInteractionMarker(
      ctx,
      { fx: m.fx, fy: m.fy, label: name ? `tap · ${name}` : 'interaction', kind: 'tap', opacity: m.opacity },
      cv.width / dpr, cv.height / dpr,
    );
  }
  ctx.restore();
}

function tick(): void {
  const v = videoEl.value;
  if (v && taps.length > 0 && anchor > 0) draw(v.currentTime * 1000);
  raf = requestAnimationFrame(tick);
}

/** rVFC path: draw exactly on presented frames (jitter-free); re-arms
 *  itself. Fallback: rAF loop. Redraw on seeked covers rVFC's seek gap. */
function onPresentedFrame(_now: number, meta: { mediaTime: number }): void {
  const v = videoEl.value;
  if (v && taps.length > 0 && anchor > 0) draw(meta.mediaTime * 1000);
  (v as unknown as { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number })
    .requestVideoFrameCallback?.(onPresentedFrame);
}

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

async function nudge(deltaMs: number): Promise<void> {
  if (!runId || alignBusy.value) return;
  alignBusy.value = true;
  try {
    const next = offsetMs + deltaMs;
    const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/overlay-offset`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offsetMs: next }),
    });
    const b = (await r.json()) as { offsetMs?: number; source?: 'run' | 'device'; error?: string };
    if (r.ok && typeof b.offsetMs === 'number') {
      offsetMs = b.offsetMs;
      offsetInfo.value = { ms: b.offsetMs, source: b.source ?? 'run' };
    }
  } catch { /* best-effort align */ }
  finally { alignBusy.value = false; }
}

watch(() => [props.templateId, props.variant] as const, async ([id, variant]) => {
  taps = [];
  anchor = 0;
  runId = '';
  offsetInfo.value = null;
  try {
    // variant scoping: undefined = legacy unscoped; a string (incl. '' for
    // the variantless lane) scopes taps to that lane's run
    const qs = variant === undefined ? '' : `?variant=${encodeURIComponent(variant)}`;
    const r = await fetch(`/api/templates/${id}/run-taps${qs}`);
    if (!r.ok) {
      // RETRY once after a short delay: a 401 here is usually the session
      // cookie expiring mid-viewing — the app's global 401 interceptor
      // bounces to /login, the operator re-logs, returns... and this
      // component already gave up (fetch ran once at mount, failure left
      // the overlay permanently off — "no tap overlay at all", live
      // 2026-10-09). One delayed retry covers the bounce; a second failure
      // stays silent (overlay is best-effort — never block the player).
      await new Promise((res) => setTimeout(res, 800));
      const r2 = await fetch(`/api/templates/${id}/run-taps${qs}`);
      if (!r2.ok) return;
      return void applyRunTaps(await r2.json());
    }
    return void applyRunTaps(await r.json());
  } catch { /* overlay is best-effort — never block the player */ }
}, { immediate: true });

async function applyRunTaps(b: {
  runId: string; videoStartedAt: number; anchor?: number; offsetMs?: number; offsetSource?: 'run' | 'device';
  taps: OverlayTap[];
}): Promise<void> {
    runId = b.runId;
    anchor = b.anchor ?? b.videoStartedAt;   // engine-measured first frame when present
    offsetMs = b.offsetMs ?? 0;
    if (offsetMs !== 0 || b.offsetSource) offsetInfo.value = { ms: offsetMs, source: b.offsetSource ?? 'run' };
    taps = b.taps ?? [];
    // label join: idx → step name (one fetch; single-run view — review F5)
    try {
      const s = await fetch(`/api/runs/${encodeURIComponent(b.runId)}/steps`);
      if (s.ok) {
        const sb = (await s.json()) as { steps?: Array<{ idx: number; name: string }> };
        stepNames = new Map((sb.steps ?? []).map((x) => [x.idx, x.name]));
      }
    } catch { /* labels best-effort — chip falls back to 'interaction' */ }
    requestAnimationFrame(syncSize);
}

onMounted(() => {
  const v = videoEl.value as (HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number }) | null;
  if (typeof v?.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(onPresentedFrame);
  else raf = requestAnimationFrame(tick);
  window.addEventListener('resize', syncSize);
});
onBeforeUnmount(() => { cancelAnimationFrame(raf); window.removeEventListener('resize', syncSize); });

function drawAtVideo(): void {
  const v = videoEl.value;
  if (v) draw(v.currentTime * 1000);
}
void drawAtVideo;
</script>

<template>
  <div class="tap-overlay-wrap">
    <video ref="videoEl" class="evidence-shot" controls preload="metadata"
      :src="`/api/templates/${props.templateId}/evidence/video${props.variant === undefined ? '' : `?variant=${encodeURIComponent(props.variant)}`}`"
      @loadedmetadata="syncSize" @seeked="drawAtVideo" @play="drawAtVideo"></video>
    <canvas ref="canvas" class="tap-overlay-canvas" aria-hidden="true"></canvas>
    <!-- fine-align cluster (plan T2.4): ◀ ▶ nudge ±100ms (shift = ±25ms),
         persisted per-run + seeds the per-device default -->
    <div v-if="taps.length > 0" class="align-cluster" @click.stop @keydown.stop>
      <button type="button" title="markers later (+100ms, shift=+25ms)" :disabled="alignBusy" @click="nudge($event.shiftKey ? 25 : 100)">◀</button>
      <span class="align-val" :title="`overlay offset (${offsetInfo?.source ?? 'run'})`">{{ offsetMs > 0 ? '+' : '' }}{{ (offsetMs / 1000).toFixed(2) }}s<template v-if="offsetInfo?.source === 'device'"> ·d</template></span>
      <button type="button" title="markers earlier (−100ms, shift=−25ms)" :disabled="alignBusy" @click="nudge($event.shiftKey ? -25 : -100)">▶</button>
    </div>
  </div>
</template>

<style scoped>
/* The wrap must size FROM the video (its only in-flow child), never from the
 * inline strut: an inline-block wrap around a <video> that has not loaded yet
 * (or whose controls rewrap) computes a phantom ~2-line width and breaks the
 * card's container. width:fit-content + display:block makes the wrap exactly
 * the video's rendered box; the absolutely-positioned canvas (inset:0) then
 * tracks the same box. Video keeps the shot sizing rules (max-* + contain). */
.tap-overlay-wrap { position: relative; display: block; width: fit-content; max-width: 100%; margin: 0 auto; }
.tap-overlay-wrap :deep(video.evidence-shot),
video.evidence-shot { display: block; max-width: 100%; max-height: calc(92vh - 96px); object-fit: contain; }
.tap-overlay-canvas { position: absolute; inset: 0; pointer-events: none; }
.align-cluster { position: absolute; left: 8px; bottom: 44px; display: flex; gap: 6px; align-items: center; font-family: var(--font-mono); font-size: 10px; color: var(--color-fog); background: rgba(0,0,0,.7); border: 1px solid var(--color-slate); border-radius: var(--r); padding: 2px 6px; }
.align-cluster button { background: none; border: 1px solid var(--color-iron); color: var(--color-fog); border-radius: var(--r); cursor: pointer; padding: 0 6px; font-size: 10px; }
.align-cluster button:hover:not(:disabled) { color: var(--color-paper); border-color: var(--color-slate); }
.align-val { min-width: 56px; text-align: center; }
</style>
