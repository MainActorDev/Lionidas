/** Inspect overlay: Figma-style selection bounds over the live stream.
 *  Pure presentational — all hit-testing is done by the PARENT (math, not DOM
 *  events; see DrivePage) and passed down as hover/selected nodes. The SVG is
 *  pointer-events:none through and through: it annotates, the page decides.
 *  Sizing rides the SAME wrapper as the canvas — one transform, no drift. */
<script setup lang="ts">
import { computed, type PropType } from 'vue';
import { renderableNodes, type AxNode } from '@crucible/shared/ax-tree';

const props = defineProps({
  nodes: { type: Array as PropType<AxNode[]>, required: true },
  logicalW: { type: Number as PropType<number | null>, default: null },
  logicalH: { type: Number as PropType<number | null>, default: null },
  hover: { type: Object as PropType<AxNode | null>, default: null },
  selected: { type: Object as PropType<AxNode | null>, default: null },
  /** aligned = draw boxes; realigning/fetching/failed = hidden (honesty) */
  visible: { type: Boolean, default: false },
});

const boxes = computed(() => (props.visible ? renderableNodes(props.nodes) : []));
const hoverRect = computed(() => props.hover?.rect ?? null);
const selRect = computed(() => props.selected?.rect ?? null);
</script>

<template>
  <svg v-if="logicalW && logicalH" class="inspect-overlay" :viewBox="`0 0 ${logicalW} ${logicalH}`" preserveAspectRatio="none" aria-hidden="true">
    <!-- selection ring under hover so hover never hides the active selection;
         gated on visible like el-boxes — a stale rect must never paint while
         the tree is realigning (it gets re-resolved on the fresh array) -->
    <rect v-if="visible && selRect" class="sel-ring" :x="selRect.x" :y="selRect.y" :width="selRect.width" :height="selRect.height" />
    <rect v-for="n in boxes" :key="n.index" class="el-box"
      :x="n.rect!.x" :y="n.rect!.y" :width="n.rect!.width" :height="n.rect!.height" />
    <rect v-if="hoverRect && hoverRect !== selRect" class="hover-ring"
      :x="hoverRect.x" :y="hoverRect.y" :width="hoverRect.width" :height="hoverRect.height" />
  </svg>
</template>

<style scoped>
.inspect-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.el-box {
  fill: none;
  stroke: var(--color-accent, #6ea8fe);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  opacity: 0.35;
}
.hover-ring {
  fill: rgba(110, 168, 254, 0.08);
  stroke: var(--color-accent, #6ea8fe);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
.sel-ring {
  fill: rgba(255, 159, 64, 0.10);
  stroke: var(--color-ember, #e06f5d);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
</style>
