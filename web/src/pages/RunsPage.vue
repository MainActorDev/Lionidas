<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useLiveEvents } from '../stores/live.ts';

interface RunRow {
  id: string; ticket_key: string; kind: string; status: string; triggered_by: string;
  device_udid: string; freshness: string; started_at: number | null; finished_at: number | null;
  template_id: string | null; app_version: string | null; blocked: number; note: string | null;
  /** phase A breadcrumb: revision this run executed + is-current flag */
  versionInfo?: { revision: number; current: boolean } | null;
  /** phase C: variant this run executed (null = plain/variantless) */
  variantId?: string | null;
}
const router = useRouter();
const runs = ref<RunRow[]>([]);
const live = useLiveEvents();
let poll: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  const suite = router.currentRoute.value.query.suite;
  const url = typeof suite === 'string' && suite ? `/api/runs?limit=50&suite=${encodeURIComponent(suite)}` : '/api/runs?limit=50';
  const res = await fetch(url);
  runs.value = (await res.json() as { runs: RunRow[] }).runs;
}
function ago(ts: number | null): string {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
/** case name from the note ("template:<id> <name>") until templates join —
 *  template_id is the truth; note carries the human name. */
function caseName(r: RunRow): string | null {
  if (r.template_id && r.note?.startsWith('template:')) return r.note.slice(r.note.indexOf(' ') + 1) || null;
  return null;
}
async function abort(r: RunRow): Promise<void> {
  try { await fetch(`/api/runs/${r.id}/abort`, { method: 'POST' }); void load(); } catch { /* next poll */ }
}

// live: run lifecycle events refresh the table instantly (no 5s wait)
const unwatch = watch(
  () => live.events.length,
  () => {
    const latest = live.events[live.events.length - 1];
    if (latest && (latest.type === 'run.started' || latest.type === 'run.finished' || latest.type === 'queue.changed')) void load();
  },
);

onMounted(() => {
  live.connect();
  void load();
  poll = setInterval(() => void load(), 5000); // safety net
});
onUnmounted(() => { if (poll) clearInterval(poll); unwatch(); live.release(); });
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">runs</div>
        <div class="page-desc">
          {{ runs.length }} recent
          <span v-if="!live.connected" style="color: var(--color-ember);"> · live offline</span>
        </div>
      </div>
    </div>

    <div v-if="runs.length === 0" class="empty">no runs yet — run a test case from the test cases page, or take control of a device</div>

    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr><th>run</th><th>case</th><th>ticket</th><th>kind</th><th>status</th><th>build</th><th>by</th><th>started</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="r in runs" :key="r.id" @click="router.push(`/runs/${r.id}`)">
            <td style="font-family: var(--font-mono, monospace); font-size: 11px;">{{ r.id.slice(0, 12) }}</td>
            <td>
              <span v-if="caseName(r)" style="color: var(--color-fog);">{{ caseName(r) }}</span>
              <span v-else-if="r.template_id" style="color: var(--color-fog);">case {{ r.template_id.slice(0, 8) }}</span>
              <span v-else style="color: var(--color-steel);">{{ r.kind === 'manual' && !r.template_id ? 'manual drive' : '—' }}</span>
              <span
                v-if="r.versionInfo"
                class="vchip"
                :class="{ stale: !r.versionInfo.current }"
                :title="r.versionInfo.current
                  ? 'the current state of the case — click to open it'
                  : `ran superseded state r${r.versionInfo.revision} — click to view it read-only in the case editor`"
                @click.stop="r.versionInfo.current
                  ? router.push(`/templates?case=${r.template_id}`)
                  : router.push(`/templates?case=${r.template_id}&rev=${r.versionInfo.revision}`)"
              >{{ r.versionInfo.current ? 'current' : `r${r.versionInfo.revision}` }}<template v-if="!r.versionInfo.current"> ⚠</template></span>
              <span
                v-if="r.variantId"
                class="vchip variant"
                :title="`variant execution — world '${r.variantId}' (env + network scenario)`"
              >▸ {{ r.variantId }}</span>
            </td>
            <td>
              <RouterLink :to="`/tickets/${r.ticket_key}`" style="color: inherit; text-decoration: none;">{{ r.ticket_key }}</RouterLink>
            </td>
            <td style="color: var(--color-ash);">{{ r.kind }}</td>
            <td>
              <span v-if="r.blocked === 1" class="status status-blocked" title="infrastructure failure — not an app failure">◆ blocked</span>
              <span v-else class="status" :class="`status-${r.status}`">{{ r.status }}</span>
            </td>
            <td style="color: var(--color-steel);">{{ r.app_version ? `v${r.app_version}` : '—' }}</td>
            <td style="color: var(--color-ash);">{{ r.triggered_by }}</td>
            <td style="color: var(--color-steel);">{{ ago(r.started_at) }}</td>
            <td>
              <button
                v-if="r.status === 'running' || r.status === 'queued'"
                class="btn btn-sm btn-danger"
                title="abort this run — remaining steps skip, device frees"
                @click.stop="abort(r)"
              >■ stop</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
/* phase A breadcrumb chip — stale runs carry ⚠ and amber */
.vchip {
  border: 1px solid var(--color-slate, #3a3a3a);
  border-radius: 2px;
  padding: 0 5px;
  color: var(--color-fog, #b4b4b4);
  font-size: 10px;
  cursor: pointer;
  margin-left: 6px;
}
.vchip:hover { border-color: var(--color-ember); color: var(--color-ember); }
.vchip.stale { border-color: var(--color-amber, #d9a03f); color: var(--color-amber, #d9a03f); }
/* phase C variant chip — same geometry, violet accent */
.vchip.variant { border-color: var(--color-violet, #8b5cf6); color: var(--color-violet, #8b5cf6); cursor: default; }
</style>
