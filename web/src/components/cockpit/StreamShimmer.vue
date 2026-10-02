<script setup lang="ts">
/** StreamShimmer — variant B "aurora veil" from sketch 023: two soft light
 *  veils drifting behind a scanline veil while the device stream connects.
 *  The two veils WANDER — long 13s/17s multi-waypoint loops (curved stroll,
 *  ease-in-out legs, never synchronous) so the light roams around the
 *  screen smoothly. REACTIVE: a --ramp var eases in over the first 1.5s
 *  (quick connects stay subtle) and scales both opacity and travel; frozen
 *  under prefers-reduced-motion. No caption — the motion is the message. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{ state: string }>();

const visible = computed((): boolean => props.state === 'connecting' || props.state === 'reconnecting');



// ramp: 0 → 1 over the first 1.5s visible (ease-out). Applied as a CSS var
// multiplying veil opacity + drift distance — quick connects stay subtle,
// long connects reach full presence.
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
onMounted(() => { void 0; });
const rampPct = computed((): string => `${Math.round(ramp.value * 100)}%`);
</script>

<template>
  <div v-if="visible" class="shimmer" :style="{ '--ramp': rampPct }">
    <div class="veil cool"></div>
    <div class="veil warm"></div>
    <div class="scan"></div>
  </div>
</template>

<style scoped>
.shimmer { position: absolute; inset: 0; overflow: hidden; background: var(--color-void); z-index: 1; }

/* aurora veils — opacity scales with the reactive ramp */
.veil { position: absolute; width: 150%; height: 75%; filter: blur(42px); border-radius: 50%; will-change: transform; }
.veil.cool { top: -20%; left: -35%; background: radial-gradient(closest-side, var(--color-paper), transparent 70%);
  opacity: calc(var(--ramp, 100%) * 0.22);
  animation: wander1 13s ease-in-out infinite; }
.veil.warm { bottom: -24%; right: -36%; background: radial-gradient(closest-side, var(--color-ember), transparent 72%);
  opacity: calc(var(--ramp, 100%) * 0.18);
  animation: wander2 17s ease-in-out infinite; }

/* TRUE wander: a closed ORBIT through 6 spread waypoints — the light
 * circuits the screen area continuously (counter-clockwise cool,
 * clockwise warm), never retracing, never pausing at an 'end'. The
 * loop closes only across the last→first leg, which is a short step
 * (not a big return sweep), so there is no ping-pong read. */
@keyframes wander1 {
  0%   { transform: translate(calc(0% * var(--ramp, 1)),   calc(0% * var(--ramp, 1)))   rotate(-5deg) scale(1); }
  16%  { transform: translate(calc(18% * var(--ramp, 1)),  calc(6% * var(--ramp, 1)))   rotate(0deg)  scale(1.1); }
  33%  { transform: translate(calc(22% * var(--ramp, 1)),  calc(22% * var(--ramp, 1)))  rotate(5deg)  scale(0.95); }
  50%  { transform: translate(calc(6% * var(--ramp, 1)),   calc(34% * var(--ramp, 1)))  rotate(9deg)  scale(1.06); }
  66%  { transform: translate(calc(-16% * var(--ramp, 1)), calc(26% * var(--ramp, 1)))  rotate(4deg)  scale(1.12); }
  83%  { transform: translate(calc(-20% * var(--ramp, 1)), calc(8% * var(--ramp, 1)))   rotate(-2deg) scale(1.02); }
  100% { transform: translate(0, 0) rotate(-5deg) scale(1); }
}
@keyframes wander2 {
  0%   { transform: translate(0, 0) rotate(6deg) scale(1.04); }
  16%  { transform: translate(calc(-14% * var(--ramp, 1)), calc(-6% * var(--ramp, 1)))  rotate(2deg)  scale(0.94); }
  33%  { transform: translate(calc(-20% * var(--ramp, 1)), calc(-22% * var(--ramp, 1))) rotate(-4deg) scale(1.1); }
  50%  { transform: translate(calc(-4% * var(--ramp, 1)),  calc(-32% * var(--ramp, 1))) rotate(-8deg) scale(1.16); }
  66%  { transform: translate(calc(14% * var(--ramp, 1)),  calc(-20% * var(--ramp, 1))) rotate(-2deg) scale(1); }
  83%  { transform: translate(calc(18% * var(--ramp, 1)),  calc(-6% * var(--ramp, 1)))  rotate(3deg)  scale(1.08); }
  100% { transform: translate(0, 0) rotate(6deg) scale(1.04); }
}

/* fine scanlines — a hint of signal */
.scan { position: absolute; inset: 0;
  background: repeating-linear-gradient(0deg, transparent 0 3px, rgba(0, 0, 0, .22) 3px 4px);
  pointer-events: none; }

/* reduced motion: veils still */
@media (prefers-reduced-motion: reduce) {
  .veil { animation: none; }
}
</style>
