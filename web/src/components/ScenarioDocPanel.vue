<script setup lang="ts">
/** ScenarioDocPanel — the scenario document editor (plan 20260928T092527Z rev 2,
 *  sketch 021-c2). Form left, live yaml document right (the ScreenDocPanel
 *  contract: form→doc live, doc→form on debounce, the DOCUMENT owns truth at
 *  save). Save = PATCH scenario (name/launch_arg) + PUT members, sequential,
 *  with SPLIT partial-failure reporting (review F6). The folder path is
 *  derived at read — never stored in the doc (F9). */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useYamlEditor } from '../composables/useYamlEditor.ts';
import { parseScenarioYaml, scenarioToYaml } from '@crucible/shared/scenario-yaml';


export interface ScenarioDocPanelProps {
  scenarioId: string;
  name: string;
  launchArg: string | null;
  members: Array<{ preset_id: string; enabled: number; method: string; path_pattern: string; status: number }>;
  runCount: number;
  changedSincePlay: boolean;
}
const props = defineProps<ScenarioDocPanelProps>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void; (e: 'editPreset', id: string): void }>();

const ed = useYamlEditor();
const host = ref<HTMLElement | null>(null);
const err = ref('');
const saveMsg = ref('');
const saving = ref(false);

// ── form model ──
// ALL presets, unscoped (the page's list is folder-scoped since round 2 —
// binding the picker to it emptied the picker inside folders; bug fix)
const allPresetsFull = ref<Array<{ id: string; name: string | null; method: string; path_pattern: string; status: number }>>([]);
void (async () => {
  try {
    const res = await fetch('/api/forge/presets');
    allPresetsFull.value = (await res.json() as { presets: typeof allPresetsFull.value }).presets;
  } catch { /* picker degrades to members-only */ }
})();

const fName = ref(props.name);
// custom preset picker (operator ask): searchable, scrollable, house-styled —
// replaces the native <select> which can't search and renders OS-styled
const pickerOpen = ref(false);
const pickerSearch = ref('');
const fLaunchArg = ref(props.launchArg ?? '');
const fMembers = ref(props.members.map((m) => ({ ...m })));

const hints = computed(() => {
  const h: Record<string, { method?: string; path?: string; status?: number }> = {};
  for (const m of [...fMembers.value, ...allPresetsFull.value]) {
    const id = 'preset_id' in m ? m.preset_id : m.id;
    h[id] = { method: m.method, path: m.path_pattern, status: m.status };
  }
  return h;
});

// ── document ⇄ form (echo guard per ScreenDocPanel) ──
let suppressDocSync = false;
let docDirty = false;

function formToDoc(): string {
  return scenarioToYaml(
    {
      scenario: fName.value,
      id: props.scenarioId,
      presets: fMembers.value.map((m) => ({ preset: m.preset_id, enabled: m.enabled === 1 })),
      launchArg: fLaunchArg.value.trim() || null,
    },
    hints.value,
  );
}
async function docToForm(): Promise<void> {
  const r = parseScenarioYaml(ed.getValue());
  if (!r.ok) { err.value = r.errors.map((e) => `line ${e.line}: ${e.message}`).join(' · '); return; }
  suppressDocSync = true;
  fName.value = r.doc.scenario;
  fLaunchArg.value = r.doc.launchArg ?? '';
  fMembers.value = r.doc.presets.map((p) => {
    const hint = allPresetsFull.value.find((x) => x.id === p.preset);
    return { preset_id: p.preset, enabled: p.enabled ? 1 : 0, method: hint?.method ?? '?', path_pattern: hint?.path_pattern ?? '?', status: hint?.status ?? 0 };
  });
  err.value = '';
  await nextTick();
  await nextTick();
  suppressDocSync = false;
}
watch([fName, fLaunchArg, fMembers], () => {
  if (suppressDocSync || docDirty) return;
  ed.setValue(formToDoc());
}, { deep: true });

let blurTimer: ReturnType<typeof setTimeout> | null = null;
function onDocChanged(): void {
  docDirty = true;
  if (blurTimer) clearTimeout(blurTimer);
  blurTimer = setTimeout(() => { void docToForm().then(() => { docDirty = false; }); }, 400);
}

function addPreset(pid: string): void {
  if (!pid || fMembers.value.some((m) => m.preset_id === pid)) return;
  const p = allPresetsFull.value.find((x) => x.id === pid);
  if (p) fMembers.value.unshift({ preset_id: p.id, enabled: 1, method: p.method, path_pattern: p.path_pattern, status: p.status });
}

// ── save: DOCUMENT is truth; PATCH + PUT sequential with split reporting (F6) ──
async function save(): Promise<void> {
  saving.value = true;
  saveMsg.value = '';
  try {
    const parsed = parseScenarioYaml(ed.getValue());
    if (!parsed.ok) { err.value = parsed.errors.map((e) => `line ${e.line}: ${e.message}`).join(' · '); return; }
    const doc = parsed.doc;
    let nameSaved = false;
    const r1 = await fetch(`/api/forge/scenarios/${props.scenarioId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: doc.scenario, launchArg: doc.launchArg ?? null }),
    });
    if (r1.ok) nameSaved = true;
    else {
      const b = (await r1.json()) as { error?: string };
      err.value = b.error ?? `scenario save failed (${r1.status})`;
      return;
    }
    const r2 = await fetch(`/api/forge/scenarios/${props.scenarioId}/members`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ members: doc.presets.map((p) => ({ presetId: p.preset, enabled: p.enabled })) }),
    });
    if (!r2.ok) {
      const b = (await r2.json()) as { error?: string };
      saveMsg.value = `name saved · membership not saved — ${b.error ?? r2.status}`; // F6 split
      return;
    }
    saveMsg.value = 'saved';
    emit('saved');
  } finally {
    saving.value = false;
  }
}

const pickerGroups = computed(() => {
  const avail = allPresetsFull.value.filter((p) => !fMembers.value.some((m) => m.preset_id === p.id));
  const q = pickerSearch.value.trim().toLowerCase();
  const matched = q
    ? avail.filter((p) => (p.name ?? p.id).toLowerCase().includes(q) || `${p.method} ${p.path_pattern}`.toLowerCase().includes(q))
    : avail;
  const groups = new Map<string, typeof avail>();
  for (const p of matched) {
    const k = `${p.method} ${p.path_pattern}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }
  return [...groups.entries()].map(([key, rows]) => ({ key, method: rows[0]!.method, path: rows[0]!.path_pattern, rows }));
});
const pickerTotal = computed(() => pickerGroups.value.reduce((n, g) => n + g.rows.length, 0));
function pickPreset(pid: string): void {
  addPreset(pid);
  pickerSearch.value = '';
  pickerOpen.value = false;
}

const dirty = computed(() => docDirty || fName.value !== props.name || (fLaunchArg.value.trim() || null) !== (props.launchArg ?? null) || JSON.stringify(fMembers.value.map((m) => [m.preset_id, m.enabled])) !== JSON.stringify(props.members.map((m) => [m.preset_id, m.enabled])));

onMounted(async () => {
  if (!host.value) return;
  await ed.mount(host.value, formToDoc(), () => void save());
  host.value.addEventListener('input', onDocChanged);
});
onBeforeUnmount(() => { host.value?.removeEventListener('input', onDocChanged); if (blurTimer) clearTimeout(blurTimer); });
</script>

<template>
  <div class="scn-doc">
    <div class="scd-head">
      <span class="scd-t">scenario document</span>
      <span class="scd-meta mono">{{ fName }} · {{ scenarioId }}</span>
      <span v-if="changedSincePlay" class="chip changed" title="membership or preset bodies changed since the newest stamped run — edits apply from the next play (launch_arg is not part of the stamp)">changed since last play</span>
      <span class="scd-fill"></span>
      <button class="btn btn-sm" :disabled="saving" @click="emit('close')">✕</button>
    </div>
    <div class="scd-body">
      <div class="scd-form">
        <label class="fld"><span class="k">name</span><input v-model="fName" placeholder="countries-sg"></label>
        <label class="fld"><span class="k">id</span><input :value="scenarioId" disabled title="stable pin — variants and cases reference this id; rename freely"></label>
        <label class="fld"><span class="k">launch_arg</span><input v-model="fLaunchArg" placeholder="optional — e.g. LP_COUNTRY=SG"></label>
        <div class="sec-h">presets</div>
        <div v-for="(m, i) in fMembers" :key="m.preset_id" class="mrow">
          <input type="checkbox" :checked="m.enabled === 1" title="enabled presets are served when this scenario runs" @change="m.enabled = m.enabled === 1 ? 0 : 1" />
          <span class="chipx" :class="{ on: m.enabled === 1 }" :title="m.enabled === 1 ? 'served when this scenario runs' : 'member, but not served'">{{ m.enabled === 1 ? 'on' : 'off' }}</span>
          <b class="mono">{{ m.method }}</b>
          <span class="mono path" :title="m.path_pattern">{{ m.path_pattern }}</span>
          <span class="st mono">{{ m.status }}</span>
          <button class="btn btn-sm" title="edit what this preset serves — opens at its row in the presets section" @click="emit('editPreset', m.preset_id)">edit</button>
          <button class="btn btn-sm" title="remove from this scenario" @click="fMembers.splice(i, 1)">✕</button>
        </div>
        <div class="picker">
          <button class="btn btn-sm picker-toggle" :title="pickerTotal + ' preset(s) available'" @click="pickerOpen = !pickerOpen">{{ pickerOpen ? '▾' : '▸' }} + add preset <span class="mut">{{ pickerTotal }}</span></button>
          <div v-if="pickerOpen" class="picker-pop">
            <input v-model="pickerSearch" class="picker-search" placeholder="search name, method, path…" @keydown.esc="pickerOpen = false" />
            <div class="picker-list">
              <div v-for="g in pickerGroups" :key="g.key" class="picker-group mono">{{ g.method }} {{ g.path }}</div>
              <button v-for="p in pickerGroups.flatMap((g) => g.rows)" :key="p.id" class="picker-opt" :title="p.id" @click="pickPreset(p.id)">
                <span class="picker-name">{{ p.name ?? p.id }}</span>
                <span class="picker-st mono">{{ p.status }}</span>
              </button>
              <div v-if="pickerTotal === 0" class="picker-empty mono">no matching presets</div>
            </div>
          </div>
        </div>
      </div>
      <div class="scd-doc">
        <div class="doc-h">the document — what variants and the agent read</div>
        <div ref="host" class="cm-host"></div>
        <div v-if="err" class="ed-err">{{ err }}</div>
        <div class="scd-foot">
          <span class="mono">{{ runCount }} runs stamped</span>
          <span v-if="saveMsg" class="mono">{{ saveMsg }}</span>
          <span class="fill"></span>
          <button class="btn btn-sm" :disabled="!dirty || saving" @click="emit('close')">cancel</button>
          <button class="btn btn-sm btn-primary" :disabled="!dirty || saving" @click="save">{{ saving ? 'saving…' : 'save' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
export default { name: 'ScenarioDocPanel' };
</script>

<style scoped>
.scn-doc { border-top: 1px solid var(--color-iron); background: var(--color-void); }
.scd-head { display: flex; align-items: center; gap: var(--s-2); padding: 8px 12px; border-bottom: 1px solid var(--color-iron); }
.scd-t { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-pewter); }
.scd-meta { font-size: 10px; color: var(--color-steel); }
.scd-fill { flex: 1; }
.chip.changed { border: 1px solid color-mix(in srgb, var(--color-ember) 40%, transparent); color: var(--color-ember); font-family: var(--font-mono); font-size: 10px; padding: 2px 6px; border-radius: var(--r-sm); }
.scd-body { display: grid; grid-template-columns: minmax(340px, 5fr) minmax(0, 7fr); min-height: 0; }
.scd-form { padding: var(--s-3) var(--s-4); overflow-y: auto; max-height: 420px; min-height: 0; }
.scd-doc { display: flex; flex-direction: column; padding: var(--s-3) var(--s-4); min-height: 0; border-left: 1px solid var(--color-iron); }
.doc-h { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-steel); margin-bottom: var(--s-2); }
.cm-host { flex: 1; min-height: 260px; overflow: hidden; display: flex; }
.cm-host > :deep(.cm-editor) { flex: 1; }
.fld { display: flex; align-items: center; gap: var(--s-2); margin-bottom: var(--s-2); }
.fld .k { width: 90px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-steel); flex-shrink: 0; }
.fld input { flex: 1; background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 5px var(--s-2); }
.fld input:disabled { color: var(--color-steel); }
.sec-h { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-steel); margin: var(--s-3) 0 var(--s-2); }
.mrow { display: flex; align-items: center; gap: var(--s-2); padding: 5px 8px; font-size: var(--text-caption); border-bottom: 1px solid var(--color-iron); background: var(--color-carbon); }
.mrow:last-of-type { border-bottom: none; }
.mrow input[type='checkbox'] { width: auto; flex: none; } /* the global input width rule stretched it to 465px */
.mrow .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--color-fog); }
.mrow .st { color: var(--color-fog); font-size: 10px; }
.mrow.add { padding: var(--s-2) 8px; background: none; border-bottom: none; }
.chipx { border: 1px solid var(--color-iron); border-radius: var(--r-sm); font-family: var(--font-mono); font-size: 9px; color: var(--color-steel); padding: 0 4px; }
.chipx.on { color: var(--color-fog); border-color: var(--color-slate); }
/* custom preset picker: house-styled, searchable, capped+scrollable */
.picker { position: relative; margin-top: var(--s-2); }
.picker-toggle .mut { color: var(--color-steel); margin-left: 4px; }
.picker-pop { position: absolute; z-index: 40; top: calc(100% + 4px); left: 0; right: 0; background: var(--color-graphite); border: 1px solid var(--color-slate); border-radius: var(--r-sm); box-shadow: 0 12px 32px rgba(0,0,0,0.5); display: flex; flex-direction: column; }
.picker-search { width: calc(100% - 12px); margin: 6px; background: var(--color-void); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: 11px; padding: 5px 7px; box-sizing: border-box; }
.picker-search:focus { outline: 1px solid var(--color-ember); outline-offset: 0; }
.picker-list { max-height: 220px; overflow-y: auto; padding-bottom: 4px; }
.picker-group { padding: 6px 10px 2px; font-size: 10px; color: var(--color-steel); text-transform: none; letter-spacing: 0; }
.picker-opt { display: flex; align-items: center; gap: var(--s-2); width: 100%; text-align: left; padding: 6px 10px; background: none; border: none; color: var(--color-fog); font-family: var(--font-mono); font-size: 11px; cursor: pointer; }
.picker-opt:hover { background: var(--color-void); color: var(--color-paper); }
.picker-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picker-st { color: var(--color-steel); font-size: 10px; }
.picker-empty { padding: 10px; font-size: 11px; color: var(--color-steel); }
.ed-err { color: var(--color-ember); font-size: var(--text-caption); margin-top: var(--s-2); }
.scd-foot { display: flex; gap: var(--s-2); align-items: center; margin-top: var(--s-2); font-size: 10px; color: var(--color-steel); }
.scd-foot .fill { flex: 1; }
.mono { font-family: var(--font-mono); }
</style>
