<script setup lang="ts">
/** P3 agent chat — composer: textarea, ＋ refs picker, chips, round send.
 *  Deterministic rule (plan F4): refs attached ⇒ send starts a pipeline;
 *  no refs ⇒ chat turn only. No executor pill (F3 — deferred to P5). */
import { ref, computed } from 'vue';

export interface Ref { kind: 'jira' | 'github-pr' | 'github-commit' | 'doc' | 'repo'; locator: string }

const props = defineProps<{ busy?: boolean }>();
const emit = defineEmits<{ send: [text: string, refs: Ref[], appBundle: string] }>();

const text = ref('');
const refs = ref<Ref[]>([]);
const appBundle = ref('');
const pickerOpen = ref(false);
const newKind = ref<Ref['kind']>('jira');
const newLocator = ref('');

const ready = computed(() => text.value.trim().length > 0 && !props.busy);
const willRun = computed(() => refs.value.length > 0);

function addRef(): void {
  const loc = newLocator.value.trim();
  if (!loc) return;
  refs.value = [...refs.value, { kind: newKind.value, locator: loc }];
  newLocator.value = '';
  pickerOpen.value = false;
}
function removeRef(i: number): void { refs.value = refs.value.filter((_, idx) => idx !== i); }

function submit(): void {
  if (!ready.value) return;
  emit('send', text.value.trim(), refs.value.map((r) => ({ ...r })), appBundle.value.trim());
  text.value = ''; refs.value = [];
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
}
</script>

<template>
  <div class="wrap">
    <div class="composer">
      <div v-if="refs.length || pickerOpen" class="chips">
        <span v-for="(r, i) in refs" :key="r.kind + r.locator" class="chip ag-mono" :class="{ jira: r.kind === 'jira' }" @click="removeRef(i)">
          {{ r.kind === 'jira' ? '◈' : '△' }} {{ r.locator }} ✕
        </span>
        <span v-if="pickerOpen" class="picker ag-mono">
          <select v-model="newKind">
            <option value="jira">jira</option><option value="github-pr">github-pr</option>
            <option value="github-commit">commit</option><option value="doc">doc</option><option value="repo">repo</option>
          </select>
          <input v-model="newLocator" placeholder="DEMO-101 / #482 / path…" @keydown.enter.prevent="addRef">
          <button class="mini" @click="addRef">add</button>
        </span>
      </div>
      <textarea v-model="text" placeholder="message butler…" @keydown="onKey"></textarea>
      <div class="row">
        <button class="icon" title="attach references (jira / pr / doc / repo)" @click="pickerOpen = !pickerOpen">＋</button>
        <input v-if="willRun" v-model="appBundle" class="bundle ag-mono" placeholder="app bundle (com.lionparcel.dev)">
        <span class="hint">{{ willRun ? 'refs attached — sending starts the author pipeline' : 'enter to send · shift+enter newline' }}</span>
        <button class="send" :class="{ ready }" :disabled="!ready" @click="submit">↑</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap { position: absolute; bottom: 0; left: 0; right: 0; pointer-events: none; padding: 0 22px; }
.composer { pointer-events: auto; max-width: 700px; margin: 0 auto 18px; border-radius: 20px; padding: 12px 14px 9px; background: #26231f; box-shadow: inset 0 0 0 1px var(--ag-line-2), 0 12px 36px rgba(0,0,0,.55); }
.composer:focus-within { box-shadow: inset 0 0 0 1px rgba(224,106,53,.5), 0 0 22px rgba(224,106,53,.12); }
.chips { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 9px; align-items: center; }
.chip { border-radius: 999px; padding: 3px 12px; font-size: 11px; color: var(--ag-ink-2); background: #1d1b18; box-shadow: inset 0 0 0 1px var(--ag-line); cursor: pointer; }
.chip.jira { color: var(--ag-ember); box-shadow: inset 0 0 0 1px rgba(224,106,53,.45); }
.chip:hover { background: var(--ag-raise); }
.picker { display: inline-flex; gap: 6px; align-items: center; }
.picker select, .picker input, .bundle { background: #1d1b18; border: none; outline: none; box-shadow: inset 0 0 0 1px var(--ag-line); border-radius: 999px; color: var(--ag-ink); font-family: var(--font-mono); font-size: 11px; padding: 3px 10px; }
.picker input { width: 190px; }
.mini { border-radius: 999px; border: none; background: var(--ag-raise); color: var(--ag-ink-2); font-family: var(--font-mono); font-size: 11px; padding: 4px 11px; cursor: pointer; }
textarea { width: 100%; background: none; border: none; outline: none; color: var(--ag-ink); font-family: var(--font-sans); font-size: 15px; resize: none; min-height: 30px; }
.row { display: flex; align-items: center; gap: 9px; margin-top: 7px; }
.icon { width: 29px; height: 29px; border-radius: 50%; display: grid; place-items: center; background: none; box-shadow: inset 0 0 0 1px var(--ag-line); color: var(--ag-ink-3); cursor: pointer; font-size: 13px; border: none; }
.icon:hover { color: var(--ag-ember); box-shadow: inset 0 0 0 1px rgba(224,106,53,.4); }
.bundle { width: 220px; }
.hint { font-size: 11px; color: var(--ag-ink-3); }
.send { width: 30px; height: 30px; border-radius: 50%; border: none; background: radial-gradient(circle at 35% 30%, var(--ag-ember), var(--ag-ember-dim) 75%); color: var(--ag-ink); display: grid; place-items: center; cursor: pointer; font-size: 12px; margin-left: auto; opacity: .3; }
.send.ready { opacity: 1; }
</style>
