<script setup lang="ts">
import { ref, computed, watch } from 'vue';

/** M3 preset editor: edit an existing preset in place (same id — scenario
 *  memberships survive). "test pattern" uses the server's match-test route —
 *  the matcher is never re-implemented in the UI. */

interface PresetRow {
  id: string; method: string; path_pattern: string; match: string; status: number;
  headers_json: string | null; body_path: string | null; delay_ms: number | null;
  seq_json: string | null; failure: string | null; throttle_kbps: number | null;
}
interface LoadBody { text: string | null; contentType: string | null; bytes: number }

const props = defineProps<{ presetId: string }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

const method = ref('GET');
const pathPattern = ref('');
const match = ref<'exact' | 'glob' | 'regex'>('exact');
const status = ref(200);
const delayMs = ref<number | null>(null);
const throttleKbps = ref<number | null>(null);
const failure = ref<string | null>(null);
const bodyText = ref('');
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

async function load(): Promise<void> {
  loading.value = true;
  msg.value = '';
  try {
    const res = await fetch(`/api/forge/presets/${props.presetId}`);
    if (!res.ok) { msg.value = 'preset not found'; return; }
    const body = res.json() as Promise<{ preset: PresetRow; body: LoadBody }>;
    const { preset, body: b } = await body;
    method.value = preset.method;
    pathPattern.value = preset.path_pattern;
    match.value = preset.match as 'exact' | 'glob' | 'regex';
    status.value = preset.status;
    delayMs.value = preset.delay_ms;
    throttleKbps.value = preset.throttle_kbps;
    failure.value = preset.failure;
    headersText.value = preset.headers_json ?? '{}';
    bodyText.value = b.text ?? '';
    contentType.value = b.contentType ?? '';
    seqText.value = preset.seq_json ? JSON.stringify(JSON.parse(preset.seq_json), null, 2) : '';
    testUrl.value = preset.path_pattern;
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
    // 1. column fields (only the editor's fields — never body_path/sha here)
    const res = await fetch(`/api/forge/presets/${props.presetId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
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
    if (!res.ok || !b.ok) { msg.value = b.error ?? `save failed (${res.status})`; return; }
    // 2. body (only when the preset has one or the text is non-empty)
    if (bodyText.value !== '' || contentType.value !== '') {
      const res2 = await fetch(`/api/forge/presets/${props.presetId}/body`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: bodyText.value, ...(contentType.value ? { contentType: contentType.value } : {}) }),
      });
      const b2 = (await res2.json()) as { ok?: boolean; error?: string };
      if (!res2.ok || !b2.ok) { msg.value = b2.error ?? `body save failed (${res2.status})`; return; }
    }
    emit('saved');
    emit('close');
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
    // route shape: { matched: boolean, presetId?, pathPattern?, reason }
    const b = (await res.json()) as { matched?: boolean; presetId?: string; reason?: string };
    testResult.value = b.matched ? `✓ preset ${b.presetId ?? '?'}` : 'no match';
  } catch { testResult.value = 'test request failed'; } finally { testing.value = false; }
}

watch(() => props.presetId, () => { void load(); }, { immediate: false });
void load();
</script>

<template>
  <div class="pe-backdrop" @click.self="emit('close')">
    <div class="pe-modal card">
      <div class="card-header">
        <span class="card-title">edit preset · {{ presetId }}</span>
        <button class="btn btn-sm" style="margin-left: auto;" @click="emit('close')">✕</button>
      </div>

      <div v-if="loading" class="empty" style="border: none;">loading preset…</div>
      <template v-else>
        <!-- pattern -->
        <div class="meta-row"><span class="k">method</span>
          <select v-model="method" style="width: 110px;">
            <option v-for="m in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*']" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
        <div class="meta-row"><span class="k">path pattern</span>
          <input v-model="pathPattern" placeholder="/api/v1/tariff" style="flex: 1; font-family: var(--font-mono, monospace);" />
        </div>
        <div class="meta-row"><span class="k">match kind</span>
          <span style="display: flex; gap: var(--s-1); align-items: center; flex: 1;">
            <button v-for="m in ['exact', 'glob', 'regex']" :key="m" class="btn btn-sm" :class="{ 'btn-primary': match === m }" @click="match = m as 'exact' | 'glob' | 'regex'">{{ m }}</button>
            <span style="font-size: var(--text-caption); color: var(--color-steel); margin-left: var(--s-2);">{{ MATCH_HELP[match] }}</span>
          </span>
        </div>
        <div class="meta-row"><span class="k">test pattern</span>
          <span style="display: flex; gap: var(--s-2); align-items: center; flex: 1;">
            <input v-model="testUrl" placeholder="/api/v1/tariff?x=1" style="flex: 1;" />
            <button class="btn btn-sm" :disabled="testing || !testUrl" @click="testPattern">{{ testing ? '…' : 'test' }}</button>
            <span v-if="testResult" style="font-size: var(--text-caption);" :class="testResult.startsWith('✓') ? 'status status-passed' : 'status status-fail'">{{ testResult }}</span>
          </span>
        </div>

        <!-- response -->
        <div class="meta-row"><span class="k">status</span>
          <input v-model.number="status" type="number" min="100" max="599" style="width: 90px;" />
          <span class="k" style="margin-left: var(--s-3);">delay ms</span>
          <input v-model.number="delayMs" type="number" min="0" placeholder="0" style="width: 90px;" title="hold the response this long before answering — simulates a slow API" />
          <span class="k" style="margin-left: var(--s-3);">throttle kbps</span>
          <input v-model.number="throttleKbps" type="number" min="0" placeholder="—" style="width: 90px;" title="trickle the response at this speed — simulates a slow network" />
        </div>
        <div class="meta-row"><span class="k">failure mode</span>
          <span style="display: flex; gap: var(--s-1); align-items: center; flex: 1;">
            <button class="btn btn-sm" :class="{ 'btn-primary': failure === null }" @click="failure = null">none</button>
            <button v-for="f in ['timeout', 'reset', 'malformed', 'throttle']" :key="f" class="btn btn-sm" :class="{ 'btn-primary': failure === f }" :title="FAILURE_HELP[f]" @click="failure = f">{{ f }}</button>
            <span v-if="failure" style="font-size: var(--text-caption); color: var(--color-steel); margin-left: var(--s-2);">{{ FAILURE_HELP[failure] }}</span>
          </span>
        </div>
        <div class="meta-row"><span class="k">response body</span>
          <span style="flex: 1; display: flex; flex-direction: column; gap: var(--s-1);">
            <input v-model="contentType" placeholder="content-type (e.g. application/json)" style="font-family: var(--font-mono, monospace);" />
            <textarea v-model="bodyText" rows="8" placeholder="the body served on match — empty serves no body" style="font-family: var(--font-mono, monospace); font-size: 11px;"></textarea>
          </span>
        </div>
        <div class="meta-row"><span class="k">headers</span>
          <textarea v-model="headersText" rows="3" :style="{ fontFamily: 'var(--font-mono, monospace)', fontSize: '11px', borderColor: headersValid ? undefined : 'var(--color-ember)' }" />
        </div>
        <div class="meta-row"><span class="k">sequence</span>
          <span style="flex: 1; display: flex; flex-direction: column; gap: var(--s-1);">
            <button class="btn btn-sm" @click="seqOpen = !seqOpen">{{ seqOpen ? '▾' : '▸' }} response sequence {{ seqText.trim() ? '· set' : '' }}</button>
            <span v-if="seqOpen" style="font-size: var(--text-caption); color: var(--color-steel);">each hit advances to the next response; the last repeats. JSON array of {'{'} status, delayMs?, bodyPath? {'}'}.</span>
            <textarea v-show="seqOpen" v-model="seqText" rows="5" placeholder='[{ "status": 500 }, { "status": 200 }]' style="font-family: var(--font-mono, monospace); font-size: 11px;"></textarea>
          </span>
        </div>

        <div v-if="msg" class="meta-row" style="color: var(--color-ember);">{{ msg }}</div>
        <div style="display: flex; gap: var(--s-2); justify-content: flex-end; margin-top: var(--s-3);">
          <button class="btn" @click="emit('close')">cancel</button>
          <button class="btn btn-primary" :disabled="saving || !headersValid" @click="save">{{ saving ? 'saving…' : 'save preset' }}</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pe-backdrop {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(0, 0, 0, 0.85);
}
.pe-modal {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  z-index: 91;
  width: min(720px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow: auto;
  background: var(--color-graphite);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  padding-bottom: var(--s-4);
}
</style>
