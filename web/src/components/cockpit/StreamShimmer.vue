<script setup lang="ts">
/** StreamShimmer — the operator's reference aurora
 *  (attachments/aurora.html), with one performance fix: the reference
 *  animates `left` (layout — reflows every frame) alongside the transform
 *  wave; in the stream overlay that shows as stutter. The horizontal drift
 *  is folded into the wave keyframes as translateX (same distances,
 *  converted to element-width %) so each band runs ONE compositor-only
 *  transform animation. Everything else is the reference verbatim. The only
 *  integration is visibility (connecting/reconnecting). */
import { computed } from 'vue';

const props = defineProps<{ state: string }>();

const visible = computed((): boolean => props.state === 'connecting' || props.state === 'reconnecting');
</script>

<template>
  <div v-if="visible" class="shimmer">
    <div class="scene">
      <div class="aurora">
        <div class="aurora__band"></div>
        <div class="aurora__band"></div>
        <div class="aurora__band"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shimmer { position: absolute; inset: 0; z-index: 1; overflow: hidden; }

.scene {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: radial-gradient(
    circle at 50% 100%,
    #12203a 0%,
    #070b16 45%,
    #02040a 100%
  );
}

.aurora {
  position: absolute;
  inset: 0;
  filter: blur(50px) saturate(140%);
}

.aurora__band {
  position: absolute;
  width: 140%;
  height: 38%;
  left: -20%;
  border-radius: 50%;
  mix-blend-mode: screen;
  opacity: 0.75;
  transform-origin: center;
}

.aurora__band:nth-child(1) {
  top: 8%;
  /* drift folded into the wave keyframes (compositor-only; see note below) */
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(0, 255, 170, 0.15) 20%,
    rgba(0, 255, 200, 0.85) 40%,
    rgba(90, 255, 220, 0.7) 58%,
    rgba(90, 140, 255, 0.45) 75%,
    transparent 100%
  );

  animation: wave-one 7.5s ease-in-out infinite alternate;
}

.aurora__band:nth-child(2) {
  top: 25%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(80, 120, 255, 0.15) 18%,
    rgba(120, 110, 255, 0.7) 38%,
    rgba(180, 90, 255, 0.65) 58%,
    rgba(255, 100, 210, 0.28) 78%,
    transparent 100%
  );

  opacity: 0.6;

  animation: wave-two 9.5s ease-in-out infinite alternate;
}

.aurora__band:nth-child(3) {
  top: 42%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(0, 255, 180, 0.08) 20%,
    rgba(0, 255, 170, 0.45) 40%,
    rgba(70, 255, 230, 0.7) 60%,
    rgba(70, 130, 255, 0.3) 78%,
    transparent 100%
  );

  opacity: 0.5;

  animation: wave-three 7s ease-in-out infinite alternate;
}

.aurora::after {
  content: "";
  position: absolute;
  width: 80%;
  height: 45%;
  left: 10%;
  top: 15%;

  background: radial-gradient(
    ellipse,
    rgba(0, 255, 190, 0.18),
    transparent 70%
  );

  filter: blur(80px);

  animation: glow 6s ease-in-out infinite alternate;
}

/* waves now carry the horizontal drift too (translateX) — ONE transform
 * animation per band, compositor-only. The reference animated `left`
 * (a layout property) alongside the transform wave; in the smaller
 * stream overlay that reflow-every-frame shows as stutter. Distances are
 * the reference's drift spans converted from containing-block % to the
 * element's own width. */
@keyframes wave-one {
  0% {
    transform:
      translateX(-8.57%)
      translateY(0)
      skewY(-6deg)
      scaleY(0.85)
      rotate(-3deg);
  }

  50% {
    transform:
      translateX(0%)
      translateY(45px)
      skewY(8deg)
      scaleY(1.2)
      rotate(2deg);
  }

  100% {
    transform:
      translateX(8.57%)
      translateY(-10px)
      skewY(-3deg)
      scaleY(0.95)
      rotate(-5deg);
  }
}

@keyframes wave-two {
  0% {
    transform:
      translateX(5%)
      translateY(25px)
      skewY(6deg)
      scaleY(1.1)
      rotate(4deg);
  }

  50% {
    transform:
      translateX(0%)
      translateY(-30px)
      skewY(-9deg)
      scaleY(0.75)
      rotate(-2deg);
  }

  100% {
    transform:
      translateX(-5%)
      translateY(20px)
      skewY(4deg)
      scaleY(1.15)
      rotate(3deg);
  }
}

@keyframes wave-three {
  0% {
    transform:
      translateX(-7.86%)
      translateY(-15px)
      skewY(-5deg)
      scaleY(0.8);
  }

  50% {
    transform:
      translateX(0%)
      translateY(30px)
      skewY(7deg)
      scaleY(1.08);
  }

  100% {
    transform:
      translateX(7.86%)
      translateY(-5px)
      skewY(-2deg)
      scaleY(0.9);
  }
}

@keyframes glow {
  from {
    opacity: 0.3;
    transform: scale(0.9);
  }

  to {
    opacity: 0.75;
    transform: scale(1.2);
  }
}

@media (prefers-reduced-motion: reduce) {
  .aurora__band,
  .aurora::after {
    animation: none;
  }
}
</style>
