<script setup lang="ts">
/** Cockpit rail — watch pane (S3): session / run watch / run activity /
 *  traffic, all bound to the ACTIVE device; env drawer content. Data from
 *  the shared live-events store (bus) + light fetches. Clear-then-fill on
 *  device switch (no stale-device data rendered). */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import WatcherSection from '../shared/WatcherSection.vue';
import WatcherSteps from '../shared/WatcherSteps.vue';
import LogTail from '../shared/LogTail.vue';
import { useLiveEvents } from '../../stores/live.ts';

const props = defineProps<{ udid: string; sessionId: string | null; dims: { w: number | null; h: number | null } }>();

const live = useLiveEvents();
onMounted(() => live.connect());
onBeforeUnmount(() => live.release());

// ── run watch: RunPanel's row model, per device (fan-out runs are parallel —
// the pane tracks EVERY device's run and shows the active device's first,
// others summarized; narrate text renders with the Gherkin keyword accent) ──
interface StepRow { idx: number; action: string; name: string; flow: string | null; status: 'todo' | 'running' | 'pass' | 'fail' | 'skip'; durationMs: number | null; narrate: string | null }
interface DeviceRun { udid: string; runId: string; steps: StepRow[]; status: 'running' | 'passed' | 'failed' | 'aborted'; startedAt: number }
const runs = ref<Map<string, DeviceRun>>(new Map()); // udid → run

// ── run activity (F4 label: run + traffic events, NOT device logs) ──
interface ActRow { ts: string; text: string; kind?: 'hit' | 'err' }
const activity = ref<ActRow[]>([]);
const trafficRows = computed((): ActRow[] => live.traffic.slice(0, 12).map((t: Record<string, unknown>) => ({
  ts: fmt(t['ts'] as number | undefined),
  text: `${t['method'] ?? '?'} ${String(t['path'] ?? '')} → ${t['status'] ?? '?'}`,
})));

function fmt(ms?: number): string {
  const d = ms ? new Date(ms) : new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function touch(ev: { type: string; payload: Record<string, unknown>; at: number }): void {
  const p = ev.payload;
  const evUdid = typeof p['udid'] === 'string' ? p['udid'] : null;
  const runFor = (rid: unknown): DeviceRun | undefined => {
    for (const r of runs.value.values()) if (r.runId === String(rid)) return r;
    return undefined;
  };
  const sync = (): void => { runs.value = new Map(runs.value); };
  switch (ev.type) {
    case 'run.started': {
      if (!evUdid) return;
      const rid = String(p['runId'] ?? '');
      runs.value.set(evUdid, { udid: evUdid, runId: rid, steps: [], status: 'running', startedAt: Date.now() });
      sync();
      pushAct(`run started${evUdid === props.udid ? '' : ` · ${deviceLabel(evUdid)}`} · ${rid.slice(0, 18)}`);
      break;
    }
    case 'run.plan': {
      const r = runFor(p['runId']); if (!r) return;
      const list = (p['steps'] ?? []) as Array<{ name: string; narrate?: string | null }>;
      r.steps = list.map((s, i) => ({ idx: i, action: 'step', name: s.name, flow: null, status: 'todo' as const, durationMs: null, narrate: s.narrate ?? null }));
      sync();
      break;
    }
    case 'step.started': {
      const r = runFor(p['runId']); if (!r) return;
      const i = Number(p['idx'] ?? -1);
      if (r.steps[i]) r.steps[i]!.status = 'running';
      sync();
      break;
    }
    case 'step.finished': {
      const r = runFor(p['runId']); if (!r) return;
      const i = Number(p['idx'] ?? -1);
      const st = String(p['status'] ?? '');
      if (r.steps[i]) r.steps[i] = { ...r.steps[i]!, status: (st === 'pass' ? 'pass' : st === 'skip' ? 'skip' : 'fail') as StepRow['status'], durationMs: Number(p['duration_ms'] ?? 0) || null };
      sync();
      if (r.udid === props.udid) pushAct(`${String(p['name'] ?? 'step')} · ${st}`, st === 'fail' ? 'err' : undefined);
      break;
    }
    case 'run.finished': {
      const r = runFor(p['runId']); if (!r) return;
      r.status = String(p['status'] ?? '') === 'passed' ? 'passed' : String(p['status'] ?? '') === 'failed' ? 'failed' : 'aborted';
      sync();
      pushAct(`run finished${r.udid === props.udid ? '' : ` · ${deviceLabel(r.udid)}`} · ${r.status}`, r.status === 'failed' ? 'err' : 'hit');
      break;
    }
  }
}
function deviceLabel(udid: string): string {
  // the page knows names; the pane only gets udids — last 8 hex reads fine in a log line
  return udid.slice(0, 8);
}
function pushAct(text: string, kind?: 'hit' | 'err'): void {
  activity.value.unshift({ ts: fmt(), text, ...(kind ? { kind } : {}) });
  if (activity.value.length > 30) activity.value.pop();
}

// event subscription: process the tail of the rolling window on mount, then live
let lastAt = 0;
const TICK = (): void => {
  for (const ev of live.events) {
    if (ev.at <= lastAt) continue;
    lastAt = ev.at;
    touch(ev);
  }
};
const timer = setInterval(TICK, 500);
onBeforeUnmount(() => clearInterval(timer));

// clear-then-fill on device switch
watch(() => props.udid, () => {
  activity.value = [];
});

const activeRun = computed((): DeviceRun | null => runs.value.get(props.udid) ?? null);
const otherRuns = computed((): DeviceRun[] => [...runs.value.values()].filter((r) => r.udid !== props.udid));
const doneCount = computed((): number => activeRun.value?.steps.filter((s) => s.status === 'pass' || s.status === 'fail' || s.status === 'skip').length ?? 0);
const runMeta = computed((): string => {
  const r = activeRun.value;
  if (!r) return otherRuns.value.length ? `${otherRuns.value.length} run${otherRuns.value.length > 1 ? 's' : ''} elsewhere` : 'no active run';
  return `${r.runId.slice(0, 14)} · ${r.status === 'running' ? 'running' : r.status}`;
});
function narrateKeyword(n: string): string { const m = n.match(/^(Given|When|Then|And|But)\b\s*/i); return m ? m[0].trim() : ''; }
function narrateRest(n: string): string { return n.slice(narrateKeyword(n).length).trim(); }
const statusSym = (s: StepRow['status']): string => s === 'pass' ? '✓' : s === 'fail' ? '✕' : s === 'skip' ? '◌' : s === 'running' ? '◆' : '◌';
</script>

<template>
  <div class="pane">
    <WatcherSection title="session" :meta="sessionId ? 'live' : 'idle'">
      <div class="row"><span class="k">lease</span><span class="v">{{ sessionId ?? '—' }}</span></div>
      <div class="row"><span class="k">dims</span><span class="v">{{ dims.w && dims.h ? `${dims.w} × ${dims.h}` : '—' }}</span></div>
    </WatcherSection>

    <WatcherSection title="run watch" :meta="runMeta">
      <template v-if="activeRun">
        <div class="runsteps">
          <div v-for="r in activeRun.steps" :key="r.idx" class="rs" :class="r.status">
            <span class="sym">{{ statusSym(r.status) }}</span>
            <span class="nm">{{ r.name }}</span>
            <span v-if="r.durationMs !== null" class="dur">{{ (r.durationMs / 1000).toFixed(1) }}s</span>
            <div v-if="r.narrate" class="narrate"><span class="kw">{{ narrateKeyword(r.narrate) }}</span><span>{{ narrateRest(r.narrate) }}</span></div>
          </div>
        </div>
        <div class="meter">
          <span class="track"><span class="fill" :style="{ width: (100 * doneCount / Math.max(activeRun.steps.length, 1)) + '%' }" /></span>
          <span>{{ doneCount }}/{{ activeRun.steps.length }}</span>
        </div>
        <div v-if="activeRun.status !== 'running'" class="verdict" :class="activeRun.status">
          {{ activeRun.status === 'passed' ? '✓ PASS' : activeRun.status === 'failed' ? '✕ FAIL' : '◌ ABORTED' }}
        </div>
      </template>
      <div v-else class="k">no run on this device</div>
      <div v-if="otherRuns.length" class="others">
        <div class="k others-title">also running</div>
        <div v-for="r in otherRuns" :key="r.runId" class="other" :class="r.status">
          <span class="sym">{{ r.status === 'running' ? '◆' : r.status === 'passed' ? '✓' : r.status === 'failed' ? '✕' : '◌' }}</span>
          <span>{{ deviceLabel(r.udid) }}</span>
          <span class="k">{{ r.steps.filter((s) => s.status === 'pass').length }}/{{ r.steps.length }} · {{ r.status }}</span>
        </div>
      </div>
    </WatcherSection>

    <WatcherSection title="run activity" meta="live">
      <LogTail v-if="activity.length" :rows="activity.slice(0, 12)" />
      <div v-else class="k">quiet</div>
    </WatcherSection>

    <WatcherSection title="traffic" meta="forge">
      <LogTail v-if="trafficRows.length" :rows="trafficRows" />
      <div v-else class="k">no hits</div>
    </WatcherSection>
  </div>
</template>

<style scoped>
.pane { display: flex; flex-direction: column; min-height: 0; }
.runsteps { font-size: 11px; max-height: 220px; overflow-y: auto; }
.rs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 2px 0; color: var(--color-ash); }
.rs .sym { width: 12px; flex: none; text-align: center; }
.rs.pass { color: var(--color-fog); } .rs.pass .sym { color: var(--color-paper); }
.rs.fail .sym { color: var(--color-paper); } .rs.fail .nm { text-decoration: line-through; text-decoration-color: var(--color-ember); }
.rs.running { color: var(--color-ember); }
.rs .dur { margin-left: auto; font-size: 9.5px; color: var(--color-steel); }
.rs .narrate { flex-basis: 100%; padding-left: 18px; font-size: 10px; line-height: 1.5; }
.rs .narrate .kw { color: var(--color-fog); font-weight: 600; margin-right: 4px; }
.rs .narrate span:last-child { color: var(--color-steel); }
.meter { display: flex; gap: 6px; align-items: center; font-size: 10px; color: var(--color-ash); margin-top: 6px; }
.meter .track { flex: 1; height: 3px; background: var(--color-iron); position: relative; }
.meter .fill { position: absolute; inset: 0 auto 0 0; height: 3px; background: var(--color-ember); }
.verdict { margin-top: 6px; font-size: 11px; letter-spacing: .08em; }
.verdict.passed { color: var(--color-paper); }
.verdict.failed { color: var(--color-ember); }
.others { margin-top: 8px; border-top: 1px dotted var(--color-iron); padding-top: 6px; }
.others-title { margin-bottom: 3px; }
.other { display: flex; gap: 6px; align-items: center; font-size: 10.5px; color: var(--color-fog); padding: 1px 0; }
.other .k { margin-left: auto; }
.row { display: flex; justify-content: space-between; padding: 3px 0; font-size: var(--text-caption); }
.k { color: var(--color-fog); font-size: var(--text-caption); }
.v { color: var(--color-paper); }
</style>
