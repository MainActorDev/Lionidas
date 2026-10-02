<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const open = ref(false);
const query = ref('');
const selectedIndex = ref(0);

interface Command {
  label: string;
  hint: string;
  run(): void;
}

async function recentTickets(): Promise<string[]> {
  const res = await fetch('/api/runs?limit=20');
  const runs = (await res.json() as { runs: Array<{ ticket_key: string }> }).runs;
  return [...new Set(runs.map((r) => r.ticket_key))].slice(0, 6);
}
async function bootedDevices(): Promise<Array<{ udid: string; name: string; kind: string | null }>> {
  const res = await fetch('/api/devices');
  const body = (await res.json()) as { devices: Array<{ udid: string; name: string | null; state: string | null; kind: string | null }> };
  const list: Array<{ udid: string; name: string; kind: string | null }> = [];
  for (const d of body.devices) {
    if (d.state === 'Booted') list.push({ udid: d.udid, name: d.name ?? d.udid.slice(0, 8), kind: d.kind });
  }
  return list;
}
const tickets = ref<string[]>([]);
const devices = ref<Array<{ udid: string; name: string; kind: string | null }>>([]);
void recentTickets().then((t) => (tickets.value = t));
void bootedDevices().then((d) => (devices.value = d));

const commands = computed<Command[]>(() => {
  const base: Command[] = [
    { label: 'devices', hint: 'device grid + queue', run: () => router.push('/devices') },
    { label: 'runs', hint: 'history', run: () => router.push('/runs') },
    { label: 'network', hint: 'traffic + mock responses', run: () => router.push('/forge') },
    { label: 'approvals', hint: 'review visual changes', run: () => router.push('/baselines') },
    { label: 'flaky tests', hint: 'quarantine', run: () => router.push('/flakes') },
    { label: 'guide', hint: 'how to use', run: () => router.push('/guide') },
  ];
  for (const d of devices.value) {
    base.push({
      label: `watch ${d.name}`,
      hint: d.kind === 'simulator' ? 'live stream' : 'live stream (sim-only)',
      run: () => router.push(`/devices?watch=${encodeURIComponent(d.udid)}`),
    });
  }
  for (const t of tickets.value) {
    base.push({ label: `ticket ${t}`, hint: 'acceptance criteria', run: () => router.push(`/tickets/${t}`) });
  }
  const q = query.value.trim().toLowerCase();
  return q ? base.filter((c) => c.label.toLowerCase().includes(q)) : base;
});

function execute(cmd: Command | undefined): void {
  if (!cmd) return;
  cmd.run();
  open.value = false;
  query.value = '';
  selectedIndex.value = 0;
}

function onKey(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    open.value = !open.value;
    query.value = '';
    void bootedDevices().then((d) => (devices.value = d)); // refresh for freshly booted sims
    return;
  }
  if (!open.value) return;
  if (e.key === 'Escape') { open.value = false; return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); selectedIndex.value = Math.min(selectedIndex.value + 1, commands.value.length - 1); }
  if (e.key === 'ArrowUp') { e.preventDefault(); selectedIndex.value = Math.max(selectedIndex.value - 1, 0); }
  if (e.key === 'Enter') { e.preventDefault(); execute(commands.value[selectedIndex.value]); }
}

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="palette-backdrop" @click.self="open = false">
      <div class="palette">
        <input ref="paletteInput" v-model="query" placeholder="jump to… (devices, new run, watch <device>, ticket)" class="palette-input" />
        <div v-for="(c, i) in commands" :key="c.label" class="palette-item" :class="{ active: i === selectedIndex }" @click="execute(c)" @mousemove="selectedIndex = i">
          <span>{{ c.label }}</span>
          <span style="color: var(--color-steel);">{{ c.hint }}</span>
        </div>
        <div v-if="commands.length === 0" class="palette-item" style="color: var(--color-steel);">no match</div>
        <div class="palette-foot">↑↓ navigate · ↵ open · esc close · ⌘K toggle</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.palette-backdrop { position: fixed; inset: 0; z-index: 90; background: rgba(0, 0, 0, 0.85); }
.palette {
  position: fixed; top: 20%; left: 50%; transform: translateX(-50%);
  z-index: 91; width: min(480px, calc(100vw - 32px));
  background: var(--color-graphite);
  border: 1px solid var(--color-slate);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
.palette-input { border: none; border-bottom: 1px solid var(--color-iron); border-radius: 0; background: var(--color-void); }
.palette-item {
  display: flex; justify-content: space-between;
  padding: var(--s-2) var(--s-3);
  font-size: var(--text-body);
  color: var(--color-fog);
  cursor: pointer;
}
.palette-item.active { background: var(--color-carbon); color: var(--color-paper); border-left: 2px solid var(--color-ember); }
.palette-foot { padding: var(--s-2) var(--s-3); font-size: var(--text-caption); color: var(--color-steel); border-top: 1px solid var(--color-iron); }
</style>
