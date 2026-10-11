<script setup lang="ts">
/** Composer rev23 (refs plan F1): command chip + @-mention ref system.
 *  Slash commands (rev21/22) unchanged. Refs are creatable ONLY through the
 *  @ pickers — the free-typed kind+locator form is gone. Selected refs render
 *  as capsule chips in the input line; send maps them to PipelineRef[]. */
import { ref, computed, watch, nextTick } from 'vue';

export interface Ref { kind: 'jira' | 'github-pr' | 'github-commit' | 'doc' | 'repo' | 'attachment'; locator: string; label?: string }

const props = defineProps<{ busy?: boolean }>();
const emit = defineEmits<{ send: [text: string, refs: Ref[], appBundle: string]; abort: []; skill: [command: string, ask: string]; 'open-attachment': [] }>();

const text = ref('');
/** rev22b: the ACTIVE command chip — a registered command the user committed
 *  (typed + space, or picked from the menu). It renders INSIDE the input as a
 *  token, distinct from the prompt text that follows. Unknown /text never
 *  becomes a chip — it stays ordinary text. */
const activeCmd = ref<string | null>(null);
/** suppresses token→chip promotion while reverting a chip back to text */
let reverting = false;

watch(text, () => {
  menuDismissed.value = false;
  if (!text.value.startsWith('/')) activeIdx.value = 0;
  // token → chip: '/planning ' becomes the chip, the rest is the prompt
  if (!reverting && !activeCmd.value) {
    const m = /^(\/\S+)(\s+.*|\s+)$/s.exec(text.value);
    if (m && REGISTERED(m[1] ?? '')) {
      activeCmd.value = m[1] ?? null;
      text.value = text.value.slice((m[1] ?? '').length).replace(/^\s+/, '');
    }
  }
});

/** chip → text token (✕ or Backspace on empty): lets the user edit the command */
function revertChip(): void {
  if (!activeCmd.value) return;
  const cmd = activeCmd.value;
  reverting = true;
  activeCmd.value = null;
  text.value = `${cmd} `;
  void nextTick(() => { reverting = false; });
  void nextTick(() => {
    const el = document.querySelector('.composer textarea') as HTMLTextAreaElement | null;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  });
}

const refs = ref<Ref[]>([]);
const appBundle = ref('');
const REF_CAP = 8;

const ready = computed(() => text.value.trim().length > 0 && !props.busy);
const willRun = computed(() => refs.value.length > 0);

/** repo-derived bundle candidates — chipping an @repo ref narrows the app */
async function repoAppsChipped(project: string): Promise<void> {
  try {
    const r = await fetch(`/api/agent/refs/repos/${encodeURIComponent(project)}/apps`);
    const b = (await r.json()) as { bundles?: string[] };
    repoBundles.value = b.bundles ?? [];
    autoSelectBundle();
  } catch { repoBundles.value = []; }
}

/** auto-select: user choice wins; else repo top pick; else single registered app */
function autoSelectBundle(): void {
  if (userPickedBundle.value) return; // explicit override sticks
  const candidates = [...new Set([...repoBundles.value, ...bundles.value])];
  if (candidates.length === 1) { appBundle.value = candidates[0]!; return; }
  if (repoBundles.value.length) appBundle.value = repoBundles.value[0]!; // repo's main app
  else if (bundles.value.length === 1) appBundle.value = bundles.value[0]!;
}

/** dropdown options: registry apps + repo-detected ids (repo's first when narrowed) */
const bundleOptions = computed(() => [...new Set([...repoBundles.value, ...bundles.value])]);

/** known app bundles — fetched lazily the first time refs attach */
const bundles = ref<string[]>([]);
const repoBundles = ref<string[]>([]);
const userPickedBundle = ref(false);
let bundlesFetched = false;
async function fetchBundles(): Promise<void> {
  if (bundlesFetched) return;
  bundlesFetched = true;
  try {
    const r = await fetch('/api/apps/bundles');
    const b = (await r.json()) as { bundles?: string[] };
    bundles.value = b.bundles ?? [];
  } catch { bundles.value = []; }
}
watch(willRun, (on) => { if (on) { void fetchBundles().then(() => autoSelectBundle()); } });

/** session switch: the composer is per-conversation — chips/bundle never leak across chats */
function resetDraft(): void {
  refs.value = [];
  activeCmd.value = null;
  text.value = '';
  appBundle.value = '';
  repoBundles.value = [];
  userPickedBundle.value = false;
  closeAt();
}
defineExpose({ addAttachmentChip, resetDraft });

function removeRef(i: number): void { refs.value = refs.value.filter((_, idx) => idx !== i); }

/** ── rev21: slash command menu ─────────────────────────────────────────── */
const SKILLS: Array<{ cmd: string; desc: string }> = [
  { cmd: '/planning', desc: 'Plan test cases from a request' },
  { cmd: '/breakdown', desc: 'Break a plan into concrete steps' },
  { cmd: '/author', desc: 'Author case YAML drafts' },
];
const REGISTERED = (c: string): boolean => SKILLS.some((s) => s.cmd === c);

const menuDismissed = ref(false);
const activeIdx = ref(0);

const skillMatches = computed(() => {
  const t = text.value.trim();
  if (!t.startsWith('/')) return [];
  return SKILLS.filter((s) => s.cmd.startsWith(t));
});

/** open only while the token could STILL become a REGISTERED command */
const menuOpen = computed(() => {
  const t = text.value;
  return t.startsWith('/') && !t.includes(' ') && !menuDismissed.value && skillMatches.value.length > 0;
});

/** accept the selected command: commit the chip, close the menu */
function acceptSkill(idx?: number): void {
  const pick = skillMatches.value[idx ?? activeIdx.value];
  if (!pick) return;
  activeCmd.value = pick.cmd;
  text.value = '';
  activeIdx.value = 0;
  menuDismissed.value = false;
  focusTA();
}

function focusTA(): void {
  void nextTick(() => {
    const el = document.querySelector('.composer textarea') as HTMLTextAreaElement | null;
    el?.focus();
    el?.setSelectionRange(el?.value.length ?? 0, el?.value.length ?? 0);
  });
}

/** ── rev23 (F1): @-mention ref pickers ───────────────────────────────────
 *  Levels: family (@jira/@repo/@attachment) → family-specific picker.
 *  F1 wires the full menu/chip state machine with STUB level-2 data; F2–F4
 *  replace the stubs with live fetches. */
type AtLevel = 'closed' | 'family' | 'jira' | 'repo' | 'repo-pick' | 'attachment';
const at = ref<AtLevel>('closed');
const atQuery = ref('');
const atIdx = ref(0);
/** repo two-level state */
const repoPick = ref<{ project: string; segment: 'commits' | 'pulls'; branch: string } | null>(null);
/** multi-select session: (kind, locator) pairs chipped during THIS open menu */
const pickedKeys = ref<Set<string>>(new Set());

const FAMILIES: Array<{ key: string; desc: string }> = [
  { key: '@jira', desc: 'Search a Jira ticket (epic/story/subtask)' },
  { key: '@repo', desc: 'Pick a repo, then commits or PRs' },
  { key: '@attachment', desc: 'Attach a file' },
];

/** typing in the jira level routes into the debounced search */
watch(atQuery, (q) => { if (at.value === 'jira') jiraQueryChanged(q.replace(/^@jira?/, '').trim()); });

function familyMatches(): Array<{ key: string; desc: string }> {
  const q = atQuery.value.trim();
  if (!q) return FAMILIES;
  return FAMILIES.filter((f) => f.key.startsWith(q));
}

/** rev23 F3: live jira search — debounced 300ms; honest states surface as rows */
interface JiraRow { key: string; title: string; type: string }
const jiraRows = ref<JiraRow[]>([]);
const jiraState = ref<'idle' | 'loading' | 'error' | 'unconfigured'>('idle');
let jiraTimer: ReturnType<typeof setTimeout> | undefined;

async function fetchJira(q: string): Promise<void> {
  jiraState.value = 'loading';
  try {
    const r = await fetch(`/api/agent/refs/jira?q=${encodeURIComponent(q)}`);
    const b = (await r.json()) as { configured?: boolean; issues?: JiraRow[]; reason?: string; error?: string };
    if (b.configured === false) { jiraState.value = 'unconfigured'; jiraRows.value = []; return; }
    if (b.error) { jiraState.value = 'error'; jiraRows.value = []; return; }
    jiraState.value = 'idle';
    jiraRows.value = b.issues ?? [];
  } catch {
    jiraState.value = 'error';
    jiraRows.value = [];
  }
}

function jiraQueryChanged(q: string): void {
  if (jiraTimer) clearTimeout(jiraTimer);
  if (!q.trim()) { jiraRows.value = []; jiraState.value = 'idle'; return; }
  jiraTimer = setTimeout(() => { void fetchJira(q); }, 300);
}
/** rev23 F4: live repo data — repos, branches (searchable), commits/PRs per segment */
const repoList = ref<string[]>([]);
const repoBranches = ref<Array<{ name: string; lastCommit: string }>>([]);
const repoRows = ref<Array<{ id: string; title: string; meta: string; sub?: string }>>([]);
const repoState = ref<'idle' | 'loading' | 'error'>('idle');
const repoErrMsg = ref('');
const branchQuery = ref('');
let repoTimer: ReturnType<typeof setTimeout> | undefined;

async function fetchRepos(): Promise<void> {
  repoState.value = 'loading';
  try {
    const r = await fetch('/api/agent/refs/repos');
    const b = (await r.json()) as { repos?: string[] };
    repoList.value = b.repos ?? [];
    repoState.value = 'idle';
  } catch { repoState.value = 'error'; repoErrMsg.value = 'repo list unreachable'; }
}

async function fetchBranches(project: string, q: string): Promise<void> {
  try {
    const r = await fetch(`/api/agent/refs/repos/${encodeURIComponent(project)}/branches${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    const b = (await r.json()) as { branches?: Array<{ name: string; lastCommit: string }>; error?: string };
    repoBranches.value = b.error ? [] : (b.branches ?? []);
  } catch { repoBranches.value = []; }
}

async function fetchRepoRows(project: string, segment: 'commits' | 'pulls', branch: string): Promise<void> {
  repoState.value = 'loading';
  try {
    const ep = segment === 'pulls' ? 'pulls' : `commits${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`;
    const r = await fetch(`/api/agent/refs/repos/${encodeURIComponent(project)}/${ep}`);
    const b = (await r.json()) as { rows?: Array<{ id: string; title: string; meta: string; sub?: string }>; error?: string };
    if (b.error) { repoState.value = 'error'; repoErrMsg.value = b.error; repoRows.value = []; return; }
    repoRows.value = b.rows ?? [];
    repoState.value = 'idle';
  } catch { repoState.value = 'error'; repoErrMsg.value = 'repo fetch failed'; }
}

function branchQueryChanged(project: string): void {
  if (repoTimer) clearTimeout(repoTimer);
  repoTimer = setTimeout(() => { void fetchBranches(project, branchQuery.value.trim()); }, 300);
}

/** unified row model for the current at-level */
interface AtRow { id: string; title: string; meta: string; sub?: string; locked?: boolean }
const atRows = computed<Array<AtRow>>(() => {
  if (at.value === 'family') return familyMatches().map((f) => ({ id: f.key, title: f.key, meta: f.desc }));
  if (at.value === 'jira') {
    if (jiraState.value === 'unconfigured') return [{ id: '__unconfigured', title: '@jira', meta: 'Jira not configured — set JIRA_TOKEN and JIRA_BASE_URL on the server', locked: true }];
    if (jiraState.value === 'error') return [{ id: '__error', title: '@jira', meta: 'Jira search failed — check the server logs / token', locked: true }];
    if (jiraState.value === 'loading') return [{ id: '__loading', title: '@jira', meta: 'searching…', locked: true }];
    return jiraRows.value.map((i) => ({ id: i.key, title: i.key, meta: `${i.type} · ${i.title}` }));
  }
  if (at.value === 'repo') {
    const q = atQuery.value.trim().toLowerCase();
    return repoList.value.filter((r) => r.toLowerCase().includes(q)).map((r) => ({ id: r, title: r, meta: 'registered repo' }));
  }
  if (at.value === 'repo-pick') {
    if (repoState.value === 'loading') return [{ id: '__loading', title: '@repo', meta: 'loading…', locked: true }];
    if (repoState.value === 'error') return [{ id: '__error', title: '@repo', meta: repoErrMsg.value || 'repo fetch failed', locked: true }];
    const q = atQuery.value.trim().toLowerCase();
    return repoRows.value
      .filter((r) => !q || r.id.toLowerCase().includes(q) || (r.sub ?? '').toLowerCase().includes(q))
      .map((r) => ({ id: r.id, title: r.id, meta: r.meta, sub: r.sub }));
  }
  return [];
});

const atMenuOpen = computed(() => at.value !== 'closed' && atRows.value.length > 0);

/** family → picker routing */
function openFamilyPick(fam: string): void {
  atQuery.value = '';
  atIdx.value = 0;
  pickedKeys.value = new Set();
  if (fam === '@jira') { at.value = 'jira'; atQuery.value = ''; }
  else if (fam === '@repo') { at.value = 'repo'; void fetchRepos(); }
  else if (fam === '@attachment') { at.value = 'closed'; emit('open-attachment'); return; }
  else at.value = 'closed';
}

/** commit a row: family level advances; jira/repo-pick rows CHIP (multi-select stays open) */
function acceptAt(idx?: number): void {
  const row = atRows.value[idx ?? atIdx.value];
  if (!row || row.locked) return;
  if (at.value === 'family') {
    openFamilyPick(row.id);
    return;
  }
  if (at.value === 'repo') {
    repoPick.value = { project: row.id, segment: 'commits', branch: '' };
    atQuery.value = '';
    void fetchRepoRows(row.id, 'commits', '');
    void fetchBranches(row.id, '');
    at.value = 'repo-pick';
    atQuery.value = '';
    atIdx.value = 0;
    return;
  }
  if (at.value === 'jira' || at.value === 'repo-pick') {
    const kind: Ref['kind'] = at.value === 'jira' ? 'jira' : (repoPick.value?.segment === 'pulls' ? 'github-pr' : 'github-commit');
    const locator = at.value === 'jira' ? row.id : `${repoPick.value?.project ?? ''}/${row.id}`;
    const wasRepo = kind !== 'jira';
    addRefChip(kind, locator, row.title);
    if (wasRepo && repoPick.value) void repoAppsChipped(repoPick.value.project);
    return; // multi-select: menu STAYS open
  }
}

/** rev23 F2: parent (page) chips a just-uploaded attachment — single-select by design */
function addAttachmentChip(id: string, fileName: string): void {
  addRefChip('attachment', id, fileName);
  closeAt();
}
/** commit a ref chip (dedup + cap) */
function addRefChip(kind: Ref['kind'], locator: string, label?: string): void {
  if (refs.value.length >= REF_CAP) return; // cap blocks gracefully (footer shows n/8)
  if (refs.value.some((r) => r.kind === kind && r.locator === locator)) return; // dedup
  refs.value = [...refs.value, { kind, locator, ...(label ? { label } : {}) }];
  pickedKeys.value.add(`${kind}:${locator}`);
}

function setBranch(name: string): void {
  if (!repoPick.value) return;
  repoPick.value = { ...repoPick.value, branch: repoPick.value.branch === name ? '' : name };
  void fetchRepoRows(repoPick.value.project, repoPick.value.segment, repoPick.value.branch);
}
function setSegment(seg: 'commits' | 'pulls'): void {
  if (!repoPick.value || repoPick.value.segment === seg) return;
  repoPick.value = { ...repoPick.value, segment: seg, branch: seg === 'pulls' ? '' : repoPick.value.branch };
  atQuery.value = '';
  void fetchRepoRows(repoPick.value.project, seg, seg === 'commits' ? repoPick.value.branch : '');
}

function closeAt(): void { at.value = 'closed'; atQuery.value = ''; }

function isPicked(row: AtRow): boolean {
  if (at.value === 'jira') return pickedKeys.value.has(`jira:${row.id}`);
  if (at.value === 'repo-pick') {
    const kind = repoPick.value?.segment === 'pulls' ? 'github-pr' : 'github-commit';
    return pickedKeys.value.has(`${kind}:${repoPick.value?.project ?? ''}/${row.id}`);
  }
  return false;
}

/** @ token detection: opens the family menu while the token is still a bare '@…' */
watch(text, (t) => {
  if (reverting) return;
  if (at.value === 'closed' && t.startsWith('@') && !t.includes(' ')) {
    at.value = 'family';
    atQuery.value = t;
    atIdx.value = 0;
  } else if (at.value !== 'closed' && t.startsWith('@') && !t.includes(' ')) {
    atQuery.value = t;
  } else if (at.value !== 'closed' && !t.startsWith('@')) {
    // past the family token: the user is now SEARCHING (jira) or filtering (repo rows)
    atQuery.value = t;
  }
});

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Backspace' && activeCmd.value && text.value === '') { e.preventDefault(); revertChip(); return; }
  if (e.key === 'Backspace' && !activeCmd.value && text.value === '' && refs.value.length) { e.preventDefault(); refs.value = refs.value.slice(0, -1); return; }
  if (atMenuOpen.value) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      atIdx.value = e.key === 'ArrowDown'
        ? (atIdx.value + 1) % atRows.value.length
        : (atIdx.value - 1 + atRows.value.length) % atRows.value.length;
      void nextTick(() => document.querySelector('.slash-row.active')?.scrollIntoView({ block: 'nearest' }));
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAt(); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeAt(); text.value = ''; return; }
  } else if (menuOpen.value) {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx.value = (activeIdx.value + 1) % skillMatches.value.length; return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx.value = (activeIdx.value - 1 + skillMatches.value.length) % skillMatches.value.length; return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptSkill(); return; }
    if (e.key === 'Escape') { e.preventDefault(); menuDismissed.value = true; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
}

function submit(): void {
  if (!ready.value) return;
  const t = text.value.trim();
  if (activeCmd.value) {
    emit('skill', activeCmd.value, t);
    text.value = ''; refs.value = []; activeCmd.value = null;
    return;
  }
  const [first] = t.split(/\s+/);
  if (first && REGISTERED(first)) {
    emit('skill', first, t.slice(first.length).trim());
    text.value = ''; refs.value = [];
    return;
  }
  emit('send', t, refs.value.map((r) => ({ ...r })), (appBundle.value ?? '').trim());
  text.value = ''; refs.value = [];
  closeAt();
}
</script>

<template>
  <div class="wrap">
    <div class="composer">
      <!-- @-mention menu (rev23 F1): family → picker; multi-select for jira/repo-pick -->
      <div v-if="atMenuOpen" class="slash-menu has-rows">
        <div class="at-head">
          <span v-if="at === 'jira'" class="at-title">@jira — search tickets <span class="at-count">{{ pickedKeys.size }} selected</span></span>
          <span v-else-if="at === 'repo'" class="at-title">@repo — pick a repository</span>
          <span v-else-if="at === 'repo-pick'" class="at-title">@repo:{{ repoPick?.project }} — <button class="seg" :class="{ on: repoPick?.segment === 'commits' }" @click="setSegment('commits')">commits</button> <button class="seg" :class="{ on: repoPick?.segment === 'pulls' }" @click="setSegment('pulls')">PRs</button> <span class="at-count">{{ pickedKeys.size }} selected · {{ refs.length }}/{{ REF_CAP }} refs</span></span>
          <span v-else class="at-title">mention a reference</span>
          <button class="at-done" title="done selecting (Esc)">done ✕</button>
        </div>
        <div class="menu-rows">
          <div v-for="(row, i) in atRows" :key="row.id" class="slash-row" :class="{ active: i === atIdx, picked: isPicked(row) }" @mousedown.prevent="acceptAt(i)" @mousemove="atIdx = i">
            <span class="slash-ico">{{ isPicked(row) ? '✓' : '◈' }}</span>
            <span class="slash-name">{{ row.title }}</span>
            <span class="slash-desc">{{ row.meta }}</span>
            <span v-if="row.sub" class="slash-sub">{{ row.sub }}</span>
          </div>
        </div>
        <div v-if="at === 'jira'" class="at-foot">type to search · Enter selects and stays open · Esc done</div>
        <div v-else-if="at === 'repo-pick' && repoPick?.segment === 'commits'" class="branch-strip">
          <span class="branch-label">branch:</span>
          <button v-for="b in repoBranches" :key="b.name" class="seg branch" :class="{ on: repoPick?.branch === b.name }" :title="b.lastCommit" @click="setBranch(b.name)">{{ b.name }}</button>
          <input v-model="branchQuery" class="branch-search" placeholder="search branches…" @input="repoPick && branchQueryChanged(repoPick.project)">
        </div>
        <div v-if="at === 'repo-pick'" class="at-foot">branch scope: {{ repoPick?.branch || 'default' }} — the SHA pins content regardless of branch</div>
      </div>

      <!-- slash menu (rev21) -->
      <div v-if="menuOpen" class="slash-menu">
        <div v-for="(s, i) in skillMatches" :key="s.cmd" class="slash-row" :class="{ active: i === activeIdx }" @mousedown.prevent="acceptSkill(i)" @mousemove="activeIdx = i">
          <span class="slash-ico">◈</span>
          <span class="slash-name">{{ s.cmd }}</span>
          <span class="slash-desc">{{ s.desc }}</span>
        </div>
      </div>

      <!-- ref capsule chips -->
      <div v-if="refs.length" class="chips">
        <span v-for="(r, i) in refs" :key="r.kind + r.locator" class="chip ref-chip" :class="{ jira: r.kind === 'jira' }" @click="removeRef(i)">
          <span class="ref-kind">@{{ r.kind === 'github-pr' || r.kind === 'github-commit' ? 'repo' : r.kind }}</span><span class="ref-name">{{ r.kind === 'attachment' ? (r.label ?? r.locator) : r.locator }}</span> ✕
        </span>
      </div>

      <div class="input-line">
        <span v-if="activeCmd" class="cmd-chip">{{ activeCmd }}<button class="chip-x" title="remove command" @mousedown.prevent.stop @click="revertChip">✕</button></span>
        <textarea v-model="text" :placeholder="activeCmd ? 'your prompt for this command…' : (at !== 'closed' ? 'search…' : 'message butler…')" @keydown="onKey"></textarea>
      </div>
      <div class="row">
        <button class="icon" title="mention a reference (@jira / @repo / @attachment)" @click="at = 'family'; atQuery = '@'; text = '@'">＋ @</button>
        <select v-if="willRun" v-model="appBundle" class="bundle" title="target app for the run — auto-selected from your @repo ref; change it here" @change="userPickedBundle = true">
          <option value="" disabled>select app…</option>
          <option v-for="b in bundleOptions" :key="b" :value="b">{{ b }}</option>
        </select>
        <span class="hint">{{ willRun ? 'refs attached — sending starts the author pipeline' : '@ for refs · / for commands · enter to send' }}</span>
        <button v-if="!busy" class="send" :class="{ ready }" :disabled="!ready" @click="submit">send</button>
        <button v-else class="send stop" @click="emit('abort')">stop</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap { position: sticky; bottom: 0; margin: 0 0 var(--s-3); background: var(--ag-bg); }
.input-line { display: flex; align-items: flex-start; gap: 8px; }
.input-line textarea { flex: 1; }
.cmd-chip { display: inline-flex; align-items: center; gap: 6px; margin-top: 3px; color: var(--color-ember); border: 1px solid var(--color-ember-dim); background: var(--ag-panel); border-radius: 999px; padding: 2px 6px 2px 12px; font-size: var(--text-caption); font-weight: var(--weight-bold); flex: none; }
.chip-x { border: none; background: none; color: var(--color-steel); cursor: pointer; font-size: 10px; padding: 2px 4px; border-radius: 50%; }
.chip-x:hover { color: var(--color-paper); background: var(--ag-surface); }
.slash-menu { position: absolute; bottom: calc(100% + 8px); left: 0; right: 0; background: var(--ag-surface); border: 1px solid var(--ag-line-2); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.5); padding: 4px; z-index: 30; max-height: 340px; overflow-y: auto; }
.slash-menu.has-rows { display: flex; flex-direction: column; overflow: hidden; }
.menu-rows { overflow-y: auto; min-height: 0; flex: 1; }
.slash-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
.slash-row.active { background: var(--ag-panel); }
.slash-row.picked { opacity: .55; }
.slash-row.picked .slash-ico { color: var(--color-fog); }
.slash-ico { color: var(--color-ember); flex: none; font-size: 12px; }
.slash-name { color: var(--color-paper); font-weight: var(--weight-bold); flex: none; }
.slash-desc { color: var(--color-steel); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slash-sub { color: var(--color-fog); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; text-align: right; }
.at-head { display: flex; align-items: center; gap: 8px; padding: 4px 10px 8px; border-bottom: 1px solid var(--ag-line); margin-bottom: 4px; }
.at-title { font-size: 11px; color: var(--color-steel); flex: 1; }
.at-count { color: var(--color-ember); }
.at-done { border: none; background: none; color: var(--color-steel); cursor: pointer; font-size: 11px; }
.at-done:hover { color: var(--color-paper); }
.at-foot { font-size: 10px; color: var(--color-steel); padding: 6px 10px 4px; border-top: 1px solid var(--ag-line); margin-top: 4px; }
.seg { border: 1px solid var(--ag-line-2); background: none; color: var(--color-steel); border-radius: 4px; font-size: 10px; padding: 1px 8px; cursor: pointer; }
.seg.on { color: var(--color-ember); border-color: var(--color-ember-dim); }
.branch-strip { display: flex; align-items: center; gap: 6px; padding: 4px 10px 8px; flex-wrap: wrap; border-bottom: 1px solid var(--ag-line); margin-bottom: 4px; }
.branch-label { font-size: 10px; color: var(--color-steel); }
.seg.branch { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.branch-search { background: var(--ag-panel); border: 1px solid var(--ag-line); border-radius: 6px; outline: none; color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 4px 10px; width: 260px; margin-left: auto; }
.composer { position: relative; pointer-events: auto; width: calc(100% - 2 * var(--s-4)); max-width: 720px; margin: 0 auto; border: 1px solid var(--ag-line-2); border-radius: var(--r-sm); padding: var(--s-2) var(--s-3); background: var(--ag-surface); }
.composer:focus-within { border-color: var(--color-ember-dim); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: var(--s-2); align-items: center; }
.chip { border: 1px solid var(--ag-line); border-radius: 999px; padding: 1px var(--s-2); font-size: var(--text-caption); color: var(--color-fog); background: var(--ag-panel); cursor: pointer; font-family: var(--font-mono); max-width: 280px; display: inline-flex; align-items: center; gap: 4px; }
.ref-kind { color: var(--color-ember); flex: none; }
.ref-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.jira { color: var(--color-ember); border-color: var(--color-ember-dim); }
.chip:hover { background: var(--color-graphite); }
textarea { width: 100%; background: none; border: none; outline: none; color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-body); resize: none; min-height: 30px; }
.row { display: flex; align-items: center; gap: var(--s-2); margin-top: 6px; }
.icon { min-height: 24px; padding: 2px var(--s-2); border: 1px solid var(--ag-line-2); border-radius: var(--r-sm); background: var(--ag-surface); color: var(--color-fog); cursor: pointer; font-size: var(--text-caption); font-family: var(--font-mono); }
.icon:hover { background: var(--color-graphite); color: var(--color-paper); }
.bundle { max-width: 260px; min-width: 120px; background: var(--ag-panel); border: 1px solid var(--ag-line); border-radius: var(--r-sm); outline: none; color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 3px var(--s-2); }
.hint { font-size: var(--text-caption); color: var(--color-steel); }
.send { min-height: 24px; padding: 2px var(--s-3); margin-left: auto; border: 1px solid var(--color-ember); border-radius: var(--r-sm); background: var(--color-ember); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); font-weight: var(--weight-bold); cursor: pointer; opacity: .35; }
.send.ready { opacity: 1; }
.send.ready:hover { background: var(--color-ember-dim); }
.send.stop { opacity: 1; background: none; border-color: var(--ag-line-2); color: var(--color-fog); }
.send.stop:hover { color: var(--color-ember); border-color: var(--color-ember-dim); }
</style>
