<script setup lang="ts">
/** P3 agent chat — sidebar (rev 4): search / new / recents with owner names.
 *  Chats = butler sessions enriched via GET /api/agent/chats (owner from the
 *  users table — fix #7). Raw butler status words are gone (fix #6). */
import { ref, computed, onMounted, nextTick } from 'vue';

const emit = defineEmits<{ select: [id: string]; newChat: []; renamed: [id: string, title: string]; deleted: [id: string] }>();
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

const renaming = ref<string | null>(null);
const menuFor = ref<string | null>(null);
const renameVal = ref('');
const renInput = ref<HTMLInputElement | null>(null);
function startRename(c: ChatRow): void {
  renaming.value = c.id;
  renameVal.value = c.title ?? c.id;
  void nextTick(() => renInput.value?.focus());
}
function commitRename(): void {
  const id = renaming.value;
  const t = renameVal.value.trim().slice(0, 80);
  renaming.value = null;
  if (id && t) emit('renamed', id, t);
}
function askDelete(c: ChatRow): void {
  if (confirm(`Delete chat "${c.title ?? c.id}"?\n\nMessages in this chat are deleted. Knowledge notes, artifacts and pipeline runs it produced are kept (they belong to Lionidas, not the chat).`)) {
    emit('deleted', c.id);
  }
}

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
        <div class="row1">
          <div class="nm">{{ c.title ?? c.id }}</div>
          <span class="ops" @click.stop>
            <button class="op dots" title="chat actions" @click.stop="menuFor = menuFor === c.id ? null : c.id">⋮</button>
          </span>
        </div>
        <div v-if="menuFor === c.id" class="menu" @click.stop>
          <button class="mi" @click.stop="menuFor = null; startRename(c);">Rename</button>
          <button class="mi danger" @click.stop="menuFor = null; askDelete(c);">Delete…</button>
        </div>
        <div v-if="renaming === c.id" class="ren" @click.stop>
          <input ref="renInput" v-model="renameVal" class="ren-in" @keydown.enter="commitRename" @keydown.esc="renaming = null" @click.stop>
          <button class="op" @click.stop="commitRename">save</button>
        </div>
        <div class="sub"><span v-if="c.owner">{{ c.owner }}</span><span v-if="c.owner"> · </span>{{ when(c.updatedAt) }}</div>
      </div>
      <div v-if="!filtered.length" class="empty-hint">no conversations yet</div>
    </div>
  </aside>
</template>

<style scoped>
.sb { width: 280px; flex: none; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--ag-line); background: var(--ag-panel); padding-top: var(--s-3); }
.new { margin: 0 var(--s-3) var(--s-2); border: 1px solid var(--color-ember-dim); border-radius: var(--r-sm); background: var(--color-ember); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); font-weight: var(--weight-bold); padding: 6px 0; cursor: pointer; }
.new:hover { background: var(--color-ember-dim); }
.search { width: calc(100% - 2 * var(--s-3)); margin: 0 var(--s-3); background: var(--ag-surface); border: 1px solid var(--ag-line); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 5px 8px; outline: none; }
.search:focus { border-color: var(--ag-line-2); }
.rlabel { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-steel); padding: var(--s-3) var(--s-3) 4px; }
.convs { flex: 1; overflow-y: auto; padding: 0 var(--s-2); }
.conv { position: relative; padding: 6px 8px; border-radius: var(--r-sm); cursor: pointer; border-left: 2px solid transparent; }
.conv:hover { background: var(--ag-surface); }
.conv.on { background: var(--ag-surface); border-left-color: var(--color-ember); }
.conv .nm { font-size: var(--text-caption); color: var(--color-paper); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv .sub { font-size: 10px; color: var(--color-steel); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.empty-hint { font-size: var(--text-caption); color: var(--color-steel); padding: 10px 8px; }
.row1 { display: flex; align-items: center; gap: 4px; }
.row1 .nm { flex: 1; min-width: 0; }
.ops { display: inline-flex; gap: 2px; opacity: 0; }
.conv:hover .ops { opacity: 1; }
.op.dots { font-size: 14px; font-weight: 700; padding: 0 6px; }
.menu { position: absolute; right: 12px; z-index: 10; background: var(--ag-surface); border: 1px solid var(--ag-line-2); border-radius: var(--r-sm); box-shadow: 0 4px 14px rgba(0,0,0,.45); min-width: 120px; margin-top: 2px; }
.mi { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--color-fog); font-family: var(--font-mono); font-size: var(--text-caption); padding: 7px 12px; cursor: pointer; }
.mi:hover { background: var(--ag-panel); color: var(--color-paper); }
.mi.danger:hover { color: var(--color-ember); }
.op { border: none; background: none; color: var(--color-steel); cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 4px; }
.op:hover { color: var(--color-paper); background: var(--ag-surface); }
.op.danger:hover { color: var(--color-ember); }
.ren { display: flex; gap: 4px; margin: 4px 0; }
.ren-in { flex: 1; min-width: 0; background: var(--ag-surface); border: 1px solid var(--ag-line-2); border-radius: 4px; color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 3px 6px; outline: none; }
</style>
