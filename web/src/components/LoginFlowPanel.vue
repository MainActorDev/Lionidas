<script setup lang="ts">
/** LoginFlowPanel — the app's login PROCEDURE editor (login-as-app-procedure
 *  plan). Form left, yaml document right (same CodeMirror + sync contract as
 *  ScreenDocPanel). Nothing here can be deleted by editing a screen; removing
 *  the flow is an explicit, confirm-gated action ON THIS SURFACE. */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useYamlEditor } from '../composables/useYamlEditor.ts';

const props = defineProps<{ bundle: string; screens: Array<{ id: string; states: string[] }> }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

const ed = useYamlEditor();
const host = ref<HTMLElement | null>(null);
const err = ref('');
const saving = ref(false);
const revision = ref(1);

// form model — every value user-entered, no defaults beyond shape
const fEntryMode = ref<'tab' | 'deepLink' | 'navigate'>('navigate');
const fTabSel = ref('');
const fDeepLink = ref('');
const fSteps = ref<string[]>([]);
const fPhone = ref('');
const fPassword = ref('');
const fSubmit = ref('');
const fVerifyScreen = ref('');
const fVerifyState = ref('');

const stateOptions = computed(() => {
  const scr = props.screens.find((s) => s.id === fVerifyScreen.value);
  return scr ? scr.states : [];
});

function formToDoc(): string {
  const L: string[] = ['login:'];
  if (fEntryMode.value === 'tab') {
    const v = fTabSel.value.trim();
    const kind = /^[A-Za-z][A-Za-z0-9_-]*$/.test(v) && !v.includes(' ') ? 'identifier' : 'label';
    L.push('  entry:', `    tab:`, `      ${kind}: ${JSON.stringify(v)}`);
  } else if (fEntryMode.value === 'deepLink') {
    L.push('  entry:', `    deepLink: ${JSON.stringify(fDeepLink.value.trim())}`);
  } else if (fSteps.value.length > 0) {
    L.push('  entry:', '    navigate:');
    for (const s of fSteps.value) L.push(`      - on: ${JSON.stringify(s)}`);
  }
  L.push(`  phone: ${JSON.stringify(fPhone.value)}`);
  L.push(`  password: ${JSON.stringify(fPassword.value)}`);
  L.push(`  submit: ${JSON.stringify(fSubmit.value)}`);
  L.push(`  verify:`, `    screen: ${JSON.stringify(fVerifyScreen.value)}`, `    state: ${JSON.stringify(fVerifyState.value)}`);
  return L.join('\n') + '\n';
}

async function docToForm(): Promise<void> {
  const YAML = await import('yaml');
  try {
    let parsed = YAML.parse(ed.getValue()) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') { err.value = 'document must be a login: mapping'; return; }
    // the document wraps the procedure in `login:`; the form reads the inner mapping
    if ('login' in parsed && Object.keys(parsed).length === 1) parsed = parsed['login'] as Record<string, unknown>;
    suppressDocSync = true;
    const e = (parsed['entry'] ?? {}) as Record<string, unknown>;
    if (e['tab']) { fEntryMode.value = 'tab'; const t = e['tab'] as Record<string, unknown>; fTabSel.value = String(t['identifier'] ?? t['label'] ?? ''); }
    else if (e['deepLink']) { fEntryMode.value = 'deepLink'; fDeepLink.value = String(e['deepLink']); }
    else if (Array.isArray(e['navigate'])) { fEntryMode.value = 'navigate'; fSteps.value = (e['navigate'] as Array<Record<string, unknown>>).map((st) => String(st['on'] ?? '')); }
    fPhone.value = String(parsed['phone'] ?? '');
    fPassword.value = String(parsed['password'] ?? '');
    fSubmit.value = String(parsed['submit'] ?? '');
    const v = (parsed['verify'] ?? {}) as Record<string, unknown>;
    fVerifyScreen.value = String(v['screen'] ?? '');
    fVerifyState.value = String(v['state'] ?? '');
    err.value = '';
  } catch (e2) {
    err.value = `document parse error: ${e2 instanceof Error ? e2.message : String(e2)}`;
  } finally {
    await nextTick(); await nextTick();
    suppressDocSync = false;
  }
}

let suppressDocSync = false;
let docDirty = false;
watch([fEntryMode, fTabSel, fDeepLink, fSteps, fPhone, fPassword, fSubmit, fVerifyScreen, fVerifyState], () => {
  if (suppressDocSync || docDirty) return;
  ed.setValue(formToDoc());
}, { deep: true });

let blurTimer: ReturnType<typeof setTimeout> | null = null;
function onDocChanged(): void {
  docDirty = true;
  if (blurTimer) clearTimeout(blurTimer);
  blurTimer = setTimeout(() => { void docToForm().then(() => { docDirty = false; }); }, 400);
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const YAML = await import('yaml');
    let login: unknown;
    try {
      login = YAML.parse(ed.getValue());
      // the document carries a `login:` wrapper for readability; the API
      // expects the bare procedure mapping
      if (login && typeof login === 'object' && 'login' in (login as Record<string, unknown>) && Object.keys(login as Record<string, unknown>).length === 1) {
        login = (login as Record<string, unknown>)['login'];
      }
    } catch (e) { err.value = `document parse error: ${e instanceof Error ? e.message : String(e)}`; return; }
    const r = await fetch(`/api/apps/${encodeURIComponent(props.bundle)}/login`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login, revision: revision.value }),
    });
    const d = (await r.json()) as { errors?: string[]; error?: string; revision?: number };
    if (!r.ok) { err.value = d.error ?? (d.errors ?? ['save failed']).join(' · '); return; }
    emit('saved');
  } finally { saving.value = false; }
}

async function remove(): Promise<void> {
  if (!window.confirm(`remove the login flow for ${props.bundle}? cases using ensure login will fail their setup until re-added`)) return;
  const r = await fetch(`/api/apps/${encodeURIComponent(props.bundle)}/login`, { method: 'DELETE' });
  if (!r.ok) { err.value = 'remove failed'; return; }
  emit('saved');
}

onMounted(async () => {
  if (!host.value) return;
  const cur = await (await fetch(`/api/apps/${encodeURIComponent(props.bundle)}/login`)).json() as { login: Record<string, unknown> | null; revision: number };
  revision.value = cur.revision;
  const initial = cur.login ? (() => { const L = ['login:']; const e = (cur.login['entry'] ?? {}) as Record<string, unknown>;
    if (e['tab']) { const t = e['tab'] as Record<string, unknown>; L.push('  entry:', '    tab:', `      ${t['identifier'] ? 'identifier: ' + JSON.stringify(String(t['identifier'])) : 'label: ' + JSON.stringify(String(t['label'] ?? ''))}`); }
    else if (e['deepLink']) L.push('  entry:', `    deepLink: ${JSON.stringify(String(e['deepLink']))}`);
    else if (Array.isArray(e['navigate'])) { L.push('  entry:', '    navigate:'); for (const st of e['navigate'] as Array<Record<string, unknown>>) L.push(`      - on: ${JSON.stringify(String(st['on'] ?? ''))}`); }
    L.push(`  phone: ${JSON.stringify(String(cur.login['phone'] ?? ''))}`);
    L.push(`  password: ${JSON.stringify(String(cur.login['password'] ?? ''))}`);
    L.push(`  submit: ${JSON.stringify(String(cur.login['submit'] ?? ''))}`);
    const v = (cur.login['verify'] ?? {}) as Record<string, unknown>;
    L.push('  verify:', `    screen: ${JSON.stringify(String(v['screen'] ?? ''))}`, `    state: ${JSON.stringify(String(v['state'] ?? ''))}`);
    return L.join('\n') + '\n'; })() : 'login:\n';
  await ed.mount(host.value, initial, () => void save());
  host.value.addEventListener('input', onDocChanged);
  // mount() resolves once the CM view holds `initial`; one more tick keeps
  // getValue() honest before the reparse (reopen showed an empty form while
  // the doc rendered — the reparse raced the editor's content set)
  await nextTick();
  await docToForm();
  // and re-run once options-dependent selects settle (screens prop may
  // arrive after mount on late page loads)
  watch(() => props.screens, () => { void docToForm(); }, { deep: true });
});
onBeforeUnmount(() => { host.value?.removeEventListener('input', onDocChanged); if (blurTimer) clearTimeout(blurTimer); });
</script>

<template>
  <div class="lfp-overlay" @click.self="emit('close')">
    <div class="lfp">
      <div class="lfp-head">
        <span class="lfp-title">login flow</span>
        <span class="lfp-meta">{{ bundle }}</span>
        <button class="lfp-x" @click="emit('close')">×</button>
      </div>
      <div class="lfp-body">
        <div class="lfp-form">
          <div class="sec-h">entry — how the runner reaches the form</div>
          <label class="fld"><span class="k">kind</span>
            <select v-model="fEntryMode">
              <option value="tab">tab tap</option>
              <option value="deepLink">deep link</option>
              <option value="navigate">navigate steps</option>
            </select>
          </label>
          <label v-if="fEntryMode === 'tab'" class="fld"><span class="k">selector</span><input v-model="fTabSel" placeholder="identifier or label"></label>
          <label v-else-if="fEntryMode === 'deepLink'" class="fld"><span class="k">url</span><input v-model="fDeepLink" placeholder="app route"></label>
          <template v-else>
            <div v-for="(s, i) in fSteps" :key="i" class="fld"><span class="k">step {{ i + 1 }}</span><input :value="s" @input="fSteps[i] = ($event.target as HTMLInputElement).value" placeholder="identifier"><button class="x" @click="fSteps.splice(i, 1)">×</button></div>
            <div class="fld"><span class="k"></span><button class="addstep" @click="fSteps.push('')">+ step</button></div>
          </template>
          <div class="sec-h">form controls</div>
          <label class="fld"><span class="k">phone</span><input v-model="fPhone" placeholder="identifier"></label>
          <label class="fld"><span class="k">password</span><input v-model="fPassword" placeholder="identifier"></label>
          <label class="fld"><span class="k">submit</span><input v-model="fSubmit" placeholder="identifier"></label>
          <div class="sec-h">verify — when login counts as done</div>
          <label class="fld"><span class="k">screen</span>
            <select v-model="fVerifyScreen">
              <option value="">—</option>
              <option v-for="s in screens" :key="s.id" :value="s.id">{{ s.id }}</option>
            </select>
          </label>
          <label class="fld"><span class="k">state</span>
            <select v-model="fVerifyState">
              <option value="">—</option>
              <option v-for="st in stateOptions" :key="st" :value="st">{{ st }}</option>
            </select>
          </label>
        </div>
        <div class="lfp-doc">
          <div class="doc-h">the document — what ensure login runs</div>
          <div ref="host" class="cm-host"></div>
          <div v-if="err" class="ed-err">{{ err }}</div>
          <div class="lfp-acts">
            <button class="danger" @click="remove">remove flow</button>
            <span style="flex:1"></span>
            <button class="btn" @click="emit('close')">cancel</button>
            <button class="btn btn-primary" :disabled="saving" @click="save">save flow</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lfp-overlay { position: fixed; inset: 0; z-index: 200; background: color-mix(in srgb, var(--color-void) 80%, transparent); display: grid; place-items: center; }
.lfp { width: min(1080px, 94vw); max-height: 88vh; display: grid; grid-template-rows: auto 1fr; border: 1px solid var(--color-slate); background: var(--color-graphite); overflow: hidden; }
.lfp-head { display: flex; gap: var(--s-3); align-items: baseline; padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--color-iron); }
.lfp-title { font-weight: var(--weight-bold); font-size: var(--text-label); }
.lfp-meta { color: var(--color-steel); font-size: var(--text-caption); }
.lfp-x { margin-left: auto; color: var(--color-pewter); font-size: var(--text-label); }
.lfp-x:hover { color: var(--color-paper); }
.lfp-body { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); min-height: 0; }
.lfp-form { padding: var(--s-3) var(--s-4); overflow-y: auto; border-right: 1px solid var(--color-iron); }
.lfp-doc { display: flex; flex-direction: column; padding: var(--s-3) var(--s-4); min-height: 0; }
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
.ed-err { color: var(--color-ember); font-size: var(--text-caption); margin-top: var(--s-2); }
.lfp-acts { display: flex; gap: var(--s-2); align-items: center; margin-top: var(--s-3); }
.lfp-acts .danger { border: none; color: var(--color-ember); font-size: var(--text-caption); }
.lfp-acts .danger:hover { color: var(--color-ember-dim); }
.btn { display: inline-flex; align-items: center; padding: 6px var(--s-3); background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-body); min-height: 30px; cursor: pointer; }
.btn-primary { background: var(--color-ember); border-color: var(--color-ember); color: var(--color-paper); font-weight: var(--weight-bold); }
</style>
