<script setup lang="ts">
/** Composer rev23 (refs plan F1): command chip + @-mention ref system.
 *  Slash commands (rev21/22) unchanged. Refs are creatable ONLY through the
 *  @ pickers — the free-typed kind+locator form is gone. Selected refs render
 *  as capsule chips in the input line; send maps them to PipelineRef[]. */
import { ref, computed, watch, nextTick } from 'vue';

export interface Ref { kind: 'jira' | 'github-pr' | 'github-commit' | 'doc' | 'repo' | 'attachment' | 'case'; locator: string; label?: string }

const props = defineProps<{ busy?: boolean }>();
const emit = defineEmits<{ send: [text: string, refs: Ref[], appBundle: string]; abort: []; skill: [command: string, ask: string, refs: Ref[]]; 'open-attachment': [] }>();

const text = ref('');
/** rev22b: the ACTIVE command chip — a registered command the user committed
 *  (typed + space, or picked from the menu). It renders INSIDE the input as a
 *  token, distinct from the prompt text that follows. Unknown /text never
 *  becomes a chip — it stays ordinary text. */
const activeCmd = ref<string | null>(null);
/** suppresses token→chip promotion while reverting a chip back to text */
let reverting = false;

watch(text, () => {
  menuDismissed.value = false;
  if (!text.value.startsWith('/')) activeIdx.value = 0;
  onTextForPalette();
  // token → chip: '/planning ' becomes the chip, the rest is the prompt
  if (!reverting && !activeCmd.value) {
    const m = /^(\/\S+)(\s+.*|\s+)$/s.exec(text.value);
    if (m && REGISTERED(m[1] ?? '')) {
      activeCmd.value = m[1] ?? null;
      text.value = text.value.slice((m[1] ?? '').length).replace(/^\s+/, '');
    }
  }
});

/** chip → text token (✕ or Backspace on empty): lets the user edit the command */
function revertChip(): void {
  if (!activeCmd.value) return;
  const cmd = activeCmd.value;
  reverting = true;
  activeCmd.value = null;
  text.value = `${cmd} `;
  void nextTick(() => { reverting = false; });
  void nextTick(() => {
    const el = document.querySelector('.composer textarea') as HTMLTextAreaElement | null;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  });
}

const refs = ref<Ref[]>([]);
const appBundle = ref('');
const REF_CAP = 8;

const ready = computed(() => text.value.trim().length > 0 && !props.busy);
const willRun = computed(() => refs.value.length > 0);

/** known app bundles — fetched lazily the first time refs attach */
/** session switch: the composer is per-conversation — chips/bundle never leak across chats */
function resetDraft(): void {
  refs.value = [];
  tokens.value = [];
  activeCmd.value = null;
  text.value = '';
  closePalette();
}

/** ＋ attach flow: an uploaded file becomes a chip-style inline token at the caret end */
function addAttachmentChip(id: string, fileName: string): void {
  const label = fileName;
  const at = text.value.length;
  text.value = `${text.value}${text.value && !text.value.endsWith(' ') ? ' ' : ''}${label} `;
  const start = at === 0 ? 0 : text.value.indexOf(label);
  tokens.value.push({ start, end: start + label.length, kind: 'attachment', locator: id, label });
  const r: Ref = { kind: 'attachment', locator: id, label };
  if (refs.value.length < REF_CAP && !refs.value.some((x) => x.kind === r.kind && x.locator === id)) refs.value.push(r);
  pushRecent(r);
  focusTA();
}
defineExpose({ addAttachmentChip, resetDraft });

/** ── rev21: slash command menu ─────────────────────────────────────────── */
const SKILLS: Array<{ cmd: string; desc: string }> = [
  { cmd: '/planning', desc: 'Plan test cases from a request' },
  { cmd: '/breakdown', desc: 'Break a plan into concrete steps' },
  { cmd: '/author', desc: 'Author case YAML drafts' },
];
const REGISTERED = (c: string): boolean => SKILLS.some((s) => s.cmd === c);

const menuDismissed = ref(false);
const activeIdx = ref(0);

const skillMatches = computed(() => {
  const t = text.value.trim();
  if (!t.startsWith('/')) return [];
  return SKILLS.filter((s) => s.cmd.startsWith(t));
});

/** open only while the token could STILL become a REGISTERED command */
const menuOpen = computed(() => {
  const t = text.value;
  return t.startsWith('/') && !t.includes(' ') && !menuDismissed.value && skillMatches.value.length > 0;
});

/** accept the selected command: commit the chip, close the menu */
function acceptSkill(idx?: number): void {
  const pick = skillMatches.value[idx ?? activeIdx.value];
  if (!pick) return;
  activeCmd.value = pick.cmd;
  text.value = '';
  activeIdx.value = 0;
  menuDismissed.value = false;
  focusTA();
}

function focusTA(): void {
  void nextTick(() => {
    const el = document.querySelector('.composer textarea') as HTMLTextAreaElement | null;
    el?.focus();
    el?.setSelectionRange(el?.value.length ?? 0, el?.value.length ?? 0);
  });
}

/** ── mention palette (sketch 033-C, plan 20261013T072312Z): ONE caret-anchored
 *  palette; query = text from '@' to caret; RANGE-TRACKED inline tokens
 *  (review MR1 — plain text only, sentinels FORBIDDEN); two-tier search
 *  (local instant + async jira, MR3). The old family/repo-wizard machine is
 *  deleted. Chips render in an overlay aligned to the textarea. */
interface PaletteRow {
  id: string;
  kind: 'case' | 'repo' | 'file' | 'jira' | 'recent';
  title: string;
  meta: string;
  ref: { kind: Ref['kind']; locator: string };
}
/** an inline token: a RANGE over the plain text (MR1) */
interface TokenRange { start: number; end: number; kind: Ref['kind']; locator: string; label: string }

const atOpen = ref(false);
const atQuery = ref('');
const atStart = ref(-1);          // index of '@' in text
const atIdx = ref(0);
const paletteRows = ref<PaletteRow[]>([]);
const paletteLoading = ref(false);
const jiraRows = ref<PaletteRow[]>([]);   // async tier
const jiraSearching = ref(false);
const tokens = ref<TokenRange[]>([]);     // MR1: ranges, never sentinels
/** caret to restore after Vue's v-model re-render (pick/backspace keep the caret honest) */
let pendingCaret = -1;
let paletteSeq = 0;

/** recent refs — palette memory only; draft NEVER pre-populated (MR2) */
const RECENT_KEY = 'lionidas.recentRefs';
function pushRecent(r: Ref): void {
  try {
    const cur = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as Ref[];
    const next = [{ ...r }, ...cur.filter((x) => !(x.kind === r.kind && x.locator === r.locator))].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* private mode etc. */ }
}
function recentRefs(): PaletteRow[] {
  try {
    return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as Ref[]).map((r, i) => ({
      id: `recent:${i}:${r.kind}:${r.locator}`,
      kind: 'recent' as const,
      title: r.label ?? r.locator,
      meta: r.kind,
      ref: { kind: r.kind, locator: r.locator },
    }));
  } catch { return []; }
}

/** rows: async jira first (if landed), then local + recent */
const atRows = computed<PaletteRow[]>(() => {
  const local = paletteRows.value;
  const rec = atQuery.value ? [] : recentRefs().slice(0, 3);
  const seen = new Set(local.concat(jiraRows.value).map((r) => r.ref.kind + r.ref.locator));
  const fresh = rec.filter((r) => !seen.has(r.ref.kind + ':' + r.ref.locator));
  return [...jiraRows.value, ...local, ...fresh];
});

let searchTimer: ReturnType<typeof setTimeout> | undefined;
/** caret-based @ token detection: opens while typing; query = '@'+… to caret */
function onTextForPalette(): void {
  if (reverting) return;
  const el = ta();
  if (!el) return;
  const caret = el.selectionStart ?? 0;
  const before = text.value.slice(0, caret);
  const m = /(^|\s)@([A-Za-z0-9_./#-]*)$/.exec(before);
  if (!m) { if (atOpen.value) closePalette(); return; }
  const startIdx = caret - (m[2]?.length ?? 0) - 1;
  // word-char directly before '@' (emails) suppresses — m[1] requires whitespace/start
  if (!atOpen.value) { atOpen.value = true; atStart.value = startIdx; atIdx.value = 0; }
  atQuery.value = m[2] ?? '';
  scheduleSearch(atQuery.value);
}

function scheduleSearch(q: string): void {
  if (searchTimer) clearTimeout(searchTimer);
  const seq = ++paletteSeq;
  searchTimer = setTimeout(() => void doSearch(q, seq), 180);
}

async function doSearch(q: string, seq: number): Promise<void> {
  paletteLoading.value = true;
  // async jira tier (MR3): fills in when it lands
  if (q.trim().length >= 2) {
    jiraSearching.value = true;
    void fetch(`/api/agent/refs/jira?q=${encodeURIComponent(q)}`)
      .then((r) => r.json())
      .then((b: { issues?: Array<{ key: string; title: string; type?: string }> }) => {
        if (seq !== paletteSeq) return;
        jiraRows.value = (b.issues ?? []).slice(0, 4).map((i) => ({
          id: `jira:${i.key}`, kind: 'jira' as const, title: `${i.key} · ${i.title}`,
          meta: i.type ?? 'jira', ref: { kind: 'jira' as const, locator: i.key },
        }));
      })
      .catch(() => { if (seq === paletteSeq) jiraRows.value = []; })
      .finally(() => { jiraSearching.value = false; });
  } else { jiraRows.value = []; }
  // local tier
  try {
    const r = await fetch(`/api/agent/refs/search?q=${encodeURIComponent(q)}`);
    const b = (await r.json()) as { rows?: PaletteRow[] };
    if (seq !== paletteSeq) return;
    paletteRows.value = (b.rows ?? []).slice(0, 12);
  } catch { if (seq === paletteSeq) paletteRows.value = []; }
  paletteLoading.value = false;
}

function closePalette(): void {
  atOpen.value = false;
  atQuery.value = '';
  atStart.value = -1;
  paletteRows.value = [];
  jiraRows.value = [];
  if (searchTimer) clearTimeout(searchTimer);
  paletteSeq++;
}

/** pick: autocomplete the token text in-place + record the RANGE (MR1) */
function acceptPalette(idx?: number): void {
  const row = atRows.value[idx ?? atIdx.value];
  if (!row) return;
  const el = ta();
  if (!el || atStart.value < 0) { closePalette(); return; }
  const label = row.ref.kind === 'jira' ? row.ref.locator
    : row.ref.kind === 'attachment' ? (row.title)
    : row.ref.kind === 'case' ? (row.title)
    : `${row.ref.locator}`;
  const insert = `${label} `;
  const caret = el.selectionStart ?? text.value.length;
  const end = caret;
  // replace '@query' with 'label '
  text.value = text.value.slice(0, atStart.value) + insert + text.value.slice(end);
  // shift existing token ranges after the edit point
  const removed = end - atStart.value;
  const added = insert.length;
  const kept: TokenRange[] = [];
  for (const t of tokens.value) {
    if (t.end <= atStart.value) kept.push(t);
    else if (t.start >= end) kept.push({ ...t, start: t.start - removed + added, end: t.end - removed + added });
    // overlapping tokens are dropped (shouldn't happen)
  }
  kept.push({ start: atStart.value, end: atStart.value + label.length, kind: row.ref.kind, locator: row.ref.locator, label });
  tokens.value = kept;
  const ref: Ref = { kind: row.ref.kind, locator: row.ref.locator, label };
  if (refs.value.length < REF_CAP && !refs.value.some((r) => r.kind === ref.kind && r.locator === ref.locator)) refs.value.push(ref);
  pushRecent(ref);
  pendingCaret = atStart.value + insert.length;
  closePalette();
}

/** overlay model: plain text + chip ranges → render segments */
const overlaySegments = computed<Array<{ text: string; token?: TokenRange }>>(() => {
  const segs: Array<{ text: string; token?: TokenRange }> = [];
  let pos = 0;
  for (const t of [...tokens.value].sort((a, b) => a.start - b.start)) {
    if (t.start > pos) segs.push({ text: text.value.slice(pos, t.start) });
    segs.push({ text: text.value.slice(t.start, t.end), token: t });
    pos = t.end;
  }
  if (pos < text.value.length) segs.push({ text: text.value.slice(pos) });
  return segs;
});

const taEl = ref<HTMLTextAreaElement | null>(null);
function ta(): HTMLTextAreaElement | null {
  // component-scoped first (tests don't attach to document); document fallback for safety
  return taEl.value ?? (document.querySelector('.composer textarea') as HTMLTextAreaElement | null);
}

/** overlay mirrors the textarea's scroll (long drafts) + pending caret restore */
watch(() => [text.value, tokens.value.length], () => {
  void nextTick(() => {
    const el = taEl.value;
    const ov = document.querySelector('.ta-overlay') as HTMLElement | null;
    if (el && ov) ov.scrollTop = el.scrollTop;
    if (el && pendingCaret >= 0) {
      const pos = Math.min(pendingCaret, el.value.length);
      el.focus();
      el.setSelectionRange(pos, pos);
      pendingCaret = -1;
      // v-model may re-set value once more after this tick — re-assert on the next frame
      requestAnimationFrame(() => {
        if (document.activeElement === el) el.setSelectionRange(pos, pos);
      });
    }
  });
});


function onKey(e: KeyboardEvent): void {
  if (e.key === 'Backspace' && activeCmd.value && text.value === '') { e.preventDefault(); revertChip(); return; }
  // MR1: Backspace at a token start removes the WHOLE token (as a unit)
  if (e.key === 'Backspace' && !activeCmd.value) {
    const el = ta();
    const caret = el?.selectionStart ?? -1;
    const atStartHit = tokens.value.find((t) => t.start === caret);
    if (atStartHit) {
      e.preventDefault();
      text.value = text.value.slice(0, atStartHit.start) + text.value.slice(atStartHit.end).replace(/^\s+/, '');
      tokens.value = tokens.value.filter((t) => t !== atStartHit).map((t) => (t.start >= atStartHit.end ? { ...t, start: t.start - (atStartHit.end - atStartHit.start), end: t.end - (atStartHit.end - atStartHit.start) } : t));
      const ref = refs.value.find((r) => r.locator === atStartHit.locator && r.kind === atStartHit.kind);
      if (ref) refs.value = refs.value.filter((r) => r !== ref);
      pendingCaret = atStartHit.start;
      return;
    }
  }
  if (atOpen.value) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = Math.max(1, atRows.value.length);
      atIdx.value = e.key === 'ArrowDown' ? (atIdx.value + 1) % n : (atIdx.value - 1 + n) % n;
      void nextTick(() => document.querySelector('.slash-row.active')?.scrollIntoView({ block: 'nearest' }));
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && atRows.value.length) { e.preventDefault(); acceptPalette(); return; }
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
  } else if (menuOpen.value) {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx.value = (activeIdx.value + 1) % skillMatches.value.length; return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx.value = (activeIdx.value - 1 + skillMatches.value.length) % skillMatches.value.length; return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptSkill(); return; }
    if (e.key === 'Escape') { e.preventDefault(); menuDismissed.value = true; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
}

function submit(): void {
  if (!ready.value) return;
  const t = text.value.trim();
  if (activeCmd.value) {
    // R2-F2: refs RIDE the skill (compile-on-skill) instead of being discarded
    emit('skill', activeCmd.value, t, refs.value.map((r) => ({ ...r })));
    text.value = ''; refs.value = []; tokens.value = []; activeCmd.value = null;
    return;
  }
  const [first] = t.split(/\s+/);
  if (first && REGISTERED(first)) {
    emit('skill', first, t.slice(first.length).trim(), refs.value.map((r) => ({ ...r })));
    text.value = ''; refs.value = []; tokens.value = [];
    return;
  }
  emit('send', t, refs.value.map((r) => ({ ...r })), (appBundle.value ?? '').trim());
  text.value = ''; refs.value = []; tokens.value = [];
  closePalette();
}
</script>

<template>
  <div class="wrap">
    <div class="composer">
      <!-- mention palette (sketch 033-C): one flat list, kind prefixes, async jira row -->
      <div v-if="atOpen" class="slash-menu palette">
        <div class="menu-rows">
          <div v-for="(row, i) in atRows" :key="row.id" class="slash-row" :class="{ active: i === atIdx }" @mousedown.prevent="acceptPalette(i)" @mousemove="atIdx = i">
            <span class="pk" :class="row.kind">{{ row.kind }}</span>
            <span class="slash-name">{{ row.title }}</span>
            <span class="slash-desc">{{ row.meta }}</span>
          </div>
          <div v-if="!atRows.length" class="slash-row state"><span class="pk">…</span><span class="slash-name">{{ paletteLoading ? 'searching…' : 'no matches' }}</span></div>
          <div v-if="jiraSearching" class="slash-row state"><span class="pk jira">jira</span><span class="slash-name">searching jira…</span></div>
        </div>
        <div class="p-foot"><span>@ reference</span><span>↑↓ ↵ esc</span></div>
      </div>

      <!-- slash menu (rev21) -->
      <div v-if="menuOpen" class="slash-menu">
        <div v-for="(s, i) in skillMatches" :key="s.cmd" class="slash-row" :class="{ active: i === activeIdx }" @mousedown.prevent="acceptSkill(i)" @mousemove="activeIdx = i">
          <span class="slash-ico">◈</span>
          <span class="slash-name">{{ s.cmd }}</span>
          <span class="slash-desc">{{ s.desc }}</span>
        </div>
      </div>

      <div class="input-line">
        <span v-if="activeCmd" class="cmd-chip">{{ activeCmd }}<button class="chip-x" title="remove command" @mousedown.prevent.stop @click="revertChip">✕</button></span>
        <div class="ta-wrap">
          <div class="ta-overlay" aria-hidden="true"><template v-for="(seg, i) in overlaySegments" :key="i"><span v-if="seg.token" class="chip inline" :class="seg.token.kind">{{ seg.token.label }}</span><template v-else>{{ seg.text }}</template></template></div>
          <textarea ref="taEl" v-model="text" :placeholder="activeCmd ? 'describe what you want from this command…' : 'ask about cases, runs, or draft new tests…  ·  @ to reference'" @keydown="onKey" @click="onTextForPalette" @keyup="onTextForPalette"></textarea>
        </div>
      </div>
      <div class="row">
        <button class="icon" title="attach a file" @click="emit('open-attachment')">＋</button>
        <span class="hint">{{ willRun ? `${refs.length} reference${refs.length > 1 ? 's' : ''} attached` : '@ to reference · / for commands · enter to send' }}</span>
        <button v-if="!busy" class="send" :class="{ ready }" :disabled="!ready" @click="submit">send</button>
        <button v-else class="send stop" @click="emit('abort')">stop</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap { position: sticky; bottom: 0; margin: 0 0 var(--s-3); background: var(--ag-bg); }
.input-line { display: flex; align-items: flex-start; gap: 8px; }
.input-line textarea { flex: 1; }
.cmd-chip { display: inline-flex; align-items: center; gap: 6px; margin-top: 3px; color: var(--color-ember); border: 1px solid var(--color-ember-dim); background: var(--ag-panel); border-radius: 999px; padding: 2px 6px 2px 12px; font-size: var(--text-caption); font-weight: var(--weight-bold); flex: none; }
.chip-x { border: none; background: none; color: var(--color-steel); cursor: pointer; font-size: 10px; padding: 2px 4px; border-radius: 50%; }
.chip-x:hover { color: var(--color-paper); background: var(--ag-surface); }
.slash-menu { position: absolute; bottom: calc(100% + 8px); left: 0; right: 0; background: var(--ag-surface); border: 1px solid var(--ag-line-2); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.5); padding: 4px; z-index: 30; max-height: 340px; overflow-y: auto; }
.slash-menu.has-rows { display: flex; flex-direction: column; overflow: hidden; }
.menu-rows { overflow-y: auto; min-height: 0; flex: 1; }
.slash-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
.slash-row.active { background: var(--ag-panel); }
.slash-row.picked { opacity: .55; }
.slash-row.picked .slash-ico { color: var(--color-fog); }
.slash-ico { color: var(--color-ember); flex: none; font-size: 12px; }
.slash-name { color: var(--color-paper); font-weight: var(--weight-bold); flex: none; }
.slash-desc { color: var(--color-steel); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slash-sub { color: var(--color-fog); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; text-align: right; }
.at-head { display: flex; align-items: center; gap: 8px; padding: 4px 10px 8px; border-bottom: 1px solid var(--ag-line); margin-bottom: 4px; }
.at-title { font-size: 11px; color: var(--color-steel); flex: 1; }
.at-count { color: var(--color-ember); }
.at-done { border: none; background: none; color: var(--color-steel); cursor: pointer; font-size: 11px; }
.at-done:hover { color: var(--color-paper); }
.at-search { background: var(--ag-panel); border: 1px solid var(--ag-line); border-radius: 6px; outline: none; color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 3px 8px; width: 200px; }
.at-search:focus { border-color: var(--color-ember-dim); }
.at-foot { font-size: 10px; color: var(--color-steel); padding: 6px 10px 4px; border-top: 1px solid var(--ag-line); margin-top: 4px; }
.seg { border: 1px solid var(--ag-line-2); background: none; color: var(--color-steel); border-radius: 4px; font-size: 10px; padding: 1px 8px; cursor: pointer; }
.seg.on { color: var(--color-ember); border-color: var(--color-ember-dim); }
.branch-strip { display: flex; align-items: center; gap: 6px; padding: 4px 10px 8px; flex-wrap: wrap; border-bottom: 1px solid var(--ag-line); margin-bottom: 4px; }
.branch-label { font-size: 10px; color: var(--color-steel); }
.seg.branch { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.branch-search { background: var(--ag-panel); border: 1px solid var(--ag-line); border-radius: 6px; outline: none; color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 4px 10px; width: 260px; margin-left: auto; }
.composer { position: relative; pointer-events: auto; width: calc(100% - 2 * var(--s-4)); max-width: 720px; margin: 0 auto; border: 1px solid var(--ag-line-2); border-radius: var(--r-sm); padding: var(--s-2) var(--s-3); background: var(--ag-surface); }
.composer:focus-within { border-color: var(--color-ember-dim); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: var(--s-2); align-items: center; }
.chip { border: 1px solid var(--ag-line); border-radius: 999px; padding: 1px var(--s-2); font-size: var(--text-caption); color: var(--color-fog); background: var(--ag-panel); cursor: pointer; font-family: var(--font-mono); max-width: 280px; display: inline-flex; align-items: center; gap: 4px; }
.ref-kind { color: var(--color-ember); flex: none; }
.ref-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.jira { color: var(--color-ember); border-color: var(--color-ember-dim); }
.chip:hover { background: var(--color-graphite); }
textarea { width: 100%; background: none; border: none; outline: none; color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-body); resize: none; min-height: 30px; }
.row { display: flex; align-items: center; gap: var(--s-2); margin-top: 6px; }
.icon { min-height: 24px; padding: 2px var(--s-2); border: 1px solid var(--ag-line-2); border-radius: var(--r-sm); background: var(--ag-surface); color: var(--color-fog); cursor: pointer; font-size: var(--text-caption); font-family: var(--font-mono); }
.icon:hover { background: var(--color-graphite); color: var(--color-paper); }
.bundle { max-width: 260px; min-width: 120px; background: var(--ag-panel); border: 1px solid var(--ag-line); border-radius: var(--r-sm); outline: none; color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 3px var(--s-2); }
.hint { font-size: var(--text-caption); color: var(--color-steel); }
.send { min-height: 24px; padding: 2px var(--s-3); margin-left: auto; border: 1px solid var(--color-ember); border-radius: var(--r-sm); background: var(--color-ember); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); font-weight: var(--weight-bold); cursor: pointer; opacity: .35; }
.send.ready { opacity: 1; }
.send.ready:hover { background: var(--color-ember-dim); }
.send.stop { opacity: 1; background: none; border-color: var(--ag-line-2); color: var(--color-fog); }
.send.stop:hover { color: var(--color-ember); border-color: var(--color-ember-dim); }

/* ── mention palette (sketch 033-C compact flat) ── */
.slash-menu.palette { width: 460px; padding: 4px; border-radius: 5px; }
.slash-menu.palette .menu-rows { max-height: 300px; overflow-y: auto; padding: 0; }
.pk { color: var(--color-steel); font-size: 10px; width: 34px; flex: none; }
.pk.jira { color: #7fb3d5; } .pk.repo { color: #e8916d; } .pk.case { color: #a8c58a; } .pk.file { color: #b08ccf; } .pk.recent { color: var(--color-steel); }
.slash-row .slash-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slash-row.state { color: var(--color-steel); cursor: default; }
.p-foot { display: flex; justify-content: space-between; padding: 4px 8px 2px; color: var(--color-steel); opacity: .7; font-size: 9.5px; border-top: 1px solid var(--ag-line); margin-top: 4px; }

/* ── textarea + chip overlay (MR1 range tokens) — METRIC-LOCKED to the textarea.
 *  The overlay must render IDENTICAL geometry or chips double/offset (screenshot bug):
 *  same font stack, size, line-height, letter-spacing, padding, wrap behavior.
 *  Chips are inline boxes that add ONLY horizontal padding — never vertical —
 *  so line metrics cannot shift; monospace house font keeps widths exact. */
.ta-wrap { position: relative; flex: 1; display: flex; }
.ta-wrap textarea,
.ta-overlay {
  font-family: var(--font-mono);
  font-size: var(--text-body);
  line-height: 1.6;
  letter-spacing: normal;
  padding: 6px 8px;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: normal;
  tab-size: 2;
  border: none;
}
.ta-overlay { position: absolute; inset: 0; color: transparent; pointer-events: none; overflow: hidden; z-index: 0; }
.ta-wrap textarea { position: relative; z-index: 1; background: transparent; caret-color: var(--color-paper); color: transparent; }
.ta-wrap textarea::placeholder { color: var(--color-steel); opacity: .8; }
/* native selection highlight would glow through the overlay chips — subdue it */
.ta-wrap textarea::selection { background: rgba(179, 84, 44, .35); }
.ta-overlay { color: var(--color-paper); }
/* the textarea's NATIVE selection still shows through (transparent text above it);
   hide the doubled selection by making the textarea's own text invisible? No —
   the textarea keeps real text (source of truth); the overlay chips SIT ABOVE it.
   To avoid double-render: the textarea text stays VISIBLE for non-token ranges is
   NOT possible per-range — so instead the OVERLAY paints chips only where tokens
   are, and the textarea's native text remains visible underneath. The chip
   background must therefore fully COVER the raw text beneath (same metrics →
   exact cover), which the metric lock above guarantees. */
.chip.inline { display: inline; border-radius: 3px; padding: 0 5px; margin: 0; font-size: inherit; line-height: inherit; background: #2a2a2a; color: var(--color-paper); border: none; text-decoration: none; }
.chip.inline.jira { color: #7fb3d5; } .chip.inline.github-commit, .chip.inline.github-pr { color: #e8916d; } .chip.inline.case { color: #a8c58a; } .chip.inline.attachment { color: #b08ccf; }
</style>
