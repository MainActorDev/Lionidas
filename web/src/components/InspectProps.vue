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
  /** exact node facts + actions (drive surface folds the old drawer in here;
   *  absent props keep the sections hidden — sidebar surface unchanged) */
  hittable: { type: Boolean, default: undefined as unknown as boolean },
  path: { type: String, default: '' },
  selectorText: { type: String, default: '' },
  showActions: { type: Boolean, default: false },
  tapDisabled: { type: Boolean, default: false },
});
const emit = defineEmits<{ (e: 'tap'): void; (e: 'copy-selector'): void }>();

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

      <!-- EXACT extras folded from the old drive drawer (only when provided) -->
      <section v-if="hittable !== undefined || path || selectorText">
        <h4>Element <span class="src">◆ exact</span></h4>
        <div class="grid" v-if="hittable !== undefined">
          <span class="k">hittable</span><span class="v">{{ hittable ? 'yes' : 'no' }}</span>
        </div>
        <div v-if="path" class="path">{{ path }}</div>
        <div v-if="selectorText" class="grid">
          <span class="k">selector</span><span class="v tok">{{ selectorText }}</span>
        </div>
      </section>

      <div v-if="showActions" class="actions">
        <button class="btn btn-sm" @click="emit('copy-selector')">copy selector</button>
        <button class="btn btn-sm btn-primary" :disabled="tapDisabled" @click="emit('tap')">tap this</button>
      </div>
    </template>
    <p v-else class="state empty">select an element to inspect</p>
  </aside>
</template>

<style scoped>
/* Axiom tokens (web/src/styles/tokens.css): mono typography, steel→paper text,
   2px radius, ember only as accent. Keys uppercase left, values right. */
.iprops {
  width: 100%;
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 12px 14px;
  background: transparent;
  font-family: var(--font-mono);
  font-size: var(--text-caption);   /* 12px */
  color: var(--color-fog);
  line-height: var(--leading-normal);
}
/* compact (sidebar pane): the .tpane provides the padding — no own padding */
.iprops.compact { padding: 0; }
.ihead { display: flex; flex-direction: column; gap: 2px; margin-bottom: 4px; }
.itype { color: var(--color-paper); font-weight: var(--weight-bold); font-size: var(--text-caption); }
.iid { color: var(--color-ember); font-size: 10px; word-break: break-all; }
.ilabel { margin: 0 0 10px; color: var(--color-fog); font-size: var(--text-caption); }
section { margin-top: var(--s-3); }
h4 {
  margin: 0 0 6px;
  font: var(--weight-bold) 10px var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--color-paper);
  border-bottom: 1px solid var(--color-iron);
  padding-bottom: 3px;
}
.src { float: right; font-weight: var(--weight-regular); letter-spacing: 0; text-transform: none; color: var(--color-steel); }
.grid {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: var(--s-3);
  row-gap: 4px;
  align-items: baseline;
}
.k {
  color: var(--color-steel);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  white-space: nowrap;
}
.v {
  color: var(--color-chalk);
  font-size: var(--text-caption);
  font-variant-numeric: tabular-nums;
  text-align: right;
  word-break: break-all;
}
.v.tok { color: var(--color-ember); }
.dot {
  display: inline-block;
  width: 9px; height: 9px;
  border-radius: var(--r-sm);
  border: 1px solid var(--color-slate);
  margin-right: 5px;
  vertical-align: -1px;
}
.state { margin-top: var(--s-3); font-size: 10px; color: var(--color-ash); }
.state.err { color: var(--color-ember); }
.state.empty { margin-top: var(--s-5); text-align: center; }
.path { margin: 4px 0 6px; font-size: 10px; color: var(--color-ash); word-break: break-all; }
.actions { display: flex; gap: var(--s-2); margin-top: var(--s-3); }
.actions .btn { flex: 1; }
</style>
