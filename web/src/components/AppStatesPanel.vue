<script setup lang="ts">
/** AppStatesPanel — the app's named states registry (phase A S6, plan
 *  20261017T112229Z): what `ensure state: <id>` converges to. The screens
 *  page carries zero states chrome beyond the header action that opens this
 *  panel (the login-flow pattern — app-level facts own their surface).
 *  List = hairline rows (id · label · probe · provenance · revision);
 *  editor = selector FIELDS for probe/verify (the expect shape) + a yaml
 *  document for the recipe (entry / actuator / steps — same grammar as case
 *  steps). Validation is save-then-show-errors on the server (one
 *  validator, no duplication). Revision-guarded writes; deletes are
 *  confirm-gated HERE where the deleted thing is visible. */
import { computed, nextTick, onMounted, ref } from 'vue';
import { useYamlEditor } from '../composables/useYamlEditor.ts';

interface StateSelector { identifier?: string; label?: string; labelContains?: string; screen?: string; via?: string }
interface StateRecipe { entry?: unknown; actuator?: string; launchArgs?: string[]; signal?: string; permission?: string; steps?: unknown[] }
interface AppStateRow {
  id: string; stateId: string; label: string;
  probe: StateSelector | null; recipe: StateRecipe; verify: StateSelector;
  provenance: string; revision: number;
}
interface ProposalRow {
  id: string; stateId: string; label: string;
  probe: StateSelector; recipe: StateRecipe; verify: StateSelector;
  rationale: string; sourceRunId: string | null; status: 'open' | 'accepted' | 'rejected';
  createdBy: string;
}
type SelKind = 'identifier' | 'label' | 'labelContains' | 'screen';

const props = defineProps<{ bundle: string }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

const states = ref<AppStateRow[]>([]);
const proposals = ref<ProposalRow[]>([]);
const justAccepted = ref('');
const err = ref('');
const busy = ref(false);
// the editor form (null = list mode); editingId null = creating
const form = ref<null | { editingId: string | null; stateId: string; label: string; probeKind: SelKind; probeValue: string; verifyKind: SelKind; verifyValue: string; verifyVia: string; wasForced: boolean }>(null);
const ed = useYamlEditor();
const host = ref<HTMLElement | null>(null);

const RECIPE_TEMPLATE = `# recipe — how to reach the state when the probe misses
# entry: { tab: {…} } | { deepLink: url } | { navigate: [{ on: id }] }
# actuator: relaunch | signal | uninstallReinstall | privacyGrant
#   relaunch needs launchArgs: […] · signal needs signal: name ·
#   privacyGrant needs permission: service
# steps: the walk — tap / type / expect / wait (same grammar as case steps;
#   type text carries \${env.NAME} refs, never literal credentials)
recipe:
  steps:
    - tap: { on: example_button }
`;

function selToKind(sel: StateSelector | null): { kind: SelKind; value: string } {
  if (!sel) return { kind: 'identifier', value: '' }; // forced reset: no probe to load
  if (sel.identifier) return { kind: 'identifier', value: sel.identifier };
  if (sel.labelContains) return { kind: 'labelContains', value: sel.labelContains };
  if (sel.screen) return { kind: 'screen', value: sel.screen };
  return { kind: 'label', value: sel.label ?? '' };
}
function describeSel(sel: StateSelector): string {
  const { kind, value } = selToKind(sel);
  return kind === 'label' ? `"${value}"` : kind === 'screen' ? value : value;
}
function recipeSummary(r: StateRecipe): string {
  const arms: string[] = [];
  if (r.entry) arms.push(Object.keys(r.entry as Record<string, unknown>)[0] ?? 'entry');
  if (r.actuator) arms.push(r.actuator);
  if (Array.isArray(r.steps)) arms.push(`walk ${r.steps.length}`);
  return arms.join(' → ');
}

async function load(): Promise<void> {
  const r = await fetch(`/api/apps/${encodeURIComponent(props.bundle)}/states`);
  const d = (await r.json()) as { states?: AppStateRow[]; error?: string };
  if (!r.ok) { err.value = d.error ?? 'load failed'; return; }
  states.value = d.states ?? [];
  const pr = await fetch(`/api/apps/${encodeURIComponent(props.bundle)}/proposals`);
  const pd = (await pr.json()) as { proposals?: ProposalRow[]; error?: string };
  proposals.value = pr.ok ? (pd.proposals ?? []) : [];
}
const openProposals = computed(() => proposals.value.filter((p) => p.status === 'open'));
const decidedProposals = computed(() => proposals.value.filter((p) => p.status !== 'open'));

/** Phase B S3: the ONLY human gate a proposal passes. Accept stamps the
 *  registry entry ai+user (rev 1) — confirm-gated HERE where the draft is
 *  visible, like deletes. Reject is final (re-propose makes a new row). */
async function accept(p: ProposalRow): Promise<void> {
  if (!window.confirm(`accept "${p.stateId}"? it enters the registry as ai+user (rev 1) — cases can ensure it immediately`)) return;
  busy.value = true;
  try {
    const r = await fetch(`/api/states/proposals/${p.id}/accept`, { method: 'POST' });
    const d = (await r.json()) as { error?: string; stateId?: string };
    if (!r.ok) { err.value = d.error ?? 'accept failed'; return; }
    justAccepted.value = p.stateId;
    err.value = '';
    await load();
    setTimeout(() => { justAccepted.value = ''; }, 4000);
  } finally { busy.value = false; }
}
async function reject(p: ProposalRow): Promise<void> {
  if (!window.confirm(`reject "${p.stateId}"? decisions are final — a better draft can be re-proposed later`)) return;
  busy.value = true;
  try {
    const r = await fetch(`/api/states/proposals/${p.id}/reject`, { method: 'POST' });
    const d = (await r.json()) as { error?: string };
    if (!r.ok) { err.value = d.error ?? 'reject failed'; return; }
    err.value = '';
    await load();
  } finally { busy.value = false; }
}

async function openCreate(): Promise<void> {
  form.value = { editingId: null, stateId: '', label: '', probeKind: 'identifier', probeValue: '', verifyKind: 'identifier', verifyValue: '', verifyVia: '', wasForced: false };
  err.value = '';
  await nextTick();
  if (host.value) await ed.mount(host.value, RECIPE_TEMPLATE, () => void save());
}
async function openEdit(s: AppStateRow): Promise<void> {
  const p = selToKind(s.probe); const v = selToKind(s.verify);
  form.value = { editingId: s.id, stateId: s.stateId, label: s.label, probeKind: p.kind, probeValue: p.value, verifyKind: v.kind, verifyValue: v.value, verifyVia: s.verify.via ?? '', wasForced: s.probe === null };
  err.value = '';
  await nextTick();
  const YAML = await import('yaml');
  const doc: Record<string, unknown> = {};
  if (s.recipe.entry) doc['entry'] = s.recipe.entry;
  if (s.recipe.actuator) {
    doc['actuator'] = s.recipe.actuator;
    if (s.recipe.launchArgs) doc['launchArgs'] = s.recipe.launchArgs;
    if (s.recipe.signal) doc['signal'] = s.recipe.signal;
    if (s.recipe.permission) doc['permission'] = s.recipe.permission;
  }
  if (s.recipe.steps) doc['steps'] = s.recipe.steps;
  const text = `recipe:\n${YAML.stringify(doc).split('\n').filter((l: string) => l.trim()).map((l: string) => `  ${l}`).join('\n')}\n`;
  if (host.value) await ed.mount(host.value, text, () => void save());
}

async function save(): Promise<void> {
  const f = form.value;
  if (!f) return;
  busy.value = true;
  try {
    const YAML = await import('yaml');
    let recipe: unknown;
    try {
      let parsed = YAML.parse(ed.getValue()) as Record<string, unknown> | null;
      if (parsed && 'recipe' in parsed && Object.keys(parsed).length === 1) parsed = parsed['recipe'] as Record<string, unknown>;
      recipe = parsed ?? {};
    } catch (e) { err.value = `recipe parse error: ${e instanceof Error ? e.message : String(e)}`; return; }
    const probe = f.wasForced && !f.probeValue.trim() ? null : { [f.probeKind]: f.probeValue.trim() };
    const verify: Record<string, string> = { [f.verifyKind]: f.verifyValue.trim() };
    if (f.verifyVia.trim()) verify['via'] = f.verifyVia.trim();
    const body = { stateId: f.stateId.trim(), label: f.label.trim(), probe, verify, recipe };
    const editing = states.value.find((s) => s.id === f.editingId);
    const url = f.editingId ? `/api/states/${f.editingId}` : `/api/apps/${encodeURIComponent(props.bundle)}/states`;
    const r = await fetch(url, {
      method: f.editingId ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(f.editingId ? { ...body, revision: editing?.revision } : body),
    });
    const d = (await r.json()) as { error?: string; errors?: string[] };
    if (!r.ok) { err.value = d.error ?? (d.errors ?? ['save failed']).join(' · '); return; }
    form.value = null;
    err.value = '';
    await load();
  } finally { busy.value = false; }
}

async function remove(s: AppStateRow): Promise<void> {
  if (!window.confirm(`delete state "${s.stateId}"? cases running 'ensure state: ${s.stateId}' will fail until re-added`)) return;
  const r = await fetch(`/api/states/${s.id}`, { method: 'DELETE' });
  if (!r.ok) { err.value = 'delete failed'; return; }
  await load();
}

onMounted(load);
</script>

<template>
  <div class="asp-overlay" @click.self="emit('close')">
    <div class="asp">
      <div class="asp-head">
        <span class="asp-title">app states</span>
        <span class="asp-meta">{{ bundle }}</span>
        <span class="asp-mode">probe → recipe → verify · save validates</span>
        <button class="asp-x" @click="emit('close')">×</button>
      </div>

      <div v-if="!form" class="asp-body">
        <div class="asp-thead">
          <span class="c-id">state</span><span class="c-label">label</span><span class="c-probe">probe</span><span class="c-recipe">recipe</span><span class="c-meta">rev</span><span class="c-acts"></span>
        </div>
        <div v-if="states.length === 0" class="hint inset">no states — <button class="inline-link" @click="openCreate">register the first one</button></div>
        <div v-for="s in states" :key="s.id" class="asp-row" :class="{ 'is-new': s.stateId === justAccepted }" :title="`provenance ${s.provenance}`">
          <span class="c-id mono">{{ s.stateId }}</span>
          <span class="c-label">{{ s.label }}</span>
          <span class="c-probe mono">{{ s.probe ? describeSel(s.probe) : 'forced ⟳' }}</span>
          <span class="c-recipe">{{ recipeSummary(s.recipe) }}</span>
          <span class="c-meta" :title="`provenance ${s.provenance}`">{{ s.revision }}</span>
          <span class="c-acts">
            <button class="c-act" title="edit this state" @click="openEdit(s)">edit</button>
            <button class="c-act danger" title="delete this state" @click="remove(s)">delete</button>
          </span>
        </div>
        <div v-if="openProposals.length > 0 || decidedProposals.length > 0" class="asp-pbox">
          <div class="asp-phead">
            <span>proposals</span>
            <span v-if="openProposals.length > 0" class="p-badge">{{ openProposals.length }}</span>
            <span class="p-hint">ai-drafted from green runs · accepting stamps ai+user</span>
          </div>
          <div v-for="p in openProposals" :key="p.id" class="asp-prow">
            <span class="p-id mono">{{ p.stateId }}</span>
            <span class="p-label">{{ p.label }}</span>
            <span class="p-why" :title="p.rationale">{{ p.rationale }}</span>
            <span class="p-recipe">{{ recipeSummary(p.recipe) }}</span>
            <span class="p-acts">
              <button class="c-act" :disabled="busy" title="enter the registry as ai+user (rev 1)" @click="accept(p)">accept</button>
              <button class="c-act danger" :disabled="busy" title="reject — final" @click="reject(p)">reject</button>
            </span>
          </div>
          <div v-if="decidedProposals.length > 0" class="p-decided mono">{{ decidedProposals.length }} decided · latest {{ decidedProposals[0]!.stateId }} → {{ decidedProposals[0]!.status }}</div>
        </div>
        <div v-else class="hint inset" style="margin-top: var(--s-2)">no open proposals — the agent drafts new states here after green runs (states.propose)</div>

        <div class="asp-acts">
          <span style="flex:1"></span>
          <button class="btn" @click="emit('close')">close</button>
          <button class="btn btn-primary" @click="openCreate">+ state</button>
        </div>
      </div>

      <div v-else class="asp-body asp-edit">
        <div class="ed-form">
          <label class="ed-row"><span class="ed-k">state id</span><input v-model="form.stateId" class="ed-in mono" placeholder="fresh_install"></label>
          <label class="ed-row"><span class="ed-k">label</span><input v-model="form.label" class="ed-in" placeholder="plain-English name"></label>
          <div class="ed-grid">
            <label class="ed-row"><span class="ed-k">probe</span>
              <select v-model="form.probeKind" class="ed-sel" title="how the engine cheaply checks the app is already in this state">
                <option value="identifier">identifier</option><option value="label">label</option><option value="labelContains">contains</option><option value="screen">screen.state</option>
              </select>
              <input v-model="form.probeValue" class="ed-in mono" placeholder="home_welcome_banner">
            </label>
            <label class="ed-row"><span class="ed-k">verify</span>
              <select v-model="form.verifyKind" class="ed-sel" title="proof of arrival — same shape as the probe">
                <option value="identifier">identifier</option><option value="label">label</option><option value="labelContains">contains</option><option value="screen">screen.state</option>
              </select>
              <input v-model="form.verifyValue" class="ed-in mono" placeholder="home_welcome_banner">
            </label>
          </div>
          <label class="ed-row"><span class="ed-k">via</span>
            <input v-model="form.verifyVia" class="ed-in mono" placeholder="control to tap before verify (optional) — for states behind a tab" title="tap this control before polling verify">
          </label>
        </div>
        <div class="doc-h">recipe — what runs when the probe misses</div>
        <div ref="host" class="cm-host"></div>
        <div v-if="err" class="ed-err">{{ err }}</div>
        <div class="asp-acts">
          <span style="flex:1"></span>
          <button class="btn" @click="form = null">cancel</button>
          <button class="btn btn-primary" :disabled="busy" @click="save">save state</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.asp-overlay { position: fixed; inset: 0; z-index: 200; background: color-mix(in srgb, var(--color-void) 80%, transparent); display: grid; place-items: center; }
.asp { width: min(1080px, 94vw); max-height: 88vh; display: grid; grid-template-rows: auto 1fr; border: 1px solid var(--color-slate); background: var(--color-graphite); overflow: hidden; }
.asp-head { display: flex; gap: var(--s-3); align-items: baseline; padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--color-iron); }
.asp-title { font-weight: var(--weight-bold); font-size: var(--text-label); }
.asp-meta { color: var(--color-steel); font-size: var(--text-caption); overflow: hidden; text-overflow: ellipsis; }
.asp-mode { color: var(--color-pewter); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; margin-left: auto; }
.asp-x { color: var(--color-pewter); font-size: var(--text-label); }
.asp-x:hover { color: var(--color-paper); }
.asp-body { display: flex; flex-direction: column; padding: var(--s-3) var(--s-4); min-height: 0; overflow: auto; }
.asp-thead, .asp-row { display: grid; grid-template-columns: 180px 1fr 200px 1fr 44px 110px; gap: var(--s-2); align-items: center; }
.asp-thead { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-steel); padding-bottom: var(--s-2); }
.asp-row { border-top: 1px solid var(--color-iron); min-height: 44px; font-size: var(--text-caption); }
.asp-row:hover { background: var(--color-carbon); }
.asp-row .c-id { color: var(--color-paper); }
.asp-row .c-label, .asp-row .c-recipe { color: var(--color-ash); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asp-row .c-probe { color: var(--color-steel); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asp-row .c-meta { color: var(--color-pewter); text-align: right; }
.c-act { border: none; background: none; color: var(--color-steel); font-family: var(--font-mono); font-size: var(--text-caption); cursor: pointer; padding: 2px 4px; }
.c-act:hover { color: var(--color-paper); }
.c-act.danger:hover { color: var(--color-ember); }
.c-acts { display: flex; gap: var(--s-1); justify-content: flex-end; }
.asp-edit { gap: var(--s-3); }
.ed-form { display: flex; flex-direction: column; gap: var(--s-2); }
.ed-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-3); }
.ed-row { display: flex; gap: var(--s-2); align-items: center; }
.ed-k { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-steel); width: 52px; flex: none; }
.ed-in, .ed-sel { flex: 1; min-width: 0; background: var(--color-void); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-size: var(--text-body); padding: 6px 8px; }
.ed-sel { flex: none; width: 130px; }
.doc-h { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-steel); }
.cm-host { min-height: 260px; overflow: hidden; display: flex; border: 1px solid var(--color-iron); }
.cm-host > :deep(.cm-editor) { flex: 1; }
.ed-err { color: var(--color-ember); font-size: var(--text-caption); white-space: pre-wrap; }
.asp-acts { display: flex; gap: var(--s-2); align-items: center; margin-top: var(--s-3); }
.btn { display: inline-flex; align-items: center; padding: 6px var(--s-3); background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-body); min-height: 30px; cursor: pointer; }
.btn-primary { background: var(--color-accent); border-color: var(--color-accent); color: #101010; font-weight: var(--weight-bold); }
.mono { font-family: var(--font-mono); }
.asp-pbox { margin-top: var(--s-4); border: 1px solid var(--color-iron); border-radius: var(--r-sm); padding: var(--s-2) var(--s-3); }
.asp-phead { display: flex; gap: var(--s-2); align-items: baseline; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-steel); padding-bottom: var(--s-1); }
.p-badge { background: var(--color-accent); color: #101010; border-radius: 999px; min-width: 16px; text-align: center; padding: 0 4px; font-family: var(--font-mono); letter-spacing: 0; }
.p-hint { margin-left: auto; color: var(--color-pewter); text-transform: none; letter-spacing: 0; }
.asp-prow { display: grid; grid-template-columns: 160px 1fr 1.4fr 130px 96px; gap: var(--s-2); align-items: center; border-top: 1px solid var(--color-iron); min-height: 40px; font-size: var(--text-caption); }
.asp-prow .p-id { color: var(--color-paper); }
.asp-prow .p-label { color: var(--color-ash); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asp-prow .p-why { color: var(--color-steel); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asp-prow .p-recipe { color: var(--color-pewter); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p-acts { display: flex; gap: var(--s-1); justify-content: flex-end; }
.p-decided { color: var(--color-pewter); font-size: var(--text-caption); border-top: 1px solid var(--color-iron); padding-top: var(--s-1); }
.asp-row.is-new { outline: 1px solid var(--color-accent); outline-offset: -1px; }
@media (max-width: 720px) { .ed-grid { grid-template-columns: 1fr; } .asp-thead, .asp-row { grid-template-columns: 110px 1fr 60px; } .c-label, .c-recipe, .c-probe { display: none; } .asp-prow { grid-template-columns: 110px 1fr 96px; } .p-label, .p-why, .p-recipe { display: none; } }
</style>
