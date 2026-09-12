/** Inspector properties rail (A2 design, FINAL): Figma-style readout for the
 *  selected node. Exact facts plain; sampled facts carry (est.) + the source
 *  legend; absence renders "—". Compact width 196px on the sidebar surface. */
<script setup lang="ts">
import { computed, type PropType } from 'vue';
import type { AxNode } from '@crucible/shared/ax-tree';

const props = defineProps({
  node: { type: Object as PropType<AxNode | null>, default: null },
  parent: { type: Object as PropType<AxNode | null>, default: null },
  siblings: { type: Array as PropType<AxNode[]>, default: () => [] },
  sample: {
    type: Object as PropType<{
      text: { color: string | null; token: string | null; sizePt: number | null } | null;
      fill: { color: string; token: string | null } | null;
      radius: { pt: number } | null;
      scale: number;
      capturedAt: number;
    } | null>,
    default: null,
  },
  loading: { type: Boolean, default: false },
  failed: { type: Boolean, default: false },
  showEstimates: { type: Boolean, default: true },
  compact: { type: Boolean, default: false },
});

const dash = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : String(Math.round(v));

const rect = computed(() => props.node?.rect ?? null);
/** estimates OFF → sampled rows render "—" (values withheld, geometry stays) */
const shown = computed(() => (props.showEstimates ? props.sample : null));
const est = (on: boolean): string => (on && props.showEstimates ? ' (est.)' : '');
const hexDot = (c: string | null | undefined): string | null =>
  c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null;
const tokenLabel = (t: string | null | undefined): string | null =>
  props.showEstimates ? (t ?? null) : null;
</script>

<template>
  <aside class="iprops" :class="{ compact }" aria-label="Inspector properties">
    <template v-if="node">
      <header class="ihead">
        <span class="itype">{{ node.type }}</span>
        <span v-if="node.identifier" class="iid">{{ node.identifier }}</span>
      </header>
      <p v-if="node.label" class="ilabel">{{ node.label }}</p>

      <!-- GEOMETRY — exact (AX rects) -->
      <section>
        <h4>Layout <span class="src">◆ exact</span></h4>
        <div class="grid">
          <span class="k">x</span><span class="v">{{ dash(rect?.x) }}</span>
          <span class="k">y</span><span class="v">{{ dash(rect?.y) }}</span>
          <span class="k">w</span><span class="v">{{ dash(rect?.width) }}</span>
          <span class="k">h</span><span class="v">{{ dash(rect?.height) }}</span>
        </div>
        <div v-if="parent && parent.rect && rect" class="grid">
          <span class="k">pad T</span><span class="v">{{ dash(rect.y - parent.rect.y) }}</span>
          <span class="k">L</span><span class="v">{{ dash(rect.x - parent.rect.x) }}</span>
          <span class="k">R</span><span class="v">{{ dash(parent.rect.x + parent.rect.width - (rect.x + rect.width)) }}</span>
          <span class="k">B</span><span class="v">{{ dash(parent.rect.y + parent.rect.height - (rect.y + rect.height)) }}</span>
        </div>
      </section>

      <!-- TYPE — mixed: size/color sampled; weight/family honest "—" -->
      <section v-if="shown?.text || node.label !== undefined">
        <h4>Type <span class="src">◌ sampled</span></h4>
        <div class="grid">
          <span class="k">size</span>
          <span class="v">
            <template v-if="shown?.text?.sizePt != null">{{ shown!.text!.sizePt }}{{ est(true) }}</template>
            <template v-else>—</template>
          </span>
          <span class="k">color</span>
          <span class="v">
            <template v-if="shown?.text?.color">
              <i v-if="hexDot(shown!.text!.color)" class="dot" :style="{ background: hexDot(shown!.text!.color)! }" />
              {{ shown!.text!.color }}{{ est(true) }}
            </template>
            <template v-else>—</template>
          </span>
          <template v-if="tokenLabel(shown?.text?.token)">
            <span class="k">token</span><span class="v tok">{{ tokenLabel(shown?.text?.token) }}</span>
          </template>
          <span class="k">weight</span><span class="v">—</span>
          <span class="k">family</span><span class="v">—</span>
        </div>
      </section>

      <!-- PAINT — sampled fill + radius -->
      <section>
        <h4>Paint <span class="src">◌ sampled</span></h4>
        <div class="grid">
          <span class="k">fill</span>
          <span class="v">
            <template v-if="shown?.fill?.color">
              <i v-if="hexDot(shown!.fill!.color)" class="dot" :style="{ background: hexDot(shown!.fill!.color)! }" />
              {{ shown!.fill!.color }}{{ est(true) }}
            </template>
            <template v-else>—</template>
          </span>
          <template v-if="tokenLabel(shown?.fill?.token)">
            <span class="k">token</span><span class="v tok">{{ tokenLabel(shown?.fill?.token) }}</span>
          </template>
          <span class="k">radius</span>
          <span class="v">
            <template v-if="shown?.radius">{{ shown!.radius!.pt }}{{ est(true) }}</template>
            <template v-else>—</template>
          </span>
        </div>
      </section>

      <p v-if="loading" class="state">sampling…</p>
      <p v-else-if="failed" class="state err">sampling failed — values above are geometry only</p>
      <p v-if="!showEstimates" class="state">estimates hidden — "—" = not sampled</p>
    </template>
    <p v-else class="state empty">select an element to inspect</p>
  </aside>
</template>

<style scoped>
.iprops {
  width: 272px;
  flex: none;
  overflow-y: auto;
  padding: 12px 14px;
  background: var(--color-carbon, #111);
  border-left: 1px solid var(--color-iron, #222);
  font: 400 12px var(--font-ui, ui-sans-serif);
  color: var(--color-mist, #9aa4b2);
  line-height: 1.4;
}
.iprops.compact { width: 196px; }
.ihead { display: flex; flex-direction: column; gap: 2px; margin-bottom: 4px; }
.itype { color: var(--color-snow, #e8edf4); font-weight: 600; font-size: 12px; }
.iid { color: var(--color-ember, #ff9f40); font: 500 10px var(--font-mono, ui-monospace); word-break: break-all; }
.ilabel { margin: 0 0 10px; color: var(--color-mist, #9aa4b2); font-size: 11px; }
section { margin-top: 12px; }
h4 {
  margin: 0 0 6px;
  font: 600 10px var(--font-ui, ui-sans-serif);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-snow, #e8edf4);
}
.src { float: right; font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--color-mist, #6b7686); }
.grid {
  display: grid;
  grid-template-columns: 52px 1fr;
  row-gap: 3px;
}
.k { color: var(--color-ash, #6b7686); }
.v { color: var(--color-snow, #c9d3e0); font-variant-numeric: tabular-nums; }
.v.tok { color: var(--color-ember, #ff9f40); font-size: 11px; }
.dot {
  display: inline-block;
  width: 9px; height: 9px;
  border-radius: 3px;
  border: 1px solid var(--color-iron, #333);
  margin-right: 5px;
  vertical-align: -1px;
}
.state { margin-top: 12px; font-size: 10px; color: var(--color-ash, #6b7686); }
.state.err { color: #ff7a7a; }
.state.empty { margin-top: 24px; text-align: center; }
</style>
