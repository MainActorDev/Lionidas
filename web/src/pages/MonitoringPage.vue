<script setup lang="ts">
/** Monitoring — A2 Ward Round (approved 004-a2 sketch, build spec).
 *  One number leads (app stability), pull-from-device is the one action,
 *  reports in plain English, technical depth lives in the drawer.
 *  Data: /api/diagnostics/* (Guvnor MetricKit pipeline). */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';

interface MxPayload {
  id: string; app_id: string; app_version: string | null;
  device_id: string | null; device_model: string | null; os_version: string | null;
  kind: 'metric' | 'diagnostic'; received_at: number; captured_at: number | null;
  source: string | null; summary: Record<string, number | string>;
  payload_json?: string;
}
interface MxDevice { udid: string; name: string | null; kind: 'simulator' | 'physical'; state: string | null }

const router = useRouter();
const payloads = ref<MxPayload[]>([]);
// last FETCHED detail (with payload_json) — the 10s feed poll refreshes rows
// without raw JSON; keep it so an open drawer never loses its raw view.
const fetchedDetail = ref<MxPayload | null>(null);
const counts = ref<{ crashes: number; hangs: number; disk: number; cpu: number }>({ crashes: 0, hangs: 0, disk: 0, cpu: 0 });
const devices = ref<MxDevice[]>([]);
const devicePick = ref('');
const busy = ref(false);
const pullMsg = ref('');
const selected = ref<MxPayload | null>(null);
const showRaw = ref(false);
let poll: ReturnType<typeof setInterval> | null = null;

async function loadFeed(): Promise<void> {
  try {
    const r = await fetch('/api/diagnostics/payloads?limit=100');
    const b = await r.json() as { payloads: MxPayload[] };
    payloads.value = b.payloads ?? [];
    // weekly counts from diagnostic summaries
    const weekAgo = Date.now() - 7 * 86400_000;
    let crashes = 0, hangs = 0, disk = 0, cpu = 0;
    for (const p of payloads.value) {
      if (p.kind !== 'diagnostic' || p.received_at < weekAgo) continue;
      crashes += Number(p.summary['crashes'] ?? 0);
      hangs += Number(p.summary['hangs'] ?? 0);
      disk += Number(p.summary['diskWriteExceptions'] ?? 0);
      cpu += Number(p.summary['cpuExceptions'] ?? 0);
    }
    counts.value = { crashes, hangs, disk, cpu };
  } catch { /* dashboard survives API hiccups; next poll retries */ }
}

async function loadDevices(): Promise<void> {
  try {
    const r = await fetch('/api/diagnostics/devices');
    const b = await r.json() as { devices: MxDevice[] };
    devices.value = b.devices ?? [];
    if (!devicePick.value && devices.value.some((d) => d.kind === 'physical')) {
      devicePick.value = devices.value.find((d) => d.kind === 'physical')!.udid;
    }
  } catch { /* devices list is best-effort */ }
}

async function pull(): Promise<void> {
  if (!devicePick.value || busy.value) return;
  busy.value = true; pullMsg.value = '';
  try {
    // appId fixed for now: the consumer app (multi-app picker arrives with fleet reality)
    const r = await fetch('/api/diagnostics/extract', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ udid: devicePick.value, appId: 'com.lionparcel.services.consumer-dev' }),
    });
    const b = await r.json() as { inserted?: number; dupes?: number; error?: string };
    pullMsg.value = b.error ? `failed: ${b.error}` : `${b.inserted ?? 0} new · ${b.dupes ?? 0} dupes`;
    await loadFeed();
  } catch (e) {
    pullMsg.value = `failed: ${e instanceof Error ? e.message : 'extract error'}`;
  } finally { busy.value = false; }
}

async function openDrawer(p: MxPayload): Promise<void> {
  selected.value = p;
  showRaw.value = false;
  if (fetchedDetail.value?.id === p.id) { selected.value = fetchedDetail.value; return; }
  try {
    const r = await fetch(`/api/diagnostics/payloads/${p.id}`);
    fetchedDetail.value = await r.json() as MxPayload;
    if (selected.value?.id === p.id) selected.value = fetchedDetail.value;
  } catch { /* keep summary-only view */ }
}

/** Plain-language rendering per the A2 spec — jargon lives in the drawer. */
const what = (p: MxPayload): { headline: string; detail: string } => {
  if (p.kind === 'metric') {
    const launch = p.summary['launchAvgMs'] ? `${(Number(p.summary['launchAvgMs']) / 1000).toFixed(1)}s` : null;
    const mem = typeof p.summary['peakMemory'] === 'string' ? p.summary['peakMemory'] : null;
    return { headline: 'typical day', detail: [launch && `launch ${launch}`, mem && `memory ${mem}`].filter(Boolean).join(' · ') || 'daily report' };
  }
  const c = Number(p.summary['crashes'] ?? 0);
  if (c > 0) return { headline: c === 1 ? 'app crashed' : `app crashed ×${c}`, detail: 'bad memory or internal error' };
  const h = Number(p.summary['hangs'] ?? 0);
  if (h > 0) return { headline: h === 1 ? 'app froze' : `app froze ×${h}`, detail: 'busy for a moment' };
  const d = Number(p.summary['diskWriteExceptions'] ?? 0);
  if (d > 0) return { headline: 'heavy disk writes', detail: 'wrote more than Apple allows' };
  const q = Number(p.summary['cpuExceptions'] ?? 0);
  if (q > 0) return { headline: 'high CPU use', detail: 'worked too hard' };
  return { headline: 'diagnostic report', detail: '' };
};

const badge = (p: MxPayload): { cls: string; text: string } => {
  if (p.kind === 'metric') return { cls: 't-DAILY', text: 'DAILY' };
  if (Number(p.summary['crashes'] ?? 0) > 0) return { cls: 't-CRASH', text: 'CRASH' };
  if (Number(p.summary['hangs'] ?? 0) > 0) return { cls: 't-HANG', text: 'HANG' };
  if (Number(p.summary['diskWriteExceptions'] ?? 0) > 0) return { cls: 't-DISK', text: 'DISK' };
  return { cls: 't-CPU', text: 'CPU' };
};

const when = (t: number): string => {
  const d = Date.now() - t;
  if (d < 3_600_000) return `${Math.max(1, Math.round(d / 60_000))}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
};

const from = (p: MxPayload): string => {
  const dev = p.device_id?.replace('sim-', '') ?? p.device_model ?? 'device';
  return `${dev} · ${p.app_version ?? '—'}`;
};

/** Crash-free rate: crash-bearing reports ÷ reports this week (honest proxy
 *  while session counts need an analytics join — deliberately not invented
 *  precision). SPARSE GUARD: below the data floor the hero says `collecting`
 *  instead of a scary number — one crash in two reports must not read as 50%. */
const STABILITY_FLOOR = 5; // weekly reports needed before a % is honest
const stability = computed(() => {
  const week = payloads.value.filter((p) => p.received_at > Date.now() - 7 * 86400_000);
  if (week.length === 0) return { state: 'empty' as const };
  if (week.length < STABILITY_FLOOR) return { state: 'collecting' as const, reports: week.length };
  const crashPayloads = week.filter((p) => p.kind === 'diagnostic' && Number(p.summary['crashes'] ?? 0) > 0).length;
  const rate = 100 - Math.min(100, crashPayloads / week.length * 100);
  return { state: 'ready' as const, rate: rate.toFixed(1), reports: week.length };
});

const pickedDevice = computed(() => devices.value.find((d) => d.udid === devicePick.value));

onMounted(() => {
  void loadFeed();
  void loadDevices();
  poll = setInterval(() => void loadFeed(), 10_000);
});
onUnmounted(() => { if (poll) clearInterval(poll); });
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">monitoring</div>
        <div class="page-desc">app health · reports pulled from devices on demand</div>
      </div>
      <span class="badge">guvnor</span>
    </div>

    <!-- hero: one number that matters + 3 supporting -->
    <div class="hero">
      <div class="stat stat-ember">
        <div class="label">app stability</div>
        <div class="big" :style="stability.state === 'collecting' ? 'font-size: 16px; color: var(--color-fog);' : ''">
          {{ stability.state === 'ready' ? stability.rate + '%' : stability.state === 'collecting' ? 'collecting…' : '—' }}
        </div>
        <div class="sub">
          {{ stability.state === 'ready' ? `${stability.reports} reports this week`
             : stability.state === 'collecting' ? `${stability.reports} of ${STABILITY_FLOOR} weekly reports needed`
             : 'no reports yet — pull from a device' }}
        </div>
      </div>
      <div class="stat"><div class="label">crashes</div><div class="big">{{ counts.crashes }}</div><div class="sub">this week</div></div>
      <div class="stat"><div class="label">hangs</div><div class="big">{{ counts.hangs }}</div><div class="sub">this week</div></div>
      <div class="stat"><div class="label">disk alerts</div><div class="big">{{ counts.disk }}</div><div class="sub">this week</div></div>
    </div>

    <!-- extract: the one action -->
    <div class="extract card">
      <span class="lbl">pull from</span>
      <select v-model="devicePick">
        <option v-for="d in devices" :key="d.udid" :value="d.udid">
          {{ d.kind === 'physical' ? '📱' : '🖥' }} {{ d.name ?? d.udid.slice(0, 8) }}{{ d.state === 'Booted' ? '' : d.state ? ` · ${d.state.toLowerCase()}` : '' }}
        </option>
      </select>
      <button class="btn btn-primary" :disabled="!devicePick || busy" @click="pull">{{ busy ? 'pulling…' : '⟳ pull reports' }}</button>
      <span style="flex: 1;"></span>
      <span v-if="pullMsg" class="meta-row" style="font-size: 10px; color: var(--color-fog);">{{ pullMsg }}</span>
    </div>

    <!-- feed -->
    <div class="section-label"><span>reports</span></div>
    <div v-if="payloads.length === 0" class="card empty">
      nothing yet — plug in a device with the app installed and pull
    </div>
    <div v-else class="feed">
      <div v-for="p in payloads" :key="p.id" class="inc" :class="{ sel: selected?.id === p.id }" @click="openDrawer(p)">
        <span class="t-badge" :class="badge(p).cls">{{ badge(p).text }}</span>
        <span class="when">{{ when(p.received_at) }}</span>
        <span class="what">{{ what(p).headline }} <small v-if="what(p).detail">· {{ what(p).detail }}</small></span>
        <span class="from">{{ from(p) }}</span>
      </div>
    </div>

    <!-- devices -->
    <div class="section-label"><span>devices</span></div>
    <div class="devs">
      <div v-for="d in devices.filter(x => x.kind === 'physical' || x.state === 'Booted')" :key="d.udid" class="dev">
        <span class="dot" :class="{ off: d.state !== 'Booted' && d.kind === 'simulator' }"></span>
        <span class="nm">{{ d.name ?? d.udid.slice(0, 8) }} <small>{{ d.kind === 'physical' ? 'physical' : 'sim' }}</small></span>
        <span class="st">{{ d.state ?? '—' }}</span>
        <button v-if="d.udid === devicePick" class="btn btn-sm" @click="pull">pull</button>
      </div>
    </div>

    <!-- drawer -->
    <transition name="sidebar">
      <aside v-if="selected" class="drawer">
        <div class="dr-head">
          <div>
            <div class="dr-title">{{ badge(selected).text }} · {{ what(selected).headline }}</div>
            <div class="dr-sub">{{ when(selected.received_at) }} · {{ from(selected) }}{{ selected.os_version ? ` · ${selected.os_version}` : '' }}</div>
          </div>
          <button class="btn btn-sm" @click="selected = null">✕</button>
        </div>
        <div class="dr-body">
          <div class="meta-row"><span class="k">app</span><span>{{ selected.app_id }} {{ selected.app_version ? `· ${selected.app_version}` : '' }}</span></div>
          <div class="meta-row"><span class="k">device</span><span>{{ selected.device_model ?? selected.device_id ?? '—' }}</span></div>
          <div class="meta-row"><span class="k">source</span><span>{{ selected.source ?? '—' }}</span></div>
          <div class="meta-row"><span class="k">counts</span>
            <span v-if="selected.kind === 'diagnostic'" class="mono" style="font-size: 10px;">
              crash {{ selected.summary['crashes'] ?? 0 }} · hang {{ selected.summary['hangs'] ?? 0 }} · cpu {{ selected.summary['cpuExceptions'] ?? 0 }} · disk {{ selected.summary['diskWriteExceptions'] ?? 0 }}
            </span>
            <span v-else class="mono" style="font-size: 10px;">daily report</span>
          </div>

          <div class="section-label" style="margin-top: 14px;">source</div>
          <span class="raw-link" @click="showRaw = !showRaw">{{ showRaw ? 'hide' : 'show' }} raw Apple payload</span>
          <pre v-if="showRaw && selected.payload_json" class="raw">{{ selected.payload_json.slice(0, 4000) }}{{ selected.payload_json.length > 4000 ? '\n… (truncated)' : '' }}</pre>
        </div>
      </aside>
    </transition>
  </div>
</template>

<style scoped>
.hero { display: grid; grid-template-columns: 1.4fr 1fr 1fr 1fr; gap: 10px; margin-bottom: 14px; max-width: 1080px; }
.stat { background: var(--color-carbon); border: 1px solid var(--color-iron); padding: 13px 15px; }
.stat-ember { border-left: 2px solid var(--color-ember); }
.stat .label { font-size: 9px; letter-spacing: .13em; text-transform: uppercase; color: var(--color-steel); margin-bottom: 7px; }
.stat .big { font-size: 25px; font-weight: 700; line-height: 1; }
.stat .sub { font-size: 9.5px; color: var(--color-ash); margin-top: 6px; }
.extract { display: flex; gap: 8px; align-items: center; padding: 9px 11px; margin-bottom: 14px; }
.extract .lbl { font-size: 9px; letter-spacing: .13em; text-transform: uppercase; color: var(--color-steel); }
.extract select { min-width: 170px; }
.section-label { font-size: 9px; letter-spacing: .13em; text-transform: uppercase; color: var(--color-steel); margin: 14px 0 8px; display: flex; justify-content: space-between; }
.feed { display: flex; flex-direction: column; gap: 7px; }
.inc { display: flex; gap: 12px; align-items: center; background: var(--color-carbon); border: 1px solid var(--color-iron); padding: 10px 13px; cursor: pointer; }
.inc:hover { border-color: var(--color-slate); }
.inc.sel { border-color: var(--color-ember); }
.t-badge { font-size: 9px; font-weight: 700; padding: 3px 0; letter-spacing: .08em; flex: none; width: 50px; text-align: center; }
.t-CRASH { background: var(--color-ember); color: var(--color-paper); }
.t-HANG { background: #3a2417; color: var(--color-ember); border: 1px solid var(--color-ember-dim); }
.t-CPU { background: var(--color-iron); color: var(--color-fog); }
.t-DISK { background: var(--color-iron); color: var(--color-fog); }
.t-DAILY { background: transparent; color: var(--color-steel); border: 1px solid var(--color-iron); }
.inc .when { font-size: 10px; color: var(--color-steel); width: 64px; flex: none; }
.inc .what { flex: 1; min-width: 0; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.inc .what small { color: var(--color-ash); font-size: 9.5px; }
.inc .from { font-size: 9.5px; color: var(--color-fog); text-align: right; flex: none; }
.devs { display: flex; flex-direction: column; gap: 6px; }
.dev { display: flex; gap: 12px; align-items: center; background: var(--color-carbon); border: 1px solid var(--color-iron); padding: 9px 13px; }
.dev .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-ember); flex: none; }
.dev .dot.off { background: var(--color-pewter); }
.dev .nm { font-size: 11px; width: 170px; flex: none; }
.dev .nm small { color: var(--color-steel); font-size: 9.5px; }
.dev .st { font-size: 9.5px; color: var(--color-steel); flex: 1; }
.empty { padding: 22px; text-align: center; color: var(--color-steel); font-size: 10.5px; }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 430px; background: var(--color-carbon); border-left: 1px solid var(--color-iron); display: flex; flex-direction: column; z-index: 60; }
.dr-head { display: flex; justify-content: space-between; align-items: center; padding: 13px 15px; border-bottom: 1px solid var(--color-iron); }
.dr-title { font-size: 12px; font-weight: 700; }
.dr-sub { font-size: 9.5px; color: var(--color-steel); margin-top: 3px; }
.dr-body { flex: 1; overflow-y: auto; padding: 13px 15px; }
.raw-link { font-size: 10px; color: var(--color-fog); cursor: pointer; text-decoration: underline; }
.raw { background: var(--color-void); border: 1px solid var(--color-iron); padding: 10px; font-size: 9px; color: var(--color-fog); max-height: 300px; overflow: auto; white-space: pre; line-height: 1.6; margin-top: 8px; }
</style>
