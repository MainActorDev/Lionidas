<script setup lang="ts">
/** StreamShimmer — aurora loading, ported from the operator's reference
 *  (attachments/aurora.html): three wide gradient bands (transparent →
 *  bright teal/green → violet/pink → transparent) that each run TWO
 *  concurrent animations — a wave (translateY + skewY + scaleY + rotate,
 *  3-stop keyframes so the band ripples like fabric) and a slow
 *  horizontal drift (alternate) — screen-blended behind a heavy blur +
 *  saturate, with a soft radial glow core pulsing over them. The screen's
 *  background is the night-sky radial from the reference. REACTIVE:
 *  --ramp eases in over the first 1.5s and scales band opacity; frozen
 *  under prefers-reduced-motion. No caption — motion is the message. */
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps<{ state: string }>();

const visible = computed((): boolean => props.state === 'connecting' || props.state === 'reconnecting');

// ramp: 0 → 1 over the first 1.5s visible (ease-out) — quick connects stay
// subtle, long connects bloom to full presence.
const ramp = ref(0);
let startedAt = 0;
let rampTimer = 0 as unknown as ReturnType<typeof setInterval>;
watch(visible, (on) => {
  if (on) {
    startedAt = Date.now();
    ramp.value = 0;
    clearInterval(rampTimer);
    rampTimer = setInterval(() => {
      const t = Math.min(1, (Date.now() - startedAt) / 1500);
      ramp.value = 1 - Math.pow(1 - t, 2); // easeOutQuad
      if (t >= 1) { clearInterval(rampTimer); rampTimer = 0 as unknown as ReturnType<typeof setInterval>; }
    }, 90);
  } else {
    clearInterval(rampTimer); rampTimer = 0 as unknown as ReturnType<typeof setInterval>;
    ramp.value = 0;
  }
}, { immediate: true });
onBeforeUnmount(() => { if (rampTimer) clearInterval(rampTimer); });
const rampPct = computed((): string => `${Math.round(ramp.value * 100)}%`);
</script>

<template>
  <div v-if="visible" class="shimmer" :style="{ '--ramp': rampPct }">
    <div class="aurora">
      <div class="aurora__band b1"></div>
      <div class="aurora__band b2"></div>
      <div class="aurora__band b3"></div>
    </div>
  </div>
</template>

<style scoped>
/* scene: the device screen is the night sky (reference's radial) */
.shimmer {
  position: absolute; inset: 0; overflow: hidden; z-index: 1;
  background: radial-gradient(circle at 50% 100%, #12203a 0%, #070b16 45%, #02040a 100%);
}

.aurora { position: absolute; inset: 0; filter: blur(26px) saturate(140%); }

/* bands: wide gradient ribbons, screen-blended; each runs wave + drift
 * concurrently (the reference's dual-animation signature — the wave makes
 * the ribbon ripple while the drift moves it, and the composite never
 * reads as a flat sweep) */
.aurora__band {
  position: absolute;
  width: 140%; height: 38%;
  left: -20%;
  border-radius: 50%;
  mix-blend-mode: screen;
  transform-origin: center;
}

.b1 {
  top: 8%;
  background: linear-gradient(90deg,
    transparent 0%,
    rgba(0, 255, 170, 0.15) 20%,
    rgba(0, 255, 200, 0.85) 40%,
    rgba(90, 255, 220, 0.7) 58%,
    rgba(90, 140, 255, 0.45) 75%,
    transparent 100%);
  opacity: calc(var(--ramp, 100%) * 0.75);
  animation:
    wave-one 7.5s ease-in-out infinite alternate,
    drift-one 15s ease-in-out infinite alternate;
}

.b2 {
  top: 25%;
  background: linear-gradient(90deg,
    transparent 0%,
    rgba(80, 120, 255, 0.15) 18%,
    rgba(120, 110, 255, 0.7) 38%,
    rgba(180, 90, 255, 0.65) 58%,
    rgba(255, 100, 210, 0.28) 78%,
    transparent 100%);
  opacity: calc(var(--ramp, 100%) * 0.6);
  animation:
    wave-two 9.5s ease-in-out infinite alternate,
    drift-two 17s ease-in-out infinite alternate;
}

.b3 {
  top: 42%;
  background: linear-gradient(90deg,
    transparent 0%,
    rgba(0, 255, 180, 0.08) 20%,
    rgba(0, 255, 170, 0.45) 40%,
    rgba(70, 255, 230, 0.7) 60%,
    rgba(70, 130, 255, 0.3) 78%,
    transparent 100%);
  opacity: calc(var(--ramp, 100%) * 0.5);
  animation:
    wave-three 7s ease-in-out infinite alternate,
    drift-three 14s ease-in-out infinite alternate;
}

/* the glow core pulsing over the bands (reference ::after) */
.aurora::after {
  content: "";
  position: absolute;
  width: 80%; height: 45%;
  left: 10%; top: 15%;
  background: radial-gradient(ellipse, rgba(0, 255, 190, 0.18), transparent 70%);
  filter: blur(36px);
  opacity: calc(var(--ramp, 100%) * 0.5);
  animation: glow 6s ease-in-out infinite alternate;
}

/* waves: 3-stop transforms — the bands ripple like hanging fabric */
@keyframes wave-one {
  0%   { transform: translateY(0) skewY(-6deg) scaleY(0.85) rotate(-3deg); }
  50%  { transform: translateY(18px) skewY(8deg) scaleY(1.2) rotate(2deg); }
  100% { transform: translateY(-6px) skewY(-3deg) scaleY(0.95) rotate(-5deg); }
}
@keyframes wave-two {
  0%   { transform: translateY(12px) skewY(6deg) scaleY(1.1) rotate(4deg); }
  50%  { transform: translateY(-14px) skewY(-9deg) scaleY(0.75) rotate(-2deg); }
  100% { transform: translateY(10px) skewY(4deg) scaleY(1.15) rotate(3deg); }
}
@keyframes wave-three {
  0%   { transform: translateY(-8px) skewY(-5deg) scaleY(0.8); }
  50%  { transform: translateY(14px) skewY(7deg) scaleY(1.08); }
  100% { transform: translateY(-3px) skewY(-2deg) scaleY(0.9); }
}

/* drifts: slow horizontal wander */
@keyframes drift-one   { from { left: -22%; } to { left: 2%; } }
@keyframes drift-two   { from { left: -10%; } to { left: -24%; } }
@keyframes drift-three { from { left: -18%; } to { left: 4%; } }

@keyframes glow {
  from { opacity: calc(var(--ramp, 100%) * 0.3); transform: scale(0.9); }
  to   { opacity: calc(var(--ramp, 100%) * 0.75); transform: scale(1.2); }
}

@media (prefers-reduced-motion: reduce) {
  .aurora__band, .aurora::after { animation: none; }
}
</style>
