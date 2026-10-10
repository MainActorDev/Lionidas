<script setup lang="ts">
/** P3 agent chat — sidebar: search / New / recents / account footer
 *  (sketch b1-warm; Claude-referenced anatomy). Conversations are butler
 *  sessions via GET /api/agent/sessions (review F1 — no new server routes). */
import { ref, computed, onMounted } from 'vue';

const emit = defineEmits<{ select: [id: string]; newChat: [] }>();
const props = defineProps<{ me: { name: string; email: string; role: string } | null; activeId: string | null }>();

interface SessionRow { id: string; title: string | null; user_id: string | null; status: string; created_at: number; updated_at: number }
const sessions = ref<SessionRow[]>([]);
const q = ref('');
const searchEl = ref<HTMLInputElement | null>(null);

const filtered = computed(() => {
  const needle = q.value.toLowerCase().trim();
  const list = [...sessions.value].sort((a, b) => b.updated_at - a.updated_at);
  if (!needle) return list;
  return list.filter((s) => (s.title ?? s.id).toLowerCase().includes(needle));
});

async function load(): Promise<void> {
  const r = await fetch('/api/agent/sessions');
  if (r.ok) sessions.value = ((await r.json()) as { sessions: SessionRow[] }).sessions ?? [];
}
defineExpose({ load });

const when = (t: number): string => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

onMounted(() => { void load(); });
</script>

<template>
  <aside class="sb">
    <button class="new" @click="emit('newChat')">＋ new chat</button>
    <input v-model="q" class="search" placeholder="search">
    <div class="rlabel">recents</div>
    <div class="convs">
      <div v-for="s in filtered" :key="s.id" class="conv" :class="{ on: s.id === activeId }" @click="emit('select', s.id)">
        <div class="nm">{{ s.title ?? s.id }}</div>
        <div class="sub">{{ when(s.updated_at) }} · {{ s.status }}</div>
      </div>
      <div v-if="!filtered.length" class="empty-hint">no conversations yet</div>
    </div>
    <div class="foot">
      <span class="nm">{{ me?.name ?? '…' }}</span>
      <span class="pl">{{ me?.role ?? '' }}</span>
    </div>
  </aside>
</template>

<style scoped>
.sb { width: 216px; flex: none; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--color-iron); background: var(--color-void); }
.new { margin: var(--s-3) var(--s-3) var(--s-2); border: 1px solid var(--color-ember-dim); border-radius: var(--r-sm); background: var(--color-ember); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); font-weight: var(--weight-bold); padding: 6px 0; cursor: pointer; }
.new:hover { background: var(--color-ember-dim); }
.search { margin: 0 var(--s-3); background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 5px 8px; outline: none; }
.search:focus { border-color: var(--color-slate); }
.rlabel { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-steel); padding: var(--s-3) var(--s-3) 4px; }
.convs { flex: 1; overflow-y: auto; padding: 0 var(--s-2); }
.conv { padding: 6px 8px; border-radius: var(--r-sm); cursor: pointer; border-left: 2px solid transparent; }
.conv:hover { background: var(--color-graphite); }
.conv.on { background: var(--color-carbon); border-left-color: var(--color-ember); }
.conv .nm { font-size: var(--text-caption); color: var(--color-paper); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv .sub { font-size: 10px; color: var(--color-steel); }
.empty-hint { font-size: var(--text-caption); color: var(--color-steel); padding: 10px 8px; }
.foot { display: flex; align-items: baseline; gap: var(--s-2); padding: var(--s-3); border-top: 1px solid var(--color-iron); }
.foot .nm { font-size: var(--text-caption); color: var(--color-fog); }
.foot .pl { font-size: 10px; color: var(--color-steel); margin-left: auto; }
</style>
