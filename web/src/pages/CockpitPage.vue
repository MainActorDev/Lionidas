<script setup lang="ts">
/** CockpitPage — the flagship device-control page (locked sketch 022-final2).
 *  T1 menubar + device switcher (ONE spacious device) + reusable rail
 *  (watch|chat) + env drawer. Round 1 chassis: menubar/switcher/stage wired;
 *  rail + chat land in S3/S4. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import MenuBar from '../components/cockpit/MenuBar.vue';
import DeviceSwitcher, { type SwitcherDevice } from '../components/cockpit/DeviceSwitcher.vue';
import StageBezel from '../components/cockpit/StageBezel.vue';
import WatcherPanel from '../components/shared/WatcherPanel.vue';
import WatcherSection from '../components/shared/WatcherSection.vue';
import WatchPane from '../components/cockpit/WatchPane.vue';
import EnvDrawer from '../components/cockpit/EnvDrawer.vue';
import ChatPane from '../components/cockpit/ChatPane.vue';
import SideDrawer from '../components/shared/SideDrawer.vue';
import { useLiveEvents } from '../stores/live.ts';

const devices = ref<SwitcherDevice[]>([]);
const activeUdid = ref('');
const sessionOn = ref<string | null>(null);
const dims = ref<{ w: number | null; h: number | null }>({ w: null, h: null });
const envOpen = ref(false);
const activeScenario = ref<string | null>(null);
const screenState = ref('—');
const railTab = ref('watch');
const stage = ref<InstanceType<typeof StageBezel> | null>(null);

const live = useLiveEvents();
onMounted(async () => {
  try {
    const res = await fetch('/api/devices');
    const body = await res.json() as { devices?: Array<{ udid: string; name: string | null; state: string | null }> };
    devices.value = (body.devices ?? []).filter((d) => (d.state ?? '').toLowerCase() === 'booted').map((d) => ({
      udid: d.udid, name: d.name ?? d.udid.slice(0, 12), sub: 'idle', live: false,
    }));
    if (devices.value.length > 0) activeUdid.value = devices.value[0]!.udid;
  } catch { devices.value = []; }
});

const activeName = computed((): string => devices.value.find((d) => d.udid === activeUdid.value)?.name ?? '—');

function onMenuEvent(event: string): void {
  if (event === 'env-scenario' || event === 'env-location' || event === 'env-vars') { envOpen.value = true; return; }
  if (event === 'new-session') void stage.value?.takeControl();
  if (event === 'screenshot') void 0; // S3: capture strip
  if (event === 'boot-device') void 0; // S3: boot picker
  // restart/shutdown/install/launch/play-case land with S3 drawer + run menu wiring
}

watch(stage, (s) => { if (s) s.setScreenState; }); // placeholder no-op — screenState flows via expose polling below
let ssTimer = setInterval(() => { const st = stage.value as unknown as { screenState?: { value: string } } | null; if (st?.screenState) screenState.value = st.screenState.value; }, 1000);
onBeforeUnmount(() => clearInterval(ssTimer));

function onSwitch(udid: string): void {
  activeUdid.value = udid;
  sessionOn.value = null;
}

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
      <StageBezel v-if="activeUdid" ref="stage" :udid="activeUdid" @session-state="onSessionState" />
      <div v-else class="empty">no booted devices — boot one from the device menu</div>
      <WatcherPanel :tabs="[{ id: 'watch', label: 'watch' }, { id: 'chat', label: 'chat' }]" :active="railTab" @switch="railTab = $event">
        <WatchPane v-show="railTab === 'watch'" :udid="activeUdid" :session-id="sessionOn" :dims="dims" />
        <ChatPane v-show="railTab === 'chat'" :udid="activeUdid" :device-name="activeName" :screen-state="screenState" :scenario="activeScenario" />
      </WatcherPanel>
    </div>
    <SideDrawer :open="envOpen" title="environment" @close="envOpen = false">
      <EnvDrawer @scenario="activeScenario = $event" />
    </SideDrawer>
  </div>
</template>

<style scoped>
.cockpit { display: flex; flex-direction: column; height: 100%; position: relative; }
.frame { flex: 1; display: grid; grid-template-columns: 1fr 320px; min-height: 0; position: relative; }
.empty { display: grid; place-items: center; color: var(--color-steel); font-size: var(--text-caption); }
.pane { display: flex; flex-direction: column; min-height: 0; }
.k { color: var(--color-fog); font-size: var(--text-caption); }
.row { display: flex; justify-content: space-between; padding: 3px 0; font-size: var(--text-caption); }
.v { color: var(--color-paper); }
</style>
