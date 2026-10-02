<script setup lang="ts">
/** StreamShimmer — AURORA loading: curtains of light flowing continuously
 *  across the screen while the device stream connects. Three skewed,
 *  heavily-blurred ribbons drift one-directionally (linear timing, wrap
 *  offscreen — never a ping-pong), each undulating vertically on its own
 *  slow phase, blending with screen mode. REACTIVE: a --ramp var eases in
 *  over the first 1.5s (quick connects stay subtle) and scales opacity +
 *  travel; frozen under prefers-reduced-motion. No caption — motion is the
 *  message. */
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps<{ state: string }>();

const visible = computed((): boolean => props.state === 'connecting' || props.state === 'reconnecting');

// ramp: 0 → 1 over the first 1.5s visible (ease-out). Scales curtain opacity
// and drift distance — quick connects stay subtle, long connects bloom.
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
      <div class="rib r1"><div class="glow g1"></div></div>
      <div class="rib r2"><div class="glow g2"></div></div>
      <div class="rib r3"><div class="glow g3"></div></div>
    </div>
  </div>
</template>

<style scoped>
.shimmer { position: absolute; inset: 0; overflow: hidden; background: var(--color-void); z-index: 1; }

.aurora { position: absolute; inset: 0; filter: blur(26px) saturate(1.2); }

/* ribbons: the curtain arms. Each .rib is a tall skewed track that drifts
 * one-directionally (linear timing, wraps offscreen — a continuous stream,
 * never a return sweep); its inner .glow is the visible light bar, which
 * undulates (translateY + slight rotate) on its own slow phase — curtains
 * waving as they cross, like aurora in a magnetic field. */
.rib { position: absolute; left: -60%; width: 220%; height: 46%; will-change: transform; }
.r1 { top: 2%;  animation: drift-a 9s linear infinite; }
.r2 { top: 26%; animation: drift-b 13s linear infinite; }
.r3 { top: 52%; animation: drift-a 17s linear infinite reverse; }

@keyframes drift-a {
  from { transform: translateX(calc(-55% * var(--ramp, 1))) skewX(-14deg); }
  to   { transform: translateX(calc(15% * var(--ramp, 1))) skewX(-14deg); }
}
@keyframes drift-b {
  from { transform: translateX(calc(10% * var(--ramp, 1))) skewX(-7deg); }
  to   { transform: translateX(calc(-50% * var(--ramp, 1))) skewX(-7deg); }
}

/* the visible light: soft bars, screen-blended so overlapping curtains
 * brighten each other; each undulates on its own slow phase */
.glow { position: absolute; inset: 0; border-radius: 50%; mix-blend-mode: screen; }
.g1 {
  background: linear-gradient(90deg,
    transparent 0%, transparent 22%,
    rgba(238, 238, 238, 0.95) 50%,
    transparent 78%, transparent 100%);
  opacity: calc(var(--ramp, 100%) * 0.5);
  animation: wave1 5.4s ease-in-out infinite;
}
.g2 {
  background: linear-gradient(90deg,
    transparent 0%, transparent 28%,
    rgba(218, 92, 44, 0.95) 54%,
    transparent 82%, transparent 100%);
  opacity: calc(var(--ramp, 100%) * 0.45);
  animation: wave2 6.8s ease-in-out infinite;
}
.g3 {
  background: linear-gradient(90deg,
    transparent 0%, transparent 26%,
    rgba(238, 238, 238, 0.6) 46%,
    rgba(218, 92, 44, 0.5) 60%,
    transparent 86%, transparent 100%);
  opacity: calc(var(--ramp, 100%) * 0.4);
  animation: wave1 8.2s ease-in-out infinite reverse;
}

@keyframes wave1 {
  0%, 100% { transform: translateY(calc(4% * var(--ramp, 1))) rotate(1.2deg) scaleY(1); }
  50%      { transform: translateY(calc(-4% * var(--ramp, 1))) rotate(-1.2deg) scaleY(1.14); }
}
@keyframes wave2 {
  0%, 100% { transform: translateY(calc(-3% * var(--ramp, 1))) rotate(-1deg) scaleY(1.08); }
  50%      { transform: translateY(calc(5% * var(--ramp, 1))) rotate(1.6deg) scaleY(0.92); }
}

/* reduced motion: curtains still, faint glow remains */
@media (prefers-reduced-motion: reduce) {
  .rib, .glow { animation: none; }
}
</style>
