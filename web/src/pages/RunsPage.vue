<script setup lang="ts">
import PageHeader from '../components/PageHeader.vue';
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
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
/** chip → query param. failed/aborted exact; blocked is a COLUMN (pseudo on
 *  the server — schema CHECK forbids status='blocked'); running maps to
 *  active (running OR queued) so queue-waiting runs are covered.
 *  all = no param (decision B: everything on load). */
const CHIPS: Array<{ key: string; label: string }> = [
  { key: '', label: 'all' },
  { key: 'failed', label: 'failed' },
  { key: 'blocked', label: 'blocked' },
  { key: 'aborted', label: 'aborted' },
  { key: 'active', label: 'running' },
];

const router = useRouter();
const runs = ref<RunRow[]>([]);
const statusFilter = ref('');
const loadingEarlier = ref(false);
const exhausted = ref(false);
/** monotonic token: a slow "load earlier" fetch must not clobber a newer page-1 refresh */
let fetchToken = 0;
const live = useLiveEvents();
let poll: ReturnType<typeof setInterval> | null = null;

async function fetchPage(before?: number): Promise<RunRow[]> {
  const suite = router.currentRoute.value.query.suite;
  const p = new URLSearchParams();
  p.set('limit', '50');
  if (typeof suite === 'string' && suite) p.set('suite', suite);
  if (statusFilter.value) p.set('status', statusFilter.value);
  if (before !== undefined) p.set('before', String(before));
  const res = await fetch(`/api/runs?${p.toString()}`);
  return (await res.json() as { runs: RunRow[] }).runs;
}

async function load(): Promise<void> {
  const token = ++fetchToken;
  const rows = await fetchPage();
  if (token !== fetchToken) return; // superseded
  runs.value = rows;
  exhausted.value = rows.length === 0;
}

async function loadEarlier(): Promise<void> {
  if (loadingEarlier.value || exhausted.value || runs.value.length === 0) return;
  const oldest = runs.value.reduce((m, r) => (r.started_at != null && (m == null || r.started_at < m) ? r.started_at : m), null as number | null);
  if (oldest == null) { exhausted.value = true; return; }
  loadingEarlier.value = true;
  const token = ++fetchToken;
  try {
    const older = await fetchPage(oldest);
    if (token !== fetchToken) return;
    if (older.length === 0) { exhausted.value = true; return; }
    const seen = new Set(runs.value.map((r) => r.id));
    runs.value = [...runs.value, ...older.filter((r) => !seen.has(r.id))];
  } finally { loadingEarlier.value = false; }
}

function setFilter(key: string): void {
  if (statusFilter.value === key) return;
  statusFilter.value = key;
  void load();
}

// ── day grouping (client-side over the loaded window) ──
interface DayGroup { key: string; label: string; runs: RunRow[]; maxMs: number | null }
const now = ref(Date.now());
const groups = computed<DayGroup[]>(() => {
  const map = new Map<string, DayGroup>();
  const active: RunRow[] = [];
  for (const r of runs.value) {
    if (r.status === 'running' || r.status === 'queued') { active.push(r); continue; }
    if (r.started_at == null) continue; // orphans: invisible in a time log
    const d = new Date(r.started_at);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    let g = map.get(key);
    if (!g) {
      g = { key, label: dayLabel(d), runs: [], maxMs: null };
      map.set(key, g);
    }
    g.runs.push(r);
    const dur = r.finished_at != null ? r.finished_at - r.started_at : null;
    if (dur != null && (g.maxMs == null || dur > g.maxMs)) g.maxMs = dur;
  }
  const out = [...map.values()];
  if (active.length > 0) out.unshift({ key: 'active', label: 'in flight', runs: active, maxMs: null });
  return out;
});
function dayLabel(d: Date): string {
  const today = new Date();
  const yest = new Date(today.getTime() - 86_400_000);
  const same = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return 'today';
  if (same(d, yest)) return 'yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}
function daySyms(g: DayGroup): Array<{ t: string; cls: string }> {
  const c = { pass: 0, fail: 0, blocked: 0, aborted: 0 };
  for (const r of g.runs) {
    if (r.blocked === 1) c.blocked++;
    else if (r.status === 'passed') c.pass++;
    else if (r.status === 'failed') c.fail++;
    else if (r.status === 'aborted') c.aborted++;
  }
  const out: Array<{ t: string; cls: string }> = [];
  if (c.pass) out.push({ t: `${c.pass} ✓`, cls: '' });
  if (c.fail) out.push({ t: `${c.fail} ✕`, cls: 'bad' });
  if (c.blocked) out.push({ t: `${c.blocked} ◆`, cls: 'bad' });
  if (c.aborted) out.push({ t: `${c.aborted} ⌫`, cls: 'warn' });
  return out;
}

// ── row helpers ──
function caseName(r: RunRow): string | null {
  if (r.template_id && r.note?.startsWith('template:')) {
    // the note can carry appended audit lines after the name — the name is
    // the FIRST line only
    const firstLine = r.note.split('\n')[0] ?? '';
    return firstLine.slice(firstLine.indexOf(' ') + 1) || null;
  }
  return null;
}
function noteOf(r: RunRow): string | null {
  if (!r.note) return null;
  // the row shows the case name + the diagnostic only — audit stamps
  // (env sources:) are stripped wherever they appear (legacy rows carry
  // them mid-note after other lines were appended)
  const lines = r.note.split('\n').filter(l => !l.startsWith('env sources:'));
  const rest = lines.join('\n').trim();
  if (!rest || rest.startsWith('template:') || rest.startsWith('sidebar:')) return null;
  return rest;
}
function fmtDur(ms: number | null, running = false): string {
  if (running) return '…';
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${(s / 3600).toFixed(1)}h`;
}
function durOf(r: RunRow): { text: string; warn: boolean } {
  const isRun = r.status === 'running';
  const ms = isRun && r.started_at != null ? now.value - r.started_at : r.finished_at != null && r.started_at != null ? r.finished_at - r.started_at : null;
  return { text: fmtDur(ms, isRun), warn: ms != null && ms > 30 * 60 * 1000 };
}
function hhmm(ts: number | null): string {
  if (ts == null) return '—';
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function statusCls(r: RunRow): string {
  if (r.blocked === 1) return 'status-blocked';
  return `status-${r.status}`;
}
function statusText(r: RunRow): string {
  if (r.blocked === 1) return '◆ blocked';
  return r.status;
}
async function abort(r: RunRow): Promise<void> {
  try { await fetch(`/api/runs/${r.id}/abort`, { method: 'POST' }); void load(); } catch { /* next poll */ }
}

// chip counts from the loaded window (grow with load earlier — intended)
const counts = computed<Record<string, number>>(() => {
  const c: Record<string, number> = { '': runs.value.length, failed: 0, blocked: 0, aborted: 0, active: 0 };
  for (const r of runs.value) {
    if (r.blocked === 1) c['blocked']!++;
    else if (r.status === 'failed') c['failed']!++;
    else if (r.status === 'aborted') c['aborted']!++;
    if (r.status === 'running' || r.status === 'queued') c['active']!++;
  }
  return c;
});
const daysShown = computed(() => groups.value.filter((g) => g.key !== 'active').length);

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
  poll = setInterval(() => { now.value = Date.now(); void load(); }, 5000); // safety net + live duration tick
});
onUnmounted(() => { if (poll) clearInterval(poll); unwatch(); live.release(); });
</script>

<template>
  <div>
    <PageHeader title="runs">
      <span class="ph-desc">{{ runs.length }} loaded · {{ daysShown }} day{{ daysShown === 1 ? '' : 's' }} shown
        <span v-if="!live.connected" style="color: var(--color-ember);"> · live offline</span>
      </span>
      <template #actions>
        <button
          v-for="c in CHIPS" :key="c.key" class="chip" :class="{ on: statusFilter === c.key }"
          :title="c.key === 'active' ? 'running or waiting in queue' : c.key === 'blocked' ? 'infrastructure-blocked runs' : c.key === '' ? 'every run regardless of outcome' : `${c.label} runs only`"
          @click="setFilter(c.key)"
        >{{ c.label }} <span class="n">{{ counts[c.key] ?? 0 }}</span></button>
      </template>
    </PageHeader>

    <div v-if="runs.length === 0" class="empty">no runs match — clear the filter, or run a test case from the test cases page</div>

    <div v-else class="log">
      <template v-for="g in groups" :key="g.key">
        <div class="dayline">
          <b>{{ g.label }}</b>
          <template v-if="g.key === 'active'">
            <span>{{ g.runs.length }} running</span>
          </template>
          <template v-else>
            <span v-for="s in daySyms(g)" :key="s.t" :class="s.cls">{{ s.t }}</span>
            <span v-if="g.maxMs != null" :class="{ bad: g.maxMs > 30 * 60 * 1000 }">longest {{ fmtDur(g.maxMs) }}{{ g.maxMs > 30 * 60 * 1000 ? ' ⚠' : '' }}</span>
          </template>
        </div>
        <div
          v-for="r in g.runs" :key="r.id" class="ln"
          @click="router.push(`/runs/${r.id}`)"
        >
          <span class="t">{{ g.key === 'active' ? '▶' : hhmm(r.started_at) }}</span>
          <span class="case">
            <span class="name-row">
              <span v-if="caseName(r)" class="name">{{ caseName(r) }}</span>
              <span v-else-if="r.template_id" class="name">case {{ r.template_id.slice(0, 8) }}</span>
              <span v-else class="name dim">{{ r.kind === 'manual' ? 'manual drive' : '—' }}</span>
              <span
                v-if="r.versionInfo" class="rchip" :class="{ stale: !r.versionInfo.current }"
                :title="r.versionInfo.current
                  ? 'the current state of the case — click to open it'
                  : `ran superseded state r${r.versionInfo.revision} — click to view it read-only in the case editor`"
                @click.stop="r.versionInfo!.current
                  ? router.push(`/templates?case=${r.template_id}`)
                  : router.push(`/templates?case=${r.template_id}&rev=${r.versionInfo!.revision}`)"
              >{{ r.versionInfo.current ? 'current' : `r${r.versionInfo.revision} ⚠` }}</span>
            </span>
            <span v-if="noteOf(r)" class="note">{{ noteOf(r) }}</span>
          </span>
          <span class="dur" :class="{ 'dur-bad': durOf(r).warn }">{{ durOf(r).text }}{{ durOf(r).warn ? ' ⚠' : '' }}</span>
          <span class="by">{{ r.triggered_by }}</span>
          <span class="status" :class="statusCls(r)">{{ statusText(r) }}
            <button
              v-if="r.status === 'running' || r.status === 'queued'"
              class="stop" title="abort this run — remaining steps skip, device frees"
              @click.stop="abort(r)">■</button>
          </span>
        </div>
      </template>
    </div>

    <button v-if="runs.length > 0 && !exhausted" class="loadmore" :disabled="loadingEarlier" @click="loadEarlier">
      {{ loadingEarlier ? 'loading…' : 'load earlier ↓' }}
    </button>
    <div v-else-if="exhausted && runs.length > 0" class="endcap">— history start —</div>
  </div>
</template>

<style scoped>
/* chips */
.chip { border:1px solid var(--color-slate); color:var(--color-ash); padding:2px 10px; font-size:var(--text-caption); border-radius:var(--r); transition:all var(--t); }
.chip:hover { color:var(--color-paper); border-color:var(--color-chalk); }
.chip.on { border-color:var(--color-paper); color:var(--color-paper); }
.chip .n { color:var(--color-pewter); margin-left:4px; }
.chip.on .n { color:var(--color-fog); }

/* day divider */
.dayline { display:flex; align-items:baseline; gap:12px; color:var(--color-steel); font-size:var(--text-caption); padding:14px 0 6px; border-bottom:1px solid var(--color-iron); }
.dayline b { color:var(--color-fog); font-weight:400; }
.dayline .bad { color:var(--color-ember); }
.dayline .warn { color:var(--color-amber, #d9a03f); }

/* log line — grid: 44px time / 1fr case (title row + note line) / 76px dur / 114px by / 96px status */
.ln { display:grid; grid-template-columns:44px minmax(0,1fr) 76px 114px 96px; gap:12px; align-items:baseline; padding:5px 0; border-bottom:1px solid var(--color-graphite); cursor:pointer; transition:background var(--t); }
.ln:hover { background:var(--color-carbon); }
.t { color:var(--color-steel); font-size:var(--text-caption); }
.case { min-width:0; display:flex; flex-direction:column; }
.name-row { display:flex; align-items:baseline; gap:6px; padding-left:30px; min-width:0; }
.name-row .name { color:var(--color-paper); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.name-row .name.dim { color:var(--color-steel); }
.case .note { color:var(--color-steel); font-size:var(--text-caption); padding-left:30px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dur { color:var(--color-steel); font-size:var(--text-caption); text-align:right; }
.dur-bad { color:var(--color-ember); }
.by { color:var(--color-steel); font-size:var(--text-caption); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.status { font-size:var(--text-caption); text-align:right; white-space:nowrap; }
.status-passed { color:var(--color-pewter); }
.status-failed { color:var(--color-ember); font-weight:700; }
.status-aborted { color:var(--color-amber, #d9a03f); }
.status-blocked { color:var(--color-ember); }
.status-running, .status-queued { color:var(--color-fog); }

.rchip { border:1px solid var(--color-slate); color:var(--color-fog); border-radius:2px; padding:0 5px; font-size:10px; margin-left:6px; cursor:pointer; flex:none; }
.rchip:hover { border-color:var(--color-ember); color:var(--color-ember); }
.rchip.stale { border-color:var(--color-amber, #d9a03f); color:var(--color-amber, #d9a03f); }

.stop { background:none; border:none; color:var(--color-ember); cursor:pointer; font-size:11px; margin-left:6px; padding:0 2px; }
.stop:hover { color:var(--color-paper); }

.loadmore { display:block; margin:24px auto 0; border:1px solid var(--color-slate); color:var(--color-fog); padding:6px 16px; font-size:var(--text-label); border-radius:var(--r); }
.loadmore:hover { color:var(--color-paper); border-color:var(--color-chalk); }
.loadmore:disabled { color:var(--color-steel); cursor:default; }
.endcap { text-align:center; color:var(--color-steel); font-size:var(--text-caption); margin:24px 0; }
</style>
