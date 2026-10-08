<script setup lang="ts">
/** Builds page (029-A Jenkins table): flat build list — # · status ball ·
 *  project · transport · duration · when · artifact; console opens as a
 *  drawer under the row (live-tailed while running via ?from= polling).
 *  ▶ build… picks a project (admin). */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import PageHeader from '../components/PageHeader.vue';

interface Build {
  id: string; projectId: string; projectName: string; number: number;
  status: 'running' | 'passed' | 'failed'; transport: 'repo-lane' | 'generic';
  scheme: string | null; configuration: string | null; resolution: string | null; smoke: string | null;
  startedAt: number; finishedAt: number | null;
  artifactPath: string | null; error: string | null;
  suite: { passed: number; failed: number; running: number; total: number; failedNames?: string[] } | null;
}
interface Project { id: string; name: string }
interface Suite { id: string; name: string; appBundleId: string | null }
interface BuildInputs {
  appSchemes: string[]; configurations: string[];
  pinned: { scheme: string | null; configuration: string | null };
  manifest: { scheme: string | null; configuration: string | null } | null;
  manifestError: string | null;
  effective: {
    scheme: string | null; configuration: string | null;
    schemeResolution: string | null; configurationResolution: string | null;
  };
  repoShape: string | null;
}

const builds = ref<Build[]>([]);
const projects = ref<Project[]>([]);
const loaded = ref(false);
const error = ref('');

const openId = ref<string | null>(null);
const logText = ref('');
const logAt = ref(0);
let poll: ReturnType<typeof setInterval> | null = null;
let logPoll: ReturnType<typeof setInterval> | null = null;

const pickOpen = ref(false);
const starting = ref(false);
// ▶ test modal (Phase 1 build→test)
const testOpen = ref(false);
const testBuild = ref<Build | null>(null);
const suites = ref<Suite[]>([]);
const devices = ref<Array<{ udid: string; name: string | null }>>([]);
const testSuiteId = ref('');
const testUdid = ref('');
const testing = ref(false);

async function openTest(b: Build): Promise<void> {
  testBuild.value = b;
  testSuiteId.value = ''; testUdid.value = ''; testing.value = false; error.value = '';
  testOpen.value = true;
  try {
    const [sr, dr, pr] = await Promise.all([
      fetch('/api/suites'),
      fetch('/api/devices'),
      fetch(`/api/projects/${b.projectId}`),
    ]);
    if (sr.ok) suites.value = ((await sr.json()) as { suites?: Suite[] }).suites ?? [];
    if (dr.ok) devices.value = (((await dr.json()) as { devices?: Array<{ udid: string; name: string | null; state?: string; kind?: string }> }).devices ?? []).filter((d) => d.state === 'Booted' && d.kind === 'simulator');
    if (pr.ok) {
      const proj = ((await pr.json()) as { project?: { defaultSuiteId?: string | null } }).project;
      testSuiteId.value = proj?.defaultSuiteId ?? suites.value.find((s) => s.appBundleId == null)?.id ?? '';
    }
    if (!testUdid.value && devices.value.length > 0) testUdid.value = devices.value[0]!.udid;
  } catch { /* modal shows empties with reasons */ }
}

/** A suite can test this build when its bundle scope matches (or is open). */
function suiteMatches(s: Suite): boolean {
  if (!testBuild.value?.artifactPath) return s.appBundleId == null;
  // the build's bundle id is derivable from the artifact name claim, but the
  // server guards authoritatively; here we only grey obvious mismatches via
  // the project's last-known bundle: rely on server 409 BUNDLE_MISMATCH.
  return true; // server is the authority; keep all selectable
}

async function runTest(): Promise<void> {
  const b = testBuild.value;
  if (!b || testing.value) return;
  testing.value = true; error.value = '';
  try {
    const r = await fetch(`/api/builds/${b.id}/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(testSuiteId.value ? { suiteId: testSuiteId.value } : {}), ...(testUdid.value ? { udid: testUdid.value } : {}) }),
    });
    const j = (await r.json()) as { runIds?: string[]; batchId?: string; error?: string };
    if (!r.ok) { error.value = j.error ?? `test failed (${r.status})`; return; }
    testOpen.value = false; testBuild.value = null;
    await load();
    // evidence lives on the runs surface (batch highlight if supported)
    void j.batchId;
  } catch { error.value = 'test failed'; }
  finally { testing.value = false; }
}
// picker step 2 (build inputs): loaded after choosing a project
const pickProject = ref<Project | null>(null);
const inputs = ref<BuildInputs | null>(null);
const inputsErr = ref('');
const selScheme = ref('');
const selConfig = ref('');
const remember = ref(false);

async function chooseProject(p: Project): Promise<void> {
  pickProject.value = p;
  inputs.value = null; inputsErr.value = ''; selScheme.value = ''; selConfig.value = ''; remember.value = false;
  try {
    const r = await fetch(`/api/projects/${p.id}/build-inputs`);
    if (r.status === 409) { inputsErr.value = 'no workspace — clone the project first'; return; }
    if (!r.ok) { inputsErr.value = `load failed (${r.status})`; return; }
    const b = (await r.json()) as BuildInputs;
    inputs.value = b;
    selScheme.value = b.effective.scheme ?? '';
    selConfig.value = b.effective.configuration ?? '';
  } catch { inputsErr.value = 'load failed'; }
}

function provChip(res: string | null): string {
  if (res === 'manifest') return 'manifest';
  if (res === 'registry') return 'set';
  if (res === 'discovered') return 'auto';
  return '';
}

function closePicker(): void {
  pickOpen.value = false;
  pickProject.value = null;
  inputs.value = null;
  inputsErr.value = '';
}

async function startPicked(): Promise<void> {
  const p = pickProject.value;
  if (!p || starting.value) return;
  // "remember" pins the chosen inputs in the registry (admin intent) —
  // provenance for the next builds becomes `registry`
  if (remember.value && (selScheme.value || selConfig.value)) {
    try {
      await fetch(`/api/projects/${p.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(selScheme.value ? { buildScheme: selScheme.value } : {}), ...(selConfig.value ? { buildConfiguration: selConfig.value } : {}) }),
      });
    } catch { /* pin best-effort; build proceeds */ }
  }
  starting.value = true; error.value = '';
  try {
    const r = await fetch(`/api/projects/${p.id}/builds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const b = (await r.json()) as { ok?: boolean; build?: Build; error?: string };
    if (!b.ok) { error.value = b.error ?? `start failed (${r.status})`; return; }
    pickOpen.value = false; pickProject.value = null; inputs.value = null;
    await load();
    if (b.build) toggleLog(b.build.id);
    if (!poll) poll = setInterval(() => void load(), 3000);
  } catch { error.value = 'start failed'; }
  finally { starting.value = false; }
}

async function load(): Promise<void> {
  try {
    const r = await fetch('/api/builds');
    if (!r.ok) { error.value = r.status === 403 ? 'admin only' : `load failed (${r.status})`; loaded.value = true; return; }
    builds.value = ((await r.json()) as { builds?: Build[] }).builds ?? [];
    // keep polling while any build runs
    if (poll && !builds.value.some((b) => b.status === 'running')) { clearInterval(poll); poll = null; }
    loaded.value = true;
  } catch { error.value = 'load failed'; }
}
async function loadProjects(): Promise<void> {
  try {
    const r = await fetch('/api/projects');
    if (r.ok) projects.value = ((await r.json()) as { projects?: Project[] }).projects ?? [];
  } catch { /* picker handles empty */ }
}
onMounted(() => {
  void load();
  void loadProjects();
  poll = setInterval(() => void load(), 3000);
});
onBeforeUnmount(() => { if (poll) clearInterval(poll); if (logPoll) clearInterval(logPoll); });

async function startBuild(pid: string): Promise<void> {
  if (starting.value) return;
  starting.value = true; error.value = '';
  try {
    const r = await fetch(`/api/projects/${pid}/builds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const b = (await r.json()) as { ok?: boolean; build?: Build; error?: string };
    if (!b.ok) { error.value = b.error ?? `start failed (${r.status})`; return; }
    pickOpen.value = false;
    await load();
    if (b.build) toggleLog(b.build.id);
    if (!poll) poll = setInterval(() => void load(), 3000);
  } catch { error.value = 'start failed'; }
  finally { starting.value = false; }
}

async function toggleLog(id: string): Promise<void> {
  if (openId.value === id) {
    openId.value = null;
    if (logPoll) { clearInterval(logPoll); logPoll = null; }
    return;
  }
  openId.value = id;
  logText.value = ''; logAt.value = 0;
  await tailLog(id);
  if (logPoll) clearInterval(logPoll);
  logPoll = setInterval(() => { if (openId.value) void tailLog(openId.value); }, 2000);
}
async function tailLog(id: string): Promise<void> {
  try {
    const r = await fetch(`/api/builds/${id}/log?from=${logAt.value}`);
    if (!r.ok) return;
    const size = Number(r.headers.get('x-log-size') ?? '0');
    const chunk = await r.text();
    if (chunk) logText.value += chunk;
    logAt.value = size;
  } catch { /* next tick */ }
}

function ball(b: Build): { glyph: string; cls: string; label: string } {
  if (b.status === 'running') return { glyph: '◐', cls: 'run', label: 'running' };
  if (b.status === 'passed') return { glyph: '●', cls: 'pass', label: 'passed' };
  return { glyph: '✕', cls: 'fail', label: 'failed' };
}
function durOf(b: Build): string {
  const end = b.finishedAt ?? Date.now();
  const s = Math.max(0, Math.round((end - b.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${(s / 3600).toFixed(1)}h`;
}
function hhmm(ts: number): string {
  const d = new Date(ts);
  const day = new Date(ts).toDateString() === new Date().toDateString() ? '' : `${new Date(ts).toLocaleDateString()} `;
  return `${day}${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const runningCount = computed(() => builds.value.filter((b) => b.status === 'running').length);

function provOf(b: Build): string {
  if (!b.resolution) return '';
  try {
    const r = JSON.parse(b.resolution) as { scheme?: string | null; configuration?: string | null };
    const src = r.scheme ?? r.configuration;
    return src === 'manifest' ? 'manifest' : src === 'registry' ? 'set' : src === 'discovered' ? 'auto' : '';
  } catch { return ''; }
}

function smokeOf(b: Build): { glyph: string; cls: string; title: string } | null {
  if (b.status !== 'passed' || !b.artifactPath) return null; // only passed builds are probed
  if (b.smoke === 'ok') return { glyph: '✓⌁', cls: 'smoke-ok', title: 'smoke: app installed, launched, stayed alive' };
  if (b.smoke === 'crash') return { glyph: '⌁✕', cls: 'smoke-crash', title: 'smoke: app died on launch' };
  if (b.smoke === 'skipped') return { glyph: '⌁–', cls: 'smoke-skip', title: 'smoke probe skipped (no simulator)' };
  return null;
}

function canTest(b: Build): boolean {
  // two-verdicts rule: only launch-verified artifacts are testable (Q3 edge)
  return b.status === 'passed' && b.smoke === 'ok' && !!b.artifactPath;
}
</script>

<template>
  <div>
    <PageHeader title="builds">
      <span class="ph-desc">ci — simulator packages built from the repos workspace · admin only</span>
      <template #actions>
        <button class="btn btn-primary" @click="pickOpen = true">▶ build…</button>
      </template>
    </PageHeader>

    <div v-if="error" class="b-err">{{ error }}</div>
    <div v-if="!loaded && !error" class="b-empty">loading…</div>

    <div v-if="loaded" class="b-list a2-list">
      <div class="b-thead">
        <span>#</span><span>status</span><span>project</span><span>transport</span><span>duration</span><span>when</span><span>artifact</span><span></span>
      </div>
      <template v-for="b in builds" :key="b.id">
        <div class="b-row" @click="toggleLog(b.id)" :title="openId === b.id ? 'click to collapse console' : 'click for console'">
          <span class="b-num">#{{ b.number }}</span>
          <span class="b-status"><span class="ball" :class="ball(b).cls">{{ ball(b).glyph }}</span> <span class="b-meta">{{ ball(b).label }}</span><span v-if="smokeOf(b)" class="smoke" :class="smokeOf(b)!.cls" :title="smokeOf(b)!.title">{{ smokeOf(b)!.glyph }}</span></span>
          <span class="b-proj">{{ b.projectName }} <span v-if="b.scheme" class="b-meta">· {{ b.scheme }}</span><span v-if="b.configuration" class="b-meta"> · {{ b.configuration }}</span></span>
          <span class="b-src"><span class="b-chip">{{ b.transport }}</span> <span v-if="provOf(b)" class="b-chip b-chip-src" :title="`inputs: ${b.resolution ?? ''}`">{{ provOf(b) }}</span></span>
          <span class="b-meta">{{ b.status === 'running' ? '…' : '' }}{{ durOf(b) }}</span>
          <span class="b-meta">{{ hhmm(b.startedAt) }}</span>
          <span class="b-meta b-art" :title="b.artifactPath ?? b.error ?? ''">
            <template v-if="b.artifactPath">{{ b.artifactPath.split('/').pop() }}</template>
            <template v-else-if="b.error">✕ {{ b.error.slice(0, 60) }}{{ b.error.length > 60 ? '…' : '' }}</template>
            <template v-else>—</template>
          </span>
          <span class="b-actions">
            <span v-if="b.suite" class="suite-chip" :class="{ bad: b.suite.failed > 0, run: b.suite.running > 0 }" :title="(b.suite.failedNames ?? []).join('\n') || `suite: ${b.suite.passed}/${b.suite.total} passed`">
              {{ b.suite.running > 0 ? `⏳ ${b.suite.passed}/${b.suite.total}` : `${b.suite.passed}/${b.suite.total}` }}
            </span>
            <button v-if="canTest(b)" class="btn btn-ghost b-test" title="install this build and run a suite against it" @click.stop="openTest(b)">▶ test</button>
            <span class="b-meta" style="cursor:pointer;">▤</span>
          </span>
        </div>
        <div v-if="openId === b.id" class="b-console">
          <pre class="b-log">{{ logText || '…' }}</pre>
        </div>
      </template>
      <div v-if="builds.length === 0" class="b-empty">no builds yet — ▶ build… starts one from a cloned project</div>
    </div>

    <!-- ▶ build… picker: step 1 project, step 2 build inputs -->
    <div v-if="pickOpen" class="pk-backdrop" @click.self="closePicker">
      <div class="pk-modal">
        <div class="pk-head">
          <span class="pk-title">{{ pickProject ? `build · ${pickProject.name}` : 'build project' }}</span>
          <button class="pk-x" @click="closePicker">✕</button>
        </div>
        <!-- step 1: choose project -->
        <div v-if="!pickProject" class="pk-body">
          <div v-if="projects.length === 0" class="b-empty">no projects — register one on the projects page first</div>
          <div v-for="p in projects" :key="p.id" class="pk-row" @click="chooseProject(p)">
            <span>{{ p.name }}</span>
            <span class="b-meta">▶</span>
          </div>
        </div>
        <!-- step 2: build inputs -->
        <div v-else class="pk-body">
          <div v-if="inputsErr" class="pk-err">{{ inputsErr }}</div>
          <div v-else-if="!inputs" class="b-empty">loading build inputs…</div>
          <template v-else>
            <div v-if="inputs.manifestError" class="pk-err" :title="inputs.manifestError">⚠ manifest: {{ inputs.manifestError.slice(0, 80) }}{{ inputs.manifestError.length > 80 ? '…' : '' }}</div>
            <div class="pk-field">
              <label class="pk-label">scheme <span v-if="provChip(inputs.effective.schemeResolution)" class="b-chip">{{ provChip(inputs.effective.schemeResolution) }}</span></label>
              <select v-model="selScheme" class="pk-select" :disabled="!!inputs.manifest?.scheme">
                <option value="" disabled>{{ inputs.appSchemes.length ? 'choose scheme…' : 'none discovered' }}</option>
                <option v-for="s in inputs.appSchemes" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>
            <div class="pk-field">
              <label class="pk-label">configuration <span v-if="provChip(inputs.effective.configurationResolution)" class="b-chip">{{ provChip(inputs.effective.configurationResolution) }}</span></label>
              <select v-model="selConfig" class="pk-select" :disabled="!!inputs.manifest?.configuration">
                <option value="" disabled>choose config…</option>
                <option v-for="c in inputs.configurations" :key="c" :value="c">{{ c }}</option>
              </select>
            </div>
            <div v-if="inputs.manifest" class="pk-note">🔒 lionidas.yml pins these — edit the file in the repo to change</div>
            <label class="pk-remember"><input v-model="remember" type="checkbox"> remember on this project (pins in registry)</label>
            <button class="btn btn-primary pk-start" :disabled="!selScheme || starting" @click="startPicked">{{ starting ? 'starting…' : '▶ build' }}</button>
          </template>
        </div>
      </div>
    </div>
    <!-- ▶ test modal (Phase 1 build→test): suite + device pickers -->
    <div v-if="testOpen" class="pk-backdrop" @click.self="testOpen = false">
      <div class="pk-modal">
        <div class="pk-head">
          <span class="pk-title">test · build #{{ testBuild?.number }} {{ testBuild?.projectName }}</span>
          <button class="pk-x" @click="testOpen = false">✕</button>
        </div>
        <div class="pk-body">
          <div class="pk-field">
            <label class="pk-label">suite</label>
            <select v-model="testSuiteId" class="pk-select">
              <option value="" disabled>{{ suites.length ? 'choose suite…' : 'no suites — record cases first' }}</option>
              <option v-for="s in suites" :key="s.id" :value="s.id">{{ s.name }}{{ s.appBundleId ? ` · ${s.appBundleId}` : '' }}</option>
            </select>
          </div>
          <div class="pk-field">
            <label class="pk-label">device — booted sims (the build installs first)</label>
            <select v-model="testUdid" class="pk-select">
              <option value="" disabled>{{ devices.length ? 'choose device…' : 'no booted simulator' }}</option>
              <option v-for="d in devices" :key="d.udid" :value="d.udid">{{ d.name ?? d.udid }}</option>
            </select>
          </div>
          <div v-if="error" class="pk-err">{{ error }}</div>
          <button class="btn btn-primary pk-start" :disabled="!testSuiteId || !testUdid || testing" @click="runTest">{{ testing ? 'starting…' : '▶ test' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.b-list { background: var(--color-carbon); border: 1px solid var(--color-iron); }
.b-thead, .b-row { display: grid; grid-template-columns: 56px 110px minmax(0, 1.4fr) 92px 82px 96px minmax(0, 1fr) 28px; gap: var(--s-3); align-items: center; padding: 0 var(--s-4); }
.b-thead { position: sticky; top: 0; z-index: 2; background: var(--color-carbon); min-height: 34px; border-bottom: 1px solid var(--color-iron); font-size: var(--text-caption); text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-steel); }
.b-row { min-height: 40px; border-bottom: 1px solid var(--color-iron); font-size: var(--text-label); color: var(--color-fog); cursor: pointer; }
.b-row:hover { background: var(--color-graphite); }
.b-num { color: var(--color-steel); }
.b-status { display: flex; align-items: center; gap: 6px; }
.ball { font-size: 13px; display: inline-block; }
.ball.pass { color: var(--color-ember); }
.ball.fail { color: var(--color-paper); }
.ball.run { color: var(--color-ash); animation: spin 1.2s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.b-proj { color: var(--color-paper); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.b-meta { color: var(--color-ash); font-size: var(--text-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.b-chip { font-size: 10px; padding: 1px 5px; border: 1px solid var(--color-iron); color: var(--color-ash); text-transform: uppercase; }
.b-console { background: var(--color-graphite); border-bottom: 1px solid var(--color-iron); padding: var(--s-3) var(--s-4); }
.b-log { font-family: var(--font-mono); font-size: 12px; line-height: 1.6; color: var(--color-fog); max-height: 320px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; margin: 0; }
.b-empty { padding: var(--s-5); color: var(--color-ash); font-size: var(--text-label); }
.b-err { color: var(--color-ember); font-size: var(--text-label); margin-bottom: var(--s-3); }
.pk-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.72); display: flex; align-items: center; justify-content: center; z-index: 90; }
.pk-modal { width: 380px; background: var(--color-graphite); border: 1px solid var(--color-iron); }
.pk-head { display: flex; align-items: center; padding: var(--s-4) var(--s-5); border-bottom: 1px solid var(--color-iron); }
.pk-title { font-size: var(--text-heading-sm); color: var(--color-paper); }
.pk-x { margin-left: auto; background: none; border: none; color: var(--color-steel); cursor: pointer; font-size: 15px; }
.pk-row { display: flex; justify-content: space-between; align-items: center; padding: var(--s-3) var(--s-5); font-size: var(--text-label); color: var(--color-fog); cursor: pointer; border-bottom: 1px solid var(--color-iron); }
.pk-row:hover { background: var(--color-carbon); color: var(--color-paper); }
.pk-field { padding: var(--s-3) var(--s-5); }
.pk-label { display: flex; align-items: center; gap: var(--s-2); font-size: var(--text-caption); text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-steel); margin-bottom: var(--s-2); }
.pk-select { width: 100%; font-family: var(--font-mono); font-size: var(--text-label); color: var(--color-paper); background: var(--color-carbon); border: 1px solid var(--color-iron); padding: var(--s-2) var(--s-3); }
.pk-select:disabled { opacity: 0.6; cursor: not-allowed; }
.pk-note { padding: 0 var(--s-5) var(--s-2); font-size: var(--text-caption); color: var(--color-ash); }
.pk-remember { display: flex; align-items: center; gap: var(--s-2); padding: var(--s-2) var(--s-5); font-size: var(--text-caption); color: var(--color-fog); cursor: pointer; }
.pk-start { margin: var(--s-3) var(--s-5) var(--s-4); }
.pk-err { padding: var(--s-3) var(--s-5); color: var(--color-ember); font-size: var(--text-caption); }
.b-src { display: flex; gap: 4px; align-items: center; }
.b-chip-src { color: var(--color-fog); }
.smoke { font-size: 11px; margin-left: 4px; }
.smoke-ok { color: var(--color-ember); }
.smoke-crash { color: var(--color-paper); font-weight: bold; }
.smoke-skip { color: var(--color-steel); }
.b-actions { display: flex; gap: 6px; align-items: center; justify-content: flex-end; }
.suite-chip { font-size: 11px; padding: 1px 6px; border: 1px solid var(--color-iron); color: var(--color-ember); white-space: nowrap; }
.suite-chip.bad { color: var(--color-paper); border-color: var(--color-paper); }
.suite-chip.run { color: var(--color-ash); }
.b-test { font-size: 11px; padding: 2px 8px; }
</style>
