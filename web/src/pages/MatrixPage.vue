<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';

interface Ac { ac_id: string; ac_text: string; category: string; status: string; lastRunId: string | null; flows: string[] }
const route = useRoute();
const router = useRouter();
const ticket = route.params.key as string;
const acs = ref<Ac[]>([]);
const ticketStatus = ref('none');

onMounted(async () => {
  const res = await fetch(`/api/tickets/${ticket}/matrix`);
  const body = await res.json() as { acs: Ac[]; status: string };
  acs.value = body.acs;
  ticketStatus.value = body.status;
});
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">{{ ticket }}</div>
        <div class="page-desc">{{ acs.length }} acceptance criteria</div>
      </div>
      <span class="status" :class="`status-${ticketStatus}`">{{ ticketStatus }}</span>
    </div>

    <div v-if="acs.some((a) => a.status === 'changes-pending')" class="card card-accent">
      <div class="card-title">◆ changes need your review</div>
      <div style="margin-top: var(--s-2);"><RouterLink to="/baselines" class="btn btn-sm">review changes</RouterLink></div>
    </div>

    <div v-if="acs.length === 0" class="empty">no automated coverage for this ticket</div>

    <div v-else class="table-wrap">
      <table>
        <thead><tr><th>ac</th><th>status</th><th>category</th><th>flows</th></tr></thead>
        <tbody>
          <tr v-for="ac in acs" :key="ac.ac_id" @click="ac.lastRunId && router.push(`/runs/${ac.lastRunId}`)">
            <td>
              <div>{{ ac.ac_id }}</div>
              <div style="color: var(--color-ash); font-size: var(--text-caption);">{{ ac.ac_text }}</div>
            </td>
            <td><span class="status" :class="`status-${ac.status}`">{{ ac.status }}</span></td>
            <td style="color: var(--color-steel);">{{ ac.category }}</td>
            <td style="color: var(--color-steel); font-size: var(--text-caption);">{{ ac.flows.join(', ') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
