<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';

interface DeviceRow { udid: string; name: string | null; state: string | null; lease_holder: string | null }
interface RunRow { id: string; ticket_key: string; status: string; started_at: number | null }

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const devices = ref<DeviceRow[]>([]);
const ticket = ref('');
const flowsDir = ref('');
const app = ref('');
const artifactPath = ref('');
const srcPath = ref('');
const submitting = ref(false);
const error = ref('');
const queued = ref('');

async function loadDevices(): Promise<void> {
  const res = await fetch('/api/devices');
  devices.value = (await res.json() as { devices: DeviceRow[] }).devices.filter((d) => d.state === 'Booted');
}
const udid = ref('');

async function submit(): Promise<void> {
  submitting.value = true; error.value = ''; queued.value = '';
  try {
    const res = await fetch('/api/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ticketKey: ticket.value, flowsDir: flowsDir.value, udid: udid.value,
        app: app.value, artifactPath: artifactPath.value,
        ...(srcPath.value ? { srcPath: srcPath.value } : {}),
        triggeredBy: 'dashboard', priority: 'manual', triage: true,
      }),
    });
    const body = await res.json() as { queueId?: string; error?: string };
    if (res.ok && body.queueId) queued.value = body.queueId;
    else error.value = body.error ?? `HTTP ${res.status}`;
  } finally { submitting.value = false; }
}
function close(): void { emit('close'); }

onMounted(loadDevices);
void 0;
</script>

<template>
  <div v-if="open" class="newrun-backdrop" @click.self="close">
    <div class="card newrun-modal">
      <div class="card-header">
        <span class="card-title">new run</span>
        <button class="btn btn-sm btn-ghost" @click="close">✕</button>
      </div>

      <div v-if="queued" class="card card-accent" style="margin-bottom: var(--s-3);">
        <div class="meta-row"><span class="k">queued</span><b>{{ queued }}</b></div>
        <div style="margin-top: var(--s-2);"><button class="btn btn-sm" @click="close">done</button></div>
      </div>

      <template v-else>
        <div class="meta-row"><span class="k">ticket</span><input v-model="ticket" placeholder="CUST-1234" /></div>
        <div class="meta-row"><span class="k">flows dir</span><input v-model="flowsDir" placeholder="/abs/path/to/flows" /></div>
        <div class="meta-row"><span class="k">device</span>
          <select v-model="udid">
            <option value="" disabled>select booted device…</option>
            <option v-for="d in devices" :key="d.udid" :value="d.udid">{{ d.name ?? d.udid.slice(0, 8) }}</option>
          </select>
        </div>
        <div class="meta-row"><span class="k">app</span><input v-model="app" placeholder="com.example.app" /></div>
        <div class="meta-row"><span class="k">artifact</span><input v-model="artifactPath" placeholder="/abs/path/App.app" /></div>
        <div class="meta-row"><span class="k">src (opt)</span><input v-model="srcPath" placeholder="freshness gate — leave empty to skip" /></div>

        <div v-if="error" class="meta-row" style="color: var(--color-ember);">{{ error }}</div>
        <div style="display: flex; gap: var(--s-2); margin-top: var(--s-3); justify-content: flex-end;">
          <button class="btn" @click="close">cancel</button>
          <button class="btn btn-primary" :disabled="submitting || !ticket || !flowsDir || !udid || !app || !artifactPath" @click="submit">
            {{ submitting ? 'queueing…' : 'queue run' }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.newrun-backdrop {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(0, 0, 0, 0.85);
}
.newrun-modal {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  z-index: 91;
  width: min(480px, calc(100vw - 32px));
  background: var(--color-graphite);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
</style>
