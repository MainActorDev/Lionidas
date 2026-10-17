<script setup lang="ts">
/** LoginFlowPanel — the app's login PROCEDURE as a steps document (plan
 *  20260930T044550Z): any app's form is a step list (tap/type/expect with
 *  ${env.NAME} refs — per-app names, expanded at run time), plus entry and
 *  verify. Doc-only: the fixed 5-field form is GONE (a procedure isn't a
 *  form — that rigidity was the point of the rework); validation is
 *  save-then-show-errors on the server (one validator, no duplication).
 *  Revision-guarded like every registry write. */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useYamlEditor } from '../composables/useYamlEditor.ts';

const props = defineProps<{ bundle: string; screens: Array<{ id: string; states: string[] }> }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

const ed = useYamlEditor();
const host = ref<HTMLElement | null>(null);
const err = ref('');
const saving = ref(false);
const revision = ref(1);

const TEMPLATE = `# ${'login procedure — steps form'}
# entry: how the runner reaches the form
# steps: tap / type / expect — type carries the text; \${env.NAME} refs expand
#   at run time (per-app names — define them on the env page)
# verify: when login counts as done (screen state holds)
login:
  entry:
    navigate:
      - on: home_login_bar_login_button
  steps:
    - type: { on: auth_login_phone_field, text: "\${env.DRILL_PHONE}" }
    - type: { on: auth_login_password_field, text: "\${env.DRILL_PASSWORD}" }
    - tap: { on: auth_login_button }
  verify:
    screen: auth
    state: session_on
`;

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
    err.value = '';
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
  const cur = await (await fetch(`/api/apps/${encodeURIComponent(props.bundle)}/login`)).json() as { login: unknown | null; revision: number };
  revision.value = cur.revision;
  const YAML = await import('yaml');
  const initial = cur.login
    ? `login:\n${YAML.stringify(cur.login).split('\n').filter((l: string) => l.trim()).map((l: string) => `  ${l}`).join('\n')}\n`
    : TEMPLATE;
  await ed.mount(host.value, initial, () => void save());
  await nextTick();
});
onBeforeUnmount(() => { /* the editor host dies with the DOM; nothing to unmount */ });
</script>

<template>
  <div class="lfp-overlay" @click.self="emit('close')">
    <div class="lfp lfp-doc-only">
      <div class="lfp-head">
        <span class="lfp-title">login flow</span>
        <span class="lfp-meta">{{ bundle }}</span>
        <span class="lfp-mode">steps form · save validates</span>
        <button class="lfp-x" @click="emit('close')">×</button>
      </div>
      <div class="lfp-body-doc">
        <div class="doc-h">the procedure — what bare <span class="mono">ensure login:</span> runs</div>
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
</template>

<style scoped>
.lfp-overlay { position: fixed; inset: 0; z-index: 200; background: color-mix(in srgb, var(--color-void) 80%, transparent); display: grid; place-items: center; }
.lfp { width: min(1080px, 94vw); max-height: 88vh; display: grid; grid-template-rows: auto 1fr; border: 1px solid var(--color-slate); background: var(--color-graphite); overflow: hidden; }
.lfp-head { display: flex; gap: var(--s-3); align-items: baseline; padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--color-iron); }
.lfp-title { font-weight: var(--weight-bold); font-size: var(--text-label); }
.lfp-meta { color: var(--color-steel); font-size: var(--text-caption); overflow: hidden; text-overflow: ellipsis; }
.lfp-mode { color: var(--color-pewter); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; margin-left: auto; }
.lfp-x { color: var(--color-pewter); font-size: var(--text-label); }
.lfp-x:hover { color: var(--color-paper); }
.lfp-body-doc { display: flex; flex-direction: column; padding: var(--s-3) var(--s-4); min-height: 0; }
.doc-h { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-steel); margin-bottom: var(--s-2); }
.doc-h .mono { font-family: var(--font-mono); text-transform: none; letter-spacing: 0; }
.cm-host { flex: 1; min-height: 340px; overflow: hidden; display: flex; }
.cm-host > :deep(.cm-editor) { flex: 1; }
.ed-err { color: var(--color-ember); font-size: var(--text-caption); margin-top: var(--s-2); white-space: pre-wrap; }
.lfp-acts { display: flex; gap: var(--s-2); align-items: center; margin-top: var(--s-3); }
.lfp-acts .danger { border: none; color: var(--color-ember); font-size: var(--text-caption); }
.lfp-acts .danger:hover { color: var(--color-ember-dim); }
.btn { display: inline-flex; align-items: center; padding: 6px var(--s-3); background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-body); min-height: 30px; cursor: pointer; }
.btn-primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-paper); font-weight: var(--weight-bold); }
</style>
