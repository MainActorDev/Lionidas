<script setup lang="ts">
/** CockpitPage — the flagship device-control page (locked sketch 022-final2).
 *  T1 menubar + device switcher (ONE spacious device) + reusable rail
 *  (watch|chat) + env drawer. Round 1 chassis: menubar/switcher/stage wired;
 *  rail + chat land in S3/S4. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MenuBar from '../components/cockpit/MenuBar.vue';
import DeviceSwitcher, { type SwitcherDevice } from '../components/cockpit/DeviceSwitcher.vue';
import StageBezel from '../components/cockpit/StageBezel.vue';
import WatcherPanel from '../components/shared/WatcherPanel.vue';
import WatcherSection from '../components/shared/WatcherSection.vue';
import WatchPane from '../components/cockpit/WatchPane.vue';
import EnvDrawer from '../components/cockpit/EnvDrawer.vue';
import ChatPane from '../components/cockpit/ChatPane.vue';
import ToolsDrawer from '../components/cockpit/ToolsDrawer.vue';
import SideDrawer from '../components/shared/SideDrawer.vue';
import { useLiveEvents } from '../stores/live.ts';

const devices = ref<SwitcherDevice[]>([]);
const route = useRoute();
const router = useRouter();
const activeUdid = ref('');
const sessionOn = ref<string | null>(null);
const dims = ref<{ w: number | null; h: number | null }>({ w: null, h: null });
const envOpen = ref(false);
const railOpen = ref(true);
const activeScenario = ref<string | null>(null);
const screenState = ref('—');
const railTab = ref('watch');
const toolsOpen = ref(false);
const toolsTab = ref<'inspect' | 'record' | 'install'>('inspect');
const overlayData = ref<{ nodes: Array<Record<string, unknown>>; w: number | null; h: number | null; visible: boolean }>({ nodes: [], w: null, h: null, visible: false });
const toast = ref('');
const stage = ref<InstanceType<typeof StageBezel> | null>(null);

const live = useLiveEvents();
async function loadDevices(): Promise<void> {
  try {
    const res = await fetch('/api/devices');
    const body = await res.json() as { devices?: Array<{ udid: string; name: string | null; state: string | null }> };
    devices.value = (body.devices ?? []).filter((d) => (d.state ?? '').toLowerCase() === 'booted').map((d) => ({
      udid: d.udid, name: d.name ?? d.udid.slice(0, 12), sub: 'idle', live: false,
    }));
    if (devices.value.length > 0 && !devices.value.some((d) => d.udid === activeUdid.value)) activeUdid.value = devices.value[0]!.udid;
    const want = String(route.query.device ?? '');
    if (want && devices.value.some((d) => d.udid === want)) activeUdid.value = want;
  } catch { devices.value = []; }
}
onMounted(async () => {
  try {
    const res = await fetch('/api/devices');
    const body = await res.json() as { devices?: Array<{ udid: string; name: string | null; state: string | null }> };
    devices.value = (body.devices ?? []).filter((d) => (d.state ?? '').toLowerCase() === 'booted').map((d) => ({
      udid: d.udid, name: d.name ?? d.udid.slice(0, 12), sub: 'idle', live: false,
    }));
    if (devices.value.length > 0) activeUdid.value = devices.value[0]!.udid;
    const want = String(route.query.device ?? '');
    if (want && devices.value.some((d) => d.udid === want)) activeUdid.value = want;
  } catch { devices.value = []; }
});

const activeName = computed((): string => devices.value.find((d) => d.udid === activeUdid.value)?.name ?? '—');

function flash(msg: string): void { toast.value = msg; setTimeout(() => { if (toast.value === msg) toast.value = ''; }, 2400); }

function onMenuEvent(event: string): void {
  if (event === 'exit-console') { void router.push('/'); return; }
  if (event === 'env-scenario' || event === 'env-vars') { envOpen.value = true; return; }
  if (event === 'new-session') void stage.value?.takeControl();
  if (event === 'screenshot') void captureScreenshot();
  if (event === 'boot-device') void pickBootDevice();
  if (event === 'restart') void power('restart');
  if (event === 'shutdown') void power('shutdown');
  if (event === 'install') { toolsOpen.value = true; toolsTab.value = 'install'; }
  if (event === 'toggle-inspect') { toolsOpen.value = true; toolsTab.value = 'inspect'; }
  if (event === 'open-chat') railTab.value = 'chat';
  if (event === 'toggle-rail') railOpen.value = !railOpen.value;
  if (event === 'play-case') void pickPlayCase();
  if (event === 'watch-run') railTab.value = 'watch';
}

/** screenshot: canvas → PNG download (same as the sidebar's camera tool) */
async function captureScreenshot(): Promise<void> {
  const c = document.querySelector('.cockpit .stage canvas') as HTMLCanvasElement | null;
  if (!c) { flash('no screen to capture'); return; }
  try {
    const url = c.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `cockpit-${activeName.value.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.png`;
    a.click();
    flash('screenshot saved');
  } catch { flash('capture failed'); }
}

/** power actions via the devices route (boot|shutdown|restart) */
const powerBusy = ref(false);
async function power(action: 'boot' | 'shutdown' | 'restart', udid: string = activeUdid.value): Promise<void> {
  if (powerBusy.value || !udid) return;
  powerBusy.value = true;
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(udid)}/power`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
    });
    const b = (await r.json()) as { ok?: boolean; error?: string };
    if (b.ok) { flash(`${action} sent — devices refresh shortly`); setTimeout(() => void loadDevices(), 4000); }
    else flash(b.error ?? `${action} failed`);
  } catch { flash(`${action} request failed`); }
  finally { powerBusy.value = false; }
}

/** boot picker: shutdown devices → boot one (the switcher only lists booted) */
const bootPick = ref<Array<{ udid: string; name: string }>>([]);
const bootOpen = ref(false);
async function pickBootDevice(): Promise<void> {
  try {
    const r = await fetch('/api/devices');
    const b = (await r.json()) as { devices?: Array<{ udid: string; name: string | null; state: string | null }> };
    bootPick.value = (b.devices ?? []).filter((x) => (x.state ?? '') !== 'Booted').map((x) => ({ udid: x.udid, name: x.name ?? x.udid.slice(0, 12) }));
    bootOpen.value = true;
  } catch { flash('device list failed'); }
}

/** play a case on this device: newest templates → prompt-free picker */
const playPick = ref<Array<{ id: string; name: string }>>([]);
const playOpen = ref(false);
const playBusy = ref(false);
async function pickPlayCase(): Promise<void> {
  try {
    const r = await fetch('/api/templates');
    const b = (await r.json()) as { templates?: Array<{ id: string; name: string }> };
    playPick.value = (b.templates ?? []).slice(0, 30);
    playOpen.value = true;
  } catch { flash('case list failed'); }
}
async function playCase(id: string): Promise<void> {
  playBusy.value = true;
  try {
    const r = await fetch(`/api/templates/${encodeURIComponent(id)}/play`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ udid: activeUdid.value }),
    });
    const b = (await r.json()) as { runId?: string; error?: string };
    if (b.runId) { playOpen.value = false; flash(`run started · ${String(b.runId).slice(0, 14)}`); railTab.value = 'watch'; }
    else flash(b.error ?? 'play failed');
  } catch { flash('play request failed'); }
  finally { playBusy.value = false; }
}

watch(stage, (s) => { if (s) s.setScreenState; }); // placeholder no-op — screenState flows via expose polling below
let ovTimer = setInterval(() => {
  const t = toolsRef.value as unknown as { tree?: { state: { value: string }; nodes: { value: Array<Record<string, unknown>> }; logicalW: { value: number | null }; logicalH: { value: number | null } } } | null;
  if (t?.tree) overlayData.value = { nodes: t.tree.nodes.value, w: t.tree.logicalW.value, h: t.tree.logicalH.value, visible: t.tree.state.value === 'aligned' };
}, 500);
onBeforeUnmount(() => clearInterval(ovTimer));
let ssTimer = setInterval(() => { const st = stage.value as unknown as { screenState?: { value: string } } | null; if (st?.screenState) screenState.value = st.screenState.value; }, 1000);
onBeforeUnmount(() => clearInterval(ssTimer));

function onSwitch(udid: string): void {
  activeUdid.value = udid;
  sessionOn.value = null;
}

function onToolsTab(tab: 'inspect' | 'record' | 'install'): void {
  toolsTab.value = tab;
  // leaving inspect turns it off (sidebar contract)
  if (tab !== 'inspect') stage.value?.setInspect(false);
}
function onInspectClick(ev: MouseEvent): void {
  toolsRef.value?.stageClick(ev);
}
const toolsRef = ref<InstanceType<typeof ToolsDrawer> | null>(null);

function onSessionState(s: { sessionId: string | null; dims?: { w: number | null; h: number | null } }): void {
  sessionOn.value = s.sessionId;
  if (s.dims) dims.value = s.dims;
}

const status = computed(() => ({
  sessionLabel: sessionOn.value ? 'MANUAL' : null,
  deviceName: activeName.value,
  liveCount: devices.value.length,
}));
void live;
</script>

<template>
  <div class="cockpit">
    <MenuBar :status="status" @menu-event="onMenuEvent" />
    <DeviceSwitcher :devices="devices" :active-udid="activeUdid" @switch="onSwitch" />
    <div class="frame">
      <StageBezel v-if="activeUdid" ref="stage" :udid="activeUdid"
        :overlay-nodes="overlayData.nodes" :overlay-w="overlayData.w" :overlay-h="overlayData.h" :overlay-visible="overlayData.visible"
        @session-state="onSessionState" @inspect-click="onInspectClick" />
      <div v-else class="empty">no booted devices — boot one from the device menu</div>
      <WatcherPanel v-show="railOpen" :tabs="[{ id: 'watch', label: 'watch' }, { id: 'chat', label: 'chat' }]" :active="railTab" @switch="railTab = $event">
        <WatchPane v-show="railTab === 'watch'" :udid="activeUdid" :session-id="sessionOn" :dims="dims" />
        <ChatPane v-show="railTab === 'chat'" :udid="activeUdid" :device-name="activeName" :screen-state="screenState" :scenario="activeScenario" />
      </WatcherPanel>
    </div>
    <ToolsDrawer ref="toolsRef" v-model:tab="toolsTab" :open="toolsOpen" :udid="activeUdid" :session-id="sessionOn"
      @close="toolsOpen = false"
      @inspect-enabled="(on) => { stage?.setInspect(on); }"
      @update:tab="onToolsTab" />
    <SideDrawer :open="envOpen" title="environment" @close="envOpen = false">
      <EnvDrawer @scenario="activeScenario = $event" />
    </SideDrawer>

    <!-- boot picker -->
    <div v-if="bootOpen" class="modal-scrim" @click.self="bootOpen = false">
      <div class="modal">
        <h3>boot device</h3>
        <div v-if="!bootPick.length" class="k">every known device is already booted</div>
        <div v-for="d in bootPick" :key="d.udid" class="pick-row" @click="bootOpen = false; power('boot', d.udid)">
          <span>{{ d.name }}</span><span class="k">{{ d.udid.slice(0, 8) }}…</span>
        </div>
      </div>
    </div>

    <!-- play-case picker -->
    <div v-if="playOpen" class="modal-scrim" @click.self="playOpen = false">
      <div class="modal">
        <h3>play case on {{ activeName }}</h3>
        <div v-if="!playPick.length" class="k">no templates found</div>
        <div v-for="t in playPick" :key="t.id" class="pick-row" :class="{ busy: playBusy }" @click="playCase(t.id)">
          <span>{{ t.name }}</span><span class="k">{{ t.id.slice(0, 10) }}…</span>
        </div>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.cockpit { display: flex; flex-direction: column; height: 100vh; position: relative; background: var(--color-void); }
.frame { flex: 1; display: grid; grid-template-columns: 1fr 320px; min-height: 0; position: relative; }
.empty { display: grid; place-items: center; color: var(--color-steel); font-size: var(--text-caption); }
.pane { display: flex; flex-direction: column; min-height: 0; }
.k { color: var(--color-fog); font-size: var(--text-caption); }
.row { display: flex; justify-content: space-between; padding: 3px 0; font-size: var(--text-caption); }
.v { color: var(--color-paper); }
.toast { position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%); background: var(--color-carbon); border: 1px solid var(--color-slate); color: var(--color-paper); font-size: var(--text-caption); padding: 6px 14px; border-radius: var(--r); z-index: 60; }
.modal-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: grid; place-items: center; z-index: 50; }
.modal { background: var(--color-carbon); border: 1px solid var(--color-slate); border-radius: var(--r); padding: 16px; min-width: 320px; max-height: 60vh; overflow-y: auto; }
.modal h3 { font-size: var(--text-caption); color: var(--color-paper); margin: 0 0 10px; text-transform: uppercase; letter-spacing: .1em; }
.pick-row { display: flex; justify-content: space-between; padding: 6px 8px; border-radius: var(--r); cursor: pointer; color: var(--color-fog); font-size: var(--text-caption); }
.pick-row:hover { background: var(--color-iron); color: var(--color-paper); }
.pick-row.busy { opacity: .5; cursor: wait; }
</style>
