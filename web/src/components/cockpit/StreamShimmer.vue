<script setup lang="ts">
/** StreamShimmer — AURORA loading, rebuilt around how auroras actually MOVE:
 *  the light does not travel across the screen — it hangs like a curtain
 *  from the top and SHIMMERS. Composition (mirrors a real aurora curtain):
 *    sky    — soft vertical light field (paper + ember), strongest up top,
 *             fading toward the bottom (light hangs from the sky)
 *    rays   — fine vertical striations leaning ~10°, marching exactly one
 *             stripe-period per loop (seamless eternal drift, no jump, no
 *             return sweep), masked to fade at top and bottom — the
 *             classic auroral rays rippling through the curtain
 *    pulse  — two glow regions that brighten/dim IN PLACE on offset
 *             phases — the light dancing within the curtain
 *    sway   — the whole curtain sways ±2° from its top attachment, like
 *             fabric in slow wind
 *  REACTIVE: --ramp eases in over 1.5s and scales opacity + sway + pulse
 *  amplitude. Frozen under prefers-reduced-motion. No caption. */
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps<{ state: string }>();

const visible = computed((): boolean => props.state === 'connecting' || props.state === 'reconnecting');

// ramp: 0 → 1 over the first 1.5s visible (ease-out) — quick connects stay
// subtle, long connects bloom. Scales opacities and motion amplitudes.
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
    <div class="curtain">
      <div class="sky"></div>
      <div class="hem"></div>
      <div class="rays"></div>
      <div class="rays2"></div>
      <div class="pulse p1"></div>
      <div class="pulse p2"></div>
    </div>
  </div>
</template>

<style scoped>
.shimmer { position: absolute; inset: 0; overflow: hidden; background: var(--color-void); z-index: 1; }

/* the curtain hangs from the top edge and sways around that attachment */
.curtain {
  position: absolute; inset: 0;
  transform-origin: 50% 0%;
  animation: sway 11s ease-in-out infinite alternate;
}
@keyframes sway {
  from { transform: rotate(calc(-1.6deg * var(--ramp, 1))) translateX(calc(-2% * var(--ramp, 1))); }
  to   { transform: rotate(calc(1.8deg * var(--ramp, 1))) translateX(calc(2% * var(--ramp, 1))); }
}

/* sky: the soft light field — strongest in the upper third, fading down
 * (auroras hang from the sky), paper tinted with ember */
.sky {
  position: absolute; inset: 0;
  background: linear-gradient(180deg,
    rgba(238, 238, 238, 0.30) 0%,
    rgba(238, 238, 238, 0.22) 16%,
    rgba(218, 92, 44, 0.30) 38%,
    rgba(238, 238, 238, 0.12) 60%,
    transparent 82%);
  filter: blur(18px);
}
/* the curtain's lower edge: a WAVY glowing hem the light drapes to —
 * folded-sheet boundary, animated slowly so the sheet undulates */
.hem {
  position: absolute; left: -12%; right: -12%; top: 40%; height: 26%;
  background:
    repeating-linear-gradient(90deg,
      rgba(238, 238, 238, 0.55) 0px, rgba(218, 92, 44, 0.45) 10px,
      rgba(238, 238, 238, 0.30) 20px, transparent 34px, transparent 56px);
  filter: blur(9px);
  -webkit-mask-image: linear-gradient(180deg, #000 0%, rgba(0,0,0,.55) 45%, transparent 85%);
  mask-image: linear-gradient(180deg, #000 0%, rgba(0,0,0,.55) 45%, transparent 85%);
  border-radius: 0;
  transform-origin: 50% 0%;
  animation: hemwave 8s ease-in-out infinite;
}
@keyframes hemwave {
  0%, 100% { transform: skewX(4deg) scaleY(1) translateY(0) rotate(0.5deg); }
  33%      { transform: skewX(-5deg) scaleY(1.18) translateY(4%) rotate(-0.8deg); }
  66%      { transform: skewX(3deg) scaleY(0.9) translateY(-3%) rotate(0.6deg); }
}

/* rays: fine vertical striations leaning like auroral rays. They march
 * horizontally EXACTLY one repeat-period per loop (44px) — a seamless
 * eternal drift with no jump and no return sweep. */
.rays {
  position: absolute; inset: -10% -15%;
  background:
    repeating-linear-gradient(90deg,
      transparent 0px, transparent 7px,
      rgba(238, 238, 238, 0.30) 9px,
      rgba(238, 238, 238, 0.08) 14px,
      transparent 18px, transparent 22px),
    repeating-linear-gradient(90deg,
      transparent 0px, transparent 15px,
      rgba(218, 92, 44, 0.14) 18px,
      transparent 26px, transparent 37px);
  transform: skewX(-10deg);
  filter: blur(2.5px);
  -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 22%, #000 55%, transparent 88%);
  mask-image: linear-gradient(180deg, transparent 0%, #000 22%, #000 55%, transparent 88%);
  opacity: calc(var(--ramp, 100%) * 0.9);
  animation: raymarch 9s linear infinite;
}
@keyframes raymarch {
  from { translate: 0 0; }
  to   { translate: 22px 0; }   /* exactly one fine-ray period — seamless */
}

.rays2 {
  position: absolute; inset: -10% -15%;
  background: repeating-linear-gradient(90deg,
    transparent 0px, transparent 21px,
    rgba(238, 238, 238, 0.10) 25px,
    transparent 31px, transparent 52px);
  transform: skewX(-14deg);
  filter: blur(9px);
  -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 30%, #000 60%, transparent 90%);
  mask-image: linear-gradient(180deg, transparent 0%, #000 30%, #000 60%, transparent 90%);
  opacity: calc(var(--ramp, 100%) * 0.7);
  animation: raymarch2 14s linear infinite;
}
@keyframes raymarch2 {
  from { translate: 0 0; }
  to   { translate: 52px 0; }   /* one period of the deep layer — seamless */
}

/* pulses: regions that brighten and dim IN PLACE — the light dancing
 * within the curtain, not moving across it */
.pulse {
  position: absolute; width: 85%; height: 38%;
  border-radius: 50%;
  filter: blur(30px);
  mix-blend-mode: screen;
}
.p1 {
  top: 4%; left: -12%;
  background: radial-gradient(closest-side, rgba(238, 238, 238, 0.65), transparent 70%);
  animation: breathe1 4.6s ease-in-out infinite;
}
.p2 {
  top: 26%; right: -16%;
  background: radial-gradient(closest-side, rgba(218, 92, 44, 0.7), transparent 70%);
  animation: breathe2 6.4s ease-in-out infinite;
}
@keyframes breathe1 {
  0%, 100% { opacity: calc(var(--ramp, 100%) * 0.30); transform: scale(1); }
  50%      { opacity: calc(var(--ramp, 100%) * 0.85); transform: scale(calc(1 + 0.25 * var(--ramp, 1))); }
}
@keyframes breathe2 {
  0%, 100% { opacity: calc(var(--ramp, 100%) * 0.85); transform: scale(calc(1 + 0.18 * var(--ramp, 1))); }
  50%      { opacity: calc(var(--ramp, 100%) * 0.25); transform: scale(0.9); }
}

/* reduced motion: everything stills; the sky + rays pattern remains */
@media (prefers-reduced-motion: reduce) {
  .curtain, .rays, .pulse { animation: none; }
}
</style>
