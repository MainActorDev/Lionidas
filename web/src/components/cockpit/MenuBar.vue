<script setup lang="ts">
/** MenuBar — T1 word-menus (locked sketch verbatim). Pure UI: emits semantic
 *  events; the PAGE owns side effects. Click-outside + Escape close; one open
 *  menu at a time; accelerators right-aligned; act items ember. */
import { onBeforeUnmount, onMounted, ref } from 'vue';

export interface MenuItem { label: string; accel?: string; act?: boolean; event?: string; separator?: boolean }

const props = defineProps<{
  status: { sessionLabel: string | null; deviceName: string; liveCount: number };
}>();
const emit = defineEmits<{ (e: 'menu-event', event: string): void }>();

const open = ref<string | null>(null);

const MENUS: Array<{ id: string; label: string; items: MenuItem[] }> = [
  { id: 'file', label: 'file', items: [
    { label: 'install app…', event: 'install' },
    { label: '', separator: true },
    { label: 'exit to console…', accel: '⌘E', event: 'exit-console' },
  ] },
  { id: 'device', label: 'device', items: [
    { label: 'boot device…', accel: '⌘⇧D', event: 'boot-device' },
    { label: 'take screenshot', accel: '⌘1', event: 'screenshot' },
    { label: 'environment…', event: 'env-scenario' },
    { label: '', separator: true },
    { label: 'restart', event: 'restart' },
    { label: 'shutdown', event: 'shutdown' },
  ] },
  { id: 'run', label: 'run', items: [
    { label: 'test case', accel: '⌘P', event: 'play-case' },
  ] },
  { id: 'view', label: 'view', items: [
    { label: 'inspect elements', accel: '⌘I', event: 'toggle-inspect' },
  ] },
];

function toggle(id: string): void { open.value = open.value === id ? null : id; }
function pick(item: MenuItem): void {
  open.value = null;
  if (item.event) emit('menu-event', item.event);
}
function onDoc(): void { open.value = null; }
function onKey(e: KeyboardEvent): void { if (e.key === 'Escape') open.value = null; }
onMounted(() => { document.addEventListener('click', onDoc); document.addEventListener('keydown', onKey); });
onBeforeUnmount(() => { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey); });
void props;
</script>

<template>
  <div class="menubar">
    <img class="brand-logo" src="/icons/lionidas-app-128.png" alt="lionidas" width="18" height="18" />
    <div v-for="m in MENUS" :key="m.id" class="menu" :class="{ open: open === m.id }">
      <button type="button" @click.stop="toggle(m.id)">{{ m.label }}</button>
      <div class="dropdown" @click.stop>
        <template v-for="(item, i) in m.items" :key="i">
          <hr v-if="item.separator" />
          <div v-else class="item" :class="{ act: item.act }" @click="pick(item)">
            <span>{{ item.label }}</span>
            <span v-if="item.accel" class="accel">{{ item.accel }}</span>
          </div>
        </template>
      </div>
    </div>
    <div class="status">
      <span v-if="status.sessionLabel" class="session-chip-top">{{ status.sessionLabel }}</span>
      <b>{{ status.deviceName }}</b>
      <span class="live">◆ {{ status.liveCount }} device{{ status.liveCount === 1 ? '' : 's' }}</span>
    </div>
  </div>
</template>

<style scoped>
.menubar { display: flex; align-items: center; gap: 2px; height: 36px; padding: 0 var(--s-3); border-bottom: 1px solid var(--color-iron); background: var(--color-carbon); position: relative; z-index: 30; }
.brand-logo { display: block; width: 18px; height: 18px; margin-right: 2px; flex: none; }
.brand { color: var(--color-ember); font-weight: var(--weight-bold); padding: 0 var(--s-2) 0 2px; }
.menu { position: relative; }
.menu > button { font-family: inherit; background: none; border: none; color: var(--color-fog); padding: 4px 10px; cursor: pointer; font-size: var(--text-caption); border-radius: var(--r); }
.menu > button:hover, .menu.open > button { background: var(--color-graphite); color: var(--color-paper); }
.dropdown { display: none; position: absolute; top: 100%; left: 0; min-width: 230px; background: var(--color-graphite); border: 1px solid var(--color-slate); border-radius: var(--r); padding: 4px; z-index: 40; }
.menu.open .dropdown { display: block; }
.item { display: flex; justify-content: space-between; gap: 14px; padding: 5px 10px; color: var(--color-fog); font-size: var(--text-caption); cursor: pointer; border-radius: var(--r); }
.item:hover { background: var(--color-iron); color: var(--color-paper); }
.item.act { color: var(--color-ember); }
.item .accel { color: var(--color-steel); }
hr { border: none; border-top: 1px solid var(--color-iron); margin: 4px 0; }
.status { margin-left: auto; display: flex; align-items: center; gap: var(--s-3); font-size: var(--text-caption); color: var(--color-ash); }
.status b { color: var(--color-paper); font-weight: var(--weight-bold); }
.live { color: var(--color-ember); }
.session-chip-top { border: 1px solid var(--color-ember); color: var(--color-ember); padding: 1px 6px; }
</style>
