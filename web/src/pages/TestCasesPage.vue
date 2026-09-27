<script setup lang="ts">
/** Test cases — the A2 design, natively: a viewport-locked column of
 *  header / case table (own scroll) / yaml panel. The minimal header is not
 *  a "locked variant" — it IS the page chrome (mockup: a2-split-panel-scroll).
 *  Run controls: filter toolbar (tabs + search) above the table; env is
 *  managed on the env page (scoped vars resolve server-side at play time).
 *  disclosure row that collapses away while editing yaml.
 *  Everything from the old page is ported: verdicts/trends, play/playAll,
 *  plans, rename/edit/delete, step expander (param/optional, + subflow,
 *  + assert), tag-filter chips, suite summary. */
import PageHeader from '../components/PageHeader.vue';
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import CaseEditorPanel from '../components/CaseEditorPanel.vue';
import RunPanel from '../components/RunPanel.vue';
import EvidenceSheet, { type EvidenceLane } from '../components/EvidenceSheet.vue';
import { initActiveRuns, useActiveRuns } from '../composables/activeRuns.ts';

interface Step { idx: number; action: string; x?: number; y?: number; direction?: string; text?: string; optional?: boolean; selector?: { identifier?: string; label?: string; type?: string }; templateId?: string }
interface Verdict {
  lastRunId: string | null; lastStatus: string | null; lastBlocked: number;
  lastFinishedAt: number | null;
  trend: string | null; totalRuns: number;
}
interface Template {
  id: string; name: string; status?: string; description: string | null; ticketKey: string | null;
  udid: string; logicalW: number | null; logicalH: number | null;
  steps: Step[]; defaultPresetId: string | null;
  appBundleId: string | null; appName: string | null; appVersion: string | null;
  tags: string[]; verdict: Verdict | null;
  evidence?: { screenshot: boolean; video: boolean };
  selectorCoverage?: { locked: number; total: number };
  createdBy: string; createdAt: number; updatedAt: number; updatedBy?: string | null;
}

const templates = ref<Template[]>([]);
async function loadBootedDevices(): Promise<void> {
  try {
    const r = await fetch('/api/devices');
    const b = (await r.json()) as { devices?: Array<{ udid: string; name: string; state: string; resolution: string | null }> };
    bootedDevices.value = (b.devices ?? []).filter((d) => d.state === 'Booted');
  } catch { /* picker stays empty; auto resolution applies */ }
}
const loading = ref(true);
const error = ref('');
const filter = ref('');
const filterEl = ref<HTMLInputElement | null>(null);
const playing = ref<string | null>(null);

// ── run menu (explicit watch/background actions) + abort (shared tracker) ──
// run = always watch (dock opens). The ▾ menu items RUN immediately in the
// chosen mode — no sticky preference: a silent mode flip on the main button
// read as "nothing happened" then betrayed the next click (user, 2026-09-06).
type RunMode = 'watch' | 'background';
function runFromMenu(m: RunMode, t: Template): void {
  runMenuOpen.value = null;
  runMenuPos.value = null;
  void play(t, m);
}
const runMenuOpen = ref<string | null>(null); // open menu's template id — one at a time
const runMenuPos = ref<{ top: number; left: number } | null>(null);
function templateById(id: string | null): Template {
  const t = templates.value.find((x) => x.id === id);
  if (!t) throw new Error('case not found');
  return t;
}
function toggleRunMenu(id: string, ev: Event): void {
  if (runMenuOpen.value === id) { runMenuOpen.value = null; runMenuPos.value = null; return; }
  const r = (ev.target as HTMLElement).getBoundingClientRect();
  // right-align under ▾ but NEVER past the viewport: menus have a fixed
  // ~190px width, so clamp the left edge (vw - width - margin)
  const MENU_W = 190;
  const left = Math.min(Math.round(r.right - MENU_W), window.innerWidth - MENU_W - 8);
  runMenuPos.value = { top: Math.round(r.bottom + 4), left: Math.max(8, left) };
  runMenuOpen.value = id;
}
const tracker = useActiveRuns();
const aborting = ref<string | null>(null);
async function abortCase(t: { id: string }): Promise<void> {
  const active = tracker.activeRun(t.id);
  if (!active) return;
  aborting.value = t.id;
  try {
    await fetch(`/api/runs/${active.runId}/abort`, { method: 'POST' });
    // click-time ack (run.aborted event) clears the tracker; pending state
    // ends here regardless — idempotent endpoint makes retry harmless
  } catch { /* tracker will clear on next event or reseed */ }
  finally { aborting.value = null; }
}
const playMsg = ref('');
// ── APP_NOT_INSTALLED remediation: one-click install from the last-known
// artifact (or the picker), then auto-replay the SAME case once. ──
interface InstallHint {
  templateId: string; udid: string; appBundleId: string;
  lastArtifact: { path: string; version: string | null; recordedAt: number } | null;
}
const installHint = ref<InstallHint | null>(null);
const installing = ref(false);
const installErr = ref('');
const artifactModal = ref(false);
const artifactList = ref<Array<{ path: string; bundleId: string; version: string | null; mtimeMs: number; source: string }>>([]);
const artifactLoading = ref(false);
const playingAll = ref(false);
// every run started while set — presets active for the run's duration only
const scenarios = ref<Array<{ id: string; name: string }>>([]);
// explicit device choice for plays (empty = auto: recorded-if-booted, else
// the single booted sim; 2+ booted without a choice → DEVICE_AMBIGUOUS 409)
const bootedDevices = ref<Array<{ udid: string; name: string; resolution: string | null }>>([]);

/** env map for plays: KEY=value lines. Prompted once, reused for every play
 *  until cleared — the Maestro envFile equivalent. */

async function play(t: Template, mode: RunMode = 'watch'): Promise<void> {
  if (playing.value) return;
  playing.value = t.id;
  playMsg.value = '';
  try {
    const r = await fetch(`/api/templates/${t.id}/play`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    // no "running · run_x" status line — the row's progress pill and the
    // dock (watch mode) are the live surfaces; playMsg stays for ERRORS
    // (device ambiguity, app-not-installed, failures) and batch results.
    // Variant plays: laneCount tells the dock to follow lanes (run.started
    // events) instead of settling on lane 1 — the response now returns
    // after lane 1 STARTS, not after the whole play finishes.
    const b = (await r.json()) as { runId?: string; runIds?: string[]; laneCount?: number; udid?: string; error?: string; code?: string; appBundleId?: string; booted?: Array<{ udid: string; name: string | null }>; lastArtifact?: { path: string; version: string | null; recordedAt: number } | null };
    if (b.code === 'DEVICE_AMBIGUOUS') {
      await loadBootedDevices();
      const names = bootedDevices.value.map((d) => d.name ?? d.udid.slice(0, 8)).join(', ');
      playMsg.value = `several devices booted (${names}) — boot exactly one, or pass ?udid via the API`;
    } else if (b.runId) {
      if (mode === 'watch') {
        runPanel.value = { runId: b.runId, templateId: t.id, caseName: t.name, udid: b.udid ?? t.udid, laneCount: (b.laneCount ?? (b.runIds?.length || 0)) || 1 };
      }
      installHint.value = null;
    } else if (b.code === 'APP_NOT_INSTALLED') {
      installHint.value = { templateId: t.id, udid: b.udid ?? t.udid, appBundleId: b.appBundleId ?? t.appBundleId ?? '', lastArtifact: b.lastArtifact ?? null };
      playMsg.value = 'app not installed on this device';
    } else {
      playMsg.value = b.error ?? 'failed';
    }
  } catch {
    playMsg.value = 'failed';
  } finally { playing.value = null; }
}

async function installFrom(path: string, version: string | null): Promise<void> {
  const h = installHint.value;
  if (!h || installing.value) return;
  installing.value = true;
  installErr.value = '';
  try {
    const r = await fetch(`/api/devices/${h.udid}/install`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appPath: path }),
    });
    const b = (await r.json()) as { ok?: boolean; version?: string | null; error?: string };
    if (!b.ok) { installErr.value = b.error ?? 'install failed'; return; }
    // installed — auto-replay the SAME case once (pre-check now passes)
    const t = templates.value.find((x) => x.id === h.templateId);
    installHint.value = null;
    artifactModal.value = false;
    if (t) await play(t);
  } catch {
    installErr.value = 'install failed';
  } finally { installing.value = false; }
}

async function openArtifactModal(): Promise<void> {
  const h = installHint.value;
  if (!h) return;
  artifactModal.value = true;
  artifactLoading.value = true;
  try {
    const r = await fetch(`/api/devices/${h.udid}/artifacts`);
    const b = (await r.json()) as { artifacts?: Array<{ path: string; bundleId: string; version: string | null; mtimeMs: number; source: string }> };
    // matching bundle first, everything else after (no filtering lies)
    artifactList.value = [
      ...(b.artifacts ?? []).filter((a) => a.bundleId === h.appBundleId),
      ...(b.artifacts ?? []).filter((a) => a.bundleId !== h.appBundleId),
    ];
  } catch { artifactList.value = []; } finally { artifactLoading.value = false; }
}

function relAge(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

function artifactLabel(a: { path: string; version: string | null; source: string }): string {
  const v = a.version ? ` v${a.version}` : '';
  const parts = a.path.split('/').filter(Boolean);
  const job = parts.length >= 3 ? parts[parts.length - 3] : parts[0] ?? a.path;
  return `${v ? v + ' · ' : ''}${job} · ${a.source}`;
}

// ── run companion panel (R1 observer dock) ──
const runPanel = ref<{ runId: string; templateId: string; caseName: string; udid: string; laneCount?: number } | null>(null);

// evidence sheet (sketch 008-C): open state is just templateId + lanes —
// all filtering/cinema state lives inside EvidenceSheet
const evidenceView = ref<{ templateId: string; caseName: string; lanes: EvidenceLane[] } | null>(null);
async function openEvidence(t: Template): Promise<void> {
  let lanes: EvidenceLane[] = [];
  try {
    const r = await fetch(`/api/templates/${t.id}/evidence`);
    if (r.ok) lanes = ((await r.json()) as { lanes: EvidenceLane[] }).lanes;
  } catch { /* gallery fetch best-effort — 404 for never-run */ }
  evidenceView.value = { templateId: t.id, caseName: t.name, lanes };
}
function closeEvidence(): void { evidenceView.value = null; }

/** a lane was purged via the sheet — drop it from the open view; empty sheet
 *  closes itself. Gallery thumbs on the row refresh via the templates refetch
 *  below (keeps the run-outcome cells in sync with what evidence remains). */
function onLaneDeleted(variantId: string | null): void {
  if (!evidenceView.value) return;
  const lanes = evidenceView.value.lanes.filter((l) => l.variantId !== variantId);
  if (lanes.length === 0) { closeEvidence(); void load(); return; }
  evidenceView.value = { ...evidenceView.value, lanes };
  void load();
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    // evidence sheet owns Escape while open (its own window listener uses
    // stopImmediatePropagation and closes itself / the cinema) — touching
    // evidence state here too would close the sheet out from under the cinema
    if (evidenceView.value) return;
    if (statusMenuOpen.value !== null) { closeStatusMenu(); return; }
    if (runMenuOpen.value !== null) { runMenuOpen.value = null; runMenuPos.value = null; return; }
  }
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
// run menu: click anywhere outside closes it (no per-row portals)
function onMenuScatter(e: MouseEvent): void {
  if (runMenuOpen.value === null && statusMenuOpen.value === null) return;
  // the menu lives at body level now (Teleport) — check both anchors
  const t = e.target as HTMLElement;
  if (!t.closest?.('.run-menu') && !t.closest?.('.run-menu-pop') && !t.closest?.('.kebab')) {
    runMenuOpen.value = null;
    runMenuPos.value = null;
    closeStatusMenu();
  }
}
onMounted(() => window.addEventListener('click', onMenuScatter));
onBeforeUnmount(() => { window.removeEventListener('click', onMenuScatter); });
/** adopt a run already live on this page's device set — reload mid-run,
 *  play from another tab, run started via plan/prompt. The panel hydrates
 *  itself from GET /api/runs/:id/steps, so no template steps needed. */
async function adoptRunningRun(): Promise<void> {
  if (runPanel.value) return; // a run is already being watched — keep it
  try {
    const r = await fetch('/api/runs?limit=200');
    const b = (await r.json()) as { runs?: Array<{ id: string; status: string; template_id: string | null; device_udid: string; note: string | null }> };
    const liveRun = (b.runs ?? []).find((x) => x.status === 'running' && templates.value.some((t) => t.id === x.template_id));
    if (liveRun) {
      const t = templates.value.find((x) => x.id === liveRun.template_id)!;
      runPanel.value = { runId: liveRun.id, templateId: t.id, caseName: t.name, udid: liveRun.device_udid };
    }
  } catch { /* adopt best-effort */ }
}

async function playAll(): Promise<void> {
  if (playingAll.value) return;
  // use the visible (filtered) set's tags — play what you see
  const visible = shown();
  const tagSet = [...new Set(visible.flatMap((t) => t.tags ?? []))];
  const tags = tagSet.length ? window.prompt(`play all ${visible.length} templates — restrict to tags (comma list, empty = all visible):`, tagSet.join(',')) ?? '' : '';
  if (tags === null) return;
  playingAll.value = true;
  playMsg.value = `playing ${visible.length} templates…`;
  try {
    const r = await fetch('/api/templates/play-all', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags }),
    });
    const b = (await r.json()) as { runIds?: string[]; count?: number; error?: string };
    playMsg.value = b.runIds ? `queued ${b.count} runs · ${b.runIds.join(' ')}` : (b.error ?? 'failed');
  } catch {
    playMsg.value = 'failed';
  } finally { playingAll.value = false; }
}

// ■ stop all (Task 4): abort every tracked run + every queued row, with
// honest per-kind counts. Idempotent endpoints make partial failure safe
// to ignore — the tracker clears via events as each abort lands.
async function stopAll(): Promise<void> {
  const runs = tracker.all();
  let queued: string[] = [];
  try {
    const r = await fetch('/api/queue');
    const b = (await r.json()) as { queue?: Array<{ id: string }> };
    queued = (b.queue ?? []).map((q) => q.id);
  } catch { /* queue listing best-effort */ }
  const results = await Promise.allSettled([
    ...runs.map((run) => fetch(`/api/runs/${run.runId}/abort`, { method: 'POST' })),
    ...queued.map((id) => fetch(`/api/queue/${id}`, { method: 'DELETE' })),
    // parallel batches: stop lanes dispatching their next case (the current
    // run aborts above; without this a lane would just start its next case)
    ...tracker.batchIds().map((id) => fetch(`/api/batches/${id}/abort`, { method: 'POST' })),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  playMsg.value = `stopped ${runs.length} run(s) · ${queued.length} queued (${ok}/${results.length} accepted)`;
}

async function patchTemplate(id: string, body: Record<string, unknown>): Promise<void> {
  await fetch(`/api/templates/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await load();
}

async function editTags(t: Template): Promise<void> {
  const raw = window.prompt('tags (comma list, max 8):', (t.tags ?? []).join(','));
  if (raw === null) return;
  const tags = raw.split(',').map((x) => x.trim()).filter(Boolean);
  await patchTemplate(t.id, { tags });
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const qs = statusFilter.value ? `?status=${encodeURIComponent(statusFilter.value)}` : '';
    const r = await fetch(`/api/templates${qs}`);
    const b = (await r.json()) as { templates?: Template[] };
    templates.value = b.templates ?? [];
    error.value = '';
  } catch {
    error.value = 'failed to load templates';
  } finally { loading.value = false; }
  try {
    const r = await fetch('/api/forge/scenarios');
    const b = (await r.json()) as { scenarios?: Array<{ id: string; name: string }> };
    scenarios.value = b.scenarios ?? [];
  } catch { /* scenarios optional — runs go without network config */ }
}

async function remove(id: string): Promise<void> {
  if (!confirm('delete this template?')) return;
  await fetch(`/api/templates/${id}`, { method: 'DELETE' });
  await load();
}

/** A2 plan: '+ case (yaml)' — hand-author a new case: create the shell row,
 *  then open it in the yaml panel (the editor IS the authoring surface). */
async function createCaseYaml(): Promise<void> {
  const res = await fetch('/api/templates', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `untitled case ${Date.now().toString(36).slice(-4)}`, steps: [{ idx: 0, action: 'scroll', direction: 'down' }] }),
  });
  if (!res.ok) { error.value = 'create failed'; return; }
  const t = (await res.json()) as Template;
  await load();
  yamlOpenId.value = t.id;
}

const shown = (): Template[] => {
  const f = filter.value.trim().toLowerCase();
  if (!f) return templates.value;
  return templates.value.filter((t) =>
    t.name.toLowerCase().includes(f) || (t.ticketKey ?? '').toLowerCase().includes(f) || (t.tags ?? []).some((tg) => tg.toLowerCase().includes(f)));
};

// ── app-grouped list (plan 20260928T003500Z): sections per bundle from the
// POST-FILTER rows; a group whose every row filtered out renders nothing.
const NO_APP = '<<no-app>>'; // sentinel sort-key; a real reverse-DNS bundle can never equal it
interface RowGroup { key: string; label: string; rows: Template[] }
const groups = computed<RowGroup[]>(() => {
  const by = new Map<string, RowGroup>();
  for (const t of shown()) {
    const key = t.appBundleId || NO_APP;
    let g = by.get(key);
    if (!g) { g = { key, label: key === NO_APP ? 'no app' : t.appBundleId!, rows: [] }; by.set(key, g); }
    g.rows.push(t);
  }
  const list = [...by.values()];
  list.sort((a, b) => (a.key === NO_APP ? 1 : b.key === NO_APP ? -1 : a.label.localeCompare(b.label)));
  return list;
});
const collapsed = ref(new Set<string>());
function toggleGroup(key: string): void {
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  collapsed.value = next;
}

// ── phase E: status lifecycle — chips (server-filtered), pill, kebab actions ──
type Lifecycle = 'draft' | 'active' | 'deprecated';
const statusFilter = ref<'' | Lifecycle>('');
watch(statusFilter, () => void load());
/** counts for the chips come from the SERVER's unfiltered view — chip math on
 *  the client would lie the moment a status filter narrows `templates`. */
const statusCounts = ref<Record<Lifecycle | 'all', number>>({ all: 0, active: 0, draft: 0, deprecated: 0 });
const statusCountsDirty = ref(true); // ref, not let — the async recount flip must re-render the tabs
function recountStatuses(): void {
  if (!statusCountsDirty.value) return;
  // recount only when the full list is loaded (no status filter active)
  void (async () => {
    try {
      const r = await fetch('/api/templates');
      const b = (await r.json()) as { templates?: Template[] };
      const all = b.templates ?? [];
      statusCounts.value = {
        all: all.length,
        active: all.filter((t) => (t.status ?? 'active') === 'active').length,
        draft: all.filter((t) => t.status === 'draft').length,
        deprecated: all.filter((t) => t.status === 'deprecated').length,
      };
      statusCountsDirty.value = false;
    } catch { /* counts stay stale — chips show nothing rather than lie */ }
  })();
}
const statusMenuOpen = ref<string | null>(null); // kebab's open template id
const statusMenuPos = ref<{ top: number; left: number } | null>(null);
function toggleStatusMenu(id: string, ev: Event): void {
  if (statusMenuOpen.value === id) { statusMenuOpen.value = null; statusMenuPos.value = null; return; }
  const r = (ev.target as HTMLElement).getBoundingClientRect();
  const MENU_W = 150;
  const left = Math.min(Math.round(r.right - MENU_W), window.innerWidth - MENU_W - 8);
  statusMenuPos.value = { top: Math.round(r.bottom + 4), left: Math.max(8, left) };
  statusMenuOpen.value = id;
}
function closeStatusMenu(): void { statusMenuOpen.value = null; statusMenuPos.value = null; }
const setStatusBusy = ref<string | null>(null);
async function setStatus(t: Template, to: Lifecycle): Promise<void> {
  closeStatusMenu();
  setStatusBusy.value = t.id;
  try {
    const r = await fetch(`/api/templates/${t.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: to }),
    });
    if (r.ok) {
      // optimistic row update + chip counts go stale (server owns the truth)
      t.status = to;
      statusCountsDirty.value = true;
      recountStatuses();
    }
  } finally { setStatusBusy.value = null; }
}

// ── A2 yaml split panel: the page's native editing surface ──
const yamlOpenId = ref<string | null>(null);
const yamlPosition = computed(() => {
  if (!yamlOpenId.value) return { pos: 1, total: 1 };
  const list = shown();
  const i = list.findIndex((t) => t.id === yamlOpenId.value);
  return { pos: i >= 0 ? i + 1 : 1, total: list.length };
});
/** ONE editor at a time, with a save/abort guard: switching (or hopping)
 *  away from dirty edits asks first — save keeps them, abort drops them. */
const yamlPanelEl = ref<InstanceType<typeof CaseEditorPanel> | Array<InstanceType<typeof CaseEditorPanel>> | null>(null);
function panel(): InstanceType<typeof CaseEditorPanel> | null {
  // template refs inside v-for arrive as ARRAYS — normalize (the setCanvas lesson)
  const el = yamlPanelEl.value;
  return Array.isArray(el) ? (el[0] ?? null) : (el ?? null);
}
const pendingSwitch = ref<string | null>(null); // case awaiting the decision
// single row-tooltip: .ibtn hover drives a FIXED element centered under the
// icon — never clipped by the table's overflow container
function ibtnEnter(el: HTMLElement): void {
  const label = el.querySelector('.ib-label')?.textContent ?? el.title;
  const tip = document.getElementById('rowtip');
  if (!tip || !label) return;
  tip.textContent = label;
  const r = el.getBoundingClientRect();
  tip.style.left = `${r.left + r.width / 2}px`;
  tip.style.top = `${r.bottom + 5}px`;
  tip.classList.add('show');
}
function ibtnLeave(): void {
  document.getElementById('rowtip')?.classList.remove('show');
}

// ── duplicate / export / import (plan 20260927T164000Z) ──────────────────
const note = ref('');
let noteTimer: ReturnType<typeof setTimeout> | null = null;
function flash(msg: string): void {
  note.value = msg;
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { note.value = ''; }, 4000);
}
const duplicating = ref<string | null>(null);
async function duplicateCase(t: Template): Promise<void> {
  if (duplicating.value !== null) return;
  duplicating.value = t.id;
  try {
    const r = await fetch(`/api/templates/${t.id}/duplicate`, { method: 'POST' });
    const b = await r.json() as { id?: string; name?: string; error?: string };
    if (!r.ok || !b.id) { flash(`duplicate failed: ${b.error ?? r.status}`); return; }
    await load(); // refresh list so the copy shows
    const copy = templates.value.find((c) => c.id === b.id);
    if (copy) openYaml(copy); // operator decision: jump into the copy
    flash(`duplicated → ${b.name}`);
  } catch (e) { flash(`duplicate failed: ${e instanceof Error ? e.message : String(e)}`); }
  finally { duplicating.value = null; }
}

function exportOne(t: Template): void {
  const a = document.createElement('a');
  const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'case';
  a.href = `/api/templates/${t.id}/yaml`;
  a.download = `${slug}.yaml`;
  a.click(); // browser fetches + saves; auth cookie rides along
}

function exportZip(): void {
  const a = document.createElement('a');
  a.href = '/api/templates/export';
  a.click();
}

const importing = ref(false);
const importPreview = ref<Array<{ label: string; name: string; steps: number }> | null>(null);
const importBusy = ref(false);
let importPayload: { yaml?: string; filename?: string; zipBase64?: string } | null = null;

async function pickImport(ev: Event): Promise<void> {
  const f = (ev.target as HTMLInputElement).files?.[0];
  (ev.target as HTMLInputElement).value = '';
  if (!f) return;
  importPayload = null; importPreview.value = null;
  try {
    if (f.name.endsWith('.zip')) {
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      importPayload = { filename: f.name, zipBase64: btoa(bin) };
      importPreview.value = [{ label: f.name, name: `${f.name} (contents checked on import)`, steps: -1 }];
    } else {
      const yaml = await f.text();
      importPayload = { yaml };
      // pre-flight preview via the validate endpoint per document
      const docs = yaml.split(/^---\s*$/m).map((d) => d.trim()).filter(Boolean);
      const pv: Array<{ label: string; name: string; steps: number }> = [];
      for (let i = 0; i < docs.length; i++) {
        const r = await fetch('/api/templates/yaml/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: docs[i] }) });
        const b = await r.json() as { ok?: boolean; errors?: Array<{ message: string }>; case?: { name?: string; steps?: unknown[] } | null };
        if (!b.ok) { flash(`document ${i + 1}: ${b.errors?.[0]?.message ?? 'invalid'}`); importPayload = null; importPreview.value = null; return; }
        pv.push({ label: `document ${i + 1}`, name: b.case?.name ?? '(unnamed)', steps: b.case?.steps?.length ?? 0 });
      }
      importPreview.value = pv;
    }
    importing.value = true;
  } catch (e) { flash(`read failed: ${e instanceof Error ? e.message : String(e)}`); }
}

async function confirmImport(): Promise<void> {
  if (!importPayload) return;
  importBusy.value = true;
  try {
    const r = await fetch('/api/templates/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(importPayload) });
    const b = await r.json() as { imported?: Array<{ name: string }>; renamed?: Array<{ to: string }>; error?: string };
    if (!r.ok) { flash(`import rejected: ${b.error ?? r.status}`); return; }
    await load();
    flash(`imported ${b.imported?.length ?? 0} case(s)${b.renamed?.length ? ` · ${b.renamed.length} renamed` : ''}`);
    importing.value = false; importPayload = null; importPreview.value = null;
  } catch (e) { flash(`import failed: ${e instanceof Error ? e.message : String(e)}`); }
  finally { importBusy.value = false; }
}

function openYaml(t: Template): void {
  if (yamlOpenId.value === t.id) { yamlOpenId.value = null; return; } // toggle
  // a collapsed section must open before the editor mounts inside it (review F2)
  const gk = t.appBundleId || NO_APP;
  if (collapsed.value.has(gk)) toggleGroup(gk);
  if (yamlOpenId.value !== null && panel()?.isDirty()) {
    pendingSwitch.value = t.id;
    return;
  }
  yamlOpenId.value = t.id;
}
async function resolveSwitch(save: boolean): Promise<void> {
  const target = pendingSwitch.value;
  pendingSwitch.value = null;
  if (!target) return;
  if (save) await panel()?.saveNow();
  yamlOpenId.value = target;
}
function hopYaml(dir: -1 | 1): void {
  const list = shown();
  const i = list.findIndex((t) => t.id === yamlOpenId.value);
  if (i < 0) return;
  const next = list[i + dir];
  if (next) openYaml(next); // same dirty guard as clicking a row
}
const yamlCase = computed(() => (yamlOpenId.value ? shown().find((t) => t.id === yamlOpenId.value) ?? null : null));
const tagCount = computed(() => new Set(templates.value.flatMap((t) => t.tags ?? [])).size);
/** the A2 editing state — drives header chrome swap + table share */
const editing = computed(() => yamlOpenId.value !== null);

// A2: ⌘F jumps to the case filter (search-to-jump)
function onCmdF(ev: KeyboardEvent): void {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'f' && yamlOpenId.value !== null) {
    ev.preventDefault();
    filterEl.value?.focus();
  }
}
onMounted(() => window.addEventListener('keydown', onCmdF));
onBeforeUnmount(() => { window.removeEventListener('keydown', onCmdF); });

onMounted(() => {
  void load().then(() => void adoptRunningRun()); void loadBootedDevices(); initActiveRuns(); recountStatuses();
  // delegated tooltip wiring for every .ibtn (current + future rows)
  const enter = (e: Event) => { const b = (e.target as HTMLElement).closest?.('.ibtn'); if (b) ibtnEnter(b as HTMLElement); };
  const leave = (e: Event) => { if ((e.target as HTMLElement).closest?.('.ibtn')) ibtnLeave(); };
  document.addEventListener('mouseover', enter);
  document.addEventListener('mouseout', leave);
  onBeforeUnmount(() => { document.removeEventListener('mouseover', enter); document.removeEventListener('mouseout', leave); });
});
// deep-link from a run's version chip: /templates?case=<id>&rev=<n> —
// opens that case's editor with the history disclosure on that revision.
const route = useRoute();
const deepRev = ref<number | null>(null);
onMounted(() => {
  const c = route.query['case'];
  const r = route.query['rev'];
  if (typeof c !== 'string' || !c) return;
  // templates load async in another mount hook — wait until the list is
  // populated (or a settle proves it never will be), then open.
  const stop = watch(templates, (list) => {
    if (list.some((t) => t.id === c)) {
      yamlOpenId.value = c;
      if (typeof r === 'string' && r) deepRev.value = Number.parseInt(r, 10) || null;
      stop();
    }
  }, { immediate: true, deep: false });
});

// verdict refresh when any tracked run settles (background runs land here)
watch(() => tracker.settledCount(), () => { void load(); });

// ── B4: verdict + trend rendering ──
type VerdictKind = 'never' | 'green' | 'red' | 'blocked' | 'aborted';
function verdictKind(t: Template): VerdictKind {
  const v = t.verdict;
  if (!v || v.lastStatus === null) return 'never';
  if (v.lastStatus === 'passed') return 'green';
  if (v.lastStatus === 'aborted') return 'aborted';
  return v.lastBlocked === 1 ? 'blocked' : 'red';
}
/** verdict → existing .status-* system class (symbols carry status per Axiom:
 *  ✓ pass · ✕ fail · ◆ blocked (dashed) · ◌ aborted · · never). */
function verdictStatusClass(t: Template): string {
  const k = verdictKind(t);
  return k === 'green' ? 'status-pass' : k === 'red' ? 'status-fail' : k === 'blocked' ? 'status-blocked' : k === 'aborted' ? 'status-quarantined' : 'status-none';
}
function verdictLabel(t: Template): string {
  const k = verdictKind(t);
  if (k === 'never') return 'never run';
  const v = t.verdict!;
  const when = v.lastFinishedAt ? relTime(v.lastFinishedAt) : '';
  const lbl = k === 'green' ? 'pass' : k === 'red' ? 'fail' : k === 'blocked' ? 'blocked (infra)' : 'aborted';
  return `${lbl}${when ? ` · ${when}` : ''}`;
}
function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

/** selector-locked step count (server-computed); null = field absent (older payload) */
function coverageOf(t: Template): { locked: number; total: number } | null { return t.selectorCoverage ?? null; }
function stepsTitle(t: Template): string {
  const c = coverageOf(t);
  const base = `${t.steps.length} steps`;
  if (!c) return base;
  const bare = c.total - c.locked;
  if (bare === 0) return `${base} — every interactive step is selector-locked (survives layout changes)`;
  return `${base} — ${bare} step(s) use bare coordinates only: one layout change can break them. Re-record with selectors (or add identifiers in the app) to harden.`;
}

/** trend → momentum dots (last 3 runs) + delta arrow (last 3 vs prior 3).
 *  Chosen over the 5-glyph string (012 sketch A): direction is the question
 *  this column answers; full glyph history stays in the tooltip. */
function trendDots(t: Template): { dots: Array<{ cls: string; tip: string }>; delta: 'up' | 'flat' | 'down' | null; tip: string } {
  const trend = t.verdict?.trend;
  if (!trend) return { dots: [], delta: null, tip: '' };
  const glyph = (g: string): string => (g === 'p' ? '✓' : g === 'F' ? '◆' : g === 'f' ? '✕' : '◌');
  const name = (g: string): string => (g === 'p' ? 'pass' : g === 'F' ? 'blocked' : g === 'f' ? 'fail' : 'abort');
  // trend arrives oldest → newest
  const last6 = trend.slice(-6);
  const last3 = last6.slice(-3);
  const prior3 = last6.slice(0, Math.max(0, last6.length - 3));
  const dots = last3.split('').map((g) => ({ cls: g === 'p' ? 'd-pass' : g === 'F' ? 'd-block' : g === 'f' ? 'd-fail' : 'd-abort', tip: name(g) }));
  let delta: 'up' | 'flat' | 'down' | null = null;
  if (prior3.length === 3) {
    const score = (g: string): number => (g === 'p' ? 1 : 0);
    const d = last3.split('').reduce((a, g) => a + score(g), 0) - prior3.split('').reduce((a, g) => a + score(g), 0);
    delta = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  }
  const tip = `last ${last6.length} play${last6.length === 1 ? '' : 's'}: ${last6.split('').map(glyph).join('')}${delta ? ` — ${delta === 'up' ? 'improving' : delta === 'down' ? 'degrading' : 'steady'}` : ''}`;
  return { dots, delta, tip };
}
const suiteSummary = computed(() => {
  const ks = templates.value.map(verdictKind);
  return {
    total: ks.length,
    green: ks.filter((k) => k === 'green').length,
    red: ks.filter((k) => k === 'red').length,
    blocked: ks.filter((k) => k === 'blocked').length,
    never: ks.filter((k) => k === 'never').length,
  };
});

</script>
<template>
  <section class="a2-page" :class="{ editing: yamlOpenId !== null }">
    <!-- ── header — the mockup's minimal one-row chrome; the suite summary +
         run controls ride in the advanced disclosure when not editing ── -->
    <PageHeader title="test cases">
      <span class="ph-desc">{{ templates.length }} case{{ templates.length === 1 ? '' : 's' }} · {{ tagCount }} tag{{ tagCount === 1 ? '' : 's' }}</span>
      <span v-if="!editing" class="ph-syms" :title="`${suiteSummary.green} pass · ${suiteSummary.red} fail · ${suiteSummary.blocked} blocked · ${suiteSummary.never} never run`">
        <span class="sym" title="passing">✓{{ suiteSummary.green }}</span>
        <span v-if="suiteSummary.red" class="sym" title="failing">✕{{ suiteSummary.red }}</span>
        <span v-if="suiteSummary.blocked" class="sym" title="blocked (infra)">◆{{ suiteSummary.blocked }}</span>
        <span v-if="suiteSummary.never" class="sym" title="never run">◌{{ suiteSummary.never }}</span>
      </span>
      <template #actions>
        <button class="btn" :disabled="playingAll" @click="createCaseYaml" title="hand-author a new case as yaml — opens the editor with a minimal starter">+ case (yaml)</button>
        <button class="btn" @click="exportZip" title="download every case as a zip of .yaml files + manifest">export zip</button>
        <button class="btn" @click="($refs.importFile as HTMLInputElement).click()" title="import cases from a .yaml (single or multi-doc) or a previously exported .zip">import</button>
        <input ref="importFile" type="file" accept=".yaml,.yml,.zip" style="display:none" @change="pickImport" />
        <span v-if="note" class="import-note">{{ note }}</span>
        <div id="rowtip" aria-hidden="true"></div>
  <div v-if="importing" class="import-modal">
          <div class="import-card">
            <div class="import-h">import cases</div>
            <div v-if="importPreview">
              <div v-for="p in importPreview" :key="p.label" class="import-row">
                <span class="import-label">{{ p.label }}</span>
                <span class="import-name">{{ p.name }}</span>
                <span class="import-steps">{{ p.steps >= 0 ? `${p.steps} steps` : '' }}</span>
              </div>
            </div>
            <div class="import-actions">
              <button class="btn" :disabled="importBusy" @click="importing = false; importPayload = null; importPreview = null">cancel</button>
              <button class="btn btn-primary" :disabled="importBusy" @click="confirmImport">{{ importBusy ? 'importing…' : 'import' }}</button>
            </div>
          </div>
        </div>
        <button v-if="playingAll" class="btn btn-danger" @click="stopAll"
          title="abort the running case and every queued one">■ stop all</button>
      </template>
    </PageHeader>



    <!-- ── filter toolbar (was the advanced row): tabs + search own the line ── -->
    <div v-if="!editing" class="a2-toolbar">
      <div class="a2-tabs" role="tablist">
        <button v-for="s in ([['', 'all'], ['active', 'active'], ['draft', 'draft'], ['deprecated', 'deprecated']] as Array<['' | Lifecycle, string]>)"
          :key="s[1]" class="a2-tab" :class="{ on: statusFilter === s[0], dep: s[0] === 'deprecated' }" role="tab"
          :aria-selected="statusFilter === s[0]"
          :title="s[0] === '' ? 'every case regardless of lifecycle' : `lifecycle: ${s[1]} (deprecated never runs in batches)`"
          @click="statusFilter = s[0]">{{ s[1] }} <span class="n">{{ statusCountsDirty ? '·' : statusCounts[s[0] === '' ? 'all' : s[0]] }}</span></button>
      </div>
      <input ref="filterEl" v-model="filter" class="a2-search" placeholder="search cases…  ⌘F" />
    </div>
    <!-- ── case table: own scroll region, sticky header ── -->
    <div class="a2-table a2-list">
      <div class="a2-thead">
        <span class="col-case">case</span>
        <span class="col-ver" title="app version — stamped live by the runner">ver</span>
        <span class="col-steps">steps</span>
        <span class="col-updated">updated</span>
        <span class="col-trend" title="last 3 runs (dots) + direction vs prior 3 (↑ → ↓)">trend</span>
        <span class="col-evidence" title="latest run evidence — screenshot of the expect that proved (or broke) the case">evidence</span>
        <span class="col-verdict">verdict</span>
        <span class="col-actions"></span>
      </div>

      <template v-for="g in groups" :key="g.key">
      <div class="a2-group-head" @click.stop="toggleGroup(g.key)" :title="g.key === NO_APP ? 'cases without an app' : g.label">
        <span class="caret">{{ collapsed.has(g.key) ? '▸' : '▾' }}</span>
        <span class="owner">{{ g.label }}</span>
        <span class="n">{{ g.rows.length }}</span>
      </div>
      <article v-for="t in g.rows" v-show="!collapsed.has(g.key)" :key="t.id" class="a2-row-card" :class="{ editing: yamlOpenId === t.id, deprecated: t.status === 'deprecated' }">
        <div class="a2-row" @click="openYaml(t)" title="click to edit this case">
          <span class="col-case">
            <span class="a2-name">{{ t.name }}</span>
            <span v-if="t.status === 'draft'" class="lifecycle-pill lifecycle-draft" title="draft — unfinished; still runs in batches">draft</span>
            <span v-else-if="t.status === 'deprecated'" class="lifecycle-pill lifecycle-deprecated" title="deprecated — skipped by run filtered + suites; manual run still allowed">deprecated</span>
            <span v-if="t.ticketKey" class="a2-ticket">{{ t.ticketKey }}</span>
            <span v-for="tg in t.tags ?? []" :key="tg" class="chip" title="click to filter by this tag" @click.stop="filter = tg">{{ tg }}</span>
          </span>
          <span class="col-ver" :title="`${t.appBundleId ?? 'no app'} · ${t.appVersion ?? 'unversioned'}`">
            <span v-if="t.appVersion" class="a2-ver-val">v{{ t.appVersion }}</span>
            <span v-else class="a2-app-none">—</span>
          </span>
          <span class="col-steps" :title="stepsTitle(t)">
            {{ t.steps.length }}<span v-if="coverageOf(t) && coverageOf(t)!.locked < coverageOf(t)!.total"
              class="steps-cov" :class="{ warn: coverageOf(t)!.total - coverageOf(t)!.locked > 0 }">
              ·🔒{{ coverageOf(t)!.locked }}/{{ coverageOf(t)!.total }}</span>
          </span>
          <span class="col-updated" :title="new Date(t.updatedAt).toLocaleString()">{{ relTime(t.updatedAt) }}</span>
          <span class="col-trend">
            <span v-if="t.verdict?.trend" class="trend" :title="trendDots(t).tip">
              <span class="dots">
                <span v-for="(d, i) in trendDots(t).dots" :key="i" class="dot" :class="d.cls" :title="d.tip"></span>
              </span>
              <span v-if="trendDots(t).delta" class="delta" :class="trendDots(t).delta">{{ trendDots(t).delta === 'up' ? '↑' : trendDots(t).delta === 'down' ? '↓' : '→' }}</span>
            </span>
            <span v-else class="a2-trend-none">—</span>
          </span>
          <span class="col-evidence">
            <img v-if="t.evidence?.screenshot" class="a2-evidence-thumb" alt="latest run evidence"
              :src="`/api/templates/${t.id}/evidence/screenshot`" loading="lazy"
              @click.stop="openEvidence(t)" @error="(e: Event) => (e.target as HTMLImageElement).style.display = 'none'"
              :title="t.evidence?.video ? 'latest run — click for screenshots + video' : 'latest run — click for screenshots'" />
            <span v-else class="a2-evidence-none" title="no evidence yet — run the case">—</span>
          </span>
          <span class="col-verdict">
            <span v-if="tracker.isRunning(t.id)" class="status status-none a2-running" title="this case is running now — abort from its row or the stream panel">
              <template v-if="tracker.progressOf(t.id)">
                {{ tracker.progressOf(t.id)!.phase === 'gate'
                  ? '◌ preparing…'
                  : `◌ running · ${tracker.progressOf(t.id)!.done}/${tracker.progressOf(t.id)!.total ?? '?'}` }}
              </template>
              <template v-else>◌ running…</template>
            </span>
            <span v-else-if="t.verdict" :class="`status ${verdictStatusClass(t)}`" :title="verdictLabel(t)">{{ verdictLabel(t) }}</span>
            <span v-else class="status status-none">never run</span>
          </span>
          <span class="col-actions" @click.stop>
            <template v-if="tracker.isRunning(t.id)">
              <button class="ibtn danger" :disabled="aborting === t.id" @click.stop="abortCase(t)"
                :title="`abort ${tracker.activeRun(t.id)?.runId ?? ''} — lands after the current step finishes`">
                <svg viewBox="0 0 20 20"><rect x="5" y="5" width="10" height="10" rx="1.5" fill="currentColor"/></svg>
                <span class="ib-label">{{ aborting === t.id ? 'aborting…' : 'abort' }}</span>
              </button>
            </template>
            <template v-else>
              <span class="run-menu">
                <button class="ibtn accent" :disabled="playing !== null" @click.stop="play(t)"
                  title="run and open the live stream panel">
                  <svg viewBox="0 0 20 20"><path d="M6 3.5l11 6.5-11 6.5v-13z" fill="currentColor"/></svg>
                  <span class="ib-label">{{ playing === t.id ? 'starting…' : 'run' }}</span>
                </button>
                <button class="ibtn run-menu-toggle" :class="{ open: runMenuOpen === t.id }" @click.stop="toggleRunMenu(t.id, $event)"
                  aria-haspopup="menu" :aria-expanded="runMenuOpen === t.id" title="run without the stream panel">
                  <svg viewBox="0 0 20 20"><path d="M5 8l5 5 5-5H5z" fill="currentColor"/></svg>
                  <span class="ib-label">run options</span>
                </button>
              </span>
            </template>
            <button class="ibtn" @click.stop="openYaml(t)" title="edit this case — metadata + yaml">
              <svg viewBox="0 0 20 20"><path d="M13.5 2.5l4 4L8 16H4v-4l9.5-9.5zm-2.8 3.7l1.6-1.6-1.2-1.2-1.6 1.6 1.2 1.2zM12.9 8.4l1.6-1.6-1.2-1.2-1.6 1.6 1.2 1.2zM5 13v2h2l1-1-2-2-1 1z" fill="currentColor"/></svg>
              <span class="ib-label">edit</span>
            </button>
            <button class="ibtn" :disabled="duplicating !== null" @click.stop="duplicateCase(t)"
              :title="`copy this case into a new draft — ${t.name} (copy)`">
              <svg viewBox="0 0 20 20"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M13 4.5V3H3v10h1.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
              <span class="ib-label">{{ duplicating === t.id ? 'copying…' : 'duplicate' }}</span>
            </button>
            <button class="ibtn" @click.stop="exportOne(t)" title="download this case as a .yaml file">
              <svg viewBox="0 0 20 20"><path d="M10 2v9m0 0l-3.5-3.5M10 11l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 13v3.5h14V13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
              <span class="ib-label">export</span>
            </button>
            <button class="ibtn" @click.stop="remove(t.id)" title="delete this case">
              <svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2m-7 0l1 11h8l1-11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <span class="ib-label">delete</span>
            </button>
            <button class="ibtn kebab" :class="{ open: statusMenuOpen === t.id }" :disabled="setStatusBusy === t.id"
              aria-haspopup="menu" :aria-expanded="statusMenuOpen === t.id" title="case status — draft / active / deprecated"
              @click.stop="toggleStatusMenu(t.id, $event)">
              <svg viewBox="0 0 20 20"><circle cx="10" cy="4.5" r="1.8" fill="currentColor"/><circle cx="10" cy="10" r="1.8" fill="currentColor"/><circle cx="10" cy="15.5" r="1.8" fill="currentColor"/></svg>
              <span class="ib-label">status</span>
            </button>
          </span>
        </div>

        <!-- the case editor (metadata + yaml) opens INLINE below this row -->
        <div v-if="yamlOpenId === t.id" class="a2-yaml">
          <CaseEditorPanel
            ref="yamlPanelEl"
            :template-id="t.id"
            :case-name="t.name"
            :position="yamlPosition.pos"
            :total="yamlPosition.total"
            :updated-at="t.updatedAt"
            :updated-by="t.updatedBy ?? null"
            :description="t.description"
            :deep-rev="yamlOpenId === t.id ? deepRev : null"
            @close="yamlOpenId = null; deepRev = null"
            @saved="() => void load()"
            @hop="hopYaml"
          />
        </div>

</article>
      </template>
    </div>

    <div v-if="playMsg" class="a2-note">{{ playMsg }}</div>

    <!-- one-click install remediation when the target app is missing -->
    <div v-if="installHint" class="hint-bar" style="margin-top: var(--s-2); align-items: center; gap: var(--s-2);">
      <span>! app <strong>{{ installHint.appBundleId }}</strong> is not installed on this device</span>
      <button v-if="installHint.lastArtifact" class="btn btn-sm" :disabled="installing"
        @click="installFrom(installHint.lastArtifact!.path, installHint.lastArtifact!.version)">
        {{ installing ? 'installing… (≈12s)' : `install${installHint.lastArtifact!.version ? ' v' + installHint.lastArtifact!.version : ''} · ${installHint.lastArtifact!.path.split('/').filter(Boolean).slice(-2)[0] ?? 'artifact'}` }}
      </button>
      <button class="btn btn-sm" :disabled="installing" @click="openArtifactModal">choose artifact…</button>
      <button class="btn btn-sm" style="margin-left: auto;" :disabled="installing" @click="installHint = null">dismiss</button>
      <span v-if="installErr" style="color: var(--color-ember);">{{ installErr }}</span>
    </div>

    <!-- artifact picker -->
    <div v-if="artifactModal" class="a2-modal-backdrop" @click.self="artifactModal = false">
      <div class="a2-modal card" style="width: 560px;">
        <div class="card-header">
          <span class="card-title">choose artifact</span>
          <span v-if="installHint" class="meta-row" style="font-size: var(--text-caption);">for {{ installHint.appBundleId }}</span>
          <button class="btn btn-sm" style="margin-left: auto;" @click="artifactModal = false">✕</button>
        </div>
        <div v-if="artifactLoading" class="a2-note">scanning…</div>
        <div v-else-if="artifactList.length === 0" class="empty">no artifacts found on disk — build the app first</div>
        <div v-else style="max-height: 340px; overflow-y: auto;">
          <div v-for="a in artifactList" :key="a.path" class="meta-row" style="padding: var(--s-2) 0; border-bottom: 1px solid var(--border); align-items: center;">
            <div style="min-width: 0;">
              <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ artifactLabel(a) }}</div>
              <div style="font-size: var(--text-caption); color: var(--color-steel); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" :title="a.path">{{ a.path }}</div>
            </div>
            <span style="color: var(--color-steel); flex: none; margin: 0 var(--s-2);">{{ relAge(a.mtimeMs) }}</span>
            <button class="btn btn-sm" style="flex: none;" :disabled="installing" @click="installFrom(a.path, a.version)">{{ installing ? '…' : 'install' }}</button>
          </div>
        </div>
      </div>
    </div>


    <!-- unsaved-changes guard: save / abort (✕ = keep editing) -->
    <div v-if="pendingSwitch" class="a2-modal-backdrop" @click.self="pendingSwitch = null">
      <div class="a2-modal card">
        <div class="card-header">
          <span class="card-title">unsaved changes</span>
          <button class="btn btn-sm" style="margin-left: auto;" title="keep editing" @click="pendingSwitch = null">✕</button>
        </div>
        <p style="color: var(--color-fog); font-size: var(--text-body); line-height: 1.6; padding: var(--s-2) var(--s-3);">
          This case has edits that are not saved yet. Save them before switching, or abort and lose the changes.
        </p>
        <div style="display: flex; gap: var(--s-2); justify-content: flex-end; padding: 0 var(--s-3) var(--s-3);">
          <button class="btn" @click="pendingSwitch = null">keep editing</button>
          <button class="btn btn-danger" @click="() => void resolveSwitch(false)">abort changes</button>
          <button class="btn btn-primary" @click="() => void resolveSwitch(true)">save &amp; switch</button>
        </div>
      </div>
    </div>

    <!-- the run companion dock (R1) — locked open for the run's duration -->
    <RunPanel
      v-if="runPanel"
      :run-id="runPanel.runId"
      :template-id="runPanel.templateId"
      :case-name="runPanel.caseName"
      :udid="runPanel.udid"
      :lane-count="runPanel.laneCount ?? 1"
      @close="runPanel = null"
      @open-run="(id) => $router.push(`/runs/${id}`)"
    />
    <!-- run-mode menu: Teleported to body — the table scrolls (overflow clips
         absolute children), so the dropdown overlays the table instead of
         being cut by its scroll container. -->
    <Teleport to="body">
      <div v-if="runMenuOpen && runMenuPos" class="run-menu-pop" role="menu" :style="{ top: `${runMenuPos.top}px`, left: `${runMenuPos.left}px` }" @click.stop>
        <button role="menuitem" @click="runFromMenu('watch', templateById(runMenuOpen))">
          <b>run · watch</b><span>opens the live stream panel</span>
        </button>
        <button role="menuitem" @click="runFromMenu('background', templateById(runMenuOpen))">
          <b>run · background</b><span>no panel — progress in the row</span>
        </button>
      </div>
      <!-- phase E: status kebab menu (same teleport + scatter pattern) -->
      <div v-if="statusMenuOpen && statusMenuPos" class="run-menu-pop status-menu-pop" role="menu" :style="{ top: `${statusMenuPos.top}px`, left: `${statusMenuPos.left}px` }" @click.stop>
        <div class="menu-label">status</div>
        <button v-if="templateById(statusMenuOpen).status !== 'draft'" role="menuitem" @click="setStatus(templateById(statusMenuOpen), 'draft')">
          <b>mark draft</b><span>unfinished — still runs in batches</span>
        </button>
        <button v-if="templateById(statusMenuOpen).status !== 'active'" role="menuitem" @click="setStatus(templateById(statusMenuOpen), 'active')">
          <b>restore to active</b><span>normal — runs everywhere</span>
        </button>
        <button v-if="templateById(statusMenuOpen).status !== 'deprecated'" role="menuitem" class="warn" @click="setStatus(templateById(statusMenuOpen), 'deprecated')">
          <b>deprecate</b><span>retired — skipped by batches, manual run still allowed</span>
        </button>
      </div>
    </Teleport>
    <!-- evidence sheet: sketch 008-C contact sheet (user pick) — per-variant
         lanes grouped as contact rows; card click → cinema view -->
    <EvidenceSheet :open="!!evidenceView" :case-name="evidenceView?.caseName ?? ''"
      :template-id="evidenceView?.templateId ?? ''" :lanes="evidenceView?.lanes ?? []"
      @close="closeEvidence" @lane-deleted="onLaneDeleted" />
  </section>
</template>

<style scoped>
/* ── the A2 layout, natively: a viewport column. Header + table (own scroll)
   + yaml panel. The lock lives at the app's scroll container (body class),
   set by the watcher — nothing here needs a "variant". ── */
.a2-page {
  display: flex; flex-direction: column;
  gap: var(--s-3);
  width: 100%;
  box-sizing: border-box;
}
/* the run dock is a pure overlay: no layout shift when it opens — it sits
   above the table (fixed, z-80), the table never reflows */
/* header */
/* ── filter toolbar (revamped; was the advanced disclosure row) ──
   a2-tabs/a2-tab are global (components.css) — shared with the env page */
.a2-toolbar { display: flex; align-items: center; gap: var(--s-3); flex: none; padding: 0; }
.a2-toolbar .a2-search { flex: 0 1 260px; margin-left: auto; }
.a2-search {
  background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r-sm);
  color: var(--color-fog); font: inherit; font-size: 12px; padding: 4px 10px; width: 220px;
}
.a2-search:focus { outline: none; border-color: var(--color-ember); }

/* ── phase E: status lifecycle (sketch 013-A chips + kebab, 1:1) ── */
.status-chip.on .n { color: var(--color-ember-dim); }
.status-chip:hover { color: var(--color-fog); }
.lifecycle-pill {
  font-size: 11px; border: 1px solid var(--color-slate); color: var(--color-ash);
  border-radius: var(--r-sm); padding: 1px 7px; white-space: nowrap; margin-left: 6px;
}
.lifecycle-draft { color: var(--color-fog); border-color: var(--color-pewter); border-style: dashed; }
.lifecycle-deprecated { color: var(--color-pewter); }
article.a2-row-card.deprecated .a2-name { color: var(--color-ash); }
article.a2-row-card.deprecated .a2-row { opacity: 0.55; }
article.a2-row-card.deprecated .a2-row:hover { opacity: 0.8; }
button.kebab { letter-spacing: 0; padding: 0; }
/* icon buttons — house icon language (20×20 viewBox, fill:currentColor,
   16px glyph in a 28×28 hit box, hover label). Hit-target floor rule. */
.ibtn {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0;
  background: none; border: none; border-radius: 5px;
  color: var(--color-pewter, #8a8f98); cursor: pointer;
}
.ibtn svg { width: 16px; height: 16px; pointer-events: none; }
.ibtn:hover { color: var(--color-paper, #f5f2ea); background: var(--color-graphite, #24262b); }
.ibtn:disabled { opacity: 0.45; cursor: default; }
.ibtn.accent:hover { color: var(--color-ember, #ff9f40); }
.ibtn.danger:hover { color: var(--color-paper, #f5f2ea); background: var(--color-ember, #ff9f40); }
/* single page-level tooltip (escapes the table's clip; centered under the
   hovered icon) — .ib-label spans are inert markers carrying the text */
#rowtip {
  position: fixed; z-index: 120; transform: translateX(-50%);
  padding: 3px 8px; border-radius: 4px; white-space: nowrap;
  background: var(--color-graphite, #24262b); border: 1px solid var(--color-iron, #3a3d44);
  font-family: var(--font-mono, monospace); font-size: 10px; letter-spacing: 0.03em;
  color: var(--color-paper, #f5f2ea); pointer-events: none; opacity: 0;
  transition: opacity 90ms ease;
}
#rowtip.show { opacity: 1; }
.ib-label { display: none; }
button.kebab.open { color: var(--color-ember); border-color: var(--color-ember); }
.status-menu-pop .menu-label {
  padding: 4px 10px 2px; color: var(--color-pewter); font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.08em;
}
.status-menu-pop button.warn b { color: var(--color-ember); }

/* advanced disclosure */
.a2-note { color: var(--color-steel); font-size: 11px; }

/* table region — content-sized: no stretch, no forced height. Scrolls only
   when the list outgrows the available space (flex shrink engages then). */
.a2-table { flex: 0 1 auto; overflow-y: auto; overscroll-behavior: contain; }
.a2-thead {
  position: sticky; top: 0; z-index: 2; background: var(--color-graphite);
  display: grid; grid-template-columns: minmax(0, 2.0fr) minmax(0, 70px) minmax(0, 64px) minmax(0, 92px) minmax(0, 110px) minmax(0, 64px) minmax(0, 235px) minmax(0, 200px);
  gap: var(--s-2); padding: 8px 12px;
  font-size: 10px; color: var(--color-steel); text-transform: uppercase; letter-spacing: 0.08em;
}
.a2-row-card { border-bottom: 1px solid var(--color-iron); }
.a2-row-card.editing { border-color: var(--color-ember); }
.a2-row-card.editing .a2-row { background: color-mix(in srgb, var(--color-ember) 6%, transparent); }
.a2-row {
  position: relative; display: grid; grid-template-columns: minmax(0, 2.0fr) minmax(0, 70px) minmax(0, 64px) minmax(0, 92px) minmax(0, 110px) minmax(0, 64px) minmax(0, 235px) minmax(0, 200px);
  gap: var(--s-2); align-items: center; padding: 8px 12px; min-height: 44px; cursor: pointer;
}
.a2-row:hover { background: var(--color-graphite); }
/* row cells only — the header spans share these class names and must keep
   the thead's 10px/steel; scope with .a2-row or the headers go 12px/fog */
.a2-row .col-steps, .a2-row .col-updated { color: var(--color-fog); font-size: 12px; }
/* selector-coverage badge inside the steps cell — ember when any bare
   coordinate step exists (fragility made visible), steel when fully locked */
.steps-cov { color: var(--color-steel); font-size: 10px; margin-left: 2px; }
.steps-cov.warn { color: var(--color-ember, #e5484d); }
.a2-name { color: var(--color-paper); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-app { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-ver { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); }
.a2-ver-val { color: var(--color-steel); }
/* .a2-group-head lives in global components.css (shared across list pages) */
/* verdict pill ellipsizes inside its track at extreme narrow widths (the
   pill is the unbreakable floor: mono text can't wrap) */
.col-evidence { display: flex; align-items: center; overflow: visible; }
.a2-evidence-thumb { width: 40px; height: 40px; border-radius: 6px; object-fit: cover; cursor: zoom-in; flex: none; border: 1px solid var(--color-line, #333); display: block; }
.a2-evidence-thumb:hover { border-color: var(--color-accent, #e5484d); }
.a2-evidence-none { color: var(--color-steel); }
.col-verdict { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-verdict .status { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
/* live progress pill (background runs): subtle pulse so 'preparing…' reads
   as activity, not a stuck verdict */
.a2-running { animation: a2-pulse 1.6s ease-in-out infinite; }
@keyframes a2-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
.a2-ticket { color: var(--color-steel); font-size: 10px; margin-left: 6px; }
.a2-app-icon { width: 16px; height: 16px; border-radius: 3px; vertical-align: -3px; margin-right: 6px; }
.a2-app-name { color: var(--color-fog); font-size: 12px; }
.a2-app-ver { color: var(--color-steel); font-size: 10px; margin-left: 4px; }
.a2-app-none { color: var(--color-steel); font-size: 11px; }
.a2-trend-none { color: var(--color-steel); }
/* actions: always-visible final column — no overlay, never covers the verdict */
.col-actions { display: flex; gap: 4px; justify-content: flex-end; }
.import-note { font-size: var(--text-caption, 11px); color: var(--color-ash, inherit); align-self: center; }
.import-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 60; }
.import-card { background: var(--color-void, #111); border: 1px solid var(--color-iron, #333); border-radius: 8px; padding: var(--s-4, 16px); min-width: 380px; max-width: 560px; max-height: 70vh; overflow: auto; }
.import-h { font-family: var(--font-mono, monospace); font-weight: var(--weight-bold, 700); font-size: var(--text-body, 13px); margin-bottom: var(--s-3, 12px); }
.import-row { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--color-iron, #2a2a2a); font-size: 12px; }
.import-label { color: var(--color-steel, #888); min-width: 90px; }
.import-name { flex: 1; }
.import-steps { color: var(--color-steel, #888); }
.import-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: var(--s-3, 12px); }

/* ── run menu (sticky watch/background) — content-sized, no fixed widths ── */
.run-menu { position: relative; display: inline-flex; }
.run-menu-toggle { padding: 0 6px; }
.run-menu-toggle.open { color: var(--color-accent, #e5484d); }
.run-menu-pop {
  position: fixed; z-index: 300; /* above the table's scroll container + sticky head */
  display: flex; flex-direction: column; width: 190px;
  background: var(--color-graphite, #1b1b1f); border: 1px solid var(--color-line, #2a2a30);
  border-radius: 4px; padding: 4px; box-shadow: 0 6px 24px rgba(0,0,0,.45);
}
.run-menu-pop button {
  display: flex; flex-direction: column; gap: 2px; align-items: flex-start;
  background: none; border: none; color: inherit; cursor: pointer;
  padding: 6px 10px; border-radius: 3px; text-align: left; font: inherit;
}
.run-menu-pop button:hover { background: rgba(255,255,255,.06); }
.run-menu-pop button.sel { color: var(--color-accent, #e5484d); }
.run-menu-pop button span { font-size: 11px; opacity: .75; }

/* row edit + expander body */

/* the yaml panel fills the remaining viewport while editing */
/* while EDITING, the table region takes its fixed mockup share */

/* the inline yaml editor below its row */
.a2-yaml { margin: 0 var(--s-2) var(--s-2); }
.a2-yaml > :deep(*) { width: 100%; }
/* unsaved-changes modal */
.a2-modal-backdrop {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(0, 0, 0, 0.85);
  display: flex; align-items: center; justify-content: center;
}
.a2-modal {
  width: min(440px, calc(100vw - 32px));
  background: var(--color-graphite);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

</style>
