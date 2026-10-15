<script setup lang="ts">
/** System status — Factory board (sketch 038-C, user-approved 2026-10-15;
 *  plan 20261015T093924Z). Overall severity band, one tile per subsystem,
 *  selected system's full observations + degrades-when rule below. One
 *  /api/status poll every 15s (paused when hidden); cached responses are
 *  LABELED — never show stale data as fresh. Operator+ (server-gated). */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import PageHeader from '../components/PageHeader.vue';

interface StatusCard {
  id: string;
  name: string;
  state: 'ok' | 'degraded' | 'down' | 'unknown';
  summary: string;
  signal: string;
  rule: string;
  detail: Record<string, string | number | boolean | null>;
}
interface StatusPayload { checkedAt: number; cached: boolean; systems: StatusCard[] }

const payload = ref<StatusPayload | null>(null);
const error = ref('');
const stale = ref(false);
const selected = ref('');
const loaded = ref(false);
const detailHead = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;
let reqGen = 0;

async function load(): Promise<void> {
  const gen = ++reqGen;
  try {
    const r = await fetch('/api/status');
    if (gen !== reqGen) return; // a newer request superseded this one
    if (r.status === 403) { payload.value = null; error.value = 'operator only'; stale.value = false; return; }
    if (!r.ok) throw new Error(String(r.status));
    payload.value = (await r.json()) as StatusPayload;
    error.value = '';
    stale.value = false;
    reconcileSelection();
  } catch {
    if (gen !== reqGen) return;
    error.value = 'server unreachable';
    stale.value = payload.value != null; // prior data stays but is labeled
  } finally {
    if (gen === reqGen) loaded.value = true;
  }
}

/** severity-first selection, stable across polls while the id survives */
function reconcileSelection(): void {
  const systems = payload.value?.systems ?? [];
  if (systems.length === 0) { selected.value = ''; return; }
  if (!systems.some((s) => s.id === selected.value)) {
    selected.value =
      systems.find((s) => s.state === 'down')?.id
      ?? systems.find((s) => s.state === 'degraded')?.id
      ?? systems.find((s) => s.state === 'unknown')?.id
      ?? systems[0]!.id;
  }
}

function startPolling(): void {
  if (timer) return;
  timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 15_000);
}
function stopPolling(): void { if (timer) { clearInterval(timer); timer = null; } }
const onVis = (): void => { if (document.visibilityState === 'visible') void load(); };

onMounted(() => { void load(); startPolling(); document.addEventListener('visibilitychange', onVis); });
onUnmounted(() => { stopPolling(); document.removeEventListener('visibilitychange', onVis); reqGen++; });

const card = computed<StatusCard | null>(() => payload.value?.systems.find((s) => s.id === selected.value) ?? null);
const overall = computed<'ok' | 'degraded' | 'down' | 'unknown'>(() => {
  const states = payload.value?.systems.map((s) => s.state) ?? [];
  if (states.some((s) => s === 'down')) return 'down';
  if (states.some((s) => s === 'degraded')) return 'degraded';
  if (states.length && states.every((s) => s === 'ok')) return 'ok';
  return 'unknown';
});
const attentionCount = computed(() => (payload.value?.systems ?? []).filter((s) => s.state === 'down' || s.state === 'degraded').length);
const unknownCount = computed(() => (payload.value?.systems ?? []).filter((s) => s.state === 'unknown').length);
const ageLabel = computed(() => {
  if (!payload.value) return '';
  const delta = Date.now() - payload.value.checkedAt;
  if (delta < -60_000) return 'clock mismatch';
  const s = Math.max(0, Math.round(delta / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
});
const detailPairs = computed<Array<[string, string]>>(() =>
  Object.entries(card.value?.detail ?? {}).map(([k, v]) => [k, v === null ? '—' : String(v)]));

function select(id: string, ev?: Event): void {
  selected.value = id;
  const viaKeyboard = ev instanceof KeyboardEvent;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  void nextTick(() => {
    if (window.matchMedia('(max-width: 760px)').matches) detailHead.value?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    // keyboard activation (Enter/Space) moves focus to the detail heading
    if (viaKeyboard) detailHead.value?.focus();
  });
}
</script>

<template>
  <div class="page">
    <PageHeader title="system status">
      <span class="meta mono">{{ payload ? `${payload.systems.length} subsystems` : '' }}</span>
    </PageHeader>

    <div v-if="error && !payload" class="err">{{ error }}</div>
    <template v-else-if="payload">
      <p v-if="error && stale" class="err" role="alert">refresh failed — showing last known data ({{ ageLabel }})</p>

      <div class="band" :class="overall">
        <span class="overall mono"><i class="dot" :class="overall" />{{ overall }}</span>
        <span class="summary mono">{{ attentionCount }} system{{ attentionCount === 1 ? ' needs' : 's need' }} attention<template v-if="unknownCount"> · {{ unknownCount }} unknown</template></span>
        <span class="stamp mono">checked {{ ageLabel }}<template v-if="payload.cached"> · cached</template></span>
      </div>

      <div class="board-head">
        <h2 class="mono">subsystems</h2>
      </div>
      <div class="board" role="group" aria-label="subsystems">
        <button
          v-for="s in payload.systems" :key="s.id" type="button"
          class="tile" :class="{ on: s.id === selected }"
          :aria-pressed="s.id === selected" aria-controls="status-detail"
          @click="select(s.id, $event)"
          @keydown.enter.prevent="select(s.id, $event)"
          @keydown.space.prevent="select(s.id, $event)"
        >
          <span class="tile-top">
            <i class="dot sm" :class="s.state" />
            <span class="name mono">{{ s.name }}</span>
            <span class="state mono" :class="s.state">{{ s.state }}</span>
          </span>
          <span class="headline mono">{{ s.summary }}</span>
          <span class="sig mono" :class="{ alert: s.state === 'degraded' || s.state === 'down' }">{{ s.signal }}</span>
        </button>
      </div>

      <section
        v-if="card" id="status-detail" class="detail" aria-live="polite"
        aria-label="selected subsystem details"
      >
        <div class="detail-head">
          <h3 ref="detailHead" class="mono" tabindex="-1">{{ card.name }}</h3>
          <span class="state mono" :class="card.state">{{ card.state }}</span>
          <span class="summary mono">{{ card.summary }}</span>
        </div>
        <dl class="kv mono">
          <template v-for="[k, v] in detailPairs" :key="k">
            <dt>{{ k }}</dt><dd :class="{ alert: /zombie|outbox|orphan|stale|burn|error|retries/i.test(k) && v !== '—' && v !== '0' && v !== 'false' }">{{ v }}</dd>
          </template>
        </dl>
        <p class="rule mono"><strong>degrades when</strong> · {{ card.rule }}</p>
      </section>
      <p v-else-if="payload.systems.length === 0" class="empty mono">no subsystems reported</p>
    </template>
    <div v-else-if="loaded" class="empty mono">no data</div>
  </div>
</template>

<style scoped>
/* layout only — chrome from theme tokens; colors via theme vars (no hexes) */
.page { width: 100%; }
.meta { font-size: 11px; color: var(--muted-foreground); }
.err { color: var(--status-orange); font: 12px var(--font-mono); padding: 12px 0; }
.empty { color: var(--muted-foreground); font-size: 13px; padding: 24px 0; }

.band { display: flex; align-items: center; gap: 12px; padding: 17px 0 15px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.overall { font-size: 17px; font-weight: 500; display: inline-flex; align-items: center; }
.summary { font-size: 12px; color: var(--muted-foreground); }
.stamp { font-size: 11px; color: var(--muted-foreground); margin-left: auto; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; flex: none; background: var(--muted-foreground); }
.dot.ok { background: var(--status-green); }
.dot.degraded, .dot.down { background: var(--status-orange); }
.dot.sm { width: 7px; height: 7px; margin-right: 0; }

.board-head { display: flex; align-items: baseline; gap: 12px; margin: 22px 0 10px; }
.board-head h2 { font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted-foreground); margin: 0; font-weight: 400; }

.board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.tile { min-width: 0; display: flex; flex-direction: column; gap: 7px; min-height: 135px; padding: 14px; border: 1px solid var(--border); border-radius: 3px; text-align: left; cursor: pointer; }
.tile:hover, .tile.on { background: var(--card); }
.tile.on { border-color: var(--muted-foreground); }
.tile:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.tile-top { display: flex; align-items: center; gap: 8px; }
.tile-top .name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile-top .state { margin-left: auto; font-size: 11px; color: var(--muted-foreground); }
.headline { font-size: 12px; line-height: 1.5; min-height: 35px; overflow-wrap: anywhere; color: var(--foreground); }
.sig { font-size: 11px; line-height: 1.4; color: var(--muted-foreground); margin-top: auto; overflow-wrap: anywhere; }
.sig.alert { color: var(--status-orange); }
.state.ok { color: var(--status-green); }
.state.degraded, .state.down { color: var(--status-orange); }

.detail { margin-top: 20px; border-top: 1px solid var(--border); padding-top: 14px; }
.detail-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.detail-head h3 { font-size: 17px; font-weight: 500; margin: 0; }
.detail-head h3:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.detail-head .summary { font-size: 11px; }
.facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 20px; }
.kv { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 20px; margin: 0; }
.fact { display: grid; }
dt { color: var(--muted-foreground); }
dd { margin: 0; }
.kv { grid-template-columns: 1fr; }
.kv dt, .kv dd { padding: 7px 2px; border-bottom: 1px solid var(--border); font-size: 11px; line-height: 1.45; }
.kv { grid-auto-rows: auto; grid-template-columns: repeat(2, minmax(115px, 40%) minmax(0, 1fr)); }
.kv > dt { grid-column: 1; }
.kv > dd { grid-column: 2; overflow-wrap: anywhere; }
.kv dd.alert { color: var(--status-orange); }
.rule { margin: 15px 0 0; color: var(--muted-foreground); font-size: 11px; line-height: 1.6; }
.rule strong { font-weight: 400; color: var(--foreground); }

@media (max-width: 1050px) { .board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) {
  .board { grid-template-columns: minmax(0, 1fr); }
  .tile { min-height: 112px; }
  .stamp { flex-basis: 100%; margin: 0; }
  .kv { grid-template-columns: 115px minmax(0, 1fr); }
}
</style>
