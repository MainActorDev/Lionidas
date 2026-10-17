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

interface PlanStep { idx: number; action: string; name: string; flow: string | null; optional: boolean; narrate?: string | null }
interface Row extends PlanStep { status: 'pending' | 'running' | 'pass' | 'fail' | 'skip'; durationMs: number | null; reason: string | null; stateAudit: { stateId: string; revision: number; path: string; probeMs?: number } | null }

const props = defineProps<{
  runId: string;
  templateId: string;
  caseName: string;
  udid: string;
  /** variant plays run N sequential lanes on one device; the dock follows
   *  lanes via run.started events (matched by templateId+udid) and stays
   *  locked until the LAST lane finishes, showing worst-of-lanes. 0/omitted
   *  = single-run watch (today's behavior). */
  laneCount?: number;
}>();

const emit = defineEmits<{ (e: 'close'): void; (e: 'open-run', runId: string): void }>();

const live = useLiveEvents();
const stream = useDeviceStream();

const rows = ref<Row[]>([]);
const status = ref<'running' | 'passed' | 'failed' | 'aborted'>('running');
/** variant-lane state: the dock follows the play's lanes (run.started
 *  events matched by templateId+udid), resetting per-lane UI when a lane
 *  adopts. Single-run watch (no lanes) keeps today's behavior. */
const lanes = ref<Array<{ runId: string; status: 'running' | 'passed' | 'failed' | 'aborted' }>>([]);
const laneIdx = ref(0);
const followLanes = computed(() => (props.laneCount ?? 0) > 1);
/** lanes still to come — the dock stays locked while any lane runs */
const lanesDone = computed(() => followLanes.value && laneIdx.value + 1 >= (props.laneCount ?? 1));
const activeRunId = computed(() => lanes.value[laneIdx.value]?.runId ?? props.runId);
/** readiness gate phase — 'stream' → 'app' → 'steps' (run.phase events);
 *  null once steps begin (plan/step events take over) */
const gate = ref<'stream' | 'app' | 'steps' | null>('stream');
/** tap markers — fired by step.tap events, fade after ~1.4s */
const taps = ref<Array<{ id: number; fx: number; fy: number }>>([]);
let tapSeq = 0;
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
    const sb = (await s.json()) as { steps?: Array<{ idx: number; flow_name: string | null; name: string; status: string; reason: string | null; duration_ms: number | null; narrate?: string | null; evaluated_json?: string | null }> };
    if (sb.steps?.length) {
      // prefer live truth over partial hydrate: keep any running row
      if (rows.value.length === 0) {
        rows.value = sb.steps.map((x) => ({
          idx: x.idx, action: 'step', name: x.name, flow: x.flow_name, optional: false, narrate: x.narrate ?? null,
          status: x.status === 'pass' ? 'pass' : x.status === 'fail' ? 'fail' : x.status === 'skip' ? 'skip' : 'pending',
          durationMs: x.duration_ms, reason: x.reason,
          // phase B S4 provenance: ensureState steps audit {stateId, revision,
          // path, probeMs} in evaluated_json — the chip shows WHICH state
          // revision this run converged with and HOW (probe-hit vs walk)
          stateAudit: (() => { try { const j = JSON.parse(x.evaluated_json ?? 'null') as { action?: string; stateId?: string; revision?: number; path?: string; probeMs?: number } | null; return j?.action === 'ensureState' && typeof j.stateId === 'string' && typeof j.revision === 'number' ? { stateId: j.stateId, revision: j.revision, path: String(j.path ?? ''), ...(typeof j.probeMs === 'number' ? { probeMs: j.probeMs } : {}) } : null; } catch { return null; } })(),
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
  if (ev.type === 'run.started' && followLanes.value) {
    // lane hand-off: a NEW run of the same case+device = the next variant
    // lane starting (the server chains lanes sequentially). Adopt it: the
    // per-lane UI resets (steps/gate/clock) while the stream keeps playing.
    const t = p['templateId'] as string | undefined;
    const u = p['udid'] as string | undefined;
    if (rid && t === props.templateId && u === props.udid && rid !== activeRunId.value) {
      lanes.value.push({ runId: rid, status: 'running' });
      laneIdx.value = lanes.value.length - 1;
      adoptLane(rid);
    }
    return;
  }
  if (!rid || rid !== activeRunId.value) return;
  if (ev.type === 'run.phase') {
    gate.value = (p['phase'] as typeof gate.value) ?? null;
  } else if (ev.type === 'step.tap') {
    // logical → fraction; canvas maps the same logical space, so the marker
    // tracks the canvas regardless of its rendered size
    const x = p['x'] as number; const y = p['y'] as number;
    const w = p['logicalW'] as number; const h = p['logicalH'] as number;
    if (w > 0 && h > 0) {
      const id = ++tapSeq;
      taps.value.push({ id, fx: x / w, fy: y / h });
      if (taps.value.length > 4) taps.value.shift();
      setTimeout(() => { taps.value = taps.value.filter((t) => t.id !== id); }, 1400);
    }
  } else if (ev.type === 'run.plan') {
    const steps = (p['steps'] as PlanStep[] | undefined) ?? [];
    if (rows.value.length === 0) {
      rows.value = steps.map((s) => ({ ...s, status: 'pending', durationMs: null, reason: null, stateAudit: null }));
    }
    gate.value = null; // steps own the footer from here
  } else if (ev.type === 'step.started') {
    gate.value = null; // adopted runs skip run.plan — steps own the footer
    const idx = p['idx'] as number;
    const row = rows.value.find((r) => r.idx === idx);
    if (row) row.status = 'running';
    const nv = p['narrate'] as string | null | undefined; // absent on old servers — tolerate
    if (row && nv !== undefined && row.narrate === undefined) row.narrate = nv;
  } else if (ev.type === 'step.finished') {
    const idx = p['idx'] as number;
    const row = rows.value.find((r) => r.idx === idx);
    if (row) {
      row.status = (p['status'] as Row['status']) ?? 'pass';
      row.durationMs = (p['durationMs'] as number) ?? null;
    }
  } else if (ev.type === 'run.aborted') {
    // click-time abort ack (Task 0): settle immediately — running steps
    // ended with the run; the record flip follows in the run's finally.
    for (const r of rows.value) if (r.status === 'running') r.status = 'skip';
    if (followLanes.value) {
      // abort stops the WHOLE play (server cascade): mark the active lane,
      // treat un-started lanes as aborted, settle on worst-of-lanes now
      if (lanes.value[laneIdx.value]) lanes.value[laneIdx.value]!.status = 'aborted';
      while (lanes.value.length < (props.laneCount ?? 1)) lanes.value.push({ runId: '', status: 'aborted' });
      status.value = worstLane();
      finishedAt.value = Date.now();
      return;
    }
    status.value = 'aborted';
    finishedAt.value = Date.now();
    void hydrate();
  } else if (ev.type === 'run.finished') {
    // any step still 'running' ended with the run — settle it as skip
    for (const r of rows.value) if (r.status === 'running') r.status = 'skip';
    const st = (p['status'] as typeof status.value) ?? 'aborted';
    if (followLanes.value) {
      // per-lane bookkeeping; the panel settles only when the LAST lane
      // finishes — worst lane wins, mirroring the verdict pill
      if (lanes.value[laneIdx.value]) lanes.value[laneIdx.value]!.status = st;
      if (lanesDone.value) {
        status.value = worstLane();
        finishedAt.value = Date.now();
        void hydrateActive();
      }
      return;
    }
    status.value = st;
    finishedAt.value = Date.now();
    void hydrate();
  }
}

/** worst-of-lanes: failed > aborted > passed (mirrors the verdict pill) */
function worstLane(): 'passed' | 'failed' | 'aborted' {
  const st = lanes.value.map((l) => l.status);
  if (st.some((s) => s === 'failed')) return 'failed';
  if (st.some((s) => s === 'aborted')) return 'aborted';
  return 'passed';
}

/** adopt a new lane: reset the per-lane UI, keep the stream + case name */
function adoptLane(rid: string): void {
  rows.value = [];
  gate.value = 'stream';
  taps.value = [];
  startedAt.value = Date.now();
  finishedAt.value = null;
  note.value = '';
  blocked.value = false;
  status.value = 'running';
  clock.value = '00:00';
  void hydrateActive();
}

/** hydrate the ACTIVE lane's run row (shared by lane adoption + finish) */
async function hydrateActive(): Promise<void> {
  try {
    const r = await fetch(`/api/runs/${activeRunId.value}`);
    const b = (await r.json()) as { run?: { status: string; blocked: number; note: string | null; started_at: number | null; finished_at: number | null } };
    if (b.run) {
      startedAt.value = b.run.started_at;
      if (b.run.status !== 'queued' && b.run.status !== 'running') {
        if (lanes.value[laneIdx.value]) {
          lanes.value[laneIdx.value]!.status = b.run.status as 'passed' | 'failed' | 'aborted';
        }
      }
      if (followLanes.value && lanesDone.value && b.run.status !== 'queued' && b.run.status !== 'running') {
        status.value = worstLane();
        finishedAt.value = b.run.finished_at;
        blocked.value = b.run.blocked === 1;
        note.value = b.run.note ?? '';
      }
    }
  } catch { /* hydrate best-effort — live events take over */ }
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
// ── stream box: deterministic phone fit ──
// aspect-ratio + max-width clamps NON-deterministically: when the width clamp
// wins (tall windows), CSS keeps the full height and the phone letterboxes
// with big black bands — the "content pushed to bottom" look. Size the wrap
// from the measured box instead: the largest phone-ratio rectangle that fits.
const streamEl = ref<HTMLElement | null>(null);
function fitStreamBox(): void {
  const box = streamEl.value;
  const wrap = box?.querySelector<HTMLElement>('.rp-canvas-wrap');
  const dock = box?.closest<HTMLElement>('.rp-dock');
  if (!box || !wrap || !dock) return;
  const pad = 32; // .rp-stream padding (16px each side)
  const availH = box.clientHeight - pad;
  const ratio = 9 / 19.5; // phone aspect (portrait)
  // height-first: the phone spans the FULL column height, width follows the
  // ratio — flush top-to-bottom, no voids. Cap so the steps column keeps a
  // minimum of ~320px; only genuinely narrow docks letterbox (graceful).
  const maxW = dock.clientWidth - pad - 320;
  let h = availH;
  let w = h * ratio;
  if (w > maxW) { w = maxW; h = w / ratio; }
  wrap.style.width = `${Math.max(1, Math.round(w))}px`;
  wrap.style.height = `${Math.max(1, Math.round(h))}px`;
}
let ro: ResizeObserver | null = null;
onMounted(() => {
  live.connect();
  stream.start(props.udid);
  if (followLanes.value) lanes.value = [{ runId: props.runId, status: 'running' }];
  void hydrate();
  clockTimer = setInterval(tick, 500);
  // keep the phone box fitted through window resizes / dock relayouts
  ro = new ResizeObserver(() => fitStreamBox());
  if (streamEl.value) ro.observe(streamEl.value);
  nextTick(() => fitStreamBox());
});
onBeforeUnmount(() => {
  ro?.disconnect(); ro = null;
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
/** Gherkin narrate split: keyword (Given/When/Then/And/But) subtly accented */
function narrateKeyword(n: string): string { const m = n.match(/^(Given|When|Then|And|But)\b\s*/i); return m ? m[0].trim() : ''; }
function narrateRest(n: string): string { return n.slice(narrateKeyword(n).length).trim(); }

watch(activeIdx, async () => { await nextTick(); stepsEl.value?.querySelector('.rp-step.active')?.scrollIntoView({ block: 'nearest' }); });

// LOCKED until the run is terminal — close is refused while running
function requestClose(): void {
  if (status.value === 'running') return;
  emit('close');
}

// abort (Task 3): single click, idempotent endpoint; the run.aborted ack
// settles the panel (steps skip, verdict ◌ ABORTED) and — per user
// request 2026-09-06 — the panel CLOSES itself once the ack lands, instead
// of lingering unlocked on an aborted run.
const aborting = ref(false);
async function requestAbort(): Promise<void> {
  if (status.value !== 'running' || aborting.value) return;
  aborting.value = true;
  try {
    // abort the ACTIVE lane; the server's abort cascade stops later lanes
    // of the play (an aborted lane means the user stopped the play)
    await fetch(`/api/runs/${activeRunId.value}/abort`, { method: 'POST' });
    if (!followLanes.value) {
      status.value = 'aborted';
      emit('close');
    }
    // lane mode: run.aborted lands via events; the panel settles through
    // worstLane() when the last lane reports — no manual close here
  } catch { /* hydrate/poll will surface terminal state anyway */ }
  finally { aborting.value = false; }
}
</script>

<template>
  <aside class="rp-dock" role="complementary" aria-label="run companion">
    <header class="rp-head">
      <span class="rp-name">{{ caseName }}</span>
      <span class="rp-live" :class="{ done: status !== 'running' }">{{ status === 'running' ? '● live' : '● finished' }}</span>
      <span class="rp-meta">{{ activeRunId }} · {{ udid.slice(0, 8) }}…</span>
      <span v-if="followLanes" class="rp-lanes" :title="`variant lanes: ${lanes.map((l) => l.status).join(' · ')}`">lane {{ laneIdx + 1 }}/{{ laneCount }}</span>
      <span class="rp-lock" :title="status === 'running' ? 'the panel stays open until the run finishes' : 'run finished — panel can be closed'">
        {{ status === 'running' ? '🔒 until done' : 'unlocked' }}
      </span>
      <span class="rp-fps" v-if="stream.state.value !== 'failed'">{{ stream.state.value === 'live' ? `live · ${stream.fps.value}fps` : stream.state.value }}</span>
      <button v-if="status === 'running'" class="rp-abort" :disabled="aborting" @click="requestAbort"
        title="abort — lands after the current step finishes">{{ aborting ? 'aborting…' : '■ abort' }}</button>
    </header>

    <div class="rp-body">
      <div class="rp-stream" ref="streamEl">
        <div class="rp-canvas-wrap">
          <canvas :ref="stream.setCanvas"></canvas>
          <span
            v-for="t in taps" :key="t.id" class="rp-tap" :style="{ left: `${t.fx * 100}%`, top: `${t.fy * 100}%` }"
          ><i></i><i></i></span>
        </div>
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
          <span v-if="r.stateAudit" class="rp-state" :class="r.stateAudit.path" :title="`ensure state: ${r.stateAudit.stateId} · revision ${r.stateAudit.revision}${r.stateAudit.probeMs !== undefined ? ` · probe ${r.stateAudit.probeMs}ms` : ''}`"><span class="rp-state-glyph">{{ r.stateAudit.path === 'probe-hit' ? '↷' : '→' }}</span>{{ r.stateAudit.stateId }} · r{{ r.stateAudit.revision }}</span>
          <span class="rp-dur">{{ r.status === 'running' ? '…' : r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)}s` : '' }}</span>
          <div v-if="r.narrate" class="rp-narrate"><span class="rp-narrate-kw">{{ narrateKeyword(r.narrate) }}</span><span class="rp-narrate-rest">{{ narrateRest(r.narrate) }}</span></div>
        </div>
      </div>
    </div>

    <footer class="rp-foot">
      <template v-if="gate">
        <span class="rp-gate">{{ gate === 'stream' ? '◦ waiting for device stream…' : gate === 'app' ? '◦ reopening app…' : '◦ preparing steps…' }}</span>
        <div class="rp-bar rp-bar-gate"><i></i></div>
      </template>
      <template v-else-if="status === 'running'">
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
/* horizontal split: stream left, steps right, equal halves (user request —
   the vertical stack made the 9:19.5 stream too small to read). Grid traps
   from the vertical spec still apply: minmax(0,1fr) columns, min-width: 0. */
.rp-dock {
  /* below the app topbar — the shell's top strip is not ours to cover */
  position: fixed; right: 0; top: var(--topbar-h); bottom: 0; width: min(840px, 92vw); z-index: 80;
  display: grid; grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr) auto;
  background: var(--color-void); border-left: 1px solid var(--color-iron);
  min-height: 0;
}
.rp-body {
  /* stream column sizes to the fitted phone (auto) — the phone fills the
     full height flush; steps get the remainder. An equal 420/420 split can
     never be filled by a 9:19.5 phone: it letterboxes with big voids. */
  display: grid; grid-template-columns: auto minmax(0, 1fr);
  min-height: 0; border-bottom: 1px solid var(--color-iron);
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
.rp-lanes { color: var(--color-fog); font-size: 10px; border: 1px solid var(--color-iron); border-radius: var(--r-sm); padding: 1px 6px; flex: none; white-space: nowrap; }

.rp-stream { position: relative; border-right: 1px solid var(--color-iron); background: #000; display: flex; align-items: center; justify-content: center; padding: 16px; overflow: hidden; min-height: 0; }
/* canvas sizing must come from the BOX, not the intrinsic 300×150 backing
   store (pre-frames it fell back to intrinsic + aspect-ratio → 302×654).
   Flex centering (not grid place-items) so the implicit row can't grow to
   content height and defeat max-height: 100%. */
/* canvas sizing: the WRAP is the aspect-locked box (height 100% of the
   stream column is definite there; width follows the 9:19.5 ratio) — the
   canvas just fills it. object-fit guards the extreme-narrow fallback
   (92vw clamp) where the box ratio breaks: the bitmap stays undistorted. */
.rp-canvas-wrap { position: relative; display: flex; } /* JS-sized: fitStreamBox() */
.rp-stream canvas { width: 100%; height: 100%; object-fit: contain; border: 1px solid var(--color-iron); border-radius: 8px; background: var(--color-void); display: block; }
/* tap ripple: fraction-positioned over the canvas — the canvas maps the same
   logical space the fractions were computed from */
.rp-tap { position: absolute; translate: -50% -50%; width: 0; height: 0; pointer-events: none; z-index: 2; }
.rp-tap i { position: absolute; left: 0; top: 0; border-radius: 999px; translate: -50% -50%; border: 2px solid var(--color-ember, #e06f5d); }
.rp-tap i:first-child { width: 14px; height: 14px; background: var(--color-ember, #e06f5d); opacity: 0.9; animation: rp-tap-pop 0.18s ease-out; }
.rp-tap i:last-child { width: 14px; height: 14px; border-color: rgba(245, 165, 36, 0.9); animation: rp-tap-ring 1.2s ease-out forwards; }
@keyframes rp-tap-pop { from { transform: scale(0.4); } to { transform: scale(1); } }
@keyframes rp-tap-ring { from { transform: scale(0.8); opacity: 0.9; } to { transform: scale(3.2); opacity: 0; } }
.rp-fps { flex: none; color: var(--color-steel); font-size: 10px; background: rgba(0, 0, 0, 0.6); padding: 1px 5px; border-radius: 2px; }
.rp-abort {
  flex: none; margin-left: auto; cursor: pointer; font: inherit; font-size: 10px;
  color: var(--color-accent, #e5484d); background: none;
  border: 1px solid var(--color-accent, #e5484d); border-radius: 3px; padding: 1px 6px;
}
.rp-abort:disabled { opacity: .55; cursor: default; }
.rp-abort:not(:disabled):hover { background: rgba(229, 72, 77, .12); }
.rp-stream-fail { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 6px; align-items: center; justify-content: center; background: rgba(0,0,0,.55); color: var(--color-steel); font-size: 12px; text-align: center; z-index: 5; }
.rp-fail-reason { font-size: 10px; color: var(--color-steel); word-break: break-word; }
/* phase B S4 provenance chip: which state revision converged, and how —
   probe-hit (↷, sage = idempotent skip) vs recipe (→, steel = the walk ran) */
.rp-state { font-family: var(--font-mono); font-size: 10px; color: var(--color-pewter); white-space: nowrap; }
.rp-state.probe-hit { color: var(--color-ok); } /* sage family: metric green = the idempotent skip */
.rp-state-glyph { margin-right: 2px; }

.rp-steps { overflow-y: auto; overscroll-behavior: contain; min-height: 0; padding: 8px 0; }
.rp-narrate { flex-basis: 100%; order: -1; padding-left: 26px; font-size: 10px; line-height: 1.5; margin-bottom: -2px; }
.rp-narrate-kw { color: var(--color-fog); font-weight: 600; margin-right: 4px; }
.rp-narrate-rest { color: var(--color-steel); }
.rp-steps-title {
  position: sticky; top: 0; z-index: 1; background: var(--color-void);
  font-size: 10px; color: var(--color-steel); text-transform: uppercase; letter-spacing: 0.1em;
  padding: 2px 16px 8px; border-bottom: 1px solid var(--color-iron);
}
.rp-step {
  display: flex; flex-wrap: wrap; gap: 10px; align-items: center; min-height: 36px;
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
.rp-gate { color: var(--color-fog); font-size: 11px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rp-bar-gate i { width: 30%; animation: rp-gate-sweep 1.4s ease-in-out infinite; }
@keyframes rp-gate-sweep { 0% { margin-left: -30%; } 100% { margin-left: 100%; } }
.rp-verdict { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; }
.rp-verdict.ok .rp-big { color: var(--color-mint, #2fbf71); }
.rp-verdict.fail .rp-big { color: var(--color-lava, #e5484d); }
.rp-verdict.blocked .rp-big { color: var(--color-amber, #d9a05b); }
.rp-big { font-weight: 700; font-size: 14px; flex: none; }
.rp-sub { color: var(--color-fog); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
.rp-open { margin-left: auto; color: var(--color-ember); font-size: 11px; text-decoration: underline; background: none; border: none; cursor: pointer; flex: none; }
.rp-close { color: var(--content-steel, var(--color-steel)); font-size: 11px; background: none; border: 1px solid var(--color-iron); border-radius: 2px; cursor: pointer; flex: none; padding: 1px 6px; }
</style>
