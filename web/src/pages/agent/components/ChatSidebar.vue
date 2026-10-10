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
    <div class="brand"><span class="orb">✦</span><span class="t">butler</span></div>
    <div class="search ag-mono"><span>⌕</span><input v-model="q" ref="searchEl" placeholder="Search"></div>
    <button class="new" @click="emit('newChat')">＋ New</button>
    <div class="rlabel">recents</div>
    <div class="convs">
      <div v-for="s in filtered" :key="s.id" class="conv" :class="{ on: s.id === activeId }" @click="emit('select', s.id)">
        <div class="nm">{{ s.title ?? s.id }}</div>
        <div class="sub">{{ when(s.updated_at) }} · {{ s.status }}</div>
      </div>
      <div v-if="!filtered.length" class="empty-hint">no conversations yet</div>
    </div>
    <div class="foot">
      <span class="av">{{ (me?.name ?? '?').slice(0, 2).toUpperCase() }}</span>
      <span class="who"><span class="nm">{{ me?.name ?? '…' }}</span><span class="pl">{{ me?.role ?? '' }}</span></span>
    </div>
  </aside>
</template>

<style scoped>
.sb { width: 232px; flex: none; display: flex; flex-direction: column; gap: 10px; padding: 16px 12px; }
.brand { display: flex; align-items: center; gap: 9px; padding: 0 6px; }
.orb { width: 26px; height: 26px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, var(--ag-ember), var(--ag-ember-dim) 70%); box-shadow: 0 0 14px rgba(224,106,53,.4); display: grid; place-items: center; font-size: 11px; }
.brand .t { font-family: Georgia, serif; font-size: 17px; }
.search { display: flex; align-items: center; gap: 8px; border-radius: 999px; padding: 7px 14px; background: var(--ag-surface); box-shadow: inset 0 0 0 1px var(--ag-line); color: var(--ag-ink-3); font-size: 12.5px; }
.search input { flex: 1; background: none; border: none; outline: none; color: var(--ag-ink); font-family: var(--font-mono); font-size: 12.5px; }
.new { display: flex; align-items: center; justify-content: center; gap: 8px; border: none; border-radius: 999px; padding: 8px 0; background: rgba(224,106,53,.1); color: var(--ag-ink); box-shadow: inset 0 0 0 1px rgba(224,106,53,.25); font-family: var(--font-sans); font-size: 13px; cursor: pointer; }
.new:hover { background: rgba(224,106,53,.16); }
.rlabel { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--ag-ink-3); padding: 4px 12px 0; }
.convs { flex: 1; overflow-y: auto; }
.conv { padding: 7px 12px; border-radius: 11px; cursor: pointer; }
.conv:hover { background: var(--ag-raise); }
.conv.on { background: rgba(224,106,53,.1); }
.conv .nm { font-size: 13px; color: var(--ag-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv .sub { font-size: 11px; color: var(--ag-ink-3); }
.empty-hint { font-size: 12px; color: var(--ag-ink-3); padding: 10px 12px; }
.foot { display: flex; align-items: center; gap: 10px; padding: 10px 10px 2px; border-top: 1px solid var(--ag-line); }
.foot .av { width: 28px; height: 28px; border-radius: 50%; background: var(--ag-surface); box-shadow: inset 0 0 0 1px var(--ag-line-2); display: grid; place-items: center; font-size: 11px; color: var(--ag-ink-2); }
.foot .who { display: flex; flex-direction: column; line-height: 1.3; }
.foot .nm { font-size: 13px; color: var(--ag-ink); }
.foot .pl { font-size: 11px; color: var(--ag-ink-3); }
</style>
