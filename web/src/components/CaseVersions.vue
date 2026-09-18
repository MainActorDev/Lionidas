<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';

/** Case version history (phase A) — the v2 spec exactly:
 *  one line per revision (rev · when · runs), detail = yaml | diff vs
 *  neighbor, current is default selection, older revisions self-declare
 *  via a one-clause amber banner. No hashes, no kv grid, no prose. */

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

const props = defineProps<{ templateId: string; initialRev?: number | null }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const versions = ref<VersionRow[]>([]);
const loading = ref(true);
const sel = ref<string | null>(null);
const tab = ref<'yaml' | 'diff'>('yaml');

const selected = computed(() => versions.value.find((v) => v.id === sel.value) ?? null);
const isCurrent = computed(() => {
  if (!selected.value || versions.value.length === 0) return false;
  return selected.value.revision === Math.max(...versions.value.map((v) => v.revision));
});
/** diff against the neighbor: older revisions diff vs current; the current
 *  one diffs vs its predecessor (what changed TO become current). */
const diffBase = computed(() => {
  if (!selected.value) return null;
  const max = Math.max(...versions.value.map((v) => v.revision));
  const target = selected.value.revision === max ? selected.value.revision - 1 : max;
  return versions.value.find((v) => v.revision === target) ?? null;
});
const diffLabel = computed(() => (diffBase.value ? `diff vs r${diffBase.value.revision}` : 'diff'));

const when = (ms: number): string => {
  const d = Date.now() - ms;
  if (d < 3600_000) return `${Math.max(1, Math.round(d / 60_000))}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
};

/** Minimal line diff (no dependency — cases are dozens of lines). */
const diffLines = computed(() => {
  const a = (diffBase.value?.yaml ?? '').split('\n');
  const b = (selected.value?.yaml ?? '').split('\n');
  const out: Array<{ m: number; kind: 'ctx' | 'old' | 'new'; text: string }> = [];
  // LCS by line (small inputs — O(n²) is fine)
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  }
  let i = 0, j = 0, line = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ m: line++, kind: 'ctx', text: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ m: line, kind: 'old', text: a[i]! }); i++; }
    else { out.push({ m: line, kind: 'new', text: b[j]! }); j++; line++; }
  }
  while (i < n) out.push({ m: line, kind: 'old', text: a[i++]! });
  while (j < m) out.push({ m: line++, kind: 'new', text: b[j++]! });
  return out;
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetch(`/api/templates/${props.templateId}/versions`);
    const body = (await res.json()) as { versions: VersionRow[] };
    versions.value = body.versions;
    // current is the default; a deep-link rev (run-chip breadcrumb) wins
    const deep = props.initialRev != null ? body.versions.find((v) => v.revision === props.initialRev)?.id : undefined;
    sel.value = deep ?? body.versions[0]?.id ?? null;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>

<template>
  <div class="hist">
    <div class="list">
      <div v-if="loading" class="li" style="color: var(--color-steel);">loading…</div>
      <div v-else-if="versions.length === 0" class="li" style="color: var(--color-steel);">no versions yet — the first run creates one</div>
      <div
        v-for="v in versions" :key="v.id" class="li"
        :class="{ sel: v.id === sel }" @click="sel = v.id; tab = 'yaml'"
      >
        <span class="rev">r{{ v.revision }}</span>
        <span class="when">{{ when(v.createdAt) }}</span>
        <span class="runs">{{ v.runCount > 0 ? v.runCount : '—' }}</span>
        <span v-if="v.revision === Math.max(...versions.map((x) => x.revision))" class="cur">(current)</span>
      </div>
    </div>
    <div class="snap" :class="{ stale: !isCurrent && selected }">
      <div class="hd">
        <span class="rev2">r{{ selected?.revision }}</span>
        <span class="tabs">
          <span class="tab" :class="{ on: tab === 'yaml' }" @click="tab = 'yaml'">yaml</span>
          <span v-if="diffBase" class="tab" :class="{ on: tab === 'diff' }" @click="tab = 'diff'">{{ diffLabel }}</span>
        </span>
      </div>
      <div v-if="!isCurrent && selected" class="banner">older snapshot — current is r{{ Math.max(...versions.map((x) => x.revision)) }}</div>
      <div class="body">
        <pre v-if="selected && selected.yaml === ''" class="yaml" style="color: var(--color-steel);">backfill snapshot — yaml is captured from the first run after this version</pre>
        <pre v-else-if="tab === 'yaml'" class="yaml">{{ selected?.yaml }}</pre>
        <div v-else class="diff">
          <div v-for="(l, k) in diffLines" :key="k" class="dl" :class="l.kind"><span class="m">{{ l.m }}</span>{{ l.kind === 'old' ? '-' : l.kind === 'new' ? '+' : ' ' }}{{ l.text }}</div>
        </div>
        <div v-if="selected?.scenarioId" class="scen">scenario {{ selected.scenarioId }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hist { display: grid; grid-template-columns: 210px 1fr; min-height: 260px; border-top: 1px solid var(--color-iron, #202020); }
.list { border-right: 1px solid var(--color-iron, #202020); overflow-y: auto; }
.li { display: flex; gap: 8px; align-items: baseline; padding: 6px 12px; border-bottom: 1px solid var(--color-iron, #202020); cursor: pointer; font-size: 11px; }
.li:hover { background: var(--color-graphite, #191919); }
.li.sel { background: var(--color-graphite, #191919); border-left: 2px solid var(--color-ember); padding-left: 10px; }
.rev { color: var(--color-ember); }
.when { color: var(--color-fog); }
.runs { color: var(--color-steel); margin-left: auto; }
.cur { color: var(--color-ash); font-size: 10px; }
.snap { display: flex; flex-direction: column; min-width: 0; }
.hd { display: flex; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--color-iron, #202020); align-items: baseline; }
.rev2 { color: var(--color-ember); }
.tabs { margin-left: auto; display: flex; gap: 4px; }
.tab { border: 1px solid var(--color-slate, #3a3a3a); border-radius: 2px; padding: 0 8px; color: var(--color-fog); font-size: 10px; cursor: pointer; }
.tab.on { border-color: var(--color-ember); color: var(--color-ember); }
.banner { border-bottom: 1px solid var(--color-iron, #202020); border-left: 2px solid var(--color-amber, #d9a03f); color: var(--color-amber, #d9a03f); font-size: 11px; padding: 4px 12px; }
.body { padding: 10px 12px; overflow: auto; flex: 1; }
.yaml { background: var(--color-void, #000); border: 1px solid var(--color-iron, #202020); border-radius: 2px; padding: 10px; color: var(--color-fog); font-size: 11px; white-space: pre; margin: 0; }
.diff { background: var(--color-void, #000); border: 1px solid var(--color-iron, #202020); border-radius: 2px; padding: 10px; font-size: 11px; overflow: auto; }
.dl { display: flex; white-space: pre; line-height: 1.7; }
.dl .m { width: 24px; color: var(--color-steel); text-align: right; padding-right: 10px; flex: none; user-select: none; }
.dl.old { color: var(--color-bad, #e05c4f); }
.dl.new { color: var(--color-ok, #8fce63); }
.dl.ctx { color: var(--color-fog); }
.scen { color: var(--color-steel); font-size: 10px; margin-top: 8px; }
</style>
