<script setup lang="ts">
// EvidenceSheet — sketch 008-C "Contact sheet", the user-picked evidence
// viewer (2026-09-19). Full-viewport sheet: header + lane filter pills +
// grouped contact rows (one group per variant lane, its step shots + whole-
// run video as cards). Clicking a card opens the per-world cinema view
// (big media + step rail) layered ABOVE the sheet. All styling is Axiom
// tokens from the app stylesheet — no local palette.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import TapOverlayVideo from './TapOverlayVideo.vue';

export interface EvidenceItem { stepIdx: number; stepName: string; status: string; kind: string; evId: string; swapTarget?: string }
export interface EvidenceLane {
  variantId: string | null; runId: string; runStatus: string; startedAt: number;
  env: Record<string, string> | null; items: EvidenceItem[];
  /** B1 (2026-09-24): a swap run is its own lane — worldSeq carries the
   *  full sequence (entry + swaps); single-world lanes leave both absent. */
  swapRun?: boolean; worldSeq?: string[];
}

const props = defineProps<{ open: boolean; caseName: string; templateId: string; lanes: EvidenceLane[] }>();
const emit = defineEmits<{ close: []; 'lane-deleted': [variantId: string | null] }>();

// ── filter pills: 'all' | 'failed' | '' (plain lane) | variant id ──
const filter = ref<string>('all');
const visibleLanes = computed(() => {
  if (filter.value === 'all') return props.lanes;
  if (filter.value === 'failed') return props.lanes.filter(laneFailed);
  return props.lanes.filter((l) => l.variantId === (filter.value === '' ? null : filter.value));
});
/** B1 tiers: shots are the row; video is the strip below. */
function shotItems(l: EvidenceLane): EvidenceItem[] { return l.items.filter((i) => i.kind !== 'video'); }
function videoItems(l: EvidenceLane): EvidenceItem[] { return l.items.filter((i) => i.kind === 'video'); }

function laneLabel(l: EvidenceLane): string { return l.swapRun ? 'swap run' : (l.variantId ?? 'plain'); }
/** world stamp (B1): on a swap lane every shot carries its world; on a
 *  single-world lane the lane already says it — no stamp needed. */
function worldBadge(item: EvidenceItem, lane: EvidenceLane): string | null {
  if (!lane.swapRun || !item.swapTarget) return null;
  return item.swapTarget;
}
function laneFailed(l: EvidenceLane): boolean { return l.runStatus === 'failed' || l.items.some((i) => i.status === 'fail'); }

/** per-lane artifact purge — DELETE /api/templates/:id/runs?variant=<lane>.
 *  Destroys files + evidence + run rows for the WHOLE lane (all runs, not
 *  just the newest); server refuses (409) if a live run is in it. */
async function deleteLane(l: EvidenceLane): Promise<void> {
  const label = l.variantId ?? 'plain';
  if (!window.confirm(`delete ALL artifacts for variant "${label}"?\n(run ${l.runId} + every earlier run in this lane — files, evidence, run rows. This cannot be undone.)`)) return;
  const res = await fetch(`/api/templates/${props.templateId}/runs?variant=${encodeURIComponent(l.variantId ?? '')}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    window.alert(`delete failed (${res.status}): ${body.error ?? res.statusText}`);
    return;
  }
  emit('lane-deleted', l.variantId);
}
function envText(l: EvidenceLane): string {
  if (!l.env) return '—';
  return Object.entries(l.env).map(([k, v]) => `${k}=${v}`).join(' · ');
}
function timeOf(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function shotCount(l: EvidenceLane): number { return l.items.filter((i) => i.kind === 'screenshot').length; }

// ── cinema overlay (card click) ──
const cinema = ref<{ lane: number; item: number } | null>(null);
function openCinema(laneIdx: number, item: EvidenceItem): void {
  const items = visibleLanes.value[laneIdx]!.items;
  cinema.value = { lane: laneIdx, item: Math.max(0, items.indexOf(item)) };
}
const cinemaLane = computed(() => (cinema.value ? visibleLanes.value[cinema.value.lane] ?? null : null));
const cinemaItems = computed(() => cinemaLane.value?.items ?? []);
function cinemaSel(): EvidenceItem | null { return cinemaItems.value[cinema.value?.item ?? -1] ?? null; }
/** video is played through TapOverlayVideo — the tap-dot overlay is a shipped
 *  debugging feature (where each tap landed); scoped to the cinema lane */
function cinemaVariant(): string { return cinemaLane.value?.variantId ?? ''; }
/** step paging within the cinema — steps + the video as the last stop */
function cinemaStep(d: number): void {
  if (!cinema.value) return;
  const n = cinemaItems.value.length;
  cinema.value.item = (cinema.value.item + d + n) % n;
}
function onKey(e: KeyboardEvent): void {
  if (!props.open) return;
  // stopImmediatePropagation: the PAGE also listens on window for Escape —
  // same-node listeners are immune to stopPropagation, and the page's
  // (parent-registered) handler would close the sheet out from under the
  // cinema. The sheet owns its keys while open.
  if (e.key === 'Escape') { e.stopImmediatePropagation(); if (cinema.value) cinema.value = null; else emit('close'); }
  else if (cinema.value && e.key === 'ArrowLeft') { e.stopImmediatePropagation(); cinemaStep(-1); }
  else if (cinema.value && e.key === 'ArrowRight') { e.stopImmediatePropagation(); cinemaStep(1); }
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
watch(() => props.open, (o) => { if (!o) { cinema.value = null; filter.value = 'all'; } });
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ev-sheet">
      <div class="sh-head">
        <span class="sh-title">evidence · {{ caseName }}</span>
        <span class="sh-sub">{{ lanes.length }} lane{{ lanes.length === 1 ? '' : 's' }} · latest run per lane</span>
        <span class="sh-spacer"></span>
        <button class="btn" @click="emit('close')">close</button>
      </div>
      <div class="filters" v-if="lanes.length > 0">
        <span class="f-label">lanes</span>
        <button class="f-pill" :class="{ on: filter === 'all' }" @click="filter = 'all'">all</button>
        <button v-for="l in lanes" :key="l.runId" class="f-pill"
          :class="{ on: filter === (l.variantId ?? ''), fail: laneFailed(l) }" @click="filter = l.variantId ?? ''">
          {{ laneLabel(l) }}</button>
        <button v-if="lanes.some(laneFailed)" class="f-pill fail" :class="{ on: filter === 'failed' }" @click="filter = 'failed'">failed</button>
        <span class="f-label right">click a card → cinema view</span>
      </div>
      <div class="grid">
        <div v-if="lanes.length === 0" class="grid-empty">no evidence yet — run the case</div>
        <section v-for="(l, li) in visibleLanes" :key="l.runId" class="grp">
          <div class="grp-head">
            <span class="grp-name">{{ laneLabel(l) }}</span>
            <span class="grp-env">{{ l.swapRun ? (l.worldSeq ?? []).join(' → ') : envText(l) }} · {{ l.runId }} · {{ timeOf(l.startedAt) }}</span>
            <span class="grp-status">
              <span class="grp-verb" :class="{ fail: laneFailed(l) }">{{ laneFailed(l) ? 'failed' : (l.runStatus || 'passed') }}</span>
              <span v-if="shotCount(l)"> · <b>{{ shotCount(l) }} shot{{ shotCount(l) === 1 ? '' : 's' }}</b></span>
              <span v-if="l.swapRun"> · <b>{{ (l.worldSeq?.length ?? 1) - 1 }} swap{{ ((l.worldSeq?.length ?? 1) - 1) === 1 ? '' : 's' }}</b></span>
            </span>
            <button class="grp-del" title="delete this variant lane's artifacts"
              @click.stop="deleteLane(l)">delete lane</button>
          </div>
          <div class="row">
            <button v-for="item in shotItems(l)" :key="item.evId" class="card"
              :class="{ fail: item.status === 'fail' }"
              :title="`${item.stepName} — ${item.status}`" @click="openCinema(li, item)">
              <img class="thumb" alt="" loading="lazy"
                :src="`/api/evidence/${item.evId}/file`" />
              <span class="stamp" :class="{ fail: item.status === 'fail' }">{{ item.status === 'fail' ? 'fail' : 'expect' }}</span>
              <span v-if="worldBadge(item, l)" class="stamp world" :title="`captured in world “${item.swapTarget}”`">{{ worldBadge(item, l) }}</span>
              <span class="cap"><span class="ix">#{{ item.stepIdx >= 0 ? item.stepIdx + 1 : '·' }}</span>
                <span class="nm">{{ item.stepName }}</span></span>
            </button>
          </div>
          <!-- B1 tier 2: the whole-run video as a subordinated full-width strip
               (chronology, not a gallery peer — the shots above are the proof) -->
          <button v-for="item in videoItems(l)" :key="item.evId" class="vid-strip"
            :title="`whole run — click to play`" @click="openCinema(li, item)">
            <span class="vid-glyph"><span class="tri"></span></span>
            <span class="vid-info">
              <span class="t">whole run</span>
              <span class="m">{{ l.swapRun ? (l.worldSeq ?? []).join(' → ') : laneLabel(l) }} · tap overlay available</span>
            </span>
            <span class="vid-len">cinema →</span>
          </button>
        </section>
      </div>

      <!-- cinema overlay: big media + step rail, layered above the sheet -->
      <div v-if="cinema && cinemaSel()" class="cinema" @click.self="cinema = null">
        <div class="ci-head">
          <span class="ci-title">{{ caseName }} · {{ laneLabel(cinemaLane!) }}</span>
          <span class="ci-sub">{{ cinemaSel()!.stepName }}</span>
          <span class="ci-spacer"></span>
          <span class="ci-keys"><kbd>←</kbd><kbd>→</kbd> step <kbd>esc</kbd> back</span>
          <button class="btn" @click="cinema = null">close</button>
        </div>
        <div class="ci-stage">
          <img v-if="cinemaSel()!.kind !== 'video'" class="ci-shot" :src="`/api/evidence/${cinemaSel()!.evId}/file`" alt="step screenshot" />
          <TapOverlayVideo v-else class="ci-shot" :template-id="templateId" :variant="cinemaVariant()" :key="`vid-${cinemaLane!.runId}`" />
        </div>
        <div class="ci-rail">
          <button v-for="(it, i) in cinemaItems" :key="it.evId" class="ci-chip" :class="{ sel: i === cinema?.item, fail: it.status === 'fail' }"
            @click="cinema!.item = i" :title="`${it.stepName} — ${it.status}`">
            <img v-if="it.kind !== 'video'" :src="`/api/evidence/${it.evId}/file`" alt="" loading="lazy" />
            <span v-else class="tri"></span>
            <span class="ci-chip-nm">{{ it.stepName }}</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ── sheet chrome ── */
.ev-sheet { position: fixed; inset: 0; z-index: 200; background: var(--color-void); display: grid; grid-template-rows: auto auto 1fr; }
.sh-head { display: flex; align-items: center; gap: var(--s-3); padding: var(--s-3) var(--s-5); border-bottom: 1px solid var(--color-iron); }
.sh-title { font-size: var(--text-body); font-weight: 700; }
.sh-sub { color: var(--color-ash); font-size: var(--text-caption); }
.sh-spacer { flex: 1; }
.btn { border: 1px solid var(--color-slate); color: var(--color-fog); font-family: var(--font-mono); font-size: var(--text-caption); padding: 5px 10px; border-radius: var(--r); transition: color var(--t), border-color var(--t); }
.btn:hover { color: var(--color-paper); border-color: var(--color-chalk); }
.filters { display: flex; gap: var(--s-2); align-items: center; padding: var(--s-2) var(--s-5); border-bottom: 1px solid var(--color-iron); flex-wrap: wrap; }
.f-label { color: var(--color-steel); font-size: 11px; }
.f-label.right { margin-left: auto; }
.f-pill { font-family: var(--font-mono); font-size: var(--text-caption); color: var(--color-ash); padding: 3px 10px; border: 1px solid var(--color-iron); border-radius: var(--r); transition: all var(--t); }
.f-pill:hover { color: var(--color-paper); }
.f-pill.on { color: var(--color-ember); border-color: var(--color-ember); }
.f-pill.fail { color: var(--color-paper); border-color: var(--color-paper); border-style: dashed; }
.f-pill.fail.on { color: var(--color-ember); border-color: var(--color-ember); border-style: solid; }

/* ── grouped grid ── */
.grid { overflow-y: auto; padding: var(--s-4) var(--s-5) var(--s-6); }
.grid-empty { color: var(--color-ash); padding: var(--s-7) 0; text-align: center; }
.grp { margin-bottom: var(--s-5); }
.grp-head { display: flex; align-items: center; gap: var(--s-3); padding: var(--s-2) 0; margin-bottom: var(--s-2); border-bottom: 1px solid var(--color-iron); }
.grp-name { font-size: var(--text-label); color: var(--color-paper); }
.grp-env { color: var(--color-steel); font-size: 11px; }
.grp-status { margin-left: auto; color: var(--color-ash); font-size: 11px; }
.grp-status b { font-weight: 400; color: var(--color-fog); }
.grp-verb.fail { color: var(--color-paper); border: 1px dashed var(--color-paper); padding: 0 6px; }
.grp-del { margin-left: var(--s-3); font-size: 10px; color: var(--color-steel); background: none; border: 1px solid var(--color-iron); border-radius: var(--r); padding: 2px 8px; cursor: pointer; transition: color var(--t), border-color var(--t); }
.grp-del:hover { color: var(--color-paper); border-color: var(--color-paper); }

/* ── contact cards ── */
.row { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.vid-strip { display:flex; align-items:center; gap:var(--s-3); margin:var(--s-2) var(--s-4) var(--s-4); border:1px solid var(--color-iron); border-radius:var(--r); background:var(--color-carbon); padding:10px 14px; cursor:pointer; width:calc(100% - var(--s-4)*2); text-align:left; transition:border-color var(--t); }
.vid-strip:hover { border-color:var(--color-slate); }
.vid-glyph { width:36px; height:36px; border-radius:var(--r); background:var(--color-void); display:flex; align-items:center; justify-content:center; border:1px solid var(--color-iron); flex:none; }
.vid-glyph .tri, .vid-strip .vid-glyph .tri { border-left:11px solid var(--color-fog); border-top:7px solid transparent; border-bottom:7px solid transparent; margin-left:3px; width:0; height:0; }
.vid-info { display:flex; flex-direction:column; gap:1px; min-width:0; }
.vid-info .t { color:var(--color-paper); font-size:var(--text-label); font-weight:600; }
.vid-info .m { color:var(--color-steel); font-size:var(--text-caption); font-family:var(--font-mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.vid-len { margin-left:auto; color:var(--color-steel); font-size:var(--text-caption); font-family:var(--font-mono); flex:none; }
.card { position: relative; border: 1px solid var(--color-iron); border-radius: var(--r); background: var(--color-carbon); padding: 0; overflow: hidden; text-align: left; transition: border-color var(--t); }
.card:hover { border-color: var(--color-chalk); }
.card .thumb { aspect-ratio: 390 / 844; width: 100%; background: var(--color-graphite); object-fit: cover; object-position: top; display: block; }
.vid-thumb { pointer-events: none; }   /* the frame is a poster — clicks belong to the card */
.vid-play { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
.vid-play .tri { width: 0; height: 0; border-left: 18px solid rgba(238, 238, 238, 0.9); border-top: 11px solid transparent; border-bottom: 11px solid transparent; filter: drop-shadow(0 0 4px rgba(0, 0, 0, 0.8)); }
.card .cap { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-top: 1px solid var(--color-iron); }
.card .cap .nm { flex: 1; min-width: 0; font-size: 11px; color: var(--color-fog); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card .cap .ix { color: var(--color-steel); font-size: 10px; }
.card.fail { border-style: dashed; }
.card.fail .cap .nm { color: var(--color-paper); }
.card .stamp { position: absolute; top: 6px; left: 6px; font-size: 9px; background: rgba(0, 0, 0, 0.75); color: var(--color-fog); padding: 1px 5px; border-radius: var(--r); }
.stamp.world { background:var(--color-carbon); color:var(--color-fog); border-color:var(--color-slate); }
.card .stamp.fail { color: var(--color-paper); border: 1px dashed var(--color-paper); }
.tri { width: 0; height: 0; border-left: 12px solid var(--color-fog); border-top: 7px solid transparent; border-bottom: 7px solid transparent; }

/* ── cinema overlay ── */
.cinema { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.94); display: grid; grid-template-rows: auto 1fr auto; z-index: 1; }
.ci-head { display: flex; align-items: center; gap: var(--s-3); padding: var(--s-3) var(--s-5); border-bottom: 1px solid var(--color-iron); }
.ci-title { font-size: var(--text-body); font-weight: 700; }
.ci-sub { color: var(--color-ash); font-size: var(--text-caption); }
.ci-spacer { flex: 1; }
.ci-keys { color: var(--color-steel); font-size: 11px; }
kbd { border: 1px solid var(--color-slate); border-radius: var(--r); padding: 1px 5px; font-family: var(--font-mono); font-size: 10px; color: var(--color-ash); }
.ci-stage { position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.ci-shot { max-height: calc(100% - 24px); max-width: 100%; object-fit: contain; border: 1px solid var(--color-iron); }
.ci-rail { border-top: 1px solid var(--color-iron); display: flex; gap: 6px; padding: var(--s-2) var(--s-5); overflow-x: auto; }
.ci-chip { position: relative; flex: none; width: 48px; height: 96px; border: 1px solid var(--color-iron); border-radius: var(--r); overflow: hidden; transition: border-color var(--t); display: flex; align-items: center; justify-content: center; }
.ci-chip:hover { border-color: var(--color-chalk); }
.ci-chip.sel { border-color: var(--color-ember); }
.ci-chip img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: top; }
.ci-chip .tri { margin: 0; }
.ci-chip-nm { position: absolute; bottom: 0; left: 0; right: 0; font-size: 8px; background: rgba(0, 0, 0, 0.72); color: var(--color-fog); padding: 1px 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; }
</style>
