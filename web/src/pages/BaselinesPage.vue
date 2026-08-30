<script setup lang="ts">
import { ref, onMounted } from 'vue';

interface Diff {
  id: string; run_id: string; scope_key: string; old_sha: string | null; new_sha: string;
  evidence_id: string | null; state: string;
  new_image_path: string | null; old_image_path: string | null;
}
const diffs = ref<Diff[]>([]);
const decided = ref('');

async function load(): Promise<void> {
  const res = await fetch('/api/baselines/diffs?state=pending');
  diffs.value = (await res.json() as { diffs: Diff[] }).diffs;
}
async function decide(id: string, action: 'approve' | 'reject'): Promise<void> {
  const res = await fetch(`/api/baselines/diffs/${id}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 'dashboard' }),
  });
  const body = await res.json() as { approved?: boolean; rejected?: boolean; withRerun?: boolean };
  decided.value = `${id} → ${action}${body.withRerun ? ' (baseline re-run)' : ''}`;
  await load();
}
onMounted(load);
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">baselines</div>
        <div class="page-desc">{{ diffs.length }} pending judgment{{ diffs.length === 1 ? '' : 's' }}</div>
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
  </div>
</template>
