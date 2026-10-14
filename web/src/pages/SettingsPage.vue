<script setup lang="ts">
/** Settings page (028, env-page anatomy): admin-only instance configuration.
 *  Sections: environment secrets (read-only env-status mirror — values live
 *  in env vars per the Phase 2 secrets decision, NEVER in the DB), storage
 *  locations (read-only, env-derived). Collapsible scope blocks inside one
 *  a2-list, env-page rhythm — future settings land as more sections. */
import { onMounted, ref } from 'vue';
import PageHeader from '../components/PageHeader.vue';

interface SecretStatus { githubToken: boolean; jiraToken: boolean; keys: Record<string, string> }

const secrets = ref<SecretStatus | null>(null);
const reposDir = ref('');
const packagesDirVal = ref('');
const readiness = ref<ReadinessRow[]>([]);
const loaded = ref(false);
const error = ref('');

interface ReadinessRow { key: string; label: string; state: 'ok' | 'fail' | 'skip'; detail: string }

const openSections = ref(new Set<string>(['cred', 'ready', 'models']));

/** models section (plan 20261014T084923Z step 5): registry editor — env names
 *  only, presence dots, combos as chains. PUT hot-reloads the router. */
interface ModelRow { id: string; kind: string; model: string; baseUrl: string | null; apiKeyEnv: string; keyPresent: boolean; priority: number; enabled: boolean }
interface ComboRow { id: string; members: string[]; strategy: string }
const modelRows = ref<ModelRow[]>([]);
const comboRows = ref<ComboRow[]>([]);
const defaultCombo = ref('');
const modelsError = ref('');
const modelsSource = ref('');
async function loadModelsSection(): Promise<void> {
  modelsError.value = '';
  try {
    const r = await fetch('/api/agent/models');
    if (!r.ok) { modelsSource.value = 'unavailable'; return; }
    const b = (await r.json()) as { registry: { models: ModelRow[]; combos: ComboRow[]; defaultCombo: string } | null; source: string };
    modelsSource.value = b.source;
    if (b.registry) { modelRows.value = b.registry.models; comboRows.value = b.registry.combos; defaultCombo.value = b.registry.defaultCombo; }
  } catch { modelsSource.value = 'unavailable'; }
}
async function saveModels(): Promise<void> {
  modelsError.value = '';
  const registry = { version: 1, defaultCombo: defaultCombo.value, models: modelRows.value.map((m) => ({
    id: m.id, kind: m.kind, ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}), model: m.model, apiKeyEnv: m.apiKeyEnv, priority: m.priority, enabled: m.enabled,
  })), combos: comboRows.value };
  const r = await fetch('/api/agent/models', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ registry }) });
  if (!r.ok) modelsError.value = ((await r.json()) as { error?: string }).error ?? `save failed (${r.status})`;
  else await loadModelsSection();
}
function toggleSec(k: string): void {
  const s = new Set(openSections.value);
  if (s.has(k)) s.delete(k); else s.add(k);
  openSections.value = s;
}

async function recheck(): Promise<void> {
  try {
    const r = await fetch('/api/setup/readiness');
    if (r.ok) readiness.value = ((await r.json()) as { rows: ReadinessRow[] }).rows ?? [];
  } catch { /* display-only */ }
}

async function load(): Promise<void> {
  void loadModelsSection();
  error.value = '';
  try {
    const r = await fetch('/api/settings/secrets');
    if (!r.ok) { error.value = r.status === 403 ? 'admin only' : `load failed (${r.status})`; loaded.value = true; return; }
    secrets.value = (await r.json()) as SecretStatus;
  } catch { error.value = 'load failed'; }
  try {
    const r = await fetch('/api/settings/repos-dir');
    if (r.ok) reposDir.value = ((await r.json()) as { dir?: string }).dir ?? '';
  } catch { /* display-only */ }
  try {
    const r = await fetch('/api/packages');
    if (r.ok) packagesDirVal.value = ((await r.json()) as { dir?: string }).dir ?? '';
  } catch { /* display-only */ }
  await recheck();
  loaded.value = true;
}
onMounted(() => void load());
</script>

<template>
  <div>
    <PageHeader title="settings">
      <span class="ph-desc">instance configuration — environment, storage · admin only</span>
    </PageHeader>

    <div v-if="error" class="st-err">{{ error }}</div>
    <div v-if="!loaded && !error" class="st-empty">loading…</div>

    <div v-if="loaded" class="st-list a2-list">
      <!-- environment readiness section (T2): re-checkable checklist -->
      <div class="scope-block" :class="{ open: openSections.has('ready') }">
        <div class="a2-group-head scope-head" @click="toggleSec('ready')">
          <span class="caret">{{ openSections.has('ready') ? '▾' : '▸' }}</span>
          <span class="tag">readiness</span>
          <span class="owner">environment checklist — tokens, storage, toolchain</span>
          <span class="cnt">{{ readiness.filter(r => r.state === 'ok').length }}/{{ readiness.length || '…' }}</span>
        </div>
        <div class="scope-body">
          <div class="st-thead"><span>check</span><span>state</span><span>detail</span></div>
          <div v-for="r in readiness" :key="r.key" class="st-row">
            <span class="st-key">{{ r.label }}</span>
            <span class="st-val" :class="r.state === 'ok' ? 'ok' : r.state === 'skip' ? 'dim' : 'bad'">{{ r.state === 'ok' ? '✓ ok' : r.state === 'skip' ? '◌ skip' : '✗ fail' }}</span>
            <span class="st-meta wide">{{ r.detail }}</span>
          </div>
          <div class="st-row">
            <span class="st-key">re-check</span>
            <span></span>
            <span class="st-meta"><button class="btn-link" @click="recheck">run checks again</button></span>
          </div>
        </div>
      </div>

      <!-- environment secrets section: read-only env-status mirror -->
      <div class="scope-block" :class="{ open: openSections.has('cred') }">
        <div class="a2-group-head scope-head" @click="toggleSec('cred')">
          <span class="caret">{{ openSections.has('cred') ? '▾' : '▸' }}</span>
          <span class="tag">environment</span>
          <span class="owner">secrets read from env vars · read-only mirror</span>
          <span class="cnt">{{ secrets ? (Number(secrets.githubToken) + Number(secrets.jiraToken)) : '…' }}/2</span>
        </div>
        <div class="scope-body">
          <div class="st-thead"><span>secret</span><span>status</span><span></span></div>
          <div class="st-row">
            <span class="st-key">github token</span>
            <span class="st-val" :class="secrets?.githubToken ? 'ok' : 'dim'">{{ secrets?.githubToken ? '✓ set' : '✗ unset' }}</span>
            <span class="st-meta">{{ secrets?.keys.githubToken ?? 'CRUCIBLE_GITHUB_TOKEN' }} · set in env</span>
          </div>
          <div class="st-row">
            <span class="st-key">jira token</span>
            <span class="st-val" :class="secrets?.jiraToken ? 'ok' : 'dim'">{{ secrets?.jiraToken ? '✓ set' : '✗ unset' }}</span>
            <span class="st-meta">{{ secrets?.keys.jiraToken ?? 'JIRA_TOKEN' }} · set in env</span>
          </div>
          <div class="st-row empty">values never enter the database — set them where the server runs and restart</div>
        </div>
      </div>

      <!-- models section (plan 20261014T084923Z): registry editor -->
      <div class="scope-block" :class="{ open: openSections.has('models') }">
        <div class="a2-group-head scope-head" @click="toggleSec('models')">
          <span class="caret">{{ openSections.has('models') ? '▾' : '▸' }}</span>
          <span class="tag">models</span>
          <span class="owner">llm registry · routing & combos</span>
          <span class="cnt">{{ modelRows.length }}<template v-if="modelsSource === 'none'"> · unconfigured</template></span>
        </div>
        <div class="scope-body">
          <div v-if="modelsSource === 'none'" class="st-row empty">set BUTLER_MODELS_FILE to enable the registry — legacy single-model env is active</div>
          <div v-else-if="modelsSource === 'unavailable'" class="st-row empty">models API unavailable</div>
          <template v-else>
            <div class="st-thead"><span>id</span><span>kind · model</span><span>key</span></div>
            <div v-for="m in modelRows" :key="m.id" class="st-row">
              <span class="st-key">{{ m.id }} <template v-if="!m.enabled">(off)</template></span>
              <span class="st-val mono">{{ m.kind }} · {{ m.model }}</span>
              <span class="st-meta mono">{{ m.apiKeyEnv }} {{ m.keyPresent ? '✓' : '✗' }} · prio {{ m.priority }}</span>
            </div>
            <div class="st-thead" style="margin-top:10px"><span>combo</span><span>chain</span><span></span></div>
            <div v-for="c in comboRows" :key="c.id" class="st-row">
              <span class="st-key">{{ c.id }}<template v-if="c.id === defaultCombo"> ★</template></span>
              <span class="st-val mono">{{ c.members.join(' → ') }}</span>
              <span class="st-meta">{{ c.id === defaultCombo ? 'default' : '' }}</span>
            </div>
            <div class="st-row empty">edits save to the registry file and hot-reload the router — no restart · values never leave env vars</div>
            <div v-if="modelsError" class="st-row empty" style="color: var(--color-ember)">{{ modelsError }}</div>
          </template>
        </div>
      </div>

      <!-- storage section -->
      <div class="scope-block" :class="{ open: openSections.has('store') }">
        <div class="a2-group-head scope-head" @click="toggleSec('store')">
          <span class="caret">{{ openSections.has('store') ? '▾' : '▸' }}</span>
          <span class="tag">storage</span>
          <span class="owner">where the system keeps clones and packages</span>
          <span class="cnt">2</span>
        </div>
        <div class="scope-body">
          <div class="st-thead"><span>what</span><span>location</span><span></span></div>
          <div class="st-row">
            <span class="st-key">repos workspace</span>
            <span class="st-val" :title="reposDir">{{ reposDir || '—' }}</span>
            <span class="st-meta">CRUCIBLE_REPOS_DIR · read-only</span>
          </div>
          <div class="st-row">
            <span class="st-key">packages dir</span>
            <span class="st-val" :title="packagesDirVal">{{ packagesDirVal || '—' }}</span>
            <span class="st-meta">CRUCIBLE_PACKAGES_DIR · read-only</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.st-list { background: var(--color-carbon); border: 1px solid var(--color-iron); }
.scope-head .tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-fog); border: 1px solid var(--color-slate); border-radius: var(--r-sm); padding: 1px var(--s-2); }
.scope-head .cnt { color: var(--color-steel); font-size: var(--text-caption); border: 1px solid var(--color-iron); border-radius: var(--r-sm); padding: 0 var(--s-2); }
.scope-body { display: none; }
.scope-block.open .scope-body { display: block; }
.st-thead, .st-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.8fr) minmax(0, 220px); gap: var(--s-2); align-items: center; padding: 8px 12px; }
.st-thead { position: sticky; top: 0; z-index: 2; background: var(--color-graphite); font-size: 10px; color: var(--color-steel); text-transform: uppercase; letter-spacing: 0.08em; }
.st-row { border-bottom: 1px solid var(--color-iron); min-height: 44px; }
.st-row:hover { background: var(--color-graphite); }
.st-row.empty { color: var(--color-steel); font-size: var(--text-caption); }
.st-key { color: var(--color-paper); font-weight: var(--weight-bold); font-size: var(--text-label); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-val { color: var(--color-fog); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-val.ok { color: var(--color-ember); }
.st-val.dim { color: var(--color-steel); }
.st-val.bad { color: #d64545; }
.st-meta.wide { white-space: normal; overflow: visible; text-overflow: unset; font-size: 10px; }
.btn-link { background: none; border: none; color: var(--color-fog); font-size: 10px; text-decoration: underline; cursor: pointer; padding: 0; }
.btn-link:hover { color: var(--color-paper); }
.st-meta { color: var(--color-steel); font-size: 10px; white-space: nowrap; justify-self: end; }
.st-err { color: var(--color-ember); font-size: var(--text-label); margin-bottom: var(--s-3); }
.st-empty { color: var(--color-steel); font-size: var(--text-label); }
</style>
