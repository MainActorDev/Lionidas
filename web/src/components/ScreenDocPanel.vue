<script setup lang="ts">
/** ScreenDocPanel — the register/edit surface (register-flow plan rev 2, sketch 009-C).
 *  Form left, the yaml DOCUMENT right in the same CodeMirror the testcase editor
 *  uses (D5). Sync (F3): form→document live; document→form on blur/debounce; the
 *  document owns truth at save. Replaces the old create/edit dialog (F1). */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useYamlEditor } from '../composables/useYamlEditor.ts';

interface Step { on?: string; x?: number; y?: number }
interface StateDef { name: string; identifier: string }
const props = defineProps<{ bundle: string; screenYaml: string; mode: 'create' | 'edit' }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

const ed = useYamlEditor();
const host = ref<HTMLElement | null>(null);
const err = ref('');
const saving = ref(false);

// ── form model ──
const fId = ref('');
const fEntryMode = ref<'tab' | 'deepLink' | 'navigate'>('tab');
const fTabSel = ref('');
const fDeepLink = ref('');
const fSteps = ref<Step[]>([]);
const fRefresh = ref('');
const fStates = ref<StateDef[]>([]);

// ── document ⇄ form ──
let suppressDocSync = false; // doc→form reparse in flight; don't echo back
let docDirty = false;        // user typed in the document; form is stale until blur/debounce

function formToDoc(): string {
  const L: string[] = [];
  L.push(`- id: ${fId.value || '?'}`);
  if (fEntryMode.value === 'tab') {
    const v = fTabSel.value.trim();
    const kind = /^[A-Za-z][A-Za-z0-9_-]*$/.test(v) && !v.includes(' ') ? 'identifier' : 'label';
    L.push(`  entry:`, `    tab:`, `      ${kind}: ${JSON.stringify(v)}`);
  } else if (fEntryMode.value === 'deepLink') {
    L.push(`  entry:`, `    deepLink: ${JSON.stringify(fDeepLink.value.trim())}`);
  } else if (fSteps.value.length > 0) {
    L.push(`  entry:`, `    navigate:`);
    for (const s of fSteps.value) L.push(`      - on: ${JSON.stringify(s.on ?? '')}`);
  }
  if (fRefresh.value) L.push(`  refresh:`, `    gesture: ${fRefresh.value}`);
  if (fStates.value.length > 0) {
    L.push(`  states:`);
    for (const s of fStates.value) L.push(`    ${s.name}:`, `      all:`, `        - { identifier: ${JSON.stringify(s.identifier)} }`);
  }
  return L.join('\n') + '\n';
}

async function docToForm(): Promise<void> {
  const YAML = await import('yaml');
  try {
    const parsed = YAML.parse(ed.getValue()) as Array<Record<string, unknown>> | null;
    const s = Array.isArray(parsed) ? parsed[0] : null;
    if (!s) { err.value = 'document must be a list with one screen'; return; }
    suppressDocSync = true;
    fId.value = typeof s['id'] === 'string' ? s['id'] : '';
    const entry = (s['entry'] ?? {}) as Record<string, unknown>;
    if (entry['tab']) {
      fEntryMode.value = 'tab';
      const t = entry['tab'] as Record<string, unknown>;
      fTabSel.value = String(t['identifier'] ?? t['label'] ?? '');
    } else if (entry['deepLink']) {
      fEntryMode.value = 'deepLink';
      fDeepLink.value = String(entry['deepLink']);
    } else if (Array.isArray(entry['navigate'])) {
      fEntryMode.value = 'navigate';
      fSteps.value = (entry['navigate'] as Array<Record<string, unknown>>).map((st) => ({ on: String(st['on'] ?? '') }));
    }
    const refresh = s['refresh'] as Record<string, unknown> | undefined;
    fRefresh.value = refresh?.['gesture'] ? String(refresh['gesture']) : '';
    fStates.value = Object.entries((s['states'] ?? {}) as Record<string, unknown>).map(([name, def]) => {
      const all = ((def as Record<string, unknown>)['all'] as Array<Record<string, unknown>> | undefined) ?? [];
      const first = all[0] ?? {};
      return { name, identifier: String(first['identifier'] ?? first['label'] ?? '') };
    });
    err.value = '';
  } catch (e) {
    err.value = `document parse error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    // keep the echo guard up until Vue has flushed the watchers the reparse
    // triggered — releasing it synchronously let the deep form watcher fire
    // afterwards and STOMP the document with formToDoc() (the user's yaml
    // edits "always gone" bug). Two ticks cover the deep chain.
    await nextTick();
    await nextTick();
    suppressDocSync = false;
  }
}

// form→doc: live, but never while a doc→form reparse just ran (echo guard)
watch([fId, fEntryMode, fTabSel, fDeepLink, fSteps, fRefresh, fStates], () => {
  if (suppressDocSync || docDirty) return;
  ed.setValue(formToDoc());
}, { deep: true });

let blurTimer: ReturnType<typeof setTimeout> | null = null;
function onDocChanged(): void {
  docDirty = true;
  if (blurTimer) clearTimeout(blurTimer);
  blurTimer = setTimeout(() => { void docToForm().then(() => { docDirty = false; }); }, 400); // F3 debounce — the document's content is truth; the form merely follows
}

// ── save: the DOCUMENT is the truth (F3), but the registry is a LIST — the
// panel edits ONE screen. PUT-screens.yaml replaces the WHOLE registry (the
// panel's first save wiped sibling screens — found in the live drill). Merge:
// fetch the current registry, upsert this screen by id, PUT the full list via
// the JSON route with the per-bundle revision (409 on drift → honest error).
async function save(): Promise<void> {
  saving.value = true;
  try {
    const YAML = await import('yaml');
    let doc: Array<Record<string, unknown>>;
    try {
      const parsed = YAML.parse(ed.getValue()) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== 1) { err.value = 'document must be a list with exactly this one screen'; return; }
      doc = parsed as Array<Record<string, unknown>>;
    } catch (e) {
      err.value = `document parse error: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    const cur = await (await fetch(`/api/apps/${encodeURIComponent(props.bundle)}/screens`)).json() as { screens?: Array<Record<string, unknown>>; revision?: number };
    const screens = (cur.screens ?? []).filter((s) => s['id'] !== doc[0]!['id']);
    screens.push(doc[0]!);
    const r = await fetch(`/api/apps/${encodeURIComponent(props.bundle)}/screens`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ screens, revision: cur.revision }),
    });
    const d = (await r.json()) as { errors?: string[]; error?: string; ok?: boolean };
    if (!r.ok) { err.value = d.error ?? (d.errors ?? ['save failed']).join(' · '); return; }
    emit('saved');
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  if (!host.value) return;
  await ed.mount(host.value, props.screenYaml, () => void save());
  // doc-change listener rides the CM updateListener via a MutationObserver-free
  // hook: the composable exposes getValue; we poll-diff on input events from CM's
  // domEventHandlers via the editor's own change dispatch — simplest reliable
  // signal: listen for CM's input events on the host
  host.value.addEventListener('input', onDocChanged);
  await docToForm();
});
onBeforeUnmount(() => { host.value?.removeEventListener('input', onDocChanged); if (blurTimer) clearTimeout(blurTimer); });

const canSave = computed(() => !saving.value);
</script>

<template>
  <div class="sdp-overlay" @click.self="emit('close')">
    <div class="sdp">
      <div class="sdp-head">
        <span class="sdp-title">{{ mode === 'create' ? 'register screen' : 'edit screen' }}</span>
        <span class="sdp-meta">{{ bundle }}</span>
        <button class="sdp-x" @click="emit('close')">×</button>
      </div>
      <div class="sdp-body">
        <div class="sdp-form">
          <label class="fld"><span class="k">id</span><input v-model="fId" placeholder="shipment-details"></label>
          <label class="fld"><span class="k">entry</span>
            <select v-model="fEntryMode">
              <option value="tab">tab tap</option>
              <option value="deepLink">deep link</option>
              <option value="navigate">navigate steps</option>
            </select>
          </label>
          <label v-if="fEntryMode === 'tab'" class="fld"><span class="k">selector</span><input v-model="fTabSel" placeholder="identifier or label"></label>
          <label v-else-if="fEntryMode === 'deepLink'" class="fld"><span class="k">url</span><input v-model="fDeepLink" placeholder="lionparcel://tracking"></label>
          <template v-else>
            <div v-for="(s, i) in fSteps" :key="i" class="fld"><span class="k">step {{ i + 1 }}</span><input v-model="s.on" placeholder="identifier"><button class="x" @click="fSteps.splice(i, 1)">×</button></div>
            <div class="fld"><span class="k"></span><button class="addstep" @click="fSteps.push({ on: '' })">+ step</button></div>
          </template>
          <label class="fld"><span class="k">refresh</span>
            <select v-model="fRefresh">
              <option value="">none</option>
              <option value="pull">pull</option>
              <option value="tab-retap">tab-retap</option>
              <option value="back-forward">back-forward</option>
              <option value="signal">signal</option>
            </select>
          </label>
          <div class="sec-h">states</div>
          <div v-for="(s, i) in fStates" :key="i" class="fld"><span class="k">{{ s.name || '?' }}</span><input v-model="s.identifier" placeholder="identifier"><button class="x" @click="fStates.splice(i, 1)">×</button></div>
          <div class="fld"><span class="k"></span>
            <button class="addstep" @click="fStates.push({ name: `state-${fStates.length + 1}`, identifier: '' })">+ state</button>
          </div>
        </div>
        <div class="sdp-doc">
          <div class="doc-h">the document — what cases and the agent read</div>
          <div ref="host" class="cm-host"></div>
          <div v-if="err" class="ed-err">{{ err }}</div>
          <div class="sdp-acts">
            <button class="btn" @click="emit('close')">cancel</button>
            <button class="btn btn-primary" :disabled="!canSave" @click="save">save screen</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
export default { name: 'ScreenDocPanel' };
</script>

<style scoped>
@reference '../styles/tokens.css';
.sdp-overlay { position: fixed; inset: 0; z-index: 200; background: color-mix(in srgb, var(--color-void) 80%, transparent); display: grid; place-items: center; }
.sdp { width: min(1080px, 94vw); max-height: 88vh; display: grid; grid-template-rows: auto 1fr; border: 1px solid var(--color-slate); background: var(--color-graphite); overflow: hidden; }
.sdp-head { display: flex; gap: var(--s-3); align-items: baseline; padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--color-iron); }
.sdp-title { font-weight: var(--weight-bold); font-size: var(--text-label); }
.sdp-meta { color: var(--color-steel); font-size: var(--text-caption); }
.sdp-x { margin-left: auto; color: var(--color-pewter); font-size: var(--text-label); }
.sdp-x:hover { color: var(--color-paper); }
.sdp-body { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); min-height: 0; }
.sdp-form { padding: var(--s-3) var(--s-4); overflow-y: auto; border-right: 1px solid var(--color-iron); }
.sdp-doc { display: flex; flex-direction: column; padding: var(--s-3) var(--s-4); min-height: 0; }
.doc-h { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-steel); margin-bottom: var(--s-2); }
.cm-host { flex: 1; min-height: 300px; overflow: hidden; display: flex; }
.cm-host > :deep(.cm-editor) { flex: 1; }
.fld { display: flex; align-items: center; gap: var(--s-2); margin-bottom: var(--s-2); }
.fld .k { width: 110px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-steel); flex-shrink: 0; }
.fld input { flex: 1; background: var(--color-void); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 5px var(--s-2); }
.fld select { background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 5px var(--s-2); width: auto; }
.fld .x { color: var(--color-pewter); font-size: var(--text-caption); }
.fld .x:hover { color: var(--color-ember); }
.addstep { border: 1px solid var(--color-iron); color: var(--color-fog); font-size: var(--text-caption); padding: 3px var(--s-2); }
.addstep:hover { border-color: var(--color-slate); color: var(--color-paper); }
.sec-h { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-steel); margin: var(--s-3) 0 var(--s-2); }
.ck { font-size: var(--text-caption); color: var(--color-fog); }
.ed-err { color: var(--color-ember); font-size: var(--text-caption); margin-top: var(--s-2); }
.sdp-acts { display: flex; gap: var(--s-2); justify-content: flex-end; margin-top: var(--s-3); }
</style>
