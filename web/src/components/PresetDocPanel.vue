<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useYamlEditor } from '../composables/useYamlEditor.ts';

/** PresetDocPanel — the preset editor as an INLINE panel under its row
 *  (round 3, operator ask: same pattern as the traffic detail and the
 *  scenario document; the old modal is retired). Two columns: the editing
 *  form left, the response body right in a CodeMirror editor with JSON
 *  pretty-formatting. Same save contract as the modal had (PATCH fields,
 *  then PUT body — same id, memberships survive). */

interface PresetRow {
  id: string; name: string | null; method: string; path_pattern: string; match: string; status: number;
  headers_json: string | null; body_path: string | null; delay_ms: number | null;
  seq_json: string | null; failure: string | null; throttle_kbps: number | null;
}
interface LoadBody { text: string | null; contentType: string | null; bytes: number }

const props = defineProps<{ presetId: string }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

const name = ref('');
const method = ref('GET');
const pathPattern = ref('');
const match = ref<'exact' | 'glob' | 'regex'>('exact');
const status = ref(200);
const delayMs = ref<number | null>(null);
const throttleKbps = ref<number | null>(null);
const failure = ref<string | null>(null);
const contentType = ref('');
const seqText = ref('');
const seqOpen = ref(false);

const loading = ref(true);
const saving = ref(false);
const msg = ref('');
const testUrl = ref('');
const testing = ref(false);
const testResult = ref<string | null>(null);

const MATCH_HELP: Record<string, string> = {
  exact: 'path must equal this string',
  glob: '* matches any characters — /api/*/tariff',
  regex: 'full JavaScript regex tested against the path',
};
const FAILURE_HELP: Record<string, string> = {
  timeout: 'hang the request — never answers',
  reset: 'drop the connection mid-response',
  malformed: 'send garbage bytes as the response',
  throttle: 'trickle the response at throttle kbps',
};

const headersText = ref('{}');
const headersValid = computed((): boolean => {
  try {
    const o = JSON.parse(headersText.value) as unknown;
    return typeof o === 'object' && o !== null && !Array.isArray(o);
  } catch { return false; }
});

// ── body editor (CodeMirror via the house composable) + JSON prettify ──
const ed = useYamlEditor();
const host = ref<HTMLElement | null>(null);
const bodyDirty = ref(false);
const bodyLoadedText = ref('');
let suppressEcho = false;

function prettyJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
function onBodyChanged(): void { bodyDirty.value = true; }

function formDirty(): boolean { return true; } // cheap: the save button is always armed; honest split messaging on failure

async function load(): Promise<void> {
  loading.value = true;
  msg.value = '';
  try {
    const res = await fetch(`/api/forge/presets/${props.presetId}`);
    if (!res.ok) { msg.value = 'preset not found'; return; }
    const body = res.json() as Promise<{ preset: PresetRow; body: LoadBody }>;
    const { preset, body: b } = await body;
    name.value = preset.name ?? '';
    method.value = preset.method;
    pathPattern.value = preset.path_pattern;
    match.value = preset.match as 'exact' | 'glob' | 'regex';
    status.value = preset.status;
    delayMs.value = preset.delay_ms;
    throttleKbps.value = preset.throttle_kbps;
    failure.value = preset.failure;
    headersText.value = preset.headers_json ? prettyJson(preset.headers_json) : '{}';
    contentType.value = b.contentType ?? '';
    seqText.value = preset.seq_json ? prettyJson(preset.seq_json) : '';
    testUrl.value = preset.path_pattern;
    bodyLoadedText.value = b.text ?? '';
  } catch { msg.value = 'load failed'; } finally { loading.value = false; }
}

async function save(): Promise<void> {
  if (saving.value) return;
  if (!pathPattern.value.startsWith('/')) { msg.value = 'path pattern must start with /'; return; }
  if (!headersValid.value) { msg.value = 'headers must be a valid JSON object'; return; }
  if (seqOpen.value && seqText.value.trim()) {
    try {
      const s = JSON.parse(seqText.value) as Array<{ status: number }>;
      if (!Array.isArray(s) || s.length === 0 || s.some((e) => typeof e.status !== 'number')) throw new Error('bad');
    } catch { msg.value = 'seq must be a JSON array of {status, delayMs?, bodyPath?}'; return; }
  }
  saving.value = true;
  msg.value = '';
  try {
    const res = await fetch(`/api/forge/presets/${props.presetId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: name.value.trim() || null,
        method: method.value,
        pathPattern: pathPattern.value,
        match: match.value,
        status: status.value,
        headers: JSON.parse(headersText.value) as Record<string, string>,
        ...(delayMs.value !== null ? { delayMs: delayMs.value } : { delayMs: null }),
        ...(throttleKbps.value !== null ? { throttleKbps: throttleKbps.value } : { throttleKbps: null }),
        ...(failure.value ? { failure: failure.value } : { failure: null }),
        ...(seqOpen.value && seqText.value.trim() ? { seq: JSON.parse(seqText.value) as Array<{ status: number }> } : { seq: null }),
      }),
    });
    const b = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || !b.ok) { msg.value = b.error ?? `fields saved failed (${res.status})`; return; }
    const bodyText = ed.getValue();
    if (bodyText !== '' || contentType.value !== '') {
      const res2 = await fetch(`/api/forge/presets/${props.presetId}/body`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: bodyText, ...(contentType.value ? { contentType: contentType.value } : {}) }),
      });
      const b2 = (await res2.json()) as { ok?: boolean; error?: string };
      if (!res2.ok || !b2.ok) { msg.value = `fields saved · body not saved — ${b2.error ?? res2.status}`; return; }
    }
    emit('saved');
  } catch { msg.value = 'save request failed'; } finally { saving.value = false; }
}

async function testPattern(): Promise<void> {
  if (!testUrl.value || testing.value) return;
  testing.value = true;
  testResult.value = null;
  try {
    const res = await fetch('/api/forge/match-test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: testUrl.value, method: method.value }),
    });
    const b = (await res.json()) as { matched?: boolean; presetId?: string; reason?: string };
    testResult.value = b.matched ? `✓ preset ${b.presetId ?? '?'}` : 'no match';
  } catch { testResult.value = 'test request failed'; } finally { testing.value = false; }
}

function formatBody(): void {
  const t = ed.getValue();
  const p = prettyJson(t);
  if (p !== t) { suppressEcho = true; ed.setValue(p); setTimeout(() => { suppressEcho = false; }, 0); }
}

// Esc closes (scoped: no field focused) — the house pattern
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)) return;
  emit('close');
}

watch(() => props.presetId, () => { void load(); });
onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  // load FIRST — the loading v-if unmounts the host subtree, so mounting
  // before it would attach CodeMirror to a detached node (0-children host bug)
  await load();
  await nextTick();
  if (host.value) {
    await ed.mount(host.value, prettyJson(bodyLoadedText.value), () => void save());
    host.value.addEventListener('input', onBodyChanged);
  }
});
onBeforeUnmount(() => { window.removeEventListener('keydown', onKeydown); host.value?.removeEventListener('input', onBodyChanged); });
</script>

<template>
  <div class="pdp">
    <div class="pdp-head">
      <span class="pdp-t">preset</span>
      <span class="mono pdp-meta">{{ presetId }}</span>
      <span class="pdp-fill"></span>
      <button class="btn btn-sm" :disabled="saving" @click="emit('close')">✕</button>
    </div>
    <div v-if="loading" class="pdp-loading mono">loading preset…</div>
    <div v-else class="pdp-body">
      <div class="pdp-form">
        <label class="fld"><span class="k">name</span><input v-model="name" placeholder="e.g. tariff SG happy path" title="display name — the id stays the stable pin"></label>
        <div class="fld"><span class="k">method</span>
          <select v-model="method" style="width: 110px;">
            <option v-for="m in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*']" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
        <label class="fld"><span class="k">path pattern</span><input v-model="pathPattern" placeholder="/api/v1/tariff" class="mono-in" /></label>
        <div class="fld"><span class="k">match kind</span>
          <span style="display: flex; gap: var(--s-1); align-items: center; flex: 1;">
            <button v-for="m in ['exact', 'glob', 'regex']" :key="m" class="btn btn-sm" :class="{ 'btn-primary': match === m }" @click="match = m as 'exact' | 'glob' | 'regex'">{{ m }}</button>
            <span class="hint">{{ MATCH_HELP[match] }}</span>
          </span>
        </div>
        <div class="fld"><span class="k">test pattern</span>
          <span style="display: flex; gap: var(--s-2); align-items: center; flex: 1;">
            <input v-model="testUrl" placeholder="/api/v1/tariff?x=1" style="flex: 1;" />
            <button class="btn btn-sm" :disabled="testing || !testUrl" @click="testPattern">{{ testing ? '…' : 'test' }}</button>
            <span v-if="testResult" class="hint" :class="testResult.startsWith('✓') ? 'ok' : 'err'">{{ testResult }}</span>
          </span>
        </div>
        <div class="fld"><span class="k">status</span>
          <input v-model.number="status" type="number" min="100" max="599" style="width: 90px;" />
          <span class="k k2">delay ms</span>
          <input v-model.number="delayMs" type="number" min="0" placeholder="0" style="width: 90px;" title="hold the response this long before answering" />
          <span class="k k2">throttle kbps</span>
          <input v-model.number="throttleKbps" type="number" min="0" placeholder="—" style="width: 90px;" title="trickle the response at this speed" />
        </div>
        <div class="fld"><span class="k">failure mode</span>
          <span style="display: flex; gap: var(--s-1); align-items: center; flex: 1;">
            <button class="btn btn-sm" :class="{ 'btn-primary': failure === null }" @click="failure = null">none</button>
            <button v-for="f in ['timeout', 'reset', 'malformed', 'throttle']" :key="f" class="btn btn-sm" :class="{ 'btn-primary': failure === f }" :title="FAILURE_HELP[f]" @click="failure = f">{{ f }}</button>
          </span>
        </div>
        <label class="fld fld-col"><span class="k">headers</span>
          <textarea v-model="headersText" rows="3" :style="{ borderColor: headersValid ? undefined : 'var(--color-ember)' }" />
        </label>
        <div class="fld fld-col"><span class="k">sequence</span>
          <button class="btn btn-sm" @click="seqOpen = !seqOpen">{{ seqOpen ? '▾' : '▸' }} response sequence {{ seqText.trim() ? '· set' : '' }}</button>
          <span v-if="seqOpen" class="hint">each hit advances to the next response; the last repeats. JSON array of { status, delayMs?, bodyPath? }.</span>
          <textarea v-show="seqOpen" v-model="seqText" rows="5" placeholder='[{ "status": 500 }, { "status": 200 }]' />
        </div>
      </div>
      <div class="pdp-doc">
        <div class="pdp-doc-h">
          <span>response body</span>
          <button class="btn btn-sm" title="reformat as pretty JSON" @click="formatBody">{ } format json</button>
          <span class="pdp-fill"></span>
        </div>
        <input v-model="contentType" placeholder="content-type (e.g. application/json)" class="mono-in pdp-ct" />
        <div ref="host" class="cm-host"></div>
      </div>
    </div>
    <div class="pdp-foot">
      <span v-if="msg" class="mono" style="color: var(--color-ember);">{{ msg }}</span>
      <span class="pdp-fill"></span>
      <button class="btn btn-sm" @click="emit('close')">cancel</button>
      <button class="btn btn-sm btn-primary" :disabled="saving || !headersValid" @click="save">{{ saving ? 'saving…' : 'save preset' }}</button>
    </div>
  </div>
</template>

<script lang="ts">
export default { name: 'PresetDocPanel' };
</script>

<style scoped>
.pdp { background: var(--color-void); border-bottom: 1px solid var(--color-iron); }
.pdp-head { display: flex; align-items: center; gap: var(--s-2); padding: 8px 12px; border-bottom: 1px solid var(--color-iron); }
.pdp-t { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-pewter); }
.pdp-meta { font-size: 10px; color: var(--color-steel); }
.pdp-fill { flex: 1; }
.pdp-loading { padding: var(--s-3); font-size: var(--text-caption); color: var(--color-steel); }
.pdp-body { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); min-height: 0; }
.pdp-form { padding: var(--s-3) var(--s-4); overflow-y: auto; max-height: 480px; }
.pdp-doc { display: flex; flex-direction: column; padding: var(--s-3) var(--s-4); min-height: 0; border-left: 1px solid var(--color-iron); }
.pdp-doc-h { display: flex; align-items: center; gap: var(--s-2); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-steel); margin-bottom: var(--s-2); }
.pdp-ct { margin-bottom: var(--s-2); }
.cm-host { flex: 1; min-height: 300px; overflow: hidden; display: flex; }
.cm-host > :deep(.cm-editor) { flex: 1; }
.fld { display: flex; align-items: center; gap: var(--s-2); margin-bottom: var(--s-2); }
.fld-col { flex-direction: column; align-items: stretch; }
.fld .k { width: 90px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-steel); flex-shrink: 0; }
.fld .k2 { width: auto; margin-left: var(--s-2); }
.fld input, .fld textarea, .fld select { background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 5px var(--s-2); }
.fld input:focus, .fld textarea:focus { outline: 1px solid var(--color-ember); outline-offset: 0; }
.fld-col textarea { width: 100%; resize: vertical; }
.mono-in { font-family: var(--font-mono); }
.hint { font-size: var(--text-caption); color: var(--color-steel); margin-left: var(--s-2); }
.hint.ok { color: var(--color-fog); } .hint.err { color: var(--color-ember); }
.pdp-foot { display: flex; align-items: center; gap: var(--s-2); padding: 8px 12px; border-top: 1px solid var(--color-iron); }
.mono { font-family: var(--font-mono); }
</style>
