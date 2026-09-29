<script setup lang="ts">
/** LogoutFlowPanel — the app's logout procedure (plan 20260929T080249Z):
 *  ONE recipe per bundle (app_logout), consumed by bare `ensure logout:`.
 *  Mirrors LoginFlowPanel: form ↔ yaml doc sync, revision-guarded save,
 *  remove with confirm. No verify section — logout success is the session
 *  indicator disappearing, judged by the executor at run time. */
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps<{ bundle: string }>();
const emit = defineEmits<{ close: []; saved: [] }>();

const fButton = ref('');
const fStay = ref('');
const fConfirm = ref('');
const fVia = ref('');
const err = ref('');
const saving = ref(false);
const revision = ref(1);
let host: HTMLElement | null = null;
let ed: { getValue(): string; setValue(v: string): void; on(ev: 'change', fn: () => void): void } | null = null;

function formToDoc(): string {
  const L: string[] = ['logout:'];
  L.push(`  button: ${JSON.stringify(fButton.value.trim())}`);
  if (fStay.value.trim()) L.push(`  stay: ${JSON.stringify(fStay.value.trim())}`);
  L.push(`  confirm: ${JSON.stringify(fConfirm.value.trim())}`);
  if (fVia.value.trim()) L.push(`  via: ${JSON.stringify(fVia.value.trim())}`);
  return L.join('\n') + '\n';
}

async function docToForm(): Promise<void> {
  const YAML = await import('yaml');
  try {
    let parsed = YAML.parse(ed!.getValue()) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') { err.value = 'document must be a logout: mapping'; return; }
    if ('logout' in parsed && Object.keys(parsed).length === 1) parsed = parsed['logout'] as Record<string, unknown>;
    fButton.value = String(parsed['button'] ?? '');
    fStay.value = String(parsed['stay'] ?? '');
    fConfirm.value = String(parsed['confirm'] ?? '');
    fVia.value = String(parsed['via'] ?? '');
    err.value = '';
  } catch (e) {
    err.value = `document parse error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

let suppressDocSync = false;
let docDirty = false;
watch([fButton, fStay, fConfirm, fVia], () => {
  if (suppressDocSync || docDirty) return;
  ed?.setValue(formToDoc());
});

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
    let logout: unknown;
    try {
      logout = YAML.parse(ed!.getValue());
      if (logout && typeof logout === 'object' && 'logout' in (logout as Record<string, unknown>) && Object.keys(logout as Record<string, unknown>).length === 1) {
        logout = (logout as Record<string, unknown>)['logout'];
      }
    } catch (e) { err.value = `document parse error: ${e instanceof Error ? e.message : String(e)}`; return; }
    const r = await fetch(`/api/apps/${encodeURIComponent(props.bundle)}/logout`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logout, revision: revision.value }),
    });
    const d = (await r.json()) as { errors?: string[]; error?: string; revision?: number };
    if (!r.ok) { err.value = d.error ?? (d.errors ?? ['save failed']).join(' · '); return; }
    emit('saved');
  } finally { saving.value = false; }
}

async function remove(): Promise<void> {
  if (!window.confirm(`remove the logout flow for ${props.bundle}? cases using bare ensure logout will fail their setup until re-added`)) return;
  const r = await fetch(`/api/apps/${encodeURIComponent(props.bundle)}/logout`, { method: 'DELETE' });
  if (!r.ok) { err.value = 'remove failed'; return; }
  emit('saved');
}

onMounted(async () => {
  const r = await fetch(`/api/apps/${encodeURIComponent(props.bundle)}/logout`);
  const d = (await r.json()) as { logout: { button?: string; stay?: string; confirm?: string; via?: string } | null; revision: number };
  revision.value = d.revision ?? 1;
  fButton.value = d.logout?.button ?? '';
  fStay.value = d.logout?.stay ?? '';
  fConfirm.value = d.logout?.confirm ?? '';
  fVia.value = d.logout?.via ?? '';
  // editor: CodeMirror-less minimal textarea keeps the panel dependency-free;
  // the login panel's editor object shape is preserved (get/set/on change)
  const ta = document.createElement('textarea');
  ta.className = 'lfp-doc';
  ta.spellcheck = false;
  ta.value = formToDoc();
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  ta.addEventListener('input', () => { if (changeTimer) clearTimeout(changeTimer); changeTimer = setTimeout(onDocChanged, 200); });
  host = document.querySelector('.lofp-doc-host');
  host?.appendChild(ta);
  ed = {
    getValue: () => ta.value,
    setValue: (v: string) => { ta.value = v; },
    on: () => undefined,
  };
});

onBeforeUnmount(() => { if (blurTimer) clearTimeout(blurTimer); host = null; ed = null; });
</script>

<template>
  <div class="lofp modal-mask" @click.self="emit('close')">
    <div class="lofp-card modal-card">
      <header class="lofp-head">
        <span class="t">logout flow</span>
        <span class="b mono">{{ bundle }}</span>
        <button class="ibtn" title="close" @click="emit('close')">✕</button>
      </header>
      <div class="lofp-body">
        <section class="grp">
          <h4>SESSION CONTROL</h4>
          <label class="fld"><span class="k">button</span><input v-model="fButton" placeholder="identifier or label — the logout button"></label>
          <label class="fld"><span class="k">confirm</span><input v-model="fConfirm" placeholder="identifier or label — the confirm-sheet control"></label>
          <label class="fld"><span class="k">stay</span><input v-model="fStay" placeholder="optional — stay-logged-in sheet title check"></label>
          <label class="fld"><span class="k">via</span><input v-model="fVia" placeholder="optional — navigate here first (e.g. the account tab)"></label>
        </section>
        <section class="grp">
          <h4>THE DOCUMENT — WHAT BARE `ensure logout:` RUNS</h4>
          <div class="lofp-doc-host"></div>
        </section>
      </div>
      <p v-if="err" class="lofp-err">{{ err }}</p>
      <footer class="lofp-foot">
        <button class="btn danger" @click="remove">remove flow</button>
        <span class="spacer"></span>
        <button class="btn" @click="emit('close')">cancel</button>
        <button class="btn primary" :disabled="saving" @click="save">{{ saving ? 'saving…' : 'save flow' }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.lofp-card { width: min(680px, 92vw); max-height: 86vh; display: flex; flex-direction: column; }
.lofp-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--color-iron); }
.lofp-head .t { font-weight: 600; }
.lofp-head .b { font-size: 11px; color: var(--color-steel); overflow: hidden; text-overflow: ellipsis; }
.lofp-head .ibtn { margin-left: auto; }
.lofp-body { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding: 14px; overflow-y: auto; }
.grp h4 { font-size: 10px; letter-spacing: 0.08em; color: var(--color-steel); margin: 0 0 8px; }
.fld { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.fld .k { width: 64px; flex: none; font-size: 11px; color: var(--color-steel); text-align: right; }
.fld input { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 11px; padding: 5px 8px; background: var(--color-void); border: 1px solid var(--color-iron); border-radius: var(--r-sm, 4px); color: var(--color-fog); }
.lofp-doc-host { min-height: 220px; }
.lofp-doc-host :deep(textarea.lfp-doc), .lofp-doc-host textarea { width: 100%; height: 220px; resize: vertical; font-family: var(--font-mono); font-size: 11px; line-height: 1.5; padding: 8px; background: var(--color-void); border: 1px solid var(--color-iron); border-radius: var(--r-sm, 4px); color: var(--color-fog); }
.lofp-err { color: var(--color-err); font-size: 11px; padding: 0 14px; }
.lofp-foot { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--color-iron); }
.lofp-foot .spacer { flex: 1; }
</style>
