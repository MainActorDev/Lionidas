/** Element hierarchy (Figma-layers style): the AX tree as an indented list.
 *  Bidirectional — clicking a row selects that node on the stream; the row
 *  matching the current selection highlights + its ancestry auto-expands.
 *  Collapsed by default (screens carry 60+ nodes; depth-first open = noise). */
<script setup lang="ts">
import { computed, ref, watch, type PropType } from 'vue';
import type { AxNode } from '@crucible/shared/ax-tree';

interface Row { node: AxNode; depth: number; hasKids: boolean; }

const props = defineProps({
  nodes: { type: Array as PropType<AxNode[]>, default: () => [] },
  selected: { type: Object as PropType<AxNode | null>, default: null },
});
const emit = defineEmits<{ (e: 'pick', node: AxNode): void }>();

const open = ref(new Set<number>());

/** children by parentIndex — orphans (missing parent) attach to the root */
const rows = computed<Row[]>(() => {
  const kids = new Map<number, AxNode[]>();
  const roots: AxNode[] = [];
  for (const n of props.nodes) {
    const p = n.parentIndex;
    if (p === undefined || p === null || !props.nodes.some((m) => m.index === p)) roots.push(n);
    else {
      const list = kids.get(p) ?? [];
      list.push(n);
      kids.set(p, list);
    }
  }
  const out: Row[] = [];
  const walk = (n: AxNode, depth: number): void => {
    const children = kids.get(n.index ?? -1) ?? [];
    out.push({ node: n, depth, hasKids: children.length > 0 });
    if (open.value.has(n.index ?? -1)) for (const c of children) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
});

/** selecting a node expands its ancestry so it's visible in the list */
watch(() => props.selected, (sel) => {
  if (!sel) return;
  const chain = new Set<number>();
  let cur: AxNode | undefined = sel;
  while (cur?.parentIndex !== undefined && cur.parentIndex !== null) {
    chain.add(cur.parentIndex);
    cur = props.nodes.find((n) => n.index === cur?.parentIndex);
    if (chain.has(cur?.index ?? -1)) break; // cycle guard
  }
  if (chain.size) open.value = new Set([...open.value, ...chain]);
}, { immediate: true });

const frame = (n: AxNode): string =>
  n.rect ? `(${Math.round(n.rect.x)} ${Math.round(n.rect.y)}; ${Math.round(n.rect.width)}×${Math.round(n.rect.height)})` : '';
const rowTitle = (n: AxNode): string =>
  `${n.type ?? 'Other'}${n.identifier ? ': ' + n.identifier : ''}${n.label ? '; label = ' + n.label : ''}${frame(n) ? '; frame = ' + frame(n) : ''}`;

const toggle = (idx: number): void => {
  const next = new Set(open.value);
  if (next.has(idx)) next.delete(idx); else next.add(idx);
  open.value = next;
};
const isSel = (n: AxNode): boolean =>
  !!props.selected && n.index !== undefined && props.selected.index === n.index;
</script>

<template>
  <div class="tree-view" aria-label="Element hierarchy">
    <button v-for="r in rows" :key="r.node.index ?? r.depth" class="trow"
      :class="{ sel: isSel(r.node) }" :style="{ paddingLeft: `${6 + r.depth * 12}px` }"
      :title="rowTitle(r.node)"
      @click="emit('pick', r.node)">
      <span class="twist" :class="{ leaf: !r.hasKids, open: open.has(r.node.index ?? -1) }"
        @click.stop="r.hasKids && toggle(r.node.index ?? -1)">▸</span>
      <span class="ttype">{{ r.node.type ?? 'Other' }}</span>
      <span v-if="r.node.label" class="tlabel">"{{ r.node.label }}"</span>
      <span class="tframe">{{ frame(r.node) }}</span>
    </button>
    <p v-if="!rows.length" class="tempty">no elements — waiting for the tree</p>
  </div>
</template>

<style scoped>
.tree-view { display: flex; flex-direction: column; gap: 1px; max-height: 260px; overflow-y: auto; }
.trow {
  display: flex; align-items: baseline; gap: 6px;
  padding: 2px 6px; border: none; background: none; cursor: pointer;
  font-family: var(--font-mono); font-size: 10px; color: var(--color-fog);
  text-align: left; min-width: 0;
}
.trow:hover { background: var(--color-graphite); color: var(--color-paper); }
.trow.sel { background: var(--color-graphite); color: var(--color-paper); border-left: 2px solid var(--color-ember); padding-left: 4px; }
.twist { color: var(--color-steel); width: 10px; flex: none; font-size: 8px; cursor: pointer; user-select: none; }
.twist.leaf { visibility: hidden; }
.twist.open { transform: rotate(90deg); display: inline-block; }
.ttype { color: var(--color-chalk); flex: none; }
.tlabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-fog); }
.tframe { margin-left: auto; flex: none; color: var(--color-steel); font-variant-numeric: tabular-nums; }
.tempty { font-size: 10px; color: var(--color-steel); padding: 6px; }
</style>
