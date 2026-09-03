<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { parseCaseYaml } from '@crucible/shared/case-yaml';
import { useYamlEditor } from '../composables/useYamlEditor.ts';

/** A2 viewport-locked split panel: outline (live parse) | CodeMirror yaml.
 *  While open, TemplatesPage locks its layout (table scrolls internally) —
 *  this component owns only the panel itself. Case hopping (‹ ›) is driven
 *  by emitted events; the page supplies the ordered case list. */

interface OutlineStep { idx: number; kind: string; detail: string; soft?: boolean }

const props = defineProps<{
  templateId: string;
  caseName: string;
  /** 1-based position + count within the current filter, for the hopper */
  position: number;
  total: number;
  /** last-saved timestamp (ms) — rendered as "· saved Xm/h ago" per A2 */
  updatedAt?: number;
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved', templateId: string): void;
  (e: 'hop', direction: -1 | 1): void;
}>();

const editorHost = ref<HTMLElement | null>(null);
const ed = useYamlEditor();
const loading = ref(true);
const saving = ref(false);
const dirty = ref(false);
const msg = ref('');
const errors = ref<Array<{ line: number; message: string }>>([]);
const outline = ref<OutlineStep[]>([]);
const outlineStale = ref(false);

const STEP_LABEL: Record<string, string> = { tap: 'tap', scroll: 'scroll', type: 'type', runFlow: 'flow', expect: 'expect' };

function outlineFromSteps(steps: Array<Record<string, unknown>>): OutlineStep[] {
  return steps.map((s, i) => {
    const kind = String(s['action'] ?? '?');
    const sel = s['selector'] as { label?: string; identifier?: string } | undefined;
    let detail = '';
    if (kind === 'tap' || kind === 'type') detail = sel?.label ?? sel?.identifier ?? `${s['x']}, ${s['y']}`;
    else if (kind === 'scroll') detail = String(s['direction'] ?? '');
    else if (kind === 'type') detail = String(s['text'] ?? '');
    else if (kind === 'runFlow') detail = String(s['templateId'] ?? '?');
    else if (kind === 'expect') detail = sel?.label ?? sel?.identifier ?? '?';
    return { idx: i + 1, kind: STEP_LABEL[kind] ?? kind, detail, soft: s['optional'] === true };
  });
}

let parseTimer: ReturnType<typeof setTimeout> | null = null;
function reparse(): void {
  if (parseTimer) clearTimeout(parseTimer);
  parseTimer = setTimeout(() => {
    const text = ed.getValue();
    const r = parseCaseYaml(text);
    if (r.ok && r.case) {
      outline.value = outlineFromSteps(r.case.steps as unknown as Array<Record<string, unknown>>);
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
    await nextTick();
    if (!editorHost.value) return;
    if (!ed.ready.value) {
      await ed.mount(editorHost.value, yaml, save);
      // value-change listener via CM updateListener would be ideal; polling
      // reparse on a light cadence is avoided — instead hook keyup host-wide
      editorHost.value.addEventListener('input', () => { dirty.value = true; reparse(); });
    } else {
      ed.setValue(yaml);
      reparse();
    }
    reparse();
  } catch { msg.value = 'load failed'; } finally { loading.value = false; }
}

async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  msg.value = '';
  try {
    const yamlText = ed.getValue();
    const res = await fetch(`/api/templates/${props.templateId}/yaml`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: yamlText }),
    });
    if (res.status === 422 || res.status === 409) {
      const b = (await res.json()) as { errors: Array<{ line: number; message: string }> };
      errors.value = b.errors ?? [];
      ed.setErrors(errors.value.map((e) => e.line));
      msg.value = 'not saved — fix the highlighted lines';
      return;
    }
    if (!res.ok) { msg.value = `save failed (${res.status})`; return; }
    dirty.value = false;
    msg.value = 'saved — serving updated';
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

/** hop guard: same unsaved protection as close — hopping away discards edits */
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
  <div class="yaml-panel">
    <div class="yaml-head">
      <span class="fname">{{ caseName }}</span>
      <span class="meta">{{ stepsCount }} step{{ stepsCount === 1 ? '' : 's' }}<template v-if="savedAgo"> · saved {{ savedAgo }}</template><template v-if="dirty"> · <span style="color: var(--color-ember);">unsaved</span></template></span>
      <span v-if="total > 1" class="hop">
        <button class="btn btn-sm" :disabled="position <= 1" title="previous case in filter" @click="hop(-1)">‹</button>
        <span class="meta">{{ position }} / {{ total }}</span>
        <button class="btn btn-sm" :disabled="position >= total" title="next case in filter" @click="hop(1)">›</button>
        <span class="meta hop-hint">· hop between cases without touching the table</span>
      </span>
      <span class="spacer"></span>
      <button class="btn btn-sm" @click="maybeClose">esc · close</button>
      <button class="btn btn-sm" @click="copyYaml" title="copy the yaml to clipboard">&lt;/&gt; copy</button>
      <button class="btn btn-sm btn-primary" :disabled="saving || loading" @click="save">{{ saving ? 'saving…' : '⌘↵ save' }}</button>
    </div>
    <div class="yaml-body">
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
        <div v-if="loading" class="empty" style="border: none; padding: var(--s-4);">loading case…</div>
        <div v-show="!loading" ref="editorHost" class="cm-host"></div>
      </div>
    </div>
    <div v-if="msg" class="yaml-foot">{{ msg }}</div>
  </div>
</template>

<style scoped>
.yaml-panel {
  display: grid; grid-template-rows: auto 1fr auto;
  min-height: 0;
  border: 1px solid var(--color-ash, #3a3a3a);
  border-radius: var(--r-sm, 2px);
  background: var(--color-void, #0a0a0a);
  overflow: hidden;
}
.yaml-head {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-bottom: 1px solid var(--color-iron, #202020);
  background: var(--color-carbon, #111);
}
.fname { color: var(--color-paper); font-weight: 700; }
.meta { color: var(--color-steel); font-size: var(--text-caption); }
.hop { display: flex; align-items: center; gap: 4px; }
.hop-hint { display: none; }
@media (min-width: 1100px) { .hop-hint { display: inline; } }
.spacer { flex: 1; }
.yaml-body { display: grid; grid-template-columns: 300px 1fr; min-height: 0; overflow: hidden; }
.outline { border-right: 1px solid var(--color-iron); overflow: auto; padding: 10px 0; }
.outline-title { font-size: 10px; color: var(--color-steel); text-transform: uppercase; letter-spacing: 0.1em; padding: 2px 12px 8px; }
.o-step { display: flex; gap: 8px; align-items: baseline; padding: 5px 12px; color: var(--color-fog); font-size: 12px; }
.o-step:hover { background: var(--color-carbon); }
.o-idx { color: var(--color-steel); width: 18px; text-align: right; }
.o-kind { font-size: 10px; border: 1px solid var(--color-ash); border-radius: 2px; padding: 0 5px; color: var(--color-paper); flex: none; }
.o-kind.k-expect { border-color: var(--color-ember); color: var(--color-ember); }
.o-kind.k-flow { border-color: var(--color-ok, #2fbf71); color: var(--color-ok, #2fbf71); }
.o-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.o-errs { margin-top: 8px; padding: 8px 12px; color: var(--color-fail, #e5484d); font-size: 11px; border-top: 1px solid var(--color-iron); }
.editor { display: flex; flex-direction: column; min-height: 0; }
.cm-host { flex: 1; min-height: 260px; overflow: hidden; display: flex; }
.cm-host > :deep(.cm-editor) { flex: 1; }
.yaml-foot { padding: 6px 12px; border-top: 1px solid var(--color-iron); color: var(--color-fog); font-size: var(--text-caption); background: var(--color-carbon); }
</style>
