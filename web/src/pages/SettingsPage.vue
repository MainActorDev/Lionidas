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
const loaded = ref(false);
const error = ref('');

const openSections = ref(new Set<string>(['cred']));
function toggleSec(k: string): void {
  const s = new Set(openSections.value);
  if (s.has(k)) s.delete(k); else s.add(k);
  openSections.value = s;
}

async function load(): Promise<void> {
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
.st-meta { color: var(--color-steel); font-size: 10px; white-space: nowrap; justify-self: end; }
.st-err { color: var(--color-ember); font-size: var(--text-label); margin-bottom: var(--s-3); }
.st-empty { color: var(--color-steel); font-size: var(--text-label); }
</style>
