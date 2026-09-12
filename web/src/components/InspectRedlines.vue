/** Inspect redlines: Figma-style spacing measures (padding to parent, gaps to
 *  siblings) painted in the SAME viewBox as the selection ring — one transform,
 *  zero drift. Pure SVG, pointer-events:none. Absent facts paint nothing. */
<script setup lang="ts">
import { computed, type PropType } from 'vue';
import { paddingToParent, siblingGaps } from '@crucible/shared/inspect-geometry';
import type { AxNode } from '@crucible/shared/ax-tree';

const props = defineProps({
  selected: { type: Object as PropType<AxNode | null>, default: null },
  parent: { type: Object as PropType<AxNode | null>, default: null },
  siblings: { type: Array as PropType<AxNode[]>, default: () => [] },
  /** 'inspect' → padding redlines | 'measure' → sibling gaps */
  mode: { type: String as PropType<'inspect' | 'measure'>, default: 'inspect' },
  visible: { type: Boolean, default: false },
  logicalW: { type: Number as PropType<number | null>, default: null },
  logicalH: { type: Number as PropType<number | null>, default: null },
});

const CAP = 14;  // cap half-length in viewBox units (logical pt)

const pad = computed(() =>
  props.visible && props.mode === 'inspect' && props.selected
    ? paddingToParent(props.selected, props.parent) : null,
);
const gaps = computed(() =>
  props.visible && props.mode === 'measure' && props.selected
    ? siblingGaps(props.selected, props.siblings) : null,
);
</script>

<template>
  <svg v-if="visible && selected && selected.rect && logicalW && logicalH" class="inspect-redlines"
       :viewBox="`0 0 ${logicalW} ${logicalH}`" preserveAspectRatio="none" aria-hidden="true">
    <!-- PADDING: four measures from the selection to the parent's inner edges -->
    <template v-if="pad">
      <!-- left -->
      <g v-if="pad.left !== null && parent && parent.rect">
        <line class="measure" :x1="parent.rect.x" :y1="selected.rect.y + selected.rect.height / 2"
              :x2="selected.rect.x" :y2="selected.rect.y + selected.rect.height / 2" />
        <line class="cap" :x1="parent.rect.x" :y1="selected.rect.y + selected.rect.height / 2 - CAP"
              :x2="parent.rect.x" :y2="selected.rect.y + selected.rect.height / 2 + CAP" />
        <line class="cap" :x1="selected.rect.x" :y1="selected.rect.y + selected.rect.height / 2 - CAP"
              :x2="selected.rect.x" :y2="selected.rect.y + selected.rect.height / 2 + CAP" />
        <text class="val" :x="(parent.rect.x + selected.rect.x) / 2"
              :y="selected.rect.y + selected.rect.height / 2 - 4">{{ pad.left }}</text>
      </g>
      <!-- right -->
      <g v-if="pad.right !== null && parent && parent.rect">
        <line class="measure" :x1="selected.rect.x + selected.rect.width" :y1="selected.rect.y + selected.rect.height / 2"
              :x2="parent.rect.x + parent.rect.width" :y2="selected.rect.y + selected.rect.height / 2" />
        <line class="cap" :x1="parent.rect.x + parent.rect.width" :y1="selected.rect.y + selected.rect.height / 2 - CAP"
              :x2="parent.rect.x + parent.rect.width" :y2="selected.rect.y + selected.rect.height / 2 + CAP" />
        <text class="val" :x="(selected.rect.x + selected.rect.width + parent.rect.x + parent.rect.width) / 2"
              :y="selected.rect.y + selected.rect.height / 2 - 4">{{ pad.right }}</text>
      </g>
      <!-- top -->
      <g v-if="pad.top !== null && parent && parent.rect">
        <line class="measure" :x1="selected.rect.x + selected.rect.width / 2" :y1="parent.rect.y"
              :x2="selected.rect.x + selected.rect.width / 2" :y2="selected.rect.y" />
        <line class="cap" :x1="selected.rect.x + selected.rect.width / 2 - CAP" :y1="parent.rect.y"
              :x2="selected.rect.x + selected.rect.width / 2 + CAP" :y2="parent.rect.y" />
        <line class="cap" :x1="selected.rect.x + selected.rect.width / 2 - CAP" :y1="selected.rect.y"
              :x2="selected.rect.x + selected.rect.width / 2 + CAP" :y2="selected.rect.y" />
        <text class="val" :y="(parent.rect.y + selected.rect.y) / 2"
              :x="selected.rect.x + selected.rect.width / 2">{{ pad.top }}</text>
      </g>
      <!-- bottom -->
      <g v-if="pad.bottom !== null && parent && parent.rect">
        <line class="measure" :x1="selected.rect.x + selected.rect.width / 2" :y1="selected.rect.y + selected.rect.height"
              :x2="selected.rect.x + selected.rect.width / 2" :y2="parent.rect.y + parent.rect.height" />
        <line class="cap" :x1="selected.rect.x + selected.rect.width / 2 - CAP" :y1="parent.rect.y + parent.rect.height"
              :x2="selected.rect.x + selected.rect.width / 2 + CAP" :y2="parent.rect.y + parent.rect.height" />
        <text class="val" :y="(selected.rect.y + selected.rect.height + parent.rect.y + parent.rect.height) / 2"
              :x="selected.rect.x + selected.rect.width / 2">{{ pad.bottom }}</text>
      </g>
    </template>

    <!-- GAPS: prev/next in-flow sibling on the dominant axis -->
    <template v-if="gaps && selected.rect">
      <g v-if="gaps.axis === 'x'">
        <g v-if="gaps.prev !== null">
          <line class="measure" :x1="selected.rect.x - gaps.prev" :y1="selected.rect.y + selected.rect.height / 2"
                :x2="selected.rect.x" :y2="selected.rect.y + selected.rect.height / 2" />
          <line class="cap" :x1="selected.rect.x - gaps.prev" :y1="selected.rect.y + selected.rect.height / 2 - CAP"
                :x2="selected.rect.x - gaps.prev" :y2="selected.rect.y + selected.rect.height / 2 + CAP" />
          <text class="val" :x="selected.rect.x - gaps.prev / 2" :y="selected.rect.y + selected.rect.height / 2 - 4">{{ gaps.prev }}</text>
        </g>
        <g v-if="gaps.next !== null">
          <line class="measure" :x1="selected.rect.x + selected.rect.width" :y1="selected.rect.y + selected.rect.height / 2"
                :x2="selected.rect.x + selected.rect.width + gaps.next" :y2="selected.rect.y + selected.rect.height / 2" />
          <line class="cap" :x1="selected.rect.x + selected.rect.width + gaps.next" :y1="selected.rect.y + selected.rect.height / 2 - CAP"
                :x2="selected.rect.x + selected.rect.width + gaps.next" :y2="selected.rect.y + selected.rect.height / 2 + CAP" />
          <text class="val" :x="selected.rect.x + selected.rect.width + gaps.next / 2"
                :y="selected.rect.y + selected.rect.height / 2 - 4">{{ gaps.next }}</text>
        </g>
      </g>
      <g v-else>
        <g v-if="gaps.prev !== null">
          <line class="measure" :x1="selected.rect.x + selected.rect.width / 2" :y1="selected.rect.y - gaps.prev"
                :x2="selected.rect.x + selected.rect.width / 2" :y2="selected.rect.y" />
          <line class="cap" :x1="selected.rect.x + selected.rect.width / 2 - CAP" :y1="selected.rect.y - gaps.prev"
                :x2="selected.rect.x + selected.rect.width / 2 + CAP" :y2="selected.rect.y - gaps.prev" />
          <text class="val" :y="selected.rect.y - gaps.prev / 2" :x="selected.rect.x + selected.rect.width / 2">{{ gaps.prev }}</text>
        </g>
        <g v-if="gaps.next !== null">
          <line class="measure" :x1="selected.rect.x + selected.rect.width / 2" :y1="selected.rect.y + selected.rect.height"
                :x2="selected.rect.x + selected.rect.width / 2" :y2="selected.rect.y + selected.rect.height + gaps.next" />
          <line class="cap" :x1="selected.rect.x + selected.rect.width / 2 - CAP" :y1="selected.rect.y + selected.rect.height + gaps.next"
                :x2="selected.rect.x + selected.rect.width / 2 + CAP" :y2="selected.rect.y + selected.rect.height + gaps.next" />
          <text class="val" :y="selected.rect.y + selected.rect.height + gaps.next / 2" :x="selected.rect.x + selected.rect.width / 2">{{ gaps.next }}</text>
        </g>
      </g>
    </template>
  </svg>
</template>

<style scoped>
.inspect-redlines {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.measure {
  stroke: var(--color-ember, #ff9f40);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.cap {
  stroke: var(--color-ember, #ff9f40);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.val {
  fill: var(--color-ember, #ff9f40);
  font: 600 10px var(--font-ui, ui-sans-serif);
  text-anchor: middle;
  paint-order: stroke;
  stroke: rgba(0, 0, 0, 0.65);
  stroke-width: 3px;
}
</style>
