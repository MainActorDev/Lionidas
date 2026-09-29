<script setup lang="ts">
import PageHeader from '../components/PageHeader.vue';
import TriagePanel from '../components/TriagePanel.vue';
import { useLiveEvents } from '../stores/live.ts';
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';

interface Step { idx: number; flow_name: string; kind: string; name: string; status: string; reason: string | null; duration_ms: number; evidence_ids_json: string; evaluated_json?: string | null; narrate?: string | null }
interface EvidenceRow { id: string; type: string; path: string; bytes: number }
interface Run { id: string; ticket_key: string; status: string; kind: string; triggered_by: string; device_udid: string; artifact_hash: string | null; freshness: string; launch_args_json: string; started_at: number | null; finished_at: number | null; template_id: string | null; app_version: string | null; app_build?: string | null; app_bundle_id?: string | null; blocked: number; note: string | null }

const route = useRoute();
const runId = route.params.id as string;
const run = ref<Run | null>(null);
const evidence = ref<EvidenceRow[]>([]);
const steps = ref<Step[]>([]);
const live = useLiveEvents();
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;

// disclosures — all expanded by default (user call, 2026-09-23; collapse is
// still one click for readers who want the short page)
const stepsOpen = ref(true);
const netOpen = ref(true);
const rawOpen = ref(true);
const evOpen = ref(true);

function stepEvidence(s: Step): string[] {
  try { return JSON.parse(s.evidence_ids_json || '[]') as string[]; } catch { return []; }
}

function fmtBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

async function load(): Promise<void> {
  const [r, s] = await Promise.all([
    fetch(`/api/runs/${runId}`).then((x) => x.json()) as Promise<{ run: Run; evidence: EvidenceRow[] }>,
    fetch(`/api/runs/${runId}/steps`).then((x) => x.json()) as Promise<{ steps: Step[] }>,
  ]);
  run.value = r.run;
  steps.value = s.steps;
  evidence.value = r.evidence ?? [];
  void loadTraffic();
  void loadDeviceName();
}

const attachMsg = ref('');

/** this run's own HTTP traffic — what the app (and the host, while the
 *  proxy routes it) talked to while THIS run executed. Empty + proxy down =
 *  hint, not silence (pages teach themselves). */
interface TrafficRow { id: string; run_id: string | null; ts: number; method: string; host: string; path: string; status: number; latency_ms: number }
const traffic = ref<TrafficRow[]>([]);
const proxyRunning = ref(false);
async function loadTraffic(): Promise<void> {
  const [t, m] = await Promise.all([
    fetch(`/api/forge/traffic?runId=${runId}`).then((x) => x.json()) as Promise<{ traffic: TrafficRow[] }>,
    fetch('/api/forge/mitm/status').then((x) => x.json()) as Promise<{ running: boolean }>,
  ]);
  traffic.value = t.traffic ?? [];
  proxyRunning.value = m.running;
}
async function attachJira(): Promise<void> {
  const res = await fetch(`/api/runs/${runId}/attach`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const body = await res.json() as { attached?: boolean; commentId?: string; ticket?: string; error?: string };
  attachMsg.value = body.attached ? `comment ${body.commentId} → ${body.ticket}` : (body.error ?? `HTTP ${res.status}`);
}

/** A4 evaluated display: the post-substitution step (what actually executed),
 *  shown when it differs from the recorded template step. */
/** Gherkin narrate split (plan 20260929T030722Z): keyword accented, rest muted */
function narrateKeyword(n: string): string { const m = n.match(/^(Given|When|Then|And|But)\b\s*/i); return m ? m[0].trim() : ''; }
function narrateRest(n: string): string { return n.slice(narrateKeyword(n).length).trim(); }
function evaluatedText(s: Step): string | null {
  if (!s.evaluated_json) return null;
  try {
    const ev = JSON.parse(s.evaluated_json) as { action?: string; text?: string; x?: number; y?: number; direction?: string; resolvedBy?: string; flow?: string; expect?: { label?: string; labelContains?: string; ignoreCase?: boolean; identifier?: string }; matched?: number };
    const summary = ev.action === 'type' ? `type "${(ev.text ?? '').slice(0, 24)}"` : ev.action === 'tap' ? `tap ${ev.x},${ev.y}` : ev.action ? `${ev.action} ${ev.direction ?? ''}`.trim() : '';
    const provenance = [ev.flow ? `flow:${ev.flow}` : null, ev.resolvedBy, ev.expect ? `expect ${ev.expect.labelContains !== undefined ? `contains: ${ev.expect.labelContains}` : ev.expect.label ?? ev.expect.identifier ?? '?'}${ev.expect.ignoreCase === true ? ' (ignore case)' : ''} · matched ${ev.matched ?? '?'}` : null].filter(Boolean).join(' · ');
    return [summary, provenance].filter(Boolean).join(' — ') || null;
  } catch { return null; }
}

// ── verdict block (018-C): exit line + cause ──
const isBlocked = computed(() => run.value?.blocked === 1);
const isRunning = computed(() => run.value?.status === 'running' || run.value?.status === 'queued');
const badOutcome = computed(() => isBlocked.value || ['failed', 'aborted'].includes(run.value?.status ?? ''));
const verdictWord = computed(() => (isBlocked.value ? 'blocked' : run.value?.status ?? '—'));
const verdictSym = computed(() => {
  if (isBlocked.value) return '◆';
  switch (run.value?.status) {
    case 'failed': return '✕';
    case 'aborted': return '⌫';
    case 'running': case 'queued': return '▶';
    case 'passed': return '✓';
    default: return '·';
  }
});
const wordCls = computed(() => (isBlocked.value || run.value?.status === 'failed') ? 'bad' : run.value?.status === 'aborted' ? 'warn' : run.value?.status === 'passed' ? 'ok' : 'live');
const exitCode = computed(() => {
  if (isRunning.value) return null;
  if (isBlocked.value) return 'exit: infra';
  switch (run.value?.status) {
    case 'failed': return 'exit 1';
    case 'aborted': return 'exit: aborted';
    case 'passed': return 'exit 0';
    default: return null;
  }
});

/** case name from the note ("template:<id> <name>") — template_id is the
 *  truth; note carries the human name (same parse as the runs log). Failed
 *  runs' note is the diagnostic, not the label — fall back to the bare id
 *  (still a working link) rather than hiding the case. */
const caseName = computed(() => {
  const r = run.value;
  if (!r?.template_id) return null;
  if (r.note?.startsWith('template:')) return r.note.slice(r.note.indexOf(' ') + 1) || null;
  return `case ${r.template_id.slice(0, 12)}`;
});
const realTicket = computed(() => {
  const k = run.value?.ticket_key;
  return k && k !== '-' && k !== 'MANUAL' ? k : null;
});

/** device model lookup — the runs API ships only the udid; the devices
 *  mirror carries the human name (iPhone 14 Plus). One fetch per page. */
const deviceName = ref<string | null>(null);
async function loadDeviceName(): Promise<void> {
  try {
    const res = await fetch('/api/devices');
    const body = (await res.json()) as { devices: Array<{ udid: string; name: string | null }> };
    deviceName.value = body.devices.find((d) => d.udid === run.value?.device_udid)?.name ?? null;
  } catch { deviceName.value = null; }
}

/** the cause sentence: steps → note → status word (plan T1 fallback chain).
 *  Blocked runs carry their message in note; failed runs' note is usually
 *  just the case label — hence the template:/sidebar: guard. */
const causeText = computed(() => {
  const r = run.value;
  if (!r) return null;
  if (isBlocked.value) return r.note ?? 'infrastructure failure — the app never got tested';
  if (r.status === 'failed' || r.status === 'aborted') {
    const s = steps.value.find((x) => x.status === 'failed' || x.status === 'aborted');
    if (s?.reason) return s.reason;
    if (r.note && !r.note.startsWith('template:') && !r.note.startsWith('sidebar:')) return r.note;
    return 'no failure reason recorded';
  }
  if (isRunning.value) {
    const done = steps.value.filter((x) => x.status !== 'running').length;
    return `step ${done} of ${Math.max(done, steps.value.length)}${steps.value.some((x) => x.status === 'running') ? ' running…' : ' — starting…'}`;
  }
  if (r.status === 'passed') return `${caseName.value ?? 'run'} — all steps green`;
  return r.note ?? null;
});
const blockedHint = computed(() => {
  const r = run.value;
  if (!isBlocked.value || !r) return null;
  return r.note?.includes('already bound')
    ? 'engine session bound to another device — release it (engine close --session alloy) or restart the server, then re-run'
    : 'the app never got tested — device/engine/network failed before or during the run';
});

const durationText = computed(() => {
  const r = run.value;
  if (!r?.started_at) return '—';
  const ms = isRunning.value ? now.value - r.started_at : r.finished_at != null ? r.finished_at - r.started_at : null;
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${(s / 3600).toFixed(1)}h`;
});

onMounted(() => {
  load();
  live.connect();
  tick = setInterval(() => { now.value = Date.now(); }, 1000); // live duration while running
  const onEvent = (ev: { type: string; payload: Record<string, unknown> }): void => {
    if (ev.type === 'step.started' && ev.payload['runId'] === runId) {
      steps.value.push({ idx: ev.payload['idx'] as number, flow_name: ev.payload['flow'] as string, kind: 'flow', name: ev.payload['flow'] as string, status: 'running', reason: null, duration_ms: 0, evidence_ids_json: '[]' });
    } else if (ev.type === 'step.finished' && ev.payload['runId'] === runId) {
      const idx = ev.payload['idx'] as number;
      const s = steps.value.find((x) => x.idx === idx);
      if (s) { s.status = ev.payload['status'] as string; s.duration_ms = ev.payload['durationMs'] as number; }
    } else if (ev.type === 'run.finished' && ev.payload['runId'] === runId) {
      load();
    }
  };
  const unwatch = watch(
    () => live.events.length,
    () => {
      const latest = live.events[live.events.length - 1];
      if (latest) onEvent(latest);
    },
    { flush: 'sync' },
  );
  onUnmounted(() => { unwatch(); if (tick) clearInterval(tick); live.release(); });
});
</script>

<template>
  <div v-if="run">
    <PageHeader :title="run.id" />

    <!-- exit verdict line -->
    <div class="exit">
      <span class="sym" :class="wordCls">{{ verdictSym }}</span>
      <span class="word" :class="wordCls">{{ verdictWord }}</span>
      <span v-if="exitCode" class="code">{{ exitCode }}</span>
    </div>

    <!-- cause: red container ONLY for bad outcomes (failed/blocked/aborted);
         passed/running render a plain line — a passed run in red reads as failure -->
    <div v-if="badOutcome" class="cause-box">
      <div class="cause-title">Reason:</div>
      <div class="cause-line">{{ causeText }}</div>
      <div v-if="blockedHint" class="cause-hint">{{ blockedHint }}</div>
    </div>
    <div v-else-if="causeText" class="cause-line plain">{{ causeText }}</div>

    <!-- env block (018-C): context as key=value output -->
    <div class="env">
      <div class="kv">
        <template v-if="caseName">
          <span class="k">case</span>
          <RouterLink class="v link" :to="`/templates?case=${run.template_id}`">{{ caseName }}</RouterLink>
        </template>
        <template v-if="realTicket">
          <span class="k">ticket</span>
          <RouterLink class="v link" :to="`/tickets/${run.ticket_key}`">{{ realTicket }}</RouterLink>
        </template>
        <span class="k">device</span><span class="v">{{ run.device_udid.slice(0, 8) }}<template v-if="deviceName"> · {{ deviceName }}</template></span>
        <span class="k">build</span><span class="v"><template v-if="run.app_bundle_id">{{ run.app_bundle_id }} · </template>{{ run.app_build ? `${run.app_build} · ` : '' }}{{ run.app_version ? `v${run.app_version}` : run.app_build || run.app_bundle_id ? '' : 'unknown' }}</span>
        <span class="k">duration</span><span class="v">{{ durationText }}</span>
        <span class="k">by</span><span class="v">{{ run.triggered_by }}</span>
        <span class="k">started</span><span class="v">{{ run.started_at ? new Date(run.started_at).toLocaleString() : '—' }}</span>
      </div>
    </div>

    <!-- next actions -->
    <div class="actions">
      <RouterLink v-if="run.template_id" class="btn" :to="`/templates?case=${run.template_id}`">open case →</RouterLink>
      <!-- attach → jira: hidden pending Jira integration wiring (kept in code, one-line restore)
      <button class="btn btn-ghost" @click="attachJira">attach → jira</button>
      <span v-if="attachMsg" class="badge">{{ attachMsg }}</span>
      -->
      <RouterLink class="btn btn-ghost" style="margin-left: auto;" to="/runs">back to log →</RouterLink>
    </div>

    <!-- run evidence: video + screenshots for EVERY verdict (018-D) -->
    <div v-if="evidence.length > 0" class="tlog">
      <button class="tlog-head" @click="evOpen = !evOpen">evidence <span class="n">· {{ evidence.length }}</span><span class="arrow">{{ evOpen ? '▾' : '▸' }}</span></button>
      <template v-if="evOpen">
        <div class="evgrid">
          <a v-for="ev in evidence" :key="ev.id" class="evcard" :href="`/api/evidence/${ev.id}/file`" target="_blank" :title="`open ${ev.type} (${fmtBytes(ev.bytes)})`">
            <img v-if="ev.type === 'screenshot' || ev.type === 'diff'" :src="`/api/evidence/${ev.id}/file`" :alt="ev.type" />
            <span v-else class="evicon">{{ ev.type === 'video' ? '▶' : '▤' }}</span>
            <span class="evmeta">{{ ev.type }} · {{ fmtBytes(ev.bytes) }}</span>
          </a>
        </div>
      </template>
    </div>

    <!-- steps as log lines (auto-collapsed when ≤3) -->
    <div v-if="steps.length > 0" class="tlog">
      <button class="tlog-head" @click="stepsOpen = !stepsOpen">steps <span class="n">· {{ steps.length }}</span><span class="arrow">{{ stepsOpen ? '▾' : '▸' }}</span></button>
      <template v-if="stepsOpen">
        <div v-for="s in steps" :key="s.idx" class="tline">
          <span class="idx">{{ s.idx }}</span>
          <span class="flow">{{ s.flow_name }}</span>
          <span class="mid">
            <span v-if="s.name && s.name !== s.flow_name" class="flow-sub">{{ s.name }}</span>
            <span v-if="s.narrate" class="narrate"><span class="narrate-kw">{{ narrateKeyword(s.narrate) }}</span>{{ narrateRest(s.narrate) }}</span>
            <span v-if="evaluatedText(s)" class="ev">↳ {{ evaluatedText(s) }}</span>
            <span v-if="s.reason" class="rs" :title="s.reason">{{ s.reason }}</span>
          </span>
          <span class="dur">{{ s.duration_ms }}ms</span>
          <span class="st" :class="`st-${s.status}`">{{ s.status }}</span>
          <template v-if="stepEvidence(s).length > 0">
            <a v-for="ev in stepEvidence(s)" :key="s.idx + ev" class="stepthumb" :href="`/api/evidence/${ev}/file`" target="_blank" :title="`open step evidence`">
              <img :src="`/api/evidence/${ev}/file`" alt="step evidence" />
            </a>
          </template>
        </div>
      </template>
    </div>

    <!-- network (auto-collapsed when empty) -->
    <div class="tlog">
      <button class="tlog-head" @click="netOpen = !netOpen">network <span class="n">· {{ traffic.length }}</span><span class="arrow">{{ netOpen ? '▾' : '▸' }}</span></button>
      <template v-if="netOpen">
        <div v-if="traffic.length > 0">
          <div v-for="t in traffic" :key="t.id" class="tline">
            <span class="idx mono">{{ t.method }}</span>
            <span class="flow" :title="t.host">{{ t.host }}</span>
            <span class="mid"><span class="rs" :title="t.path">{{ t.path }}</span></span>
            <span class="dur">{{ t.latency_ms }}ms</span>
            <span class="st" :class="t.status < 400 ? 'st-pass' : 'st-fail'">{{ t.status }}</span>
          </div>
        </div>
        <div v-else class="empty-note">no traffic captured for this run<span v-if="!proxyRunning"> — <RouterLink class="link" to="/forge">the network proxy was not running</RouterLink>; start it there before a run to capture</span></div>
      </template>
    </div>

    <!-- raw diagnostics (rarely read — kept, demoted) -->
    <div class="tlog">
      <button class="tlog-head" @click="rawOpen = !rawOpen">raw<span class="arrow">{{ rawOpen ? '▾' : '▸' }}</span></button>
      <template v-if="rawOpen">
        <div class="env" style="margin-top: 8px;">
          <div class="kv">
            <span class="k">artifact</span><span class="v">{{ run.artifact_hash?.slice(0, 12) ?? '—' }}</span>
            <span class="k">freshness</span><span class="v">{{ run.freshness }}{{ run.freshness === 'stale_ignored' ? ' ⚠ older than source' : '' }}</span>
            <span class="k">launch args</span><span class="v">{{ run.launch_args_json || '—' }}</span>
            <span class="k">kind</span><span class="v">{{ run.kind }}</span>
          </div>
        </div>
      </template>
    </div>

    <TriagePanel :key="runId" />
  </div>
</template>

<style scoped>
/* exit verdict */
.exit { display:flex; align-items:baseline; gap:12px; margin-bottom:12px; }
.exit .sym { font-size:24px; font-weight:700; }
.exit .word { font-size:24px; font-weight:700; letter-spacing:-0.01em; }
.exit .sym.bad, .exit .word.bad { color:var(--color-ember); }
.exit .sym.warn, .exit .word.warn { color:var(--color-amber, #d9a03f); }
.exit .sym.ok, .exit .word.ok { color:var(--color-paper); }
.exit .sym.live, .exit .word.live { color:var(--color-fog); }
.exit .code { color:var(--color-steel); font-size:var(--text-label); font-weight:400; }

/* cause — red container (ember @ 0.5) ONLY for bad outcomes */
.cause-box {
  margin-bottom:16px;
  border:1px solid rgba(218, 92, 44, 0.6);
  background:rgba(218, 92, 44, 0.5);
  border-radius:var(--r);
  padding:12px 16px;
}
.cause-box .cause-title { color:var(--color-fog); font-size:var(--text-caption); text-transform:uppercase; letter-spacing:.08em; font-weight:700; margin-bottom:4px; }
.cause-box .cause-line { color:var(--color-paper); font-size:var(--text-label); max-width:76ch; }
.cause-box .cause-hint { color:var(--color-fog); font-size:var(--text-caption); margin-top:6px; opacity:.85; }
.cause-line.plain { color:var(--color-fog); font-size:var(--text-label); margin-bottom:16px; max-width:76ch; }

/* env block */
.env { margin-bottom:16px; border:1px solid var(--color-iron); border-radius:var(--r); background:var(--color-carbon); padding:12px 16px; font-size:var(--text-caption); }
.env .kv { display:grid; grid-template-columns:110px minmax(0,1fr); gap:3px 12px; justify-items:start; }
.env .k { color:var(--color-steel); }
.env .v { color:var(--color-fog); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* link underline hugs the text, not the grid cell — inline-block shrinks the
   box to content so border-bottom spans only the label */
.link { text-decoration:none; border-bottom:1px dotted var(--color-slate); display:inline-block; max-width:100%; overflow:hidden; text-overflow:ellipsis; vertical-align:bottom; }
.link:hover { color:var(--color-ember); border-bottom-color:var(--color-ember); }

/* actions */
.actions { display:flex; gap:8px; margin-bottom:8px; align-items:center; }
.btn { border:1px solid var(--color-slate); color:var(--color-paper); padding:5px 12px; font-size:var(--text-label); border-radius:var(--r); text-decoration:none; display:inline-block; }
.btn:hover { border-color:var(--color-chalk); }
.btn-ghost { color:var(--color-fog); }
.badge { border:1px solid var(--color-slate); color:var(--color-fog); padding:2px 8px; font-size:var(--text-caption); border-radius:var(--r); }

/* evidence grid */
.evgrid { display:flex; flex-wrap:wrap; gap:12px; padding:12px 0; }
.stepthumb { grid-column: 1 / -1; justify-self:start; display:inline-block; margin:2px 0 4px; }
.stepthumb img { height: 84px; width:auto; border:1px solid var(--color-iron); border-radius:4px; display:block; }
.stepthumb:hover img { border-color:var(--color-slate); }

.evcard { position:relative; border:1px solid var(--color-iron); border-radius:var(--r); overflow:hidden; background:var(--color-carbon); text-decoration:none; max-width:220px; }
.evcard:hover { border-color:var(--color-slate); }
.evcard img { display:block; width:220px; height:auto; }
.evicon { display:flex; align-items:center; justify-content:center; width:220px; height:120px; font-size:28px; color:var(--color-fog); }
.evmeta { display:block; padding:6px 10px; font-size:var(--text-caption); color:var(--color-steel); border-top:1px solid var(--color-iron); }

/* log sections */
.tlog { margin-top:20px; font-size:var(--text-label); }
.tlog-head { display:flex; gap:8px; align-items:baseline; font-size:var(--text-caption); font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:var(--color-steel); padding:8px 0; width:100%; text-align:left; cursor:pointer; background:none; border:none; border-bottom:1px solid var(--color-iron); }
.tlog-head:hover { color:var(--color-fog); }
.tlog-head .n { color:var(--color-pewter); font-weight:400; }
.tlog-head .arrow { margin-left:auto; color:var(--color-pewter); }
.narrate { font-size: 10px; color: var(--color-steel); margin-left: 6px; }
.narrate-kw { color: var(--color-fog); font-weight: 600; margin-right: 3px; }
.tline { display:grid; grid-template-columns:56px 170px minmax(0,1fr) 70px 80px; gap:12px; padding:6px 0; border-bottom:1px solid var(--color-graphite); align-items:baseline; }
.tline .idx { color:var(--color-steel); font-size:var(--text-caption); }
.tline .idx.mono { color:var(--color-fog); }
.tline .flow { color:var(--color-paper); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tline .flow-sub { color:var(--color-steel); font-size:var(--text-caption); display:block; }
.tline .ev { color:var(--color-steel); font-size:10px; display:block; white-space:normal; }
.tline .rs { color:var(--color-steel); font-size:var(--text-caption); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:block; }
.tline .dur { color:var(--color-steel); font-size:var(--text-caption); text-align:right; }
.tline .st { text-align:right; font-size:var(--text-caption); }
.st-passed, .st-pass { color:var(--color-fog); }
.st-failed, .st-fail { color:var(--color-ember); font-weight:700; }
.st-skip { color:var(--color-amber, #d9a03f); }
.st-running { color:var(--color-fog); }
.empty-note { color:var(--color-steel); font-size:var(--text-caption); padding:10px 0; }
</style>
