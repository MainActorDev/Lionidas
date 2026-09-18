<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';

/** Version history — OPTION A "quiet footer" (chosen 2026-09-18):
 *  revisions as a breadcrumb strip in the editor footer, always visible.
 *  Clicking a revision emits `pick` — the EDITOR's yaml column becomes
 *  read-only (banner + dim); no second viewer surface exists. The footer
 *  never renders a diff or yaml itself.
 *
 *  Vocabulary: `revision N` (r = revision, never "version" — v belongs to
 *  the app build a run tested). The tooltip on every step spells it out. */

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
  /** currently-viewed revision (null = editing the live case) */
  viewing: number | null;
}>();
const emit = defineEmits<{ (e: 'pick', revision: number | null): void }>();

const versions = ref<VersionRow[]>([]);
const loading = ref(true);

const currentRevision = computed(() =>
  versions.value.length === 0 ? null : Math.max(...versions.value.map((v) => v.revision)));

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
    const body = (await res.json()) as { versions: VersionRow[] };
    // asc for the strip (oldest → current, like pages)
    versions.value = body.versions.slice().sort((a, b) => a.revision - b.revision);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function tip(v: VersionRow): string {
  const runs = v.runCount > 0 ? `${v.runCount} run${v.runCount === 1 ? '' : 's'} executed this exact yaml` : 'no runs yet';
  const cur = v.revision === currentRevision.value ? ' · current' : '';
  return `revision ${v.revision} — ${runs} · ${when(v.createdAt)}${cur}`;
}
</script>

<template>
  <div class="vfoot">
    <span class="lbl">revisions</span>
    <span v-if="loading" class="cnt">loading…</span>
    <template v-else>
      <span
        v-for="v in versions" :key="v.id"
        class="vstep"
        :class="{ on: viewing === v.revision }"
        :title="tip(v)"
        @click="emit('pick', v.revision === viewing ? null : v.revision)"
      >r{{ v.revision }}<span class="n">{{ v.runCount > 0 ? v.runCount : '·' }}</span></span>
      <span v-if="versions.length === 0" class="cnt">none yet — the first run creates revision 1</span>
      <span v-else-if="viewing === null" class="cnt">editing current</span>
      <span v-else-if="viewing !== currentRevision" class="cnt stale">
        viewing r{{ viewing }} · <span class="link" @click="emit('pick', null)">back to current r{{ currentRevision }}</span>
      </span>
      <span v-else class="cnt">current</span>
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
.vstep .n { color: var(--color-steel); font-size: 9px; margin-left: 3px; }
.cnt { color: var(--color-steel); font-size: 10px; margin-left: 4px; }
.cnt.stale { color: var(--color-amber, #d9a03f); }
.link { text-decoration: underline; cursor: pointer; }
</style>
