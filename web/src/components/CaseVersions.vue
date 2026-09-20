<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';

/** Version history — quiet footer, "current"-first model (user directive
 *  2026-09-18):
 *  - `current` is its own selectable item — the LIVE editable case — and
 *    is the default selection. It is never numbered.
 *  - A state only becomes `rN` once SUPERSEDED (a newer version exists
 *    with different content). Snapshots matching the live content are
 *    represented by the `current` chip — no duplicate numbered chip.
 *  - Selection is always exactly ONE item: you move between chips;
 *    clicking the selected one is a no-op (there is no unselect). */

interface VersionRow {
  id: string;
  revision: number;
  stepsSha: string;
  yaml: string;
  scenarioId: string | null;
  source: string;
  createdAt: number;
  runCount: number;
}

const props = defineProps<{
  templateId: string;
  /** 'current' = the live case; a number = viewing that revision */
  viewing: number | 'current' | null;
}>();
const emit = defineEmits<{ (e: 'pick', which: number | 'current'): void }>();

const versions = ref<VersionRow[]>([]);
const liveSha = ref<string | null>(null);
const loading = ref(true);

/** superseded = a NEWER version exists (the snapshot has history above it). */
const superseded = computed(() => versions.value.filter((v) =>
  versions.value.some((w) => w.revision > v.revision)));

/** the revision the live content matches, if any (for run-count merge) */
const liveRevision = computed(() =>
  liveSha.value === null ? null : versions.value.find((v) => v.stepsSha === liveSha.value) ?? null);

/** items in strip order: newest 5 superseded revisions asc, then `current`
 *  last. With long histories the full strip bloats the footer irrecoverably
 *  (not scrollable); the tail is the working set. Older revisions stay
 *  reachable: deep-link `#r<N>` or the runs page's version filter. */
const items = computed<Array<{ kind: 'rev'; v: VersionRow } | { kind: 'current'; runs: number }>>(() => {
  const runs = liveRevision.value?.runCount ?? 0;
  return [
    ...superseded.value
      .slice()
      .sort((a, b) => a.revision - b.revision)
      .slice(-5)
      .map((v) => ({ kind: 'rev' as const, v })),
    { kind: 'current' as const, runs },
  ];
});

const when = (ms: number): string => {
  const d = Date.now() - ms;
  if (d < 3600_000) return `${Math.max(1, Math.round(d / 60_000))}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
};

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetch(`/api/templates/${props.templateId}/versions`);
    const body = (await res.json()) as { versions: VersionRow[]; liveSha: string | null };
    versions.value = body.versions.slice().sort((a, b) => a.revision - b.revision);
    liveSha.value = body.liveSha;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function isActive(item: { kind: 'rev'; v: VersionRow } | { kind: 'current'; runs: number }): boolean {
  if (item.kind === 'current') return props.viewing === 'current' || props.viewing === null;
  return props.viewing === item.v.revision;
}
function pick(item: { kind: 'rev'; v: VersionRow } | { kind: 'current'; runs: number }): void {
  if (isActive(item)) return; // cannot unselect — clicking the selected chip is a no-op
  emit('pick', item.kind === 'current' ? 'current' : item.v.revision);
}
function tip(item: { kind: 'rev'; v: VersionRow } | { kind: 'current'; runs: number }): string {
  if (item.kind === 'current') {
    const runs = item.runs > 0 ? `${item.runs} run${item.runs === 1 ? '' : 's'} executed this exact yaml` : 'no runs yet';
    return `current — the live case you are editing · ${runs}`;
  }
  const v = item.v;
  const runs = v.runCount > 0 ? `${v.runCount} run${v.runCount === 1 ? '' : 's'} executed this exact yaml` : 'no runs';
  return `revision ${v.revision} — ${runs} · ${when(v.createdAt)} · superseded`;
}
</script>

<template>
  <div class="vfoot">
    <span class="lbl">versions</span>
    <span v-if="loading" class="cnt">loading…</span>
    <template v-else>
      <template v-for="item in items" :key="item.kind === 'current' ? 'cur' : item.v.id">
        <span
          class="vstep"
          :class="{ on: isActive(item), cur: item.kind === 'current' }"
          :title="tip(item)"
          @click="pick(item)"
        >{{ item.kind === 'current' ? 'current' : `r${item.v.revision}` }}<span class="n">{{ (item.kind === 'current' ? item.runs : item.v.runCount) > 0 ? (item.kind === 'current' ? item.runs : item.v.runCount) : '·' }}</span></span>
      </template>
      <span v-if="superseded.length > 5" class="cnt" :title="`${superseded.length - 5} older revisions — open a run from /runs to inspect its version`">+{{ superseded.length - 5 }}</span>
      <span v-if="items.length === 1" class="cnt">current only — a version becomes rN when superseded</span>
      <span v-else-if="viewing !== 'current' && viewing !== null" class="cnt stale">viewing r{{ viewing }} — superseded</span>
    </template>
  </div>
</template>

<style scoped>
.vfoot {
  display: flex; gap: 6px; align-items: baseline;
  padding: 6px 12px; border-top: 1px solid var(--color-iron, #202020);
  font-size: 11px;
}
.lbl { color: var(--color-steel); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; margin-right: 4px; }
.vstep {
  border: 1px solid var(--color-slate, #3a3a3a); border-radius: 2px;
  padding: 0 7px; font-size: 10px; color: var(--color-fog, #b4b4b4); cursor: pointer;
}
.vstep:hover { border-color: var(--color-ember); color: var(--color-ember); }
.vstep.on { border-color: var(--color-ember); color: var(--color-ember); background: rgba(255, 95, 46, .08); }
.vstep.cur.on { border-color: var(--color-ember); }
.vstep .n { color: var(--color-steel); font-size: 9px; margin-left: 3px; }
.cnt { color: var(--color-steel); font-size: 10px; margin-left: 4px; }
.cnt.stale { color: var(--color-amber, #d9a03f); }
</style>
