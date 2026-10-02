<script setup lang="ts">
/** ToolsDrawer — the cockpit INSPECT panel (redesigned): breadcrumb path of
 *  the selection, collapsible hierarchy tree, and a structured detail card
 *  (identity / geometry / paint / actions). Same logic as the old pane —
 *  useInspectTree lifecycle, hit-test clicks, tap-this, copy selector/spec,
 *  pixel sample; the STAGE owns the session, this drawer receives it. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { hitTestNodeAt, parentOf, siblingsOf, type AxNode } from '@crucible/shared/ax-tree';
import { useInspectTree, TreeFetchError, type TreeState } from '../../composables/useInspectTree.ts';
import { useInspectSample } from '../../composables/useInspectSample.ts';
import { canvasPointToLogical } from '../../composables/deviceStream.ts';
import InspectTree from '../InspectTree.vue';

const props = defineProps<{
  open: boolean;
  udid: string;
  sessionId: string | null;
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'inspect-enabled', on: boolean): void;
}>();

// ── tree lifecycle (fetch /tree, keep aligned to the stream, honest states) ──
const tree = useInspectTree(async (sid, signal) => {
  const res = await fetch(`/api/manual/${sid}/tree`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal,
  });
  if (!res.ok) {
    let code: string | undefined;
    try { code = ((await res.json()) as { code?: string }).code; } catch { /* non-json */ }
    throw new TreeFetchError(`tree ${res.status}`, res.status, code);
  }
  return (await res.json()) as { nodes: AxNode[]; logicalW: number | null; logicalH: number | null };
});
const inspect = computed((): boolean => tree.state.value !== 'off');
const selNode = ref<AxNode | null>(null);
const hoverNode = ref<AxNode | null>(null);
const selParent = computed((): AxNode | null => (selNode.value ? parentOf(tree.nodes.value, selNode.value) : null));
const selSiblings = computed((): AxNode[] => (selNode.value ? siblingsOf(tree.nodes.value, selNode.value) : []));

const sample = useInspectSample(computed(() => props.sessionId), selNode, tree.logicalW, computed(() => props.open));

watch(() => [props.open, props.sessionId] as const, ([open, sid]) => {
  if (open && sid) { if (!inspect.value) tree.enable(sid); }
  else tree.disable();
  if (!open) { selNode.value = null; treeOpen.value = true; }
});
watch(() => props.sessionId, (sid) => { if (sid && props.open) tree.enable(sid); });

let settleInterval = 0 as unknown as ReturnType<typeof setInterval>;
onMounted(() => {
  settleInterval = setInterval(() => { if (inspect.value) tree.tick(Date.now()); }, 1000);
});
onBeforeUnmount(() => { clearInterval(settleInterval); tree.disable(); });

watch(inspect, (on) => emit('inspect-enabled', on));

// picking a node collapses the tree so the detail card takes the space
const treeOpen = ref(true);
watch(selNode, (n) => { if (n) treeOpen.value = false; });

// stage canvas hit-test (page routes canvas clicks here)
function stageClick(e: MouseEvent): void {
  if (!props.open) return;
  const el = document.querySelector('.cockpit .stage canvas');
  if (!(el instanceof HTMLCanvasElement) || tree.state.value !== 'aligned') return;
  const { x, y } = canvasPointToLogical(el, e.clientX, e.clientY, tree.logicalW.value, tree.logicalH.value);
  selNode.value = hitTestNodeAt(tree.nodes.value, x, y);
}
defineExpose({ stageClick, tree, selection: selNode });

const stateLabel = computed((): string => {
  const s: TreeState = tree.state.value;
  if (s === 'aligned') return tree.animating.value ? 'aligned · animating' : 'aligned';
  return s;
});
const sessionDead = computed((): boolean => (tree.lastError.value as TreeFetchError | null)?.code === 'SESSION_NOT_FOUND');

// breadcrumb: ancestor chain, root → selected (labels only, capped)
const crumbs = computed((): string[] => {
  const out: string[] = [];
  let cur: AxNode | undefined = selNode.value ?? undefined;
  while (cur && out.length < 5) {
    out.unshift(cur.identifier ?? cur.label ?? cur.type ?? 'element');
    cur = parentOf(tree.nodes.value, cur) ?? undefined;
  }
  return out;
});

// geometry grid values
const geo = computed((): Array<{ k: string; v: string }> => {
  const n = selNode.value;
  const p = selParent.value;
  const r = n?.rect;
  const pr = p?.rect;
  if (!r) return [];
  const round = (x: number): string => String(Math.round(x));
  return [
    { k: 'x', v: round(r.x) }, { k: 'y', v: round(r.y) },
    { k: 'w', v: round(r.width) }, { k: 'h', v: round(r.height) },
    ...(pr ? [
      { k: 'pad top', v: round(r.y - pr.y) }, { k: 'pad left', v: round(r.x - pr.x) },
    ] : []),
  ];
});
const paint = computed((): Array<{ k: string; v: string }> => {
  const s = sample.sample.value;
  if (!s) return [];
  const rows: Array<{ k: string; v: string }> = [];
  if (s.text?.color) rows.push({ k: 'text', v: `${s.text.color}${s.text.token ? ` (${s.text.token})` : ''}` });
  if (s.text?.sizePt != null) rows.push({ k: 'size', v: `${s.text.sizePt}pt` });
  if (s.fill) rows.push({ k: 'fill', v: `${s.fill.color}${s.fill.token ? ` (${s.fill.token})` : ''}` });
  if (s.radius) rows.push({ k: 'radius', v: `${s.radius.pt}pt` });
  return rows;
});

async function tapThis(): Promise<void> {
  const n = selNode.value;
  if (!n?.rect || !props.sessionId) return;
  tree.markInteraction();
  try {
    const r = await fetch(`/api/manual/${props.sessionId}/tap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: n.rect.x + n.rect.width / 2, y: n.rect.y + n.rect.height / 2 }),
    });
    if (r.status === 410) { emit('close'); return; }
  } catch { /* surfaced by tree realigning */ }
}

async function copy(text: string, what: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); copyMsg.value = `${what} copied`; }
  catch { copyMsg.value = 'clipboard blocked'; }
  setTimeout(() => { copyMsg.value = ''; }, 1600);
}
const copyMsg = ref('');
function selectorText(n: AxNode): string {
  return n.identifier ? `${n.type ?? 'element'}(identifier:"${n.identifier}")` : `${n.type ?? 'element'}(label:"${n.label ?? ''}")`;
}
function copySelector(): void { if (selNode.value) void copy(selectorText(selNode.value), 'selector'); }
function copySpec(): void {
  const n = selNode.value;
  if (!n) return;
  const spec = {
    type: n.type ?? null, identifier: n.identifier ?? null, label: n.label ?? null,
    rect: n.rect ? { x: Math.round(n.rect.x), y: Math.round(n.rect.y), w: Math.round(n.rect.width), h: Math.round(n.rect.height) } : null,
    padding: selParent.value?.rect && n.rect ? {
      top: Math.round(n.rect.y - selParent.value.rect.y),
      left: Math.round(n.rect.x - selParent.value.rect.x),
    } : null,
    text: sample.sample.value?.text ?? null, fill: sample.sample.value?.fill ?? null, radius: sample.sample.value?.radius ?? null,
  };
  void copy(JSON.stringify(spec, null, 2), 'spec');
}
</script>

<template>
  <div class="tools" v-if="open">
    <!-- header: one line — title, live state, close -->
    <header class="head">
      <span class="title">inspect</span>
      <span class="state" :data-state="tree.state.value">{{ stateLabel }}</span>
      <span class="spacer" />
      <button type="button" class="x" title="close" @click="emit('close')">✕</button>
    </header>

    <template v-if="sessionId">
      <!-- breadcrumb of the selection -->
      <div v-if="crumbs.length" class="crumbs">
        <template v-for="(c, i) in crumbs" :key="i">
          <span v-if="i" class="sep">›</span>
          <span :class="{ last: i === crumbs.length - 1 }">{{ c }}</span>
        </template>
      </div>

      <div class="split">
        <!-- hierarchy: collapsible -->
        <section class="hier" :class="{ closed: !treeOpen }">
          <button type="button" class="sect-head" @click="treeOpen = !treeOpen">
            <span class="chev">{{ treeOpen ? '▾' : '▸' }}</span> hierarchy
            <span class="count">{{ tree.nodes.value.length || '' }}</span>
          </button>
          <div v-show="treeOpen" class="hier-body">
            <div v-if="tree.state.value === 'failed' && !sessionDead" class="hint-row">
              <span>tree fetch failed</span>
              <button class="mini" @click="tree.refresh()">retry</button>
            </div>
            <InspectTree v-if="tree.nodes.value.length" class="tree" :nodes="tree.nodes.value" :selected="selNode" @pick="(n) => { selNode = n; }" />
          </div>
        </section>

        <!-- detail card -->
        <section class="detail">
          <div v-if="!selNode" class="empty">
            <div class="empty-mark">◇</div>
            <p>click any element on the device screen<br />or pick one from the hierarchy</p>
          </div>

          <template v-else>
            <!-- identity -->
            <div class="ident">
              <div class="ident-main">
                <span class="etype">{{ selNode.type ?? 'element' }}</span>
                <span v-if="selNode.identifier" class="eid">{{ selNode.identifier }}</span>
              </div>
              <div v-if="selNode.label" class="elabel">“{{ selNode.label }}”</div>
              <div class="tags">
                <span class="tag" :class="{ ok: selNode.hittable }">{{ selNode.hittable ? 'hittable' : 'not hittable' }}</span>
                <span v-if="sample.loading.value" class="tag dim">sampling…</span>
                <span v-else-if="sample.failed.value" class="tag dim">sample n/a</span>
              </div>
            </div>

            <!-- geometry -->
            <div v-if="geo.length" class="kv-grid">
              <div v-for="g in geo" :key="g.k" class="kv">
                <span class="k">{{ g.k }}</span>
                <span class="v">{{ g.v }}</span>
              </div>
            </div>

            <!-- paint -->
            <div v-if="paint.length" class="paint">
              <div class="sect-label">paint</div>
              <div v-for="p in paint" :key="p.k" class="paint-row">
                <span class="k">{{ p.k }}</span>
                <span class="v">{{ p.v }}</span>
              </div>
            </div>

            <!-- selector preview -->
            <div class="selbox">
              <div class="sect-label">selector</div>
              <code class="selcode">{{ selectorText(selNode) }}</code>
            </div>

            <!-- actions -->
            <div class="actions">
              <button class="act primary" :disabled="tree.state.value !== 'aligned' || !selNode.hittable" title="tap the element's center on the device" @click="tapThis">tap</button>
              <button class="act" @click="copySelector">copy selector</button>
              <button class="act" @click="copySpec">copy spec</button>
            </div>
            <div v-if="copyMsg" class="copymsg">{{ copyMsg }}</div>
          </template>
        </section>
      </div>
    </template>

    <div v-else class="empty full">
      <div class="empty-mark">◇</div>
      <p>take control first —<br />inspect needs a live session</p>
    </div>
  </div>
</template>

<style scoped>
.tools { position: absolute; top: 40px; left: 0; bottom: 0; width: 340px; z-index: 25; background: var(--color-carbon); border-right: 1px solid var(--color-iron); display: flex; flex-direction: column; }

/* header */
.head { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 38px; border-bottom: 1px solid var(--color-iron); flex: 0 0 auto; }
.title { font-size: 10px; letter-spacing: .16em; text-transform: uppercase; color: var(--color-paper); font-weight: var(--weight-bold); }
.state { font-size: 9px; letter-spacing: .08em; color: var(--color-fog); border: 1px solid var(--color-iron); padding: 1px 7px; border-radius: var(--r); }
.state[data-state='aligned'] { border-color: var(--color-ember); color: var(--color-ember); }
.state[data-state='failed'] { color: var(--color-paper); }
.head .spacer { flex: 1; }
.x { background: none; border: none; color: var(--color-fog); cursor: pointer; font-size: 12px; padding: 2px 4px; }
.x:hover { color: var(--color-paper); }

/* breadcrumb */
.crumbs { display: flex; align-items: center; gap: 5px; padding: 8px 12px; font-size: 10px; color: var(--color-ash); border-bottom: 1px solid var(--color-iron); overflow: hidden; white-space: nowrap; flex: 0 0 auto; }
.crumbs .sep { color: var(--color-pewter); }
.crumbs .last { color: var(--color-paper); }

/* split: hierarchy (top, collapsible) + detail (fills) */
.split { flex: 1; min-height: 0; display: flex; flex-direction: column; }

.sect-head { display: flex; align-items: center; gap: 6px; width: 100%; background: none; border: none; border-bottom: 1px solid var(--color-iron); color: var(--color-fog); font-family: inherit; font-size: 9px; letter-spacing: .14em; text-transform: uppercase; padding: 7px 12px; cursor: pointer; }
.sect-head:hover { color: var(--color-paper); }
.chev { color: var(--color-steel); font-size: 9px; }
.count { margin-left: auto; color: var(--color-steel); }

.hier { flex: 0 1 auto; min-height: 0; display: flex; flex-direction: column; }
.hier:not(.closed) { flex: 0 1 42%; }
.hier-body { overflow-y: auto; min-height: 0; }
.hint-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; font-size: var(--text-caption); color: var(--color-steel); }
.mini { background: none; border: 1px solid var(--color-iron); color: var(--color-fog); font-family: inherit; font-size: 10px; padding: 1px 8px; border-radius: var(--r); cursor: pointer; }

.detail { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 12px; display: flex; flex-direction: column; gap: 12px; }

/* empty state */
.empty { flex: 1; display: grid; place-items: center; text-align: center; color: var(--color-steel); font-size: var(--text-caption); line-height: 1.7; }
.empty.full { padding: 24px; }
.empty-mark { font-size: 20px; color: var(--color-pewter); margin-bottom: 8px; }
.empty p { margin: 0; }

/* identity */
.ident-main { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.etype { color: var(--color-paper); font-weight: var(--weight-bold); font-size: var(--text-caption); }
.eid { color: var(--color-ember); font-size: var(--text-caption); font-family: ui-monospace, monospace; }
.elabel { color: var(--color-fog); font-size: var(--text-caption); margin-top: 3px; }
.tags { display: flex; gap: 6px; margin-top: 7px; }
.tag { font-size: 9px; letter-spacing: .06em; border: 1px solid var(--color-iron); color: var(--color-fog); padding: 1px 7px; border-radius: var(--r); }
.tag.ok { border-color: var(--color-ember); color: var(--color-ember); }
.tag.dim { opacity: .6; }

/* geometry grid */
.kv-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--color-iron); border: 1px solid var(--color-iron); border-radius: var(--r); overflow: hidden; }
.kv { background: var(--color-carbon); padding: 6px 8px; display: flex; flex-direction: column; gap: 1px; }
.kv .k { font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: var(--color-ash); }
.kv .v { font-size: var(--text-caption); color: var(--color-paper); font-family: ui-monospace, monospace; }

/* paint */
.sect-label { font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: var(--color-steel); margin-bottom: 6px; }
.paint-row, .selbox { font-size: var(--text-caption); }
.paint-row { display: flex; justify-content: space-between; padding: 3px 0; }
.paint-row .k { color: var(--color-steel); }
.paint-row .v { color: var(--color-fog); font-family: ui-monospace, monospace; }

/* selector */
.selbox code { display: block; background: var(--color-void); border: 1px solid var(--color-iron); border-radius: var(--r); padding: 6px 8px; color: var(--color-fog); font-size: 10px; white-space: pre-wrap; word-break: break-all; }

/* actions */
.actions { display: flex; gap: 6px; margin-top: 2px; }
.act { flex: 1; font-family: inherit; background: none; border: 1px solid var(--color-iron); color: var(--color-fog); padding: 6px 0; cursor: pointer; font-size: var(--text-caption); border-radius: var(--r); }
.act:hover:not(:disabled) { border-color: var(--color-slate); color: var(--color-paper); }
.act.primary { background: var(--color-ember); border-color: var(--color-ember); color: #000; font-weight: var(--weight-bold); flex: 0 0 64px; }
.act:disabled { opacity: .45; cursor: default; }
.copymsg { font-size: 10px; color: var(--color-ember); text-align: center; }

.tree { padding: 4px 6px; }
</style>
