<script setup lang="ts">
/** SessionRail — sketch 042-A session rail (Phase 5 revamp): 200px fixed,
 *  recency rows (title + `ago · model · N turns` mono subline), `N sessions ·
 *  M live` footer, new-chat on top. Search/rename/delete keep their tested
 *  interactions from the v1 sidebar — this is a reskin + subline upgrade. */
import { ref, computed, onMounted } from 'vue';

const emit = defineEmits<{ select: [id: string]; newChat: []; renamed: [id: string, title: string]; deleted: [id: string] }>();
const props = defineProps<{ me: { name: string; email: string; role: string } | null; activeId: string | null }>();

interface ChatRow { id: string; title: string | null; status: string; updatedAt: number; owner: string | null; ownerRole: string | null; turns?: number; model?: string | null; live?: boolean }
const chats = ref<ChatRow[]>([]);
const q = ref('');

const filtered = computed(() => {
  const needle = q.value.toLowerCase().trim();
  const list = [...chats.value];
  if (!needle) return list;
  return list.filter((c) => (c.title ?? c.id).toLowerCase().includes(needle));
});
const liveCount = computed(() => chats.value.filter((c) => c.live).length);

const ago = (t: number): string => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const subline = (c: ChatRow): string => {
  const parts = [ago(c.updatedAt)];
  if (c.model) parts.push(c.model);
  if (typeof c.turns === 'number' && c.turns > 0) parts.push(`${c.turns} turns`);
  return parts.join(' · ');
};

async function load(): Promise<void> {
  const r = await fetch('/api/agent/chats');
  if (r.ok) chats.value = ((await r.json()) as { chats: ChatRow[] }).chats ?? [];
}
defineExpose({ load });
onMounted(() => { void load(); });

const renaming = ref<string | null>(null);
const menuFor = ref<string | null>(null);
const renameVal = ref('');
function startRename(c: ChatRow): void {
  renaming.value = c.id;
  renameVal.value = c.title ?? c.id;
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
</script>

<template>
  <aside class="rail" aria-label="chat sessions">
    <div class="rail-head">
      <button type="button" class="new" @click="emit('newChat')">＋ new chat</button>
      <input v-model="q" class="search" type="search" placeholder="type to search…" aria-label="search chats" />
    </div>
    <div class="rail-list">
      <div
        v-for="c in filtered" :key="c.id"
        class="sess" :class="{ on: c.id === activeId }"
        role="button" tabindex="0"
        @click="emit('select', c.id)" @keydown.enter="emit('select', c.id)"
        @contextmenu.prevent="menuFor = menuFor === c.id ? null : c.id"
      >
        <template v-if="renaming === c.id">
          <input v-model="renameVal" class="ren-in" aria-label="rename chat" @keyup.enter="commitRename" @keyup.esc="renaming = null" @blur="commitRename" />
        </template>
        <template v-else>
          <div class="t" :title="c.title ?? c.id">{{ c.title ?? c.id }}</div>
          <div class="m">
            {{ subline(c) }}
            <span v-if="c.live" class="live-dot" title="turn live"></span>
          </div>
          <button v-if="menuFor === c.id" type="button" class="mi" @click.stop="startRename(c)">rename</button>
          <button v-if="menuFor === c.id" type="button" class="mi danger" @click.stop="askDelete(c)">delete</button>
        </template>
      </div>
      <div v-if="!filtered.length" class="empty">no conversations yet</div>
    </div>
    <div class="rail-foot">{{ chats.length }} session{{ chats.length === 1 ? '' : 's' }}<template v-if="liveCount"> · <span class="live-n">{{ liveCount }} live</span></template></div>
  </aside>
</template>

<style scoped>
.rail { width: 200px; flex: none; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--ag-line, #2a2a2a); background: var(--ag-panel, #181818); }
.rail-head { padding: 14px 16px 8px; display: flex; flex-direction: column; gap: 8px; }
.new { border: 1px solid var(--color-ember-dim, #c24f13); border-radius: 2px; background: var(--color-ember, #ee6018); color: #141414; font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 12px; font-weight: 600; padding: 7px 10px; cursor: pointer; text-align: left; }
.new:hover { border-color: #141414; }
.new:focus-visible { outline: 1px solid #141414; outline-offset: 2px; }
.search { background: var(--ag-surface, #1f1f1f); border: 1px solid var(--ag-line, #2a2a2a); border-radius: 2px; color: var(--color-paper, #f5f5f2); font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 11px; padding: 5px 8px; outline: none; width: 100%; box-sizing: border-box; }
.search:focus { border-color: var(--ag-line-2, #3a3a3a); }
.search::placeholder { color: var(--ag-ink-dim, #a39d95); opacity: .7; }
.rail-list { flex: 1; overflow-y: auto; padding: 6px 8px; }
.sess { padding: 8px 10px; border-radius: 2px; margin-bottom: 2px; position: relative; cursor: pointer; min-width: 0; }
.sess:hover { background: var(--ag-surface, #1f1f1f); }
.sess.on { background: var(--ag-surface, #1f1f1f); }
.sess:focus-visible { outline: 1px solid var(--color-ember, #ee6018); outline-offset: -1px; }
.sess .t { font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif); font-size: 12px; color: var(--ag-ink-dim, #a39d95); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sess.on .t { color: var(--color-paper, #f5f5f2); }
.sess .m { font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 10px; color: var(--ag-ink-dim, #a39d95); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.live-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--color-ember, #ee6018); margin-left: 5px; animation: railblink 1.2s infinite; vertical-align: baseline; }
@keyframes railblink { 50% { opacity: .25; } }
.mi { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--ag-ink-dim, #a39d95); font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 10px; padding: 4px 0 0; cursor: pointer; }
.mi:hover { color: var(--color-paper, #f5f5f2); }
.mi.danger:hover { color: var(--color-danger, #d97a6a); }
.ren-in { width: 100%; box-sizing: border-box; background: var(--ag-surface, #1f1f1f); border: 1px solid var(--ag-line-2, #3a3a3a); border-radius: 2px; color: var(--color-paper, #f5f5f2); font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 11px; padding: 3px 6px; outline: none; }
.empty { padding: 16px 10px; font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 11px; color: var(--ag-ink-dim, #a39d95); opacity: .7; }
.rail-foot { border-top: 1px solid var(--ag-line, #2a2a2a); padding: 10px 16px; font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 10px; color: var(--ag-ink-dim, #a39d95); }
.live-n { color: var(--color-ember, #ee6018); }
</style>
