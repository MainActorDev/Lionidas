<script setup lang="ts">
/** Status page (plan 20261014T062902Z, sketch 034 variant C — split
 *  master-detail). One /api/status poll every 15s (paused when hidden),
 *  cached responses are LABELED (the page's founding rule: never show stale
 *  data as fresh). Thresholds always visible in the detail pane footer. */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import PageHeader from '../components/PageHeader.vue';

interface StatusCard {
  id: string;
  name: string;
  state: 'ok' | 'degraded' | 'down' | 'unknown';
  summary: string;
  detail: Record<string, string | number | boolean | null>;
}
interface StatusPayload { checkedAt: number; cached: boolean; systems: StatusCard[] }

const payload = ref<StatusPayload | null>(null);
const error = ref('');
const selected = ref('');
const loaded = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  try {
    const r = await fetch('/api/status');
    if (!r.ok) { error.value = r.status === 403 ? 'operator only' : `load failed (${r.status})`; return; }
    payload.value = (await r.json()) as StatusPayload;
    error.value = '';
    if (!selected.value) selected.value = payload.value.systems[0]?.id ?? '';
  } catch { error.value = 'server unreachable'; }
  finally { loaded.value = true; }
}

function startPolling(): void {
  if (timer) return;
  timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 15_000);
}
function stopPolling(): void { if (timer) { clearInterval(timer); timer = null; } }
const onVis = (): void => { if (document.visibilityState === 'visible') void load(); };

onMounted(() => { void load(); startPolling(); document.addEventListener('visibilitychange', onVis); });
onUnmounted(() => { stopPolling(); document.removeEventListener('visibilitychange', onVis); });

const overall = computed<'ok' | 'degraded' | 'down' | 'unknown'>(() => {
  const states = payload.value?.systems.map((s) => s.state) ?? [];
  if (states.some((s) => s === 'down')) return 'down';
  if (states.some((s) => s === 'degraded')) return 'degraded';
  if (states.length && states.every((s) => s === 'ok')) return 'ok';
  return 'unknown';
});
const card = computed<StatusCard | null>(() => payload.value?.systems.find((s) => s.id === selected.value) ?? null);
const ageLabel = computed(() => {
  if (!payload.value) return '';
  const s = Math.round((Date.now() - payload.value.checkedAt) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
});
</script>

<template>
  <div class="pg">
    <PageHeader title="system status" :subtitle="`all subsystems · read from tables`" />
    <div v-if="error" class="err">{{ error }}</div>
    <template v-else-if="payload">
      <div class="head">
        <span class="overall"><i class="dot" :class="overall" />{{ overall }}</span>
        <span class="meta mono">checked {{ ageLabel }}<template v-if="payload.cached"> · cached</template></span>
      </div>
      <div class="wrap">
        <nav class="list">
          <button
            v-for="s in payload.systems" :key="s.id" type="button"
            class="item" :class="{ on: s.id === selected }"
            @click="selected = s.id"
          >
            <i class="dot" :class="s.state" />
            <span class="nm">{{ s.name }}</span>
            <span class="n mono">{{ s.summary.split('·')[0]?.trim() }}</span>
          </button>
        </nav>
        <section v-if="card" class="detail">
          <h4><i class="dot" :class="card.state" />{{ card.name }} <span class="badge" :class="card.state">{{ card.state }}</span></h4>
          <div class="kv mono">
            <template v-for="(v, k) in card.detail" :key="k">
              <b>{{ k }}</b><span :class="{ warn: String(k).includes('zombie') || String(k).includes('burn') || String(k).includes('stale') || String(k).includes('orphan') || String(k).includes('backlog') || String(k).includes('error') || String(k).includes('retries') }">{{ v === null ? '—' : v }}</span>
            </template>
          </div>
          <div class="thr mono">thresholds — zombie 15m · outbox &gt;0 · mcp retries 1h &gt;0 · burn 24h &gt;0 · run 7d · ingest 7d · diag 14d</div>
        </section>
      </div>
    </template>
    <div v-else-if="loaded" class="err">no data</div>
  </div>
</template>

<style scoped>
.pg { padding: 20px 24px; max-width: 980px; }
.err { color: var(--color-ember); font: 12px var(--font-mono); padding: 12px 0; }
.mono { font-family: var(--font-mono); }
.head { display: flex; align-items: baseline; gap: 14px; margin: 4px 0 14px; padding-bottom: 12px; border-bottom: 1px solid var(--color-slate); }
.overall { font-weight: 700; font-size: 18px; display: inline-flex; align-items: center; }
.meta { font-size: 11px; color: var(--color-ash); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; flex: none; }
.dot.ok { background: #8fbf7f; }
.dot.degraded { background: var(--color-ember); }
.dot.down { background: #e03e3e; }
.dot.unknown { background: var(--color-steel); }

.wrap { display: grid; grid-template-columns: 230px 1fr; border: 1px solid var(--color-slate); border-radius: var(--r); overflow: hidden; }
.list { background: var(--color-graphite); border-right: 1px solid var(--color-slate); display: flex; flex-direction: column; }
.item { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: none; border: 0; border-bottom: 1px solid var(--color-slate); color: var(--color-paper); font: 12.5px/1.2 inherit; text-align: left; cursor: pointer; }
.item:hover { background: var(--color-iron); }
.item.on { background: var(--color-iron); box-shadow: inset 2px 0 0 var(--color-ember); }
.item .nm { flex: 1; }
.item .n { color: var(--color-fog); font-size: 11px; }

.detail { padding: 18px 20px; min-height: 260px; }
.detail h4 { margin: 0 0 10px; font-size: 13px; display: flex; align-items: center; }
.badge { font: 700 10px var(--font-mono); letter-spacing: .1em; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; margin-left: 8px; }
.badge.ok { background: rgba(143,191,127,.15); color: #8fbf7f; }
.badge.degraded { background: rgba(218,92,44,.18); color: var(--color-ember); }
.badge.down { background: rgba(224,62,62,.18); color: #e03e3e; }
.badge.unknown { background: rgba(96,96,96,.2); color: var(--color-steel); }
.kv { display: grid; grid-template-columns: 170px 1fr; gap: 5px 12px; font-size: 11.5px; }
.kv b { color: var(--color-fog); font-weight: 400; }
.kv .warn { color: var(--color-ember); }
.thr { margin-top: 16px; padding-top: 10px; border-top: 1px dashed var(--color-slate); font-size: 10.5px; color: var(--color-steel); }
</style>
