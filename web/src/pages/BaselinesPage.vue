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
  decided.value = `${id} → ${action}${body.withRerun ? ' (baseline flow re-run w/ updateBaselines)' : ''}`;
  await load();
}
onMounted(load);
</script>

<template>
  <main class="page">
    <header class="head">
      <h1>Baseline approvals</h1>
      <RouterLink to="/runs" class="mono dim">← runs</RouterLink>
    </header>
    <p v-if="decided" class="mono ok">{{ decided }}</p>
    <p v-if="diffs.length === 0" class="dim">No pending baseline diffs — nothing needs judgment.</p>

    <article v-for="d in diffs" :key="d.id" class="card">
      <header>
        <strong class="mono">{{ d.scope_key }}</strong>
        <span class="mono dim">run {{ d.run_id }}</span>
      </header>
      <div class="compare">
        <figure>
          <img v-if="d.old_image_path" :src="`/api/evidence/byPath?path=${encodeURIComponent(d.old_image_path)}`" alt="baseline" />
          <figcaption class="mono dim">baseline ({{ d.old_sha?.slice(0, 8) ?? 'none' }})</figcaption>
        </figure>
        <figure>
          <img v-if="d.evidence_id" :src="`/api/evidence/${d.evidence_id}/file`" alt="current" />
          <figcaption class="mono dim">current ({{ d.new_sha.slice(0, 8) }})</figcaption>
        </figure>
      </div>
      <footer>
        <button class="approve" @click="decide(d.id, 'approve')">Approve — UI changed legitimately</button>
        <button class="reject" @click="decide(d.id, 'reject')">Reject — regression stands</button>
      </footer>
    </article>
  </main>
</template>

<style scoped>
.page { padding: var(--s6); max-width: 1000px; }
.head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: var(--s4); }
h1 { font-size: var(--text-base); font-weight: 600; margin: 0; }
.ok { color: var(--pass); }
.card { border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface); padding: var(--s4); margin-bottom: var(--s4); }
.card header { display: flex; justify-content: space-between; margin-bottom: var(--s2); }
.compare { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s3); }
.compare img { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-ctl); display: block; }
figcaption { margin-top: var(--s1); }
footer { display: flex; gap: var(--s2); margin-top: var(--s3); }
button { border: 1px solid var(--border); background: var(--bg); color: var(--fg); border-radius: var(--radius-ctl); padding: var(--s2) var(--s3); cursor: pointer; font-size: var(--text-sm); }
.approve { border-color: var(--pass); color: var(--pass); }
.reject { border-color: var(--fail); color: var(--fail); }
</style>
