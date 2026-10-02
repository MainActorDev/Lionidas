<script setup lang="ts">
/** StreamShimmer — variant B "aurora veil" from sketch 023: two soft light
 *  veils drifting behind a scanline veil while the device stream connects.
 *  REACTIVE: veil drift intensity eases with elapsed connecting time (first
 *  1.5s calm ramp-in so brief reconnects don't flash), the caption tracks
 *  the real stream state, and everything freezes to a still breathing state
 *  under prefers-reduced-motion. Pure CSS animation; reactive timing via a
 *  CSS variable driven by the component (no rAF loop while visible). */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{ state: string }>();

const visible = computed((): boolean => props.state === 'connecting' || props.state === 'reconnecting');

const caption = computed((): string => {
  if (props.state === 'reconnecting') return 'stream reconnecting';
  return 'stream connecting';
});

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
    <div class="status">stream <em>{{ caption.replace('stream ', '') }}</em></div>
  </div>
</template>

<style scoped>
.shimmer { position: absolute; inset: 0; overflow: hidden; background: var(--color-void); z-index: 1; }

/* aurora veils — opacity scales with the reactive ramp */
.veil { position: absolute; width: 160%; height: 70%; filter: blur(38px); border-radius: 50%;
  opacity: calc(var(--ramp, 100%) * 0.22); }
.veil.cool { top: -18%; left: -30%; background: radial-gradient(closest-side, var(--color-paper), transparent 70%);
  animation: drift1 5.2s ease-in-out infinite alternate; }
.veil.warm { bottom: -22%; right: -34%; background: radial-gradient(closest-side, var(--color-ember), transparent 72%);
  animation: drift2 6.8s ease-in-out infinite alternate; opacity: calc(var(--ramp, 100%) * 0.18); }
@keyframes drift1 {
  from { transform: translate(calc(-8% * var(--ramp, 1)), 0) rotate(-6deg) scale(1); }
  to   { transform: translate(calc(14% * var(--ramp, 1)), calc(10% * var(--ramp, 1))) rotate(4deg) scale(1.15); }
}
@keyframes drift2 {
  from { transform: translate(calc(10% * var(--ramp, 1)), 0) rotate(8deg) scale(1.1); }
  to   { transform: translate(calc(-12% * var(--ramp, 1)), calc(-12% * var(--ramp, 1))) rotate(-4deg) scale(0.95); }
}

/* fine scanlines — a hint of signal */
.scan { position: absolute; inset: 0;
  background: repeating-linear-gradient(0deg, transparent 0 3px, rgba(0, 0, 0, .22) 3px 4px);
  pointer-events: none; }

.status { position: absolute; bottom: 18px; left: 0; right: 0; text-align: center;
  color: var(--color-steel); font-size: 10px; letter-spacing: .14em; text-transform: uppercase; }
.status em { color: var(--color-ember); font-style: normal; animation: breathe 1.6s ease-in-out infinite; }
@keyframes breathe { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }

/* reduced motion: veils still, caption keeps the (opacity-only) breathe */
@media (prefers-reduced-motion: reduce) {
  .veil { animation: none; }
  .status em { animation-duration: 3s; }
}
</style>
