<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { parseCaseYaml } from '@crucible/shared/case-yaml';
import { useYamlEditor } from '../composables/useYamlEditor.ts';
import CaseVersions from './CaseVersions.vue';

/** The ONE case editor: metadata (name / description) above,
 *  yaml steps below — a single component, a single save, a single dirty flag.
 *  Opens inline under its row; the page guards switching via isDirty. */

interface OutlineStep { idx: number; kind: string; detail: string; soft?: boolean }

const props = defineProps<{
  templateId: string;
  caseName: string;
  /** 1-based position + count within the current filter, for the hopper */
  position: number;
  total: number;
  /** last-saved timestamp (ms) — rendered as "· saved Xm/h ago" */
  updatedAt?: number;
  /** attribution — who authored / last edited this case */
  updatedBy?: string | null;
  description: string | null;
  /** deep-link: open history on this revision (from a run's version chip) */
  deepRev?: number | null;
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved', templateId: string): void;
  (e: 'hop', direction: -1 | 1): void;
}>();

// ── metadata ──
const name = ref('');
const description = ref('');

// ── version history (option A quiet footer): revisions strip, always
// visible; picking one flips the yaml column read-only. No disclosure. ──
const viewingRev = ref<number | 'current' | null>(null); // null ≡ 'current' (default editing)
const snapshots = new Map<number, string>(); // revision → yaml (fetched on demand)
const editingYaml = ref(''); // the live doc before a revision view took over
const currentRevision = ref<number | null>(null);
async function loadVersionsFooter(): Promise<void> {
  try {
    const res = await fetch(`/api/templates/${props.templateId}/versions`);
    const body = (await res.json()) as { versions: Array<{ revision: number; yaml: string }> };
    currentRevision.value = body.versions.length ? Math.max(...body.versions.map((v) => v.revision)) : null;
    for (const v of body.versions) snapshots.set(v.revision, v.yaml);
  } catch { currentRevision.value = null; }
}
onMounted(loadVersionsFooter);
/** Footer pick: 'current' = edit the live case (restore the stashed doc);
 *  N = show revision N read-only. Stash/restore so switching never loses
 *  edits. Selection always moves — the footer refuses unselect. */
function pickRevision(which: number | 'current'): void {
  if (which === 'current') {
    viewingRev.value = null; // null ≡ current — editing mode
    ed.setEditable(true);
    ed.setValue(editingYaml.value);
    return;
  }
  if (viewingRev.value === null || viewingRev.value === 'current') editingYaml.value = ed.getValue();
  viewingRev.value = which;
  ed.setEditable(false); // CM-level read-only — CSS cannot stop a focused editor
  const yaml = snapshots.get(which) ?? '';
  ed.setValue(yaml === '' ? `# revision ${which} — backfill snapshot; yaml is captured from the first run after it` : yaml);
}
// deep-link: a rev in the query opens that revision read-only. The doc
// loads async AFTER mount — applying pickRevision before load() finishes
// would be overwritten by the live yaml. Capture now, apply at load end.
const pendingDeepRev = ref<number | null>(null);
watch(() => props.deepRev, (r) => { if (r != null) pendingDeepRev.value = r; }, { immediate: true });

// ── yaml editor ──
const editorHost = ref<HTMLElement | null>(null);
const ed = useYamlEditor();
const loading = ref(true);
const saving = ref(false);
const dirty = ref(false);
const msg = ref('');
const errors = ref<Array<{ line: number; message: string }>>([]);
const outline = ref<OutlineStep[]>([]);
const outlineStale = ref(false);

const STEP_LABEL: Record<string, string> = { tap: 'tap', scroll: 'scroll', type: 'type', runFlow: 'flow', expect: 'expect', alert: 'alert' };

function outlineFromSteps(steps: Array<Record<string, unknown>>, group: '' | 'setup' = ''): OutlineStep[] {
  return steps.map((s, i) => {
    const kind = String(s['action'] ?? '?');
    const sel = s['selector'] as { label?: string; identifier?: string; labelContains?: string } | undefined;
    let detail = '';
    if (kind === 'tap') detail = sel?.label ?? sel?.identifier ?? `${s['x']}, ${s['y']}`;
    else if (kind === 'scroll') detail = String(s['direction'] ?? '');
    else if (kind === 'alert') detail = String(s['alertAction'] ?? '');
    else if (kind === 'type') detail = String(s['text'] ?? '');
    else if (kind === 'runFlow') detail = String(s['templateId'] ?? '?');
    else if (kind === 'expect') detail = sel?.labelContains !== undefined ? `contains: ${sel.labelContains}` : sel?.label ?? sel?.identifier ?? '?';
    const when = typeof s['when'] === 'string' ? ` (when: ${s['when']})` : '';
    return { idx: group === 'setup' ? i + 1 : i + 1, kind: group ? `${group}.${STEP_LABEL[kind] ?? kind}` : STEP_LABEL[kind] ?? kind, detail: detail + when, soft: s['optional'] === true };
  });
}

let parseTimer: ReturnType<typeof setTimeout> | null = null;
function reparse(): void {
  if (parseTimer) clearTimeout(parseTimer);
  parseTimer = setTimeout(() => {
    const text = ed.getValue();
    const r = parseCaseYaml(text);
    if (r.ok && r.case) {
      const setupRows = r.case.setup ? outlineFromSteps(r.case.setup as unknown as Array<Record<string, unknown>>, 'setup') : [];
      outline.value = [...setupRows, ...outlineFromSteps(r.case.steps as unknown as Array<Record<string, unknown>>)];
      outlineStale.value = false;
      errors.value = [];
    } else {
      errors.value = r.errors;
      outlineStale.value = true; // outline freezes on last good parse
    }
    ed.setErrors(r.ok ? [] : r.errors.map((e) => e.line));
  }, 300);
}

async function load(): Promise<void> {
  loading.value = true;
  dirty.value = false;
  errors.value = [];
  msg.value = '';
  try {
    const res = await fetch(`/api/templates/${props.templateId}/yaml`);
    if (!res.ok) { msg.value = 'case not found'; return; }
    const { yaml } = (await res.json()) as { yaml: string };
    name.value = props.caseName;
    description.value = props.description ?? '';
    await nextTick();
    if (!editorHost.value) return;
    if (!ed.ready.value) {
      let vocab: import('../composables/useYamlEditor').EditorVocabulary | undefined;
      try {
        const r = await fetch('/api/templates/vocabulary');
        if (r.ok) vocab = (await r.json()) as import('../composables/useYamlEditor').EditorVocabulary;
      } catch { /* grammar-only completions */ }
      await ed.mount(editorHost.value, yaml, save, vocab);
      editorHost.value.addEventListener('input', () => { dirty.value = true; reparse(); });
    } else {
      ed.setValue(yaml);
      reparse();
    }
    reparse();
  } catch { msg.value = 'load failed'; } finally {
    loading.value = false;
    // deep-link wins AFTER the live doc is in place (see pendingDeepRev)
    if (pendingDeepRev.value != null) { const r = pendingDeepRev.value; pendingDeepRev.value = null; pickRevision(r); }
  }
}

/** ONE save: metadata first (name/description via the template PATCH route;
 *  tags ride the yaml — the PUT persists them from the parsed document),
 *  then the yaml (PUT :id/yaml validates + persists steps). */
async function save(): Promise<void> {
  if (saving.value) return;
  // Viewing an old revision read-only: the editor shows the SNAPSHOT's
  // yaml — saving here would silently overwrite the live case with old
  // content. Guard at the choke point (button, ⌘↵, switch-modal all
  // funnel here). Return to editing first.
  if (viewingRev.value !== null && viewingRev.value !== 'current') { pickRevision('current'); return; }
  saving.value = true;
  msg.value = '';
  try {
    const meta = await fetch(`/api/templates/${props.templateId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: name.value.trim() || props.caseName,
        description: description.value.trim() || null,
      }),
    });
    if (!meta.ok) { msg.value = `metadata save failed (${meta.status})`; return; }
    const yamlText = ed.getValue();
    const res = await fetch(`/api/templates/${props.templateId}/yaml`, {
      // collision-safety T3: yaml is content — the save carries the token the
      // case was loaded with; a mismatch = someone else edited meanwhile.
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: yamlText, ...(props.updatedAt ? { expectedUpdatedAt: props.updatedAt } : {}) }),
    });
    if (res.status === 409) {
      const b = (await res.json().catch(() => ({}))) as { code?: string; updatedBy?: string | null };
      if (b.code === 'EDIT_CONFLICT') {
        msg.value = `edited by ${b.updatedBy ?? 'someone'} since you loaded — reloading (your yaml is still in the editor; re-apply after reviewing)`;
        emit('saved', props.templateId); // reloads the case underneath; editor text kept
        dirty.value = true;
        return;
      }
    }
    if (res.status === 422 || res.status === 409) {
      const b = (await res.json()) as { errors: Array<{ line: number; message: string }> };
      errors.value = b.errors ?? [];
      ed.setErrors(errors.value.map((e) => e.line));
      msg.value = 'metadata saved — yaml not saved (fix the highlighted lines)';
      dirty.value = true; // yaml still unsaved
      return;
    }
    if (!res.ok) { msg.value = `save failed (${res.status})`; return; }
    dirty.value = false;
    msg.value = 'saved — case updated';
    emit('saved', props.templateId);
    setTimeout(() => { msg.value = ''; }, 2500);
  } catch { msg.value = 'save request failed'; } finally { saving.value = false; }
}

function copyYaml(): void {
  void navigator.clipboard.writeText(ed.getValue());
  msg.value = 'copied';
  setTimeout(() => { if (msg.value === 'copied') msg.value = ''; }, 1500);
}

function maybeClose(): void {
  if (dirty.value && !window.confirm('unsaved changes — close anyway?')) return;
  emit('close');
}

function hop(dir: -1 | 1): void {
  if (dirty.value && !window.confirm('unsaved changes — move to another case anyway?')) return;
  emit('hop', dir);
}

// parent-driven guard surface: the page asks before switching/closing
defineExpose({ isDirty: () => dirty.value, saveNow: () => save() });

function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') { ev.stopPropagation(); maybeClose(); }
}

onMounted(() => { void load(); window.addEventListener('keydown', onKey, true); });
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey, true); if (parseTimer) clearTimeout(parseTimer); });
watch(() => props.templateId, () => { void load(); });

const stepsCount = computed(() => outline.value.length);
const savedAgo = computed((): string | null => {
  if (!props.updatedAt) return null;
  const s = Math.max(1, Math.round((Date.now() - props.updatedAt) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
});
</script>

<template>
  <div class="ce-panel">
    <div class="ce-head">
      <span class="fname">{{ caseName }}</span>
      <span class="meta">{{ stepsCount }} step{{ stepsCount === 1 ? '' : 's' }}<template v-if="savedAgo"> · saved {{ savedAgo }}</template><template v-if="updatedBy"> · by {{ updatedBy }}</template><template v-if="dirty"> · <span style="color: var(--color-ember);">unsaved</span></template></span>
      <span v-if="total > 1" class="hop">
        <button class="btn btn-sm" :disabled="position <= 1" title="previous case in filter" @click="hop(-1)">‹</button>
        <span class="meta">{{ position }} / {{ total }}</span>
        <button class="btn btn-sm" :disabled="position >= total" title="next case in filter" @click="hop(1)">›</button>
      </span>
      <span class="spacer"></span>
      <button class="btn btn-sm" @click="maybeClose">esc · close</button>
      <button class="btn btn-sm" @click="copyYaml" title="copy the yaml to clipboard">&lt;/&gt; copy</button>
      <button class="btn btn-sm btn-primary" :disabled="saving || loading || (viewingRev !== null && viewingRev !== 'current')" :title="viewingRev !== null && viewingRev !== 'current' ? 'viewing a superseded state — back to current to save' : undefined" @click="save">{{ saving ? 'saving…' : '⌘↵ save' }}</button>
    </div>

    <!-- metadata: name / description (tags live in the yaml; ticket dropped
         until a Jira tie-in earns the field back) -->
    <div class="ce-meta" :class="{ ro: viewingRev !== null && viewingRev !== 'current' }">
      <label class="ce-field"><span>name</span><input v-model="name" :disabled="viewingRev !== null && viewingRev !== 'current'" @input="dirty = true" placeholder="case name" /></label>
      <label class="ce-field ce-wide"><span>description</span><input v-model="description" :disabled="viewingRev !== null && viewingRev !== 'current'" @input="dirty = true" placeholder="what this case verifies" /></label>
    </div>

    <div class="ce-body" :class="{ ro: viewingRev !== null && viewingRev !== 'current' }">
      <div class="outline">
        <div class="outline-title">steps<template v-if="outlineStale"> · <span style="color: var(--color-ember);">stale</span></template></div>
        <div v-for="s in outline" :key="s.idx" class="o-step" :title="s.detail">
          <span class="o-idx">{{ s.idx }}</span>
          <span class="o-kind" :class="{ 'k-expect': s.kind === 'expect', 'k-flow': s.kind === 'flow' }">{{ s.kind }}</span>
          <span class="o-detail">{{ s.detail }}<template v-if="s.soft"> <i style="color: var(--color-steel);">(soft)</i></template></span>
        </div>
        <div v-if="errors.length > 0" class="o-errs">
          <div v-for="e in errors" :key="e.message" style="padding: 3px 0;">✕ line {{ e.line }} — {{ e.message }}</div>
        </div>
      </div>
      <div class="editor">
        <div v-if="viewingRev !== null && viewingRev !== 'current'" class="ro-banner">
          viewing r{{ viewingRev }} — superseded state, read-only
          · <span class="ro-link" @click="pickRevision('current')">back to current</span>
        </div>
        <div v-if="loading" class="empty" style="border: none; padding: var(--s-4);">loading case…</div>
        <div v-show="!loading" ref="editorHost" class="cm-host" :class="{ ro: viewingRev !== null && viewingRev !== 'current' }"></div>
      </div>
    </div>
    <CaseVersions :template-id="templateId" :viewing="viewingRev === null ? 'current' : viewingRev" @pick="pickRevision" />
    <div v-if="msg" class="ce-foot">{{ msg }}</div>
  </div>
</template>

<style scoped>
.ce-panel {
  display: grid; grid-template-rows: auto auto 1fr auto auto;
  min-height: 0;
  border: 1px solid var(--color-ash, #3a3a3a);
  border-radius: var(--r-sm, 2px);
  background: var(--color-void, #0a0a0a);
  overflow: hidden;
}
/* read-only revision view: banner + dimmed editor + disabled inputs */
.ro-banner {
  display: flex; gap: 8px; align-items: baseline;
  padding: 5px 12px; border-bottom: 1px solid var(--color-iron, #202020);
  border-left: 2px solid var(--color-amber, #d9a03f);
  color: var(--color-amber, #d9a03f); font-size: 11px;
}
.ro-link { text-decoration: underline; cursor: pointer; }
.ce-meta.ro, .ce-body.ro { opacity: .55; }
.cm-host.ro { pointer-events: none; filter: saturate(.6); }
.ce-head {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-bottom: 1px solid var(--color-iron, #202020);
  background: var(--color-carbon, #111);
}
.fname { color: var(--color-paper); font-weight: 700; }
.meta { color: var(--color-steel); font-size: var(--text-caption); }
.hop { display: flex; align-items: center; gap: 4px; }
.spacer { flex: 1; }
/* metadata row */
.ce-meta {
  display: grid; grid-template-columns: 1.2fr 0.8fr 2fr 1fr; gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  border-bottom: 1px solid var(--color-iron);
  background: var(--color-carbon, #111);
}
.ce-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.ce-field span { font-size: 10px; color: var(--color-steel); text-transform: uppercase; letter-spacing: 0.08em; }
.ce-field input {
  background: var(--color-void); border: 1px solid var(--color-iron); border-radius: var(--r-sm);
  color: var(--color-paper); font: inherit; font-size: 12px; padding: 4px 8px; width: 100%;
}
.ce-field input:focus { outline: none; border-color: var(--color-accent); }
.ce-wide { grid-column: span 1; }
@media (max-width: 1000px) { .ce-meta { grid-template-columns: 1fr 1fr; } }
/* body: outline | editor */
.ce-body { display: grid; grid-template-columns: 300px 1fr; min-height: 0; overflow: hidden; }
.outline { border-right: 1px solid var(--color-iron); overflow: auto; padding: 10px 0; }
.outline-title { font-size: 10px; color: var(--color-steel); text-transform: uppercase; letter-spacing: 0.1em; padding: 2px 12px 8px; }
.o-step { display: flex; gap: 8px; align-items: baseline; padding: 5px 12px; color: var(--color-fog); font-size: 12px; }
.o-step:hover { background: var(--color-carbon); }
.o-idx { color: var(--color-steel); width: 18px; text-align: right; }
.o-kind { font-size: 10px; border: 1px solid var(--color-ash); border-radius: 2px; padding: 0 5px; color: var(--color-paper); flex: none; }
.o-kind.k-expect { border-color: var(--color-accent); color: var(--color-accent); }
.o-kind.k-flow { border-color: var(--color-ok, #2fbf71); color: var(--color-ok, #2fbf71); }
.o-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.o-errs { margin-top: 8px; padding: 8px 12px; color: var(--color-fail, #e5484d); font-size: 11px; border-top: 1px solid var(--color-iron); }
.editor { display: flex; flex-direction: column; min-height: 0; }
.cm-host { flex: 1; min-height: 260px; overflow: hidden; display: flex; }
.cm-host > :deep(.cm-editor) { flex: 1; }
.ce-foot { padding: 6px 12px; border-top: 1px solid var(--color-iron); color: var(--color-fog); font-size: var(--text-caption); background: var(--color-carbon); }
</style>
