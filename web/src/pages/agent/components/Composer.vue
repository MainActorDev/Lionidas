<script setup lang="ts">
/** P3 agent chat — composer: textarea, ＋ refs picker, chips, round send.
 *  Deterministic rule (plan F4): refs attached ⇒ send starts a pipeline;
 *  no refs ⇒ chat turn only. No executor pill (F3 — deferred to P5). */
import { ref, computed, watch, nextTick } from 'vue';

export interface Ref { kind: 'jira' | 'github-pr' | 'github-commit' | 'doc' | 'repo'; locator: string }

const props = defineProps<{ busy?: boolean }>();
const emit = defineEmits<{ send: [text: string, refs: Ref[], appBundle: string]; abort: []; skill: [command: string, ask: string] }>();

const text = ref('');
watch(text, () => { menuDismissed.value = false; if (!text.value.startsWith('/')) activeIdx.value = 0; });
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

/** rev21: ChatGPT-style slash menu. SKILLS carries name + description. */
const SKILLS: Array<{ cmd: string; desc: string }> = [
  { cmd: '/planning', desc: 'Plan test cases from a request' },
  { cmd: '/breakdown', desc: 'Break a plan into concrete steps' },
  { cmd: '/author', desc: 'Author case YAML drafts' },
];

const menuDismissed = ref(false);
const activeIdx = ref(0);

const skillMatches = computed(() => {
  const t = text.value.trim();
  if (!t.startsWith('/')) return [];
  return SKILLS.filter((s) => s.cmd.startsWith(t));
});

/** open only while the token could STILL become a REGISTERED command —
 *  unregistered /text never opens a menu and is never treated as a command */
const menuOpen = computed(() => {
  const t = text.value;
  return t.startsWith('/') && !t.includes(' ') && !menuDismissed.value && skillMatches.value.length > 0;
});

/** accept the selected command: insert it + trailing space, close the menu */
function acceptSkill(idx?: number): void {
  const pick = skillMatches.value[idx ?? activeIdx.value];
  if (!pick) return;
  text.value = `${pick.cmd} `;
  activeIdx.value = 0;
  menuDismissed.value = false;
  void nextTick(() => {
    const el = document.querySelector('.composer textarea') as HTMLTextAreaElement | null;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  });
}

function onKey(e: KeyboardEvent): void {
  if (menuOpen.value) {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx.value = (activeIdx.value + 1) % skillMatches.value.length; return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx.value = (activeIdx.value - 1 + skillMatches.value.length) % skillMatches.value.length; return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptSkill(); return; }
    if (e.key === 'Escape') { e.preventDefault(); menuDismissed.value = true; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
}

const REGISTERED = (c: string): boolean => SKILLS.some((s) => s.cmd === c);

/** the command token when the CURRENT input begins with a REGISTERED command */
const recognizedCmd = computed(() => {
  const [first] = text.value.trim().split(/\s+/);
  return first && REGISTERED(first) ? first : null;
});

function submit(): void {
  if (!ready.value) return;
  const t = text.value.trim();
  // rev22: ONLY registered commands are skills — any other slash text is an
  // ordinary message (the tripwire/agent sees it as prose, never a command).
  const [first] = t.split(/\s+/);
  if (first && REGISTERED(first)) {
    emit('skill', first, t.slice(first.length).trim());
    text.value = ''; refs.value = [];
    return;
  }
  emit('send', t, refs.value.map((r) => ({ ...r })), appBundle.value.trim());
  text.value = ''; refs.value = [];
}
</script>

<template>
  <div class="wrap">
    <div class="composer">
      <div v-if="recognizedCmd && !menuOpen" class="cmd-badge">▸ {{ recognizedCmd }} <span class="cmd-hint">— press send to run this command</span></div>
      <div v-if="menuOpen" class="slash-menu">
        <div v-for="(s, i) in skillMatches" :key="s.cmd" class="slash-row" :class="{ active: i === activeIdx }" @mousedown.prevent="acceptSkill(i)" @mousemove="activeIdx = i">
          <span class="slash-ico">◈</span>
          <span class="slash-name">{{ s.cmd }}</span>
          <span class="slash-desc">{{ s.desc }}</span>
        </div>
      </div>
      <div v-if="refs.length || pickerOpen" class="chips">
        <span v-for="(r, i) in refs" :key="r.kind + r.locator" class="chip" :class="{ jira: r.kind === 'jira' }" @click="removeRef(i)">
          {{ r.kind === 'jira' ? '◈' : '△' }} {{ r.locator }} ✕
        </span>
        <span v-if="pickerOpen" class="picker">
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
        <button class="icon" title="attach references (jira / pr / doc / repo)" @click="pickerOpen = !pickerOpen">＋ refs</button>
        <input v-if="willRun" v-model="appBundle" class="bundle" placeholder="app bundle (com.lionparcel.dev)">
        <span class="hint">{{ willRun ? 'refs attached — sending starts the author pipeline' : 'enter to send · shift+enter newline' }}</span>
        <button v-if="!busy" class="send" :class="{ ready }" :disabled="!ready" @click="submit">send</button>
        <button v-else class="send stop" @click="emit('abort')">stop</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap { position: sticky; bottom: 0; margin: 0 0 var(--s-3); background: var(--ag-bg); }
.cmd-badge { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: var(--text-caption); color: var(--color-ember); border: 1px solid var(--color-ember-dim); border-radius: var(--r-sm); padding: 3px 10px; background: var(--ag-panel); }
.cmd-badge .cmd-hint { color: var(--color-steel); }
.slash-menu { position: absolute; bottom: calc(100% + 8px); left: 0; right: 0; background: var(--ag-surface); border: 1px solid var(--ag-line-2); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.5); padding: 4px; z-index: 30; }
.slash-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
.slash-row.active { background: var(--ag-panel); }
.slash-ico { color: var(--color-ember); flex: none; font-size: 12px; }
.slash-name { color: var(--color-paper); font-weight: var(--weight-bold); flex: none; }
.slash-desc { color: var(--color-steel); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer { position: relative; pointer-events: auto; width: calc(100% - 2 * var(--s-4)); max-width: 720px; margin: 0 auto; border: 1px solid var(--ag-line-2); border-radius: var(--r-sm); padding: var(--s-2) var(--s-3); background: var(--ag-surface); }
.composer:focus-within { border-color: var(--color-ember-dim); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: var(--s-2); align-items: center; }
.chip { border: 1px solid var(--ag-line); border-radius: var(--r-sm); padding: 1px var(--s-2); font-size: var(--text-caption); color: var(--color-fog); background: var(--ag-panel); cursor: pointer; font-family: var(--font-mono); }
.chip.jira { color: var(--color-ember); border-color: var(--color-ember-dim); }
.chip:hover { background: var(--color-graphite); }
.picker { display: inline-flex; gap: 6px; align-items: center; }
.picker select, .picker input, .bundle { background: var(--ag-panel); border: 1px solid var(--ag-line); border-radius: var(--r-sm); outline: none; color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 3px var(--s-2); }
.picker input { width: 190px; }
.mini { border: 1px solid var(--ag-line-2); border-radius: var(--r-sm); background: var(--ag-surface); color: var(--color-fog); font-family: var(--font-mono); font-size: var(--text-caption); padding: 2px var(--s-2); cursor: pointer; }
.mini:hover { color: var(--color-paper); }
textarea { width: 100%; background: none; border: none; outline: none; color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-body); resize: none; min-height: 30px; }
.row { display: flex; align-items: center; gap: var(--s-2); margin-top: 6px; }
.icon { min-height: 24px; padding: 2px var(--s-2); border: 1px solid var(--ag-line-2); border-radius: var(--r-sm); background: var(--ag-surface); color: var(--color-fog); cursor: pointer; font-size: var(--text-caption); font-family: var(--font-mono); }
.icon:hover { background: var(--color-graphite); color: var(--color-paper); }
.bundle { width: 220px; }
.hint { font-size: var(--text-caption); color: var(--color-steel); }
.send { min-height: 24px; padding: 2px var(--s-3); margin-left: auto; border: 1px solid var(--color-ember); border-radius: var(--r-sm); background: var(--color-ember); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); font-weight: var(--weight-bold); cursor: pointer; opacity: .35; }
.send.ready { opacity: 1; }
.send.ready:hover { background: var(--color-ember-dim); }
.send.stop { opacity: 1; background: none; border-color: var(--ag-line-2); color: var(--color-fog); }
.send.stop:hover { color: var(--color-ember); border-color: var(--color-ember-dim); }
</style>
