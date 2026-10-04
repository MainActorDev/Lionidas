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
import EnvPanelContent from '../components/cockpit/EnvPanelContent.vue';
import OverlayPanel from '../components/shared/OverlayPanel.vue';
import ChatPane from '../components/cockpit/ChatPane.vue';
import { useDeviceSessions, type DeviceSession } from '../composables/deviceSessions.ts';
import ToolsDrawer from '../components/cockpit/ToolsDrawer.vue';
import { useLiveEvents } from '../stores/live.ts';

const devices = ref<SwitcherDevice[]>([]);
const route = useRoute();
const router = useRouter();
const activeUdid = ref('');
const sessionOn = ref<string | null>(null); // per-ACTIVE-device mirror; source of truth = deviceSessions map
const dims = ref<{ w: number | null; h: number | null }>({ w: null, h: null });
const activeScenario = ref<string | null>(null);
const screenState = ref('—');
const menuSessionLabel = ref<string | null>(null);
const railTab = ref('watch');
const toolsOpen = ref(false); // inspect overlay (kept name: menu + refs)
const overlay = ref<'env' | 'inspect' | null>(null); // ONE supplementary panel at a time
watch(overlay, (o) => { if (o !== 'inspect') stage.value?.setInspect(false); })
watch(activeUdid, () => { void pollCaseRunning(); })
const overlayData = ref<{ nodes: Array<Record<string, unknown>>; w: number | null; h: number | null; visible: boolean; sel: Record<string, unknown> | null }>({ nodes: [], w: null, h: null, visible: false, sel: null });
interface Toast { id: number; text: string; kind: 'ok' | 'err' }
const toasts = ref<Toast[]>([]);
let toastSeq = 0;
function flash(msg: string, kind: 'ok' | 'err' = 'ok'): void {
  const id = ++toastSeq;
  toasts.value = [...toasts.value.slice(-3), { id, text: msg, kind }];
  setTimeout(() => { toasts.value = toasts.value.filter((t) => t.id !== id); }, 5000);
}
function dropToast(id: number): void { toasts.value = toasts.value.filter((t) => t.id !== id); }
const stage = ref<InstanceType<typeof StageBezel> | null>(null);
const deviceSessions = useDeviceSessions();
const activeSession = computed((): DeviceSession | null => deviceSessions.sessions.get(activeUdid.value) ?? null);
onMounted(() => deviceSessions.start());
onBeforeUnmount(() => deviceSessions.stop());

const live = useLiveEvents();
let preselectApplied = false;
// udids mid power-restart: the API list drops them the moment the device
// leaves Booted — the cockpit must NOT (the tab would vanish + auto-switch
// away mid-restart, exactly when the operator is watching). Kept in `devices`
// with sub:'restarting' until the cycle completes server-side.
// a testcase (template run) active on the ACTIVE device — take control
// is disabled while one runs (driving mid-case poisons its steps)
const caseRunningOnActive = ref(false);
async function pollCaseRunning(): Promise<void> {
  if (!activeUdid.value) { caseRunningOnActive.value = false; return; }
  try {
    const r = await fetch('/api/runs?limit=12');
    const b = (await r.json()) as { runs?: Array<{ device_udid?: string; status?: string; template_id?: string | null; kind?: string }> };
    caseRunningOnActive.value = (b.runs ?? []).some((x) => x.device_udid === activeUdid.value && (x.status === 'queued' || x.status === 'running') && x.template_id);
  } catch { /* transient */ }
}

const restarting = ref(new Set<string>());
const restartingStartedAt = new Map<string, number>();
const restartingLocal = new Set<string>();
const restartingWentDown = new Set<string>();
function isRestarting(udid: string): boolean { return restarting.value.has(udid); }

async function loadDevices(): Promise<void> {
  try {
    const res = await fetch('/api/devices');
    const body = await res.json() as { devices?: Array<{ udid: string; name: string | null; state: string | null; restarting?: boolean }> };
    const rows = body.devices ?? [];
    // server-truth restarting (power route holds the whole cycle): ANY page,
    // ANY session, even after a reload mid-restart sees the state
    for (const r of rows) {
      if (r.restarting) { if (!restarting.value.has(r.udid) && !restartingStartedAt.has(r.udid)) restartingStartedAt.set(r.udid, Date.now()); restarting.value = new Set([...restarting.value, r.udid]); }
      else if (restartingStartedAt.has(r.udid) && !restartingLocal.has(r.udid)) { restarting.value.delete(r.udid); restarting.value = new Set(restarting.value); restartingStartedAt.delete(r.udid); restartingWentDown.delete(r.udid); }
    }
    const booted = rows.filter((d) => (d.state ?? '').toLowerCase() === 'booted');
    const kept: Array<{ udid: string; name: string; sub: string; live: boolean }> = booted.map((d) => ({
      udid: d.udid, name: d.name ?? d.udid.slice(0, 12),
      sub: restarting.value.has(d.udid) ? 'restarting' : 'idle', live: false,
    }));
    // restarting devices stay as tabs until the cycle ends:
    //  - confirmed BACK (booted again, after having gone down) → drop from restarting
    //  - still booted (shutdown not landed yet) → keep, marked restarting
    for (const udid of Array.from(restarting.value)) {
      const row = rows.find((r) => r.udid === udid);
      const bootedAgain = (row?.state ?? '').toLowerCase() === 'booted';
      const wentDown = (row?.state ?? '').toLowerCase() !== 'booted';
      if (wentDown) restartingWentDown.add(udid);
      // the server holds the restart open until the device is back (it waits
      // out the shutdown internally), so the client's 1.5s polls may only
      // ever see Booted → after 20s, a Booted device counts as completed
      const startedAt = restartingStartedAt.get(udid) ?? 0;
      const cycleTimedOut = Date.now() - startedAt > 20_000;
      if (bootedAgain && (restartingWentDown.has(udid) || cycleTimedOut)) {
        restartingStartedAt.delete(udid);
        restartingLocal.delete(udid);
        restarting.value.delete(udid); restartingWentDown.delete(udid);
        continue; // it's in `booted` already with sub flipping to 'idle'
      }
      if (!kept.some((k) => k.udid === udid)) {
        kept.push({ udid, name: row?.name ?? udid.slice(0, 12), sub: 'restarting', live: false });
      }
    }
    devices.value = kept;
    // clear stale restarting entries (device never came back after timeout — surfaced by the power call itself)
    if (restarting.value.size === 0) restartingWentDown.clear();
    // ?device= preselect applies ONCE (first successful load); later reloads
    // must not fight the boot auto-switch or manual tab changes
    const want = String(route.query.device ?? '');
    if (!preselectApplied && want && devices.value.some((d) => d.udid === want)) { activeUdid.value = want; preselectApplied = true; }
    // auto-switch only when the ACTIVE device truly left (shutdown/closed) —
    // a RESTARTING device stays in devices (kept above), so the tab and the
    // stage never bounce mid-restart
    if (devices.value.length > 0 && !devices.value.some((d) => d.udid === activeUdid.value)) activeUdid.value = devices.value[0]!.udid;
  } catch { devices.value = []; }
}
// ⌘I toggles inspect (the menu promises the accelerator); Esc dismisses the
// inspect overlay — the mode dies with the panel, so this is a real exit.
function onGlobalKey(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    e.preventDefault();
    onMenuEvent('toggle-inspect');
  } else if (e.key === 'Escape' && overlay.value === 'inspect') {
    overlay.value = null; toolsOpen.value = false;
  }
}
onMounted(() => { window.addEventListener('keydown', onGlobalKey); });

onMounted(async () => {
  await loadDevices();
  // steady refresh: devices booted elsewhere appear; a mount-time auth race
  // (first load 401 → empty) heals instead of stranding the page empty
  devicesTimer = setInterval(() => { void loadDevices(); void pollCaseRunning(); }, 5_000);
});
let devicesTimer: ReturnType<typeof setInterval> | undefined;
onBeforeUnmount(() => { if (devicesTimer) clearInterval(devicesTimer); window.removeEventListener('keydown', onGlobalKey); })

const activeName = computed((): string => devices.value.find((d) => d.udid === activeUdid.value)?.name ?? '—');


function onMenuEvent(event: string): void {
  if (event === 'exit-console') { void router.push('/'); return; }
  if (event === 'env-scenario') { overlay.value = 'env'; return; }
  if (event === 'screenshot') void captureScreenshot();
  if (event === 'boot-device') void pickBootDevice();
  if (event === 'restart') void power('restart');
  if (event === 'shutdown') void power('shutdown');
  if (event === 'install') void openInstall();
  if (event === 'run-app') void openRunApp();
  if (event === 'toggle-inspect') { overlay.value = overlay.value === 'inspect' ? null : 'inspect'; toolsOpen.value = overlay.value === 'inspect'; }
  if (event === 'play-case') void pickPlayCase();
  if (event === 'play-suite') void openSuite();
}

/** screenshot: canvas → PNG download (same as the sidebar's camera tool) */
async function captureScreenshot(): Promise<void> {
  const c = document.querySelector('.cockpit .stage canvas') as HTMLCanvasElement | null;
  if (!c) { flash('no screen to capture', 'err'); return; }
  try {
    const url = c.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `cockpit-${activeName.value.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.png`;
    a.click();
    flash('screenshot saved');
  } catch { flash('capture failed', 'err'); }
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
    if (b.ok) {
      if (action === 'restart') {
        // hold the tab + poll fast through the whole down-and-back cycle
        restarting.value = new Set([...restarting.value, udid]);
        restartingStartedAt.set(udid, Date.now());
        restartingLocal.add(udid);
        restartingWentDown.delete(udid);
        flash('restarting — the device returns when it\u2019s back');
        void loadDevices();
        const poll = setInterval(() => { void loadDevices(); if (!restarting.value.has(udid)) clearInterval(poll); }, 1500);
        setTimeout(() => clearInterval(poll), 180_000);
      } else {
        flash(`${action} sent — devices refresh shortly`);
        setTimeout(() => void loadDevices(), 4000);
      }
    }
    else flash(b.error ?? `${action} failed`, 'err');
  } catch { flash(`${action} request failed`, 'err'); }
  finally { powerBusy.value = false; }
}

/** boot picker: shutdown devices → boot one (the switcher only lists booted) */
interface BootDevice { udid: string; name: string; os: string; res: string; state: string }
const bootPick = ref<BootDevice[]>([]);
const bootOpen = ref(false);
const bootSel = ref('');
const bootBusy = ref(false);
const bootErr = ref('');

// ── run-app modal (app menu) — installed apps of the ACTIVE simulator ──
const runAppOpen = ref(false);
interface InstalledApp { bundleId: string; name: string; version: string | null; running: boolean; userFacing?: boolean }
const runAppApps = ref<InstalledApp[]>([]);
const runAppIcons = ref(false); // all-or-nothing icon column
const runAppLoaded = ref(false);
const runAppPick = ref('');
const runAppBusy = ref(false);
const runAppErr = ref('');
const runAppMsg = ref('');
async function openRunApp(): Promise<void> {
  runAppOpen.value = true; runAppErr.value = ''; runAppMsg.value = '';
  runAppLoaded.value = false;
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(activeUdid.value)}/apps`);
    const b = (await r.json()) as { apps?: InstalledApp[]; error?: string };
    if (!r.ok || b.error) { runAppErr.value = b.error ?? 'app catalog failed'; return; }
    // the catalog includes Apple system apps; user apps first, system after
    // server classifies user-facing apps (wallpaper engines, accessibility
    // daemons, SpringBoard plumbing are NOT openable in any visible sense);
    // user apps first, then real system apps (Safari, Settings…)
    const list = (b.apps ?? []).filter((a) => a.userFacing !== false);
    const user = list.filter((a) => !a.bundleId.startsWith('com.apple.'));
    const sys = list.filter((a) => a.bundleId.startsWith('com.apple.'));
    runAppApps.value = [...user, ...sys];
    // icons are ALL-OR-NOTHING (operator: mixed rows look broken): probe
    // every app's icon; only when they ALL resolve does the column show
    runAppIcons.value = false;
    const probes = runAppApps.value.map((a) => fetch(`/api/devices/${encodeURIComponent(activeUdid.value)}/apps/${encodeURIComponent(a.bundleId)}/icon`).then((r) => r.ok).catch(() => false));
    if (probes.length > 0 && await Promise.all(probes).then((rs) => rs.every(Boolean))) runAppIcons.value = true;
    runAppLoaded.value = true;
  } catch { runAppErr.value = 'app catalog failed'; }
}
async function launchApp(): Promise<void> {
  if (!runAppPick.value || runAppBusy.value) return;
  runAppBusy.value = true; runAppErr.value = ''; runAppMsg.value = '';
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(activeUdid.value)}/apps/${encodeURIComponent(runAppPick.value)}/launch`, { method: 'POST' });
    const b = (await r.json()) as { ok?: boolean; error?: string };
    if (b.ok) { runAppOpen.value = false; flash(`running ${runAppApps.value.find((a) => a.bundleId === runAppPick.value)?.name ?? runAppPick.value}`); }
    else runAppErr.value = b.error ?? 'launch failed';
  } catch { runAppErr.value = 'launch request failed'; }
  finally { runAppBusy.value = false; }
}

// ── install modal (file menu) ──
const installOpen = ref(false);
interface ArtifactFlat { path: string; bundleId: string; version: string | null; mtimeMs: number; source: string }
const installApps = ref<Array<{ key: string; name: string; bundleId: string; version: string | null; mtimeMs: number; source: string; builds: ArtifactFlat[] }>>([]);
const installLoaded = ref(false);
const installPick = ref('');
const installBusy = ref(false);
const installErr = ref('');
const installExpanded = ref<string | null>(null);
async function openInstall(): Promise<void> {
  installOpen.value = true; installErr.value = '';
  if (!installLoaded.value) {
    try {
      const r = await fetch(`/api/devices/${encodeURIComponent(activeUdid.value)}/artifacts`);
      const b = (await r.json()) as { artifacts?: ArtifactFlat[] };
      // group flat artifacts by bundle (sidebar parity: human name, newest first)
      const list = b.artifacts ?? [];
      const byBundle = new Map<string, ArtifactFlat[]>();
      for (const a of list) {
        const k = a.bundleId || a.path;
        byBundle.set(k, [...(byBundle.get(k) ?? []), a]);
      }
      const storeName = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+-\d+(\.\d+)*-\d+$/;
      installApps.value = [...byBundle.values()].map((builds) => {
        const sorted = [...builds].sort((x, y) => y.mtimeMs - x.mtimeMs);
        const head = sorted[0]!;
        const humanName = sorted.map((x) => x.path.split('/').pop()?.replace(/\.app$/, '') ?? '')
          .find((n) => n && !storeName.test(n));
        return { key: head.bundleId || head.path, name: humanName ?? head.bundleId ?? 'app', bundleId: head.bundleId, version: head.version, mtimeMs: head.mtimeMs, source: head.source, builds: sorted };
      }).sort((a, b2) => b2.mtimeMs - a.mtimeMs);
      installLoaded.value = true;
    } catch { installErr.value = 'artifact discovery failed'; }
  }
}
function ageOf(ms: number): string {
  const h = Math.floor((Date.now() - ms) / 3600_000);
  if (h < 1) return `${Math.max(1, Math.floor((Date.now() - ms) / 60_000))}m ago`;
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
async function runInstall(): Promise<void> {
  if (!installPick.value || installBusy.value) return;
  installBusy.value = true; installErr.value = '';
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(activeUdid.value)}/install`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appPath: installPick.value }),
    });
    const b = (await r.json()) as { ok?: boolean; version?: string; error?: string };
    if (b.ok) { installOpen.value = false; flash(`installed${b.version ? ` · ${b.version}` : ''}`); }
    else installErr.value = b.error ?? 'install failed';
  } catch { installErr.value = 'install request failed'; }
  finally { installBusy.value = false; }
}
async function pickBootDevice(): Promise<void> {
  bootErr.value = ''; bootSel.value = '';
  try {
    const r = await fetch('/api/devices');
    const b = (await r.json()) as { devices?: Array<{ udid: string; name: string | null; state: string | null; os_version: string | null; resolution: string | null }> };
    bootPick.value = (b.devices ?? [])
      .filter((x) => (x.state ?? '') !== 'Booted')
      .map((x) => ({ udid: x.udid, name: x.name ?? x.udid.slice(0, 12), os: x.os_version ?? '', res: x.resolution ?? '', state: x.state ?? '' }))
      .sort((a, b2) => a.name.localeCompare(b2.name));
    bootOpen.value = true;
  } catch { flash('device list failed'); }
}
async function bootSelected(): Promise<void> {
  if (!bootSel.value || bootBusy.value) return;
  bootBusy.value = true; bootErr.value = '';
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(bootSel.value)}/power`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'boot' }),
    });
    const b = (await r.json()) as { ok?: boolean; error?: string };
    if (b.ok) {
      bootOpen.value = false;
      flash('booting — switching when ready');
      const bootedUdid = bootSel.value;
      // poll until the boot lands (sim boot takes seconds), then switch to it
      const deadline = Date.now() + 20000;
      const waitBoot = async (): Promise<void> => {
        for (;;) {
          await new Promise((res) => setTimeout(res, 2000));
          try {
            const r = await fetch('/api/devices');
            const b2 = (await r.json()) as { devices?: Array<{ udid: string; state: string | null }> };
            const row = (b2.devices ?? []).find((x) => x.udid === bootedUdid);
            if (row && (row.state ?? '').toLowerCase() === 'booted') {
              preselectApplied = true;          // later loads never override
              await loadDevices();
              activeUdid.value = bootedUdid;    // auto-switch to the new tab
              flash(`switched to ${devices.value.find((x) => x.udid === bootedUdid)?.name ?? 'new device'}`);
              return;
            }
          } catch { /* keep waiting */ }
          if (Date.now() > deadline) { flash('boot is slow — check the devices page'); return; }
        }
      };
      void waitBoot();
    } else bootErr.value = b.error ?? 'boot failed';
  } catch { bootErr.value = 'boot request failed'; }
  finally { bootBusy.value = false; }
}

/** play a case on this device: newest templates → prompt-free picker */
const playPick = ref<Array<{ id: string; name: string; desc: string | null; ticket: string | null; steps: number }>>([]);
const playPickId = ref('');
const playSearch = ref('');

// ── suite modal (run → suite) — uniform with the test-case modal ──
interface SuiteRowM { id: string; name: string; desc: string | null; members: number }
const suiteOpen = ref(false);
const suiteList = ref<SuiteRowM[]>([]);
const suiteSearch = ref('');
const suitePickId = ref('');
const suiteBusy = ref(false);
const suiteErr = ref('');
const suiteFiltered = computed((): SuiteRowM[] => {
  const q = suiteSearch.value.trim().toLowerCase();
  if (!q) return suiteList.value;
  return suiteList.value.filter((s) => s.name.toLowerCase().includes(q) || (s.desc ?? '').toLowerCase().includes(q));
});
async function openSuite(): Promise<void> {
  suiteOpen.value = true; suiteErr.value = ''; suiteSearch.value = ''; suitePickId.value = '';
  try {
    const r = await fetch('/api/suites');
    const b = (await r.json()) as { suites?: Array<{ id: string; name: string; description?: string | null; members?: unknown[] }> };
    suiteList.value = (b.suites ?? []).map((s) => ({ id: s.id, name: s.name, desc: s.description ?? null, members: Array.isArray(s.members) ? s.members.length : 0 }));
  } catch { suiteErr.value = 'suite list failed'; }
}
async function playSuite(): Promise<void> {
  if (!suitePickId.value || suiteBusy.value) return;
  suiteBusy.value = true; suiteErr.value = '';
  try {
    const r = await fetch(`/api/suites/${encodeURIComponent(suitePickId.value)}/play`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(playAllBooted.value ? {} : { udid: activeUdid.value }),
    });
    const b = (await r.json()) as { runIds?: string[]; count?: number; batchId?: string; error?: string };
    if (b.runIds) {
      suiteOpen.value = false;
      flash(`suite · ${b.count ?? b.runIds.length} runs queued`);
      railTab.value = 'watch';
    }
    else suiteErr.value = b.error ?? 'suite play failed';
  } catch { suiteErr.value = 'suite request failed'; }
  finally { suiteBusy.value = false; }
}
const playFiltered = computed((): Array<{ id: string; name: string; desc: string | null; ticket: string | null; steps: number }> => {
  const q = playSearch.value.trim().toLowerCase();
  if (!q) return playPick.value;
  return playPick.value.filter((t) => t.name.toLowerCase().includes(q) || (t.desc ?? '').toLowerCase().includes(q) || (t.ticket ?? '').toLowerCase().includes(q));
});
const playOpen = ref(false);
const playBusy = ref(false);
const playAllBooted = ref(false);
const bootedCount = ref(0);
async function pickPlayCase(): Promise<void> {
  try {
    const r = await fetch('/api/templates');
    const b = (await r.json()) as { templates?: Array<{ id: string; name: string; description?: string | null; ticketKey?: string | null; steps?: unknown[] }> };
    playPick.value = (b.templates ?? []).slice(0, 30).map((t) => ({
      id: t.id, name: t.name,
      desc: t.description ?? null,
      ticket: t.ticketKey ?? null,
      steps: Array.isArray(t.steps) ? t.steps.length : 0,
    }));
    try {
      const rd = await fetch('/api/devices');
      const bd = (await rd.json()) as { devices?: Array<{ state: string | null }> };
      bootedCount.value = (bd.devices ?? []).filter((x) => (x.state ?? '').toLowerCase() === 'booted').length;
    } catch { bootedCount.value = devices.value.length; }
    playAllBooted.value = false;
    playPickId.value = '';
    playSearch.value = '';
    playOpen.value = true;
  } catch { flash('case list failed', 'err'); }
}
async function playCase(id: string): Promise<void> {
  playBusy.value = true;
  try {
    const r = await fetch(`/api/templates/${encodeURIComponent(id)}/play`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(playAllBooted.value ? { allBooted: true } : { udid: activeUdid.value }),
    });
    const b = (await r.json()) as { runId?: string; fanOut?: boolean; count?: number; runs?: Array<{ runId?: string; error?: string }>; error?: string };
    if (b.fanOut) {
      playOpen.value = false;
      const ok = (b.runs ?? []).filter((x) => x.runId).length;
      flash(`queued on ${ok}/${b.count ?? '?'} devices`);
      railTab.value = 'watch';
    } else if (b.runId) { playOpen.value = false; flash(`run started · ${String(b.runId).slice(0, 14)}`); railTab.value = 'watch'; }
    else flash(b.error ?? 'play failed', 'err');
  } catch { flash('play request failed', 'err'); }
  finally { playBusy.value = false; }
}

watch(stage, (s) => { if (s) s.setScreenState; }); // placeholder no-op — screenState flows via expose polling below
let ovTimer = setInterval(() => {
  const t = toolsRef.value as unknown as { tree?: { state: { value: string }; nodes: { value: Array<Record<string, unknown>> }; logicalW: { value: number | null }; logicalH: { value: number | null } }; selection?: Record<string, unknown> | null } | null;
  if (t?.tree) {
    overlayData.value = { nodes: t.tree.nodes.value, w: t.tree.logicalW.value, h: t.tree.logicalH.value, visible: t.tree.state.value === 'aligned', sel: (t.selection ?? null) as Record<string, unknown> | null };
    // keep the stage's picking mode locked to the tree's live state — the
    // child's emit can race setup flushes; this poll is the sync truth
    stage.value?.setInspect(t.tree.state.value !== 'off');
  }
}, 500);
onBeforeUnmount(() => clearInterval(ovTimer));
let ssTimer = setInterval(() => {
  const st = stage.value as unknown as { screenState?: { value: string }; sessionLabel?: { value: string | null } } | null;
  if (st?.screenState) screenState.value = st.screenState.value;
  if (st?.sessionLabel) menuSessionLabel.value = st.sessionLabel.value;
}, 1000);
onBeforeUnmount(() => clearInterval(ssTimer));

const closingUdid = ref('');
async function onTabClose(udid: string): Promise<void> {
  if (closingUdid.value) return;
  closingUdid.value = udid;
  try {
    // 1. release any open manual session on that device (finish is idempotent server-side)
    deviceSessions.set(udid, null);
    if (sessionOn.value && udid === activeUdid.value) {
      try { await fetch(`/api/manual/${encodeURIComponent(sessionOn.value)}/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'manual:cockpit:tab-close' }) }); } catch { /* idempotent */ }
      sessionOn.value = null;
    } else {
      // a session on a NON-active tab: the stage only holds the active one —
      // find + finish any open session for that udid directly
      try {
        const r = await fetch('/api/devices');
        void r;
        // (manual sessions are per-device; a background device has no stage session)
      } catch { /* noop */ }
    }
    // 2. shutdown the device
    const r = await fetch(`/api/devices/${encodeURIComponent(udid)}/power`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'shutdown' }),
    });
    const b = (await r.json()) as { ok?: boolean; error?: string };
    if (b.ok) {
      flash('device released + shutting down');
      // move off the dying tab before the list refresh removes it
      if (udid === activeUdid.value) {
        const next = devices.value.find((x) => x.udid !== udid);
        activeUdid.value = next?.udid ?? '';
      }
      setTimeout(() => void loadDevices(), 4000);
    } else flash(b.error ?? 'shutdown failed');
  } catch { flash('close failed'); }
  finally { closingUdid.value = ''; }
}

function onSwitch(udid: string): void {
  activeUdid.value = udid;
  sessionOn.value = null;
}

function onInspectClick(ev: MouseEvent): void {
  toolsRef.value?.stageClick(ev);
}
const toolsRef = ref<InstanceType<typeof ToolsDrawer> | null>(null);

function onSessionAcquired(s: { sessionId: string; startedAt: number }): void {
  deviceSessions.set(activeUdid.value, { sessionId: s.sessionId, startedAt: s.startedAt, dims: { w: null, h: null } });
}
function onSessionDropped(): void {
  deviceSessions.set(activeUdid.value, null);
}

function onSessionState(s: { sessionId: string | null; dims?: { w: number | null; h: number | null } }): void {
  sessionOn.value = s.sessionId;
  if (s.dims) dims.value = s.dims;
}

const status = computed(() => ({
  sessionLabel: menuSessionLabel.value,
  deviceName: activeName.value,
  liveCount: devices.value.length,
}));
void live;
</script>

<template>
  <div class="cockpit">
    <MenuBar :status="status" @menu-event="onMenuEvent" />
    <DeviceSwitcher :devices="devices" :active-udid="activeUdid" :closing-udid="closingUdid" @switch="onSwitch" @close="onTabClose" />
    <div class="frame">
      <div class="stage-col">
      <StageBezel v-if="activeUdid" :key="activeUdid" ref="stage" :udid="activeUdid" :restarting="isRestarting(activeUdid)" :case-running="caseRunningOnActive" :session="activeSession"
        :overlay-nodes="overlayData.nodes" :overlay-w="overlayData.w" :overlay-h="overlayData.h" :overlay-visible="overlayData.visible" :sel-parent-node="overlayData.sel" :selected-node="overlayData.sel"
        @session-state="onSessionState" @inspect-click="onInspectClick"
        @session-acquired="onSessionAcquired" @session-dropped="onSessionDropped"
        @exit-inspect="overlay = null; toolsOpen = false" />
      <div v-else class="empty">no booted devices — boot one from the device menu</div>
      <!-- toasts live INSIDE the device container area (stage column), top-left -->
      <div class="toast-stack" aria-live="polite">
        <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind" @click="dropToast(t.id)">
          <span class="t-ico">{{ t.kind === 'ok' ? '✓' : '✕' }}</span>
          <span class="t-text">{{ t.text }}</span>
          <span class="t-bar"><i /></span>
        </div>
      </div>
      </div>
      <WatcherPanel :tabs="[{ id: 'watch', label: 'watch' }, { id: 'chat', label: 'chat' }]" :active="railTab" @switch="railTab = $event">
        <WatchPane v-show="railTab === 'watch'" :udid="activeUdid" :session-id="sessionOn" :dims="dims" />
        <ChatPane v-show="railTab === 'chat'" :udid="activeUdid" :device-name="activeName" :screen-state="screenState" :scenario="activeScenario" />
        <template #overlay>
          <!-- supplementary overlays — ONE at a time, covering the ENTIRE rail
               (tabs included) per operator directive -->
          <OverlayPanel v-if="overlay === 'env'" title="environment" icon="◔" :badge="activeScenario ? '1 active' : '· none'" @close="overlay = null">
            <EnvPanelContent @scenario="activeScenario = $event" />
          </OverlayPanel>
          <ToolsDrawer v-if="overlay === 'inspect'" ref="toolsRef" :open="overlay === 'inspect'" :udid="activeUdid" :session-id="sessionOn"
            @close="overlay = null; toolsOpen = false"
            @exit-inspect="overlay = null; toolsOpen = false"
            @inspect-enabled="(on) => { stage?.setInspect(on); }" />
        </template>
      </WatcherPanel>
    </div>

    <!-- boot picker -->
    <!-- boot modal (install pattern) -->
    <div v-if="bootOpen" class="modal-scrim" @click.self="bootOpen = false">
      <div class="modal wide">
        <h3>boot device</h3>
        <div class="modal-body">
          <div v-if="!bootPick.length" class="k">every known device is already booted</div>
          <div v-for="d in bootPick" :key="d.udid" class="dev-row" :class="{ picked: bootSel === d.udid }" @click="bootSel = d.udid">
            <div class="dev-main">
              <span class="dev-name">{{ d.name }}</span>
              <span class="dev-meta">{{ [d.os, d.res].filter(Boolean).join(' · ') || d.udid.slice(0, 8) }}</span>
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="m-btn" @click="bootOpen = false">cancel</button>
          <button class="m-btn primary" :disabled="!bootSel || bootBusy" @click="bootSelected">{{ bootBusy ? 'booting…' : 'boot' }}</button>
        </div>
        <div v-if="bootErr" class="hint-err">{{ bootErr }}</div>
      </div>
    </div>

    <!-- play-case picker -->
    <div v-if="playOpen" class="modal-scrim" @click.self="playOpen = false">
      <div class="modal wide">
        <h3>test case on {{ activeName }}</h3>
        <div class="modal-body">
          <label class="fanout-row"><input v-model="playAllBooted" type="checkbox" /> run on all booted devices ({{ bootedCount }})</label>
          <input v-model="playSearch" type="search" class="modal-search" placeholder="search cases…" />
          <div v-if="!playFiltered.length" class="k">{{ playPick.length ? 'no case matches' : 'no cases found' }}</div>
          <div v-for="t in playFiltered" :key="t.id" class="app-row case-row" :class="{ picked: playPickId === t.id, busy: playBusy }" @click="playPickId = t.id">
            <div class="app-head">
              <span class="app-name">{{ t.name }}</span>
              <span class="k">{{ t.ticket ? t.ticket + ' · ' : '' }}{{ t.steps }} steps</span>
            </div>
            <div v-if="t.desc" class="case-desc">{{ t.desc }}</div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="m-btn" :disabled="playBusy" @click="playOpen = false">cancel</button>
          <button class="m-btn primary" :disabled="!playPickId || playBusy" @click="playCase(playPickId!)">{{ playBusy ? 'running…' : 'run' }}</button>
        </div>
      </div>
    </div>

    <!-- suite modal (uniform with test case) -->
    <div v-if="suiteOpen" class="modal-scrim" @click.self="suiteOpen = false">
      <div class="modal wide">
        <h3>suite on {{ activeName }}</h3>
        <div class="modal-body">
          <label class="fanout-row"><input v-model="playAllBooted" type="checkbox" /> distribute across booted devices ({{ bootedCount }})</label>
          <input v-model="suiteSearch" type="search" class="modal-search" placeholder="search suites…" />
          <div v-if="!suiteFiltered.length" class="k">{{ suiteList.length ? 'no suite matches' : 'no suites found' }}</div>
          <div v-for="s in suiteFiltered" :key="s.id" class="app-row case-row" :class="{ picked: suitePickId === s.id, busy: suiteBusy }" @click="suitePickId = s.id">
            <div class="app-head">
              <span class="app-name">{{ s.name }}</span>
              <span class="k">{{ s.members }} case{{ s.members === 1 ? '' : 's' }}</span>
            </div>
            <div v-if="s.desc" class="case-desc">{{ s.desc }}</div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="m-btn" :disabled="suiteBusy" @click="suiteOpen = false">cancel</button>
          <button class="m-btn primary" :disabled="!suitePickId || suiteBusy" @click="playSuite">{{ suiteBusy ? 'running…' : 'run suite' }}</button>
        </div>
        <div v-if="suiteErr" class="hint-err">{{ suiteErr }}</div>
      </div>
    </div>

    <!-- install modal -->
    <div v-if="installOpen" class="modal-scrim" @click.self="installOpen = false">
      <div class="modal wide">
        <h3>install app on {{ activeName }}</h3>
        <div class="modal-body">
        <div v-if="!installLoaded && !installErr" class="k">discovering artifacts…</div>
        <div v-for="a in installApps" :key="a.key" class="app-row" :class="{ picked: installPick && a.builds.some((b) => b.path === installPick) }">
          <div class="app-head" @click="installExpanded = installExpanded === a.key ? null : a.key">
            <span class="app-name">{{ a.name }}</span>
            <span class="k">{{ a.version ?? '—' }} · {{ ageOf(a.mtimeMs) }} · {{ a.builds.length > 1 ? a.builds.length + ' builds' : a.source }}</span>
          </div>
          <div v-if="installExpanded === a.key" class="app-builds">
            <div v-for="b in a.builds" :key="b.path" class="pick-row" :class="{ picked: installPick === b.path }" @click="installPick = b.path">
              <span>{{ b.path.split('/').pop() }}</span>
              <span class="k">{{ ageOf(b.mtimeMs) }} · {{ b.source }}</span>
            </div>
          </div>
        </div>
        </div>
        <div class="modal-actions">
          <button class="m-btn" @click="installOpen = false">cancel</button>
          <button class="m-btn primary" :disabled="!installPick || installBusy" @click="runInstall">{{ installBusy ? 'installing… (≈12s)' : 'install' }}</button>
        </div>
        <div v-if="installErr" class="hint-err">{{ installErr }}</div>
      </div>
    </div>

    <!-- run app modal (installed apps of this simulator) -->
    <div v-if="runAppOpen" class="modal-scrim" @click.self="runAppOpen = false">
      <div class="modal wide">
        <h3>run app on {{ activeName }}</h3>
        <div class="modal-body">
          <div v-if="!runAppLoaded && !runAppErr" class="k">reading installed apps…</div>
          <div v-for="a in runAppApps" :key="a.bundleId" class="pick-row" :class="{ picked: runAppPick === a.bundleId }" @click="runAppPick = a.bundleId">
            <span>
              <img v-if="runAppIcons" class="runapp-icon" :src="`/api/devices/${encodeURIComponent(activeUdid)}/apps/${encodeURIComponent(a.bundleId)}/icon`" alt="" width="18" height="18" />
              {{ a.name }}
              <span v-if="a.running" class="running-dot" title="running">●</span>
            </span>
            <span class="k">{{ a.version ?? '—' }}<template v-if="a.bundleId.startsWith('com.apple.')"> · system</template></span>
          </div>
        </div>
        <div class="modal-actions">
          <button class="m-btn" @click="runAppOpen = false">cancel</button>
          <button class="m-btn primary" :disabled="!runAppPick || runAppBusy" @click="launchApp">{{ runAppBusy ? 'launching…' : 'run' }}</button>
        </div>
        <div v-if="runAppMsg" class="hint-ok">{{ runAppMsg }}</div>
        <div v-if="runAppErr" class="hint-err">{{ runAppErr }}</div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.cockpit { display: flex; flex-direction: column; height: 100vh; position: relative; background: var(--color-void); }
.frame { flex: 1; display: grid; grid-template-columns: 1fr 420px; min-height: 0; position: relative; background: var(--color-carbon); border-top: 1px solid var(--color-iron); }
.empty { display: grid; place-items: center; color: var(--color-steel); font-size: var(--text-caption); }
.pane { display: flex; flex-direction: column; min-height: 0; }
.k { color: var(--color-fog); font-size: var(--text-caption); }
.row { display: flex; justify-content: space-between; padding: 3px 0; font-size: var(--text-caption); }
.v { color: var(--color-paper); }
.stage-col { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.toast-stack { position: absolute; top: 12px; left: 14px; z-index: 60; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; pointer-events: none; }
.toast { position: relative; display: flex; align-items: center; gap: 8px; background: var(--color-carbon); border: 1px solid var(--color-slate); color: var(--color-paper); font-size: var(--text-caption); padding: 7px 12px; border-radius: var(--r); pointer-events: auto; cursor: pointer; overflow: hidden; animation: toast-in .18s ease; max-width: 340px; }
@keyframes toast-in { from { opacity: 0; transform: translateX(8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
.toast .t-ico { flex: none; width: 16px; height: 16px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; }
.toast.ok .t-ico { background: var(--color-ember); color: var(--color-carbon); }
.toast.err { border-color: var(--color-ember); }
.toast.err .t-ico { border: 1px solid var(--color-ember); color: var(--color-ember); }
.toast .t-text { white-space: normal; overflow-wrap: anywhere; }
.toast .t-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; }
.toast .t-bar i { display: block; height: 2px; background: var(--color-ember); animation: toast-drain 5s linear forwards; }
@keyframes toast-drain { from { width: 100%; } to { width: 0; } }
@media (prefers-reduced-motion: reduce) { .toast .t-bar { display: none; } }
.modal-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: grid; place-items: center; z-index: 50; }
.modal { background: var(--color-carbon); border: 1px solid var(--color-slate); border-radius: var(--r); padding: 16px; min-width: 320px; max-height: 60vh; display: flex; flex-direction: column; }
.modal-body { flex: 1; min-height: 0; overflow-y: auto; }
.runapp-icon { vertical-align: -4px; margin-right: 7px; border-radius: 4px; }
.running-dot { color: var(--color-ember); font-size: 9px; margin-left: 5px; }
.modal h3 { font-size: var(--text-caption); color: var(--color-paper); margin: 0 0 10px; text-transform: uppercase; letter-spacing: .1em; }
.pick-row { display: flex; justify-content: space-between; padding: 6px 8px; border-radius: var(--r); cursor: pointer; color: var(--color-fog); font-size: var(--text-caption); }
.pick-row:hover { background: var(--color-iron); color: var(--color-paper); }
.pick-row.busy { opacity: .5; cursor: wait; }
.pick-row.picked { border: 1px solid var(--color-ember); background: rgba(218, 92, 44, .08); color: var(--color-paper); }
.pick-row.picked .k { color: var(--color-ember); }
.fanout-row { display: flex; align-items: center; gap: 8px; font-size: var(--text-caption); color: var(--color-fog); margin-bottom: 10px; cursor: pointer; user-select: none; }
/* flex was STRETCHING the native checkbox to the row width (286px!) — the
   box rendered far from its label. Fixed size + no grow keeps the classic
   checkbox-next-to-text shape. */
.fanout-row input { width: 13px; height: 13px; flex: 0 0 auto; margin: 0; accent-color: var(--color-ember); cursor: pointer; }
.fanout-row:hover { color: var(--color-paper); }
.modal.wide { min-width: 460px; }
.app-row { border: 1px solid var(--color-iron); border-radius: var(--r); padding: 8px; margin-bottom: 6px; }
.app-row.picked { border-color: var(--color-ember); }
.modal-search { font-family: inherit; font-size: var(--text-caption); color: var(--color-paper); background: var(--color-void); border: 1px solid var(--color-iron); border-radius: var(--r); padding: 5px 8px; margin-bottom: 8px; width: 100%; outline: none; }
.modal-search:focus { border-color: var(--color-slate); }
.case-row { cursor: pointer; }
.case-row:hover { border-color: var(--color-slate); }
.case-row.busy { opacity: .6; pointer-events: none; }
.case-row.picked { background: rgba(218, 92, 44, .08); }
.case-desc { font-size: 10.5px; color: var(--color-ash); margin-top: 4px; line-height: 1.45; }
.app-head { display: flex; justify-content: space-between; gap: 10px; cursor: pointer; }
.app-name { color: var(--color-paper); font-size: var(--text-caption); }
.app-builds { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.m-btn { font-family: inherit; background: none; border: 1px solid var(--color-iron); color: var(--color-fog); padding: 4px 14px; cursor: pointer; font-size: var(--text-caption); border-radius: var(--r); }
.m-btn:hover:not(:disabled) { border-color: var(--color-slate); color: var(--color-paper); }
.m-btn.primary { background: var(--color-ember); border-color: var(--color-ember); color: #000; font-weight: var(--weight-bold); }
.m-btn:disabled { opacity: .5; cursor: default; }
.hint-ok { color: var(--color-paper); font-size: var(--text-caption); margin-top: 8px; }
.hint-err { color: var(--color-paper); font-size: var(--text-caption); margin-top: 8px; border-left: 2px solid var(--color-ember); padding-left: 8px; }
.dev-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; border: 1px solid var(--color-iron); border-radius: var(--r); padding: 8px 10px; margin-bottom: 6px; cursor: pointer; }
.dev-row:hover { border-color: var(--color-slate); }
.dev-row.picked { border-color: var(--color-ember); }
.dev-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dev-name { color: var(--color-paper); font-size: var(--text-caption); }
.dev-meta { color: var(--color-steel); font-size: 10px; }
</style>
