<script setup lang="ts">
import { ref, onMounted } from 'vue';

interface Diff {
  id: string; run_id: string; scope_key: string; old_sha: string | null; new_sha: string;
  evidence_id: string | null; state: string;
  new_image_path: string | null; old_image_path: string | null;
}
const diffs = ref<Diff[]>([]);
const decided = ref('');

interface BaselineRow { id: string; scope_key: string; approved_by: string; approved_at: number; ticket_key: string | null }
const history = ref<BaselineRow[]>([]);
async function load(): Promise<void> {
  const res = await fetch('/api/baselines/diffs?state=pending');
  diffs.value = (await res.json() as { diffs: Diff[] }).diffs;
}
async function decide(id: string, action: 'approve' | 'reject'): Promise<void> {
  const res = await fetch(`/api/baselines/diffs/${id}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}), // identity comes from the session server-side
  });
  const body = await res.json() as { approved?: boolean; rejected?: boolean; withRerun?: boolean };
  decided.value = `${id} → ${action}${body.withRerun ? ' (baseline re-run)' : ''}`;
  await load();
}
async function loadHistory(): Promise<void> {
  try {
    const r = await fetch('/api/baselines');
    const b = await r.json() as { baselines?: BaselineRow[] };
    history.value = (b.baselines ?? []).slice(0, 20);
  } catch { /* best effort */ }
}
onMounted(() => { void load(); void loadHistory(); });
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">approvals</div>
        <div class="page-desc">{{ diffs.length }} pending review{{ diffs.length === 1 ? '' : 's' }}</div>
      </div>
    </div>

    <div v-if="decided" class="meta-row">{{ decided }}</div>
    <div v-if="diffs.length === 0" class="empty">no pending diffs — nothing needs judgment</div>

    <div v-for="d in diffs" :key="d.id" class="card card-accent">
      <div class="card-header">
        <span class="card-title">{{ d.scope_key }}</span>
        <span class="badge">run {{ d.run_id }}</span>
      </div>
      <div class="compare">
        <figure>
          <img v-if="d.old_image_path" :src="`/api/evidence/byPath?path=${encodeURIComponent(d.old_image_path)}`" alt="baseline" />
          <figcaption>baseline · {{ d.old_sha?.slice(0, 8) ?? 'none' }}</figcaption>
        </figure>
        <figure>
          <img v-if="d.evidence_id" :src="`/api/evidence/${d.evidence_id}/file`" alt="current" />
          <figcaption>current · {{ d.new_sha.slice(0, 8) }}</figcaption>
        </figure>
      </div>
      <div style="display: flex; gap: var(--s-2); margin-top: var(--s-3);">
        <button class="btn btn-primary" @click="decide(d.id, 'approve')">approve — intentional change</button>
        <button class="btn btn-danger" @click="decide(d.id, 'reject')">reject — regression</button>
      </div>
    </div>

    <div class="section-label" style="margin-top: var(--s-4);"><span>approval history</span></div>
    <div class="card table-wrap" style="padding: 0;" v-if="history.length > 0">
      <table>
        <thead><tr><th>scope</th><th>approved by</th><th>when</th><th>ticket</th></tr></thead>
        <tbody>
          <tr v-for="b in history" :key="b.id">
            <td style="font-family: monospace; font-size: 10px;">{{ b.scope_key }}</td>
            <td>{{ b.approved_by }}</td>
            <td style="color: var(--color-steel); font-size: 10px;">{{ new Date(b.approved_at).toLocaleString() }}</td>
            <td style="color: var(--color-steel);">{{ b.ticket_key ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
