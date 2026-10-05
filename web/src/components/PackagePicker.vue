<script setup lang="ts">
/** Shared package picker (026-B grouped by app): lists CI-dropped packages
 *  from GET /api/packages grouped by bundle id, newest within each group,
 *  freshest group first. Emits `picked` with the package path. Apk rows are
 *  selectable for visibility but flagged (install lands with Android). */
import { computed, onMounted, ref } from 'vue';

export interface PkgRow { path: string; bundleId: string | null; version: string | null; kind: 'ipa' | 'apk'; mtimeMs: number; sizeBytes: number }
interface Group { key: string; bundleId: string | null; rows: PkgRow[] }

const props = defineProps<{ modelValue: boolean; title?: string }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'picked', path: string): void; (e: 'confirm', path: string): void }>();

const dir = ref('');
const rows = ref<PkgRow[]>([]);
const loaded = ref(false);
const err = ref('');
const pick = ref('');
const expanded = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const uploadErr = ref('');

async function load(): Promise<void> {
  err.value = '';
  try {
    const r = await fetch('/api/packages');
    const b = (await r.json()) as { dir?: string; packages?: PkgRow[] };
    dir.value = b.dir ?? '';
    rows.value = b.packages ?? [];
    loaded.value = true;
  } catch { err.value = 'package list failed'; }
}
onMounted(() => void load());

async function uploadFile(f: File): Promise<void> {
  uploading.value = true; uploadErr.value = '';
  try {
    const r = await fetch(`/api/packages?filename=${encodeURIComponent(f.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: f,
    });
    const b = (await r.json()) as { ok?: boolean; error?: string };
    if (!b.ok) { uploadErr.value = b.error ?? 'upload failed'; return; }
    await load(); // refresh the list; the new file lands on top (freshest)
  } catch { uploadErr.value = 'upload failed'; }
  finally { uploading.value = false; }
}
function onFileChosen(e: Event): void {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (f) void uploadFile(f);
  input.value = ''; // same file re-choosable
}

const groups = computed<Group[]>(() => {
  const byKey = new Map<string, PkgRow[]>();
  for (const p of rows.value) {
    const k = p.bundleId ?? 'unidentified';
    byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }
  return [...byKey.values()].map((list) => ({
    key: list[0]!.bundleId ?? 'unidentified',
    bundleId: list[0]!.bundleId,
    rows: [...list].sort((a, b) => b.mtimeMs - a.mtimeMs),
  })).sort((a, b) => b.rows[0]!.mtimeMs - a.rows[0]!.mtimeMs);
});

function ageOf(ms: number): string {
  const h = Math.floor((Date.now() - ms) / 3600_000);
  if (h < 1) return `${Math.max(1, Math.floor((Date.now() - ms) / 60_000))}m`;
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function sizeOf(bytes: number): string {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
  return `${Math.round(bytes / 1024 / 1024)}M`;
}
function choose(p: PkgRow): void {
  pick.value = p.path;
  if (p.kind === 'ipa') emit('picked', p.path);
}
</script>

<template>
  <div v-if="modelValue" class="pp-backdrop" @click.self="emit('update:modelValue', false)">
    <div class="pp-modal">
      <div class="pp-head">
        <span class="pp-title">{{ title ?? 'install package' }}</span>
        <button class="pp-linkbtn" :disabled="uploading" @click="fileInput?.click()">{{ uploading ? 'uploading…' : '+ choose file…' }}</button>
        <input ref="fileInput" type="file" accept=".ipa,.apk" style="display: none;" @change="onFileChosen" />
        <button class="pp-x" @click="emit('update:modelValue', false)">✕</button>
      </div>
      <div class="pp-body">
        <div v-if="!loaded && !err" class="pp-empty">listing packages…</div>
        <div v-else-if="err" class="pp-empty pp-err">{{ err }}</div>
        <div v-else-if="groups.length === 0" class="pp-empty">no packages — drop .ipa files in the packages dir, or choose a file above</div>
        <template v-else>
          <div v-for="g in groups" :key="g.key" class="pp-grp">
            <button type="button" class="pp-grp-head" @click="expanded = expanded === g.key ? null : g.key">
              <span class="pp-caret">{{ expanded === g.key ? '▾' : '▸' }}</span>
              <span class="pp-bundle">{{ g.bundleId ?? 'unidentified' }}</span>
              <span class="pp-n">{{ g.rows.length }}</span>
            </button>
            <div v-if="expanded === g.key" class="pp-rows">
              <div v-for="p in g.rows" :key="p.path" class="pp-row" :class="{ picked: pick === p.path, apk: p.kind === 'apk' }" @click="choose(p)">
                <span class="pp-name" :title="p.path">{{ p.path.split('/').pop() }}</span>
                <span class="pp-ver">{{ p.version ?? '' }}</span>
                <span class="pp-chip" :class="p.kind">{{ p.kind }}</span>
                <span class="pp-age">{{ ageOf(p.mtimeMs) }} · {{ sizeOf(p.sizeBytes) }}</span>
              </div>
            </div>
          </div>
        </template>
        <div v-if="uploadErr" class="pp-empty pp-err" style="padding-top: 0;">{{ uploadErr }}</div>
      </div>
      <div class="pp-actions">
        <button class="btn" @click="emit('update:modelValue', false)">cancel</button>
        <button class="btn btn-primary" :disabled="!pick || pick.endsWith('.apk')" @click="pick && emit('confirm', pick)">install</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pp-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.72); display: flex; align-items: center; justify-content: center; z-index: 90; }
.pp-modal { width: 560px; max-width: calc(100vw - 48px); background: var(--color-graphite); border: 1px solid var(--color-iron); display: flex; flex-direction: column; }
.pp-head { display: flex; align-items: center; padding: var(--s-4) var(--s-5); border-bottom: 1px solid var(--color-iron); }
.pp-title { font-size: var(--text-heading-sm); color: var(--color-paper); }
.pp-x { margin-left: auto; background: none; border: none; color: var(--color-steel); cursor: pointer; font-size: 15px; }
.pp-x:hover { color: var(--color-paper); }
.pp-linkbtn { margin-left: auto; background: none; border: none; font-family: var(--font-mono); font-size: var(--text-caption); color: var(--color-ash); cursor: pointer; padding: 0; }
.pp-linkbtn:hover { color: var(--color-paper); }
.pp-linkbtn:disabled { opacity: .5; cursor: default; }
.pp-x { margin-left: var(--s-3); }
.pp-dir { padding: var(--s-2) var(--s-5); font-size: var(--text-caption); color: var(--color-steel); border-bottom: 1px solid var(--color-iron); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-body { max-height: 340px; overflow-y: auto; min-height: 120px; }
.pp-empty { padding: var(--s-5); color: var(--color-ash); font-size: var(--text-label); }
.pp-err { color: var(--color-ember); }
.pp-grp-head { display: flex; align-items: center; gap: var(--s-2); width: 100%; background: none; border: none; padding: var(--s-2) var(--s-4); font-family: var(--font-mono); font-size: var(--text-caption); text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-steel); cursor: pointer; user-select: none; }
.pp-grp-head:hover { color: var(--color-fog); }
.pp-caret { width: 12px; flex: none; }
.pp-bundle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-n { margin-left: auto; color: var(--color-steel); }
.pp-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: var(--s-3); align-items: center; padding: var(--s-2) var(--s-5) var(--s-2) 30px; font-size: var(--text-label); color: var(--color-fog); cursor: pointer; border-top: 1px solid var(--color-iron); }
.pp-row:hover { background: var(--color-carbon); color: var(--color-paper); }
.pp-row.picked { background: var(--color-carbon); color: var(--color-paper); box-shadow: inset 2px 0 0 var(--color-ember); }
.pp-row.apk { opacity: .7; }
.pp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-ver { color: var(--color-ash); font-size: var(--text-caption); }
.pp-chip { font-size: 10px; padding: 1px 5px; border: 1px solid var(--color-iron); color: var(--color-ash); text-transform: uppercase; letter-spacing: 0.04em; }
.pp-chip.ipa { color: var(--color-ember); border-color: var(--color-ember-dim); }
.pp-age { color: var(--color-steel); font-size: var(--text-caption); }
.pp-actions { display: flex; gap: var(--s-2); padding: var(--s-3) var(--s-5); border-top: 1px solid var(--color-iron); justify-content: flex-end; }
</style>
