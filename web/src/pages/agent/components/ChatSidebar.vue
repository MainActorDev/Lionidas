<script setup lang="ts">
/** P3 agent chat — sidebar (rev 4): search / new / recents with owner names.
 *  Chats = butler sessions enriched via GET /api/agent/chats (owner from the
 *  users table — fix #7). Raw butler status words are gone (fix #6). */
import { ref, computed, onMounted } from 'vue';

const emit = defineEmits<{ select: [id: string]; newChat: [] }>();
const props = defineProps<{ me: { name: string; email: string; role: string } | null; activeId: string | null }>();

interface ChatRow { id: string; title: string | null; status: string; updatedAt: number; owner: string | null; ownerRole: string | null }
const chats = ref<ChatRow[]>([]);
const q = ref('');

const filtered = computed(() => {
  const needle = q.value.toLowerCase().trim();
  const list = [...chats.value];
  if (!needle) return list;
  return list.filter((c) => (c.title ?? c.id).toLowerCase().includes(needle));
});

async function load(): Promise<void> {
  const r = await fetch('/api/agent/chats');
  if (r.ok) chats.value = ((await r.json()) as { chats: ChatRow[] }).chats ?? [];
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
      <div v-for="c in filtered" :key="c.id" class="conv" :class="{ on: c.id === activeId }" @click="emit('select', c.id)">
        <div class="nm">{{ c.title ?? c.id }}</div>
        <div class="sub"><span v-if="c.owner">{{ c.owner }}</span><span v-if="c.owner"> · </span>{{ when(c.updatedAt) }}</div>
      </div>
      <div v-if="!filtered.length" class="empty-hint">no conversations yet</div>
    </div>
  </aside>
</template>

<style scoped>
.sb { width: 216px; flex: none; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--ag-line); background: var(--ag-panel); padding-top: var(--s-3); }
.new { margin: 0 var(--s-3) var(--s-2); border: 1px solid var(--color-ember-dim); border-radius: var(--r-sm); background: var(--color-ember); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); font-weight: var(--weight-bold); padding: 6px 0; cursor: pointer; }
.new:hover { background: var(--color-ember-dim); }
.search { width: calc(100% - 2 * var(--s-3)); margin: 0 var(--s-3); background: var(--ag-surface); border: 1px solid var(--ag-line); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 5px 8px; outline: none; }
.search:focus { border-color: var(--ag-line-2); }
.rlabel { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-steel); padding: var(--s-3) var(--s-3) 4px; }
.convs { flex: 1; overflow-y: auto; padding: 0 var(--s-2); }
.conv { padding: 6px 8px; border-radius: var(--r-sm); cursor: pointer; border-left: 2px solid transparent; }
.conv:hover { background: var(--ag-surface); }
.conv.on { background: var(--ag-surface); border-left-color: var(--color-ember); }
.conv .nm { font-size: var(--text-caption); color: var(--color-paper); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv .sub { font-size: 10px; color: var(--color-steel); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.empty-hint { font-size: var(--text-caption); color: var(--color-steel); padding: 10px 8px; }
</style>
