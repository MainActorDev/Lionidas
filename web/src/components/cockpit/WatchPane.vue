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

// ── run watch: newest run touching the active device (events carry udid) ──
interface StepRow { text: string; state: 'done' | 'live' | 'todo' }
const runId = ref<string | null>(null);
const runName = ref('');
const steps = ref<StepRow[]>([]);
const planTotal = ref(0);

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
  switch (ev.type) {
    case 'run.started': {
      if (evUdid && evUdid !== props.udid) return;
      runId.value = String(p['runId'] ?? '');
      steps.value = [];
      planTotal.value = 0;
      pushAct(`run started · ${String(p['runId'] ?? '').slice(0, 18)}`);
      break;
    }
    case 'run.plan': {
      if (p['runId'] !== runId.value) return;
      const list = (p['steps'] ?? []) as Array<{ name: string; narrate?: string | null }>;
      planTotal.value = list.length;
      steps.value = list.map((s) => ({ text: s.narrate ?? s.name, state: 'todo' as const }));
      break;
    }
    case 'step.started': {
      if (p['runId'] !== runId.value) return;
      const i = Number(p['idx'] ?? -1);
      if (steps.value[i]) steps.value[i]!.state = 'live';
      break;
    }
    case 'step.finished': {
      if (p['runId'] !== runId.value) return;
      const i = Number(p['idx'] ?? -1);
      const st = String(p['status'] ?? '');
      if (steps.value[i]) steps.value[i] = { text: steps.value[i]!.text, state: st === 'pass' ? 'done' : 'live' };
      pushAct(`${String(p['name'] ?? 'step')} · ${st}`, st === 'fail' ? 'err' : undefined);
      break;
    }
    case 'run.finished': {
      if (p['runId'] !== runId.value) return;
      pushAct(`run finished · ${String(p['status'] ?? '')}`, String(p['status']) === 'failed' ? 'err' : 'hit');
      break;
    }
  }
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
  runId.value = null; runName.value = ''; steps.value = []; planTotal.value = 0; activity.value = [];
});

const doneCount = computed((): number => steps.value.filter((s) => s.state === 'done').length);
const runMeta = computed((): string => (runId.value ? `${runId.value.slice(0, 14)}` : 'no active run'));
</script>

<template>
  <div class="pane">
    <WatcherSection title="session" :meta="sessionId ? 'live' : 'idle'">
      <div class="row"><span class="k">lease</span><span class="v">{{ sessionId ?? '—' }}</span></div>
      <div class="row"><span class="k">dims</span><span class="v">{{ dims.w && dims.h ? `${dims.w} × ${dims.h}` : '—' }}</span></div>
    </WatcherSection>

    <WatcherSection title="run watch" :meta="runMeta">
      <WatcherSteps v-if="steps.length && planTotal" :steps="steps" :meter="{ value: doneCount, max: planTotal }" />
      <WatcherSteps v-else-if="steps.length" :steps="steps" />
      <div v-else class="k">no run on this device</div>
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
.row { display: flex; justify-content: space-between; padding: 3px 0; font-size: var(--text-caption); }
.k { color: var(--color-fog); font-size: var(--text-caption); }
.v { color: var(--color-paper); }
</style>
