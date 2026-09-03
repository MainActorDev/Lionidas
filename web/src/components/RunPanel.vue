<script setup lang="ts">
/** RunPanel — R1 observer dock (sketches/002-run-panel/r1-observer-dock).
 *  The run companion: fires when a case starts, shows the live device stream
 *  + that case's steps, highlights the executing step, stays LOCKED open until
 *  the run reaches a terminal status, then shows the verdict.
 *
 *  Wiring (all live events over the shared /api/events WS):
 *   - run.plan    → the expanded step list (subflows flattened; template steps
 *                   can't be keyed directly because expandFlows reindexes)
 *   - step.started/finished → per-step highlight + duration
 *   - run.finished → verdict; the panel unlocks
 *  Recovery: if the page loads mid-run (or the WS reconnects), the panel
 *  re-hydrates from GET /api/runs/:id/steps + the run row itself.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useDeviceStream } from '../composables/deviceStream.ts';
import { useLiveEvents } from '../stores/live.ts';

interface PlanStep { idx: number; action: string; name: string; flow: string | null; optional: boolean }
interface Row extends PlanStep { status: 'pending' | 'running' | 'pass' | 'fail' | 'skip'; durationMs: number | null; reason: string | null }

const props = defineProps<{
  runId: string;
  templateId: string;
  caseName: string;
  udid: string;
}>();

const emit = defineEmits<{ (e: 'close'): void; (e: 'open-run', runId: string): void }>();

const live = useLiveEvents();
const stream = useDeviceStream();

const rows = ref<Row[]>([]);
const status = ref<'running' | 'passed' | 'failed' | 'aborted'>('running');
const startedAt = ref<number | null>(null);
const finishedAt = ref<number | null>(null);
const blocked = ref(false);
const note = ref('');

/** hydrate from the server (page-load mid-run / reconnect) */
async function hydrate(): Promise<void> {
  try {
    const r = await fetch(`/api/runs/${props.runId}`);
    const b = (await r.json()) as { run?: { status: string; blocked: number; note: string | null; started_at: number | null; finished_at: number | null } };
    if (b.run) {
      startedAt.value = b.run.started_at;
      if (b.run.status !== 'queued' && b.run.status !== 'running') {
        status.value = b.run.status as typeof status.value;
        finishedAt.value = b.run.finished_at;
        blocked.value = b.run.blocked === 1;
        note.value = b.run.note ?? '';
      }
    }
    const s = await fetch(`/api/runs/${props.runId}/steps`);
    const sb = (await s.json()) as { steps?: Array<{ idx: number; flow_name: string | null; name: string; status: string; reason: string | null; duration_ms: number | null }> };
    if (sb.steps?.length) {
      // prefer live truth over partial hydrate: keep any running row
      if (rows.value.length === 0) {
        rows.value = sb.steps.map((x) => ({
          idx: x.idx, action: 'step', name: x.name, flow: x.flow_name, optional: false,
          status: x.status === 'pass' ? 'pass' : x.status === 'fail' ? 'fail' : x.status === 'skip' ? 'skip' : 'pending',
          durationMs: x.duration_ms, reason: x.reason,
        }));
        if (status.value === 'running') {
          const lastDone = rows.value.filter((r) => r.status !== 'pending');
          const firstPending = rows.value.find((r) => r.status === 'pending');
          if (lastDone.length && firstPending && rows.value.every((r) => r.status !== 'running')) {
            // run still live: the first unfinished row is executing now
            if (b?.run?.status === 'running') firstPending.status = 'running';
          }
        }
      }
    }
  } catch { /* hydrate best-effort — live events take over */ }
}

// ── live event handling ──
function onEvent(ev: { type: string; payload: Record<string, unknown> }): void {
  const p = ev.payload;
  const rid = p['runId'] as string | undefined;
  if (!rid || rid !== props.runId) return;
  if (ev.type === 'run.plan') {
    const steps = (p['steps'] as PlanStep[] | undefined) ?? [];
    if (rows.value.length === 0) {
      rows.value = steps.map((s) => ({ ...s, status: 'pending', durationMs: null, reason: null }));
    }
  } else if (ev.type === 'step.started') {
    const idx = p['idx'] as number;
    const row = rows.value.find((r) => r.idx === idx);
    if (row) row.status = 'running';
  } else if (ev.type === 'step.finished') {
    const idx = p['idx'] as number;
    const row = rows.value.find((r) => r.idx === idx);
    if (row) {
      row.status = (p['status'] as Row['status']) ?? 'pass';
      row.durationMs = (p['durationMs'] as number) ?? null;
    }
  } else if (ev.type === 'run.finished') {
    // any step still 'running' ended with the run — settle it as skip
    for (const r of rows.value) if (r.status === 'run' + '' || r.status === 'running') r.status = 'skip';
    status.value = (p['status'] as typeof status.value) ?? 'aborted';
    finishedAt.value = Date.now();
    void hydrate(); // blocked/note come from the run row
  }
}

const unwatch = watch(
  () => live.events.length,
  () => {
    const latest = live.events[live.events.length - 1];
    if (latest) onEvent(latest);
  },
  { flush: 'sync' },
);

// run counter clock
const clock = ref('00:00');
let clockTimer: ReturnType<typeof setInterval> | null = null;
function tick(): void {
  if (startedAt.value === null || status.value !== 'running') return;
  const end = finishedAt.value ?? Date.now();
  const s = Math.max(0, Math.floor((end - startedAt.value) / 1000));
  clock.value = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
onMounted(() => {
  live.connect();
  stream.start(props.udid);
  void hydrate();
  clockTimer = setInterval(tick, 500);
});
onBeforeUnmount(() => {
  unwatch();
  live.release();
  stream.stop();
  if (clockTimer) clearInterval(clockTimer);
});

// stream always tracks the run's device (a rerun on another device swaps it)
watch(() => props.udid, (u) => { if (u) stream.start(u); });

const doneCount = computed(() => rows.value.filter((r) => r.status === 'pass' || r.status === 'fail' || r.status === 'skip').length);
const activeIdx = computed(() => rows.value.find((r) => r.status === 'running')?.idx ?? null);
const progress = computed(() => (rows.value.length ? doneCount.value / rows.value.length : 0));
const verdict = computed(() => {
  if (status.value === 'running') return null;
  if (status.value === 'passed') return { big: '✓ PASS', cls: 'ok', sub: `${doneCount.value}/${rows.value.length} steps · ${clock.value}` };
  if (status.value === 'failed') return { big: '✕ FAIL', cls: 'fail', sub: `${doneCount.value}/${rows.value.length} steps · ${clock.value}${note.value ? ` · ${note.value}` : ''}` };
  return { big: blocked.value ? '◆ BLOCKED' : '◌ ABORTED', cls: 'blocked', sub: `${doneCount.value}/${rows.value.length} steps · ${clock.value}${note.value ? ` · ${note.value}` : ''}` };
});

// auto-scroll the active step into view
const stepsEl = ref<HTMLElement | null>(null);
watch(activeIdx, async () => { await nextTick(); stepsEl.value?.querySelector('.rp-step.active')?.scrollIntoView({ block: 'nearest' }); });

// LOCKED until the run is terminal — close is refused while running
function requestClose(): void {
  if (status.value === 'running') return;
  emit('close');
}
</script>

<template>
  <aside class="rp-dock" role="complementary" aria-label="run companion">
    <header class="rp-head">
      <span class="rp-name">{{ caseName }}</span>
      <span class="rp-live" :class="{ done: status !== 'running' }">{{ status === 'running' ? '● live' : '● finished' }}</span>
      <span class="rp-meta">{{ runId }} · {{ udid.slice(0, 8) }}…</span>
      <span class="rp-lock" :title="status === 'running' ? 'the panel stays open until the run finishes' : 'run finished — panel can be closed'">
        {{ status === 'running' ? '🔒 until done' : 'unlocked' }}
      </span>
    </header>

    <div class="rp-stream">
      <span class="rp-fps" v-if="stream.state.value !== 'failed'">{{ stream.state.value === 'live' ? `live · ${stream.fps.value}fps` : stream.state.value }}</span>
      <canvas ref="stream.setCanvas"></canvas>
      <div v-if="stream.state.value === 'failed'" class="rp-stream-fail">
        <span>stream unavailable</span>
        <span class="rp-fail-reason">{{ stream.failure.value }}</span>
        <button v-if="stream.retryable.value" class="btn btn-sm" @click="stream.retry()">retry stream</button>
      </div>
    </div>

    <div class="rp-steps" ref="stepsEl">
      <div class="rp-steps-title">steps · {{ doneCount }} / {{ rows.length }}</div>
      <div v-for="r in rows" :key="r.idx" class="rp-step" :class="r.status">
        <span class="rp-idx">{{ r.idx + 1 }}</span>
        <span class="rp-kind" :title="r.action">{{ r.action }}</span>
        <span class="rp-detail">{{ r.name }}</span>
        <span v-if="r.flow" class="rp-flow" :title="`subflow: ${r.flow}`">↳ {{ r.flow }}</span>
        <span class="rp-dur">{{ r.status === 'running' ? '…' : r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)}s` : '' }}</span>
      </div>
    </div>

    <footer class="rp-foot">
      <template v-if="status === 'running'">
        <span>step {{ Math.min((activeIdx ?? 0) + 1, rows.length) }} / {{ rows.length }}</span>
        <div class="rp-bar"><i :style="{ width: `${Math.round(progress * 100)}%` }"></i></div>
        <span class="rp-clock">{{ clock }}</span>
      </template>
      <div v-else class="rp-verdict" :class="verdict?.cls">
        <span class="rp-big">{{ verdict?.big }}</span>
        <span class="rp-sub">{{ verdict?.sub }}</span>
        <button class="rp-open" @click="emit('open-run', runId)">open run ↗</button>
        <button class="rp-close" @click="requestClose">✕ close</button>
      </div>
    </footer>
  </aside>
</template>

<style scoped>
/* R1 spec: dock 420 · pad 16/12 · stream 248 (9:19.5) · row 36 · head ≥42 · foot ≥44.
   Grid traps (both measured in the sketch): explicit minmax(0,1fr) column — a
   rows-only grid sizes its implicit column to max-content; min-width: 0 on all
   flexible flex children or they refuse to shrink (long step text). */
.rp-dock {
  position: fixed; right: 0; top: 0; bottom: 0; width: 420px; z-index: 80;
  display: grid; grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto auto minmax(120px, 1fr) auto;
  background: var(--color-void); border-left: 1px solid var(--color-iron);
  min-height: 0;
}
.rp-head {
  display: flex; align-items: center; gap: 10px; padding: 12px 16px;
  border-bottom: 1px solid var(--color-iron); background: var(--color-carbon);
  min-height: 42px;
}
.rp-name { color: var(--color-paper); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; }
.rp-live { color: var(--color-ember); font-size: 11px; flex: none; }
.rp-live.done { color: var(--color-steel); }
.rp-meta { color: var(--color-steel); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
.rp-lock { color: var(--color-steel); font-size: 10px; border: 1px solid var(--color-iron); border-radius: var(--r-sm); padding: 1px 6px; flex: none; }

.rp-stream { position: relative; height: 248px; border-bottom: 1px solid var(--color-iron); background: #000; display: grid; place-items: center; padding: 12px 16px; }
.rp-stream canvas { height: 100%; aspect-ratio: 9 / 19.5; border: 1px solid var(--color-iron); border-radius: 8px; background: var(--color-void); }
.rp-fps { position: absolute; right: 18px; top: 14px; color: var(--color-steel); font-size: 10px; background: rgba(0, 0, 0, 0.6); padding: 1px 5px; border-radius: 2px; }
.rp-stream-fail { display: flex; flex-direction: column; gap: 6px; align-items: center; color: var(--color-steel); font-size: 12px; padding: 0 24px; text-align: center; }
.rp-fail-reason { font-size: 10px; color: var(--color-steel); word-break: break-word; }

.rp-steps { overflow-y: auto; overscroll-behavior: contain; min-height: 0; padding: 8px 0; }
.rp-steps-title {
  position: sticky; top: 0; z-index: 1; background: var(--color-void);
  font-size: 10px; color: var(--color-steel); text-transform: uppercase; letter-spacing: 0.1em;
  padding: 2px 16px 8px; border-bottom: 1px solid var(--color-iron);
}
.rp-step {
  display: flex; gap: 10px; align-items: center; min-height: 36px;
  padding: 4px 16px; color: var(--color-steel); position: relative; min-width: 0;
}
.rp-idx { width: 22px; text-align: right; flex: none; font-size: 11px; }
.rp-step.pass .rp-idx::before { content: '✓ '; color: var(--color-mint, #2fbf71); }
.rp-step.fail .rp-idx::before { content: '✕ '; color: var(--color-lava, #e5484d); }
.rp-step.skip .rp-idx { text-decoration: line-through; }
.rp-kind {
  font-size: 10px; border: 1px solid var(--color-iron); border-radius: 2px;
  padding: 1px 6px; color: var(--color-fog); flex: none; min-width: 44px; text-align: center;
}
.rp-detail { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; min-width: 0; flex: 1; }
.rp-flow { color: var(--color-steel); font-size: 10px; flex: none; }
.rp-dur { margin-left: auto; color: var(--color-steel); font-size: 10px; flex: none; padding-left: 8px; font-variant-numeric: tabular-nums; }
.rp-step.running {
  color: var(--color-paper); background: color-mix(in srgb, var(--color-ember) 10%, transparent);
  box-shadow: inset 2px 0 var(--color-ember);
}
.rp-step.running .rp-kind { border-color: var(--color-ember); color: var(--color-ember); }

.rp-foot {
  display: flex; align-items: center; gap: 10px; padding: 10px 16px;
  border-top: 1px solid var(--color-iron); background: var(--color-carbon);
  min-height: 44px; color: var(--color-steel); font-size: 11px; min-width: 0;
}
.rp-bar { flex: 1; height: 4px; background: var(--color-iron); border-radius: 2px; overflow: hidden; min-width: 0; }
.rp-bar i { display: block; height: 100%; background: var(--color-ember); transition: width 0.3s; }
.rp-clock { font-variant-numeric: tabular-nums; flex: none; }
.rp-verdict { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; }
.rp-verdict.ok .rp-big { color: var(--color-mint, #2fbf71); }
.rp-verdict.fail .rp-big { color: var(--color-lava, #e5484d); }
.rp-verdict.blocked .rp-big { color: var(--color-amber, #d9a05b); }
.rp-big { font-weight: 700; font-size: 14px; flex: none; }
.rp-sub { color: var(--color-fog); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
.rp-open { margin-left: auto; color: var(--color-ember); font-size: 11px; text-decoration: underline; background: none; border: none; cursor: pointer; flex: none; }
.rp-close { color: var(--content-steel, var(--color-steel)); font-size: 11px; background: none; border: 1px solid var(--color-iron); border-radius: 2px; cursor: pointer; flex: none; padding: 1px 6px; }
</style>
