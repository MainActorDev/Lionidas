<script setup lang="ts">
/** Composer rev23 (refs plan F1): command chip + @-mention ref system.
 *  Slash commands (rev21/22) unchanged. Refs are creatable ONLY through the
 *  @ pickers — the free-typed kind+locator form is gone. Selected refs render
 *  as capsule chips in the input line; send maps them to PipelineRef[]. */
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { DEFAULT_COMMANDS } from '../commandRegistry.ts';

export interface Ref { kind: 'jira' | 'github-pr' | 'github-commit' | 'doc' | 'repo' | 'attachment' | 'case'; locator: string; label?: string }
/** a /command token rides the same range machinery (kind 'cmd' is Composer-internal; never sent as a Ref) */

const props = defineProps<{ busy?: boolean; modelOptions?: ModelOption[]; model?: string }>();
const emit = defineEmits<{ send: [text: string, refs: Ref[], appBundle: string, commands: string[], model?: string]; abort: []; 'open-attachment': []; 'model-change': [model: string] }>();

/** model picker (sketch 035-B): segmented chips above the input. Combos tinted
 *  ember with their fallback chain subtitle; direct models gray. */
interface ModelOption { id: string; kind: 'combo' | 'model'; label?: string; members?: string[]; healthy?: boolean }

const text = ref('');
/** command tokens now ride the range machinery (kind 'cmd'); activeCmd is a
 *  computed view over tokens. The old text-mangling promotion/revert is gone —
 *  Backspace-as-unit replaces it. */
let reverting = false; // suppresses palette re-open while clearing text programmatically

watch(text, () => {
  onTextForPalette();
  onTextForSlash();
});

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
  text.value = '';
  closePalette();
  closeSlash();
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
/** edit-back from the queue (visible-queue plan Stage B): restore a draft */
function loadDraft(draftText: string, draftRefs: Ref[], draftCommands: string[]): void {
  resetDraft();
  text.value = `${draftCommands.length ? `${draftCommands.join(' ')} ` : ''}${draftText}`;
  refs.value = [...draftRefs];
  // command tokens as ranges
  let pos = 0;
  for (const c of draftCommands) {
    const at = text.value.indexOf(c, pos);
    if (at >= 0) { tokens.value.push({ start: at, end: at + c.length, kind: 'cmd', locator: c, label: c }); pos = at + c.length; }
  }
  focusTA();
}
defineExpose({ addAttachmentChip, resetDraft, loadDraft });

/** ── rev21: slash command menu ─────────────────────────────────────────── */
// palette rows come from the live registry (fallback: the shared constant — CR4)
const SKILLS = ref<Array<{ cmd: string; desc: string }>>(DEFAULT_COMMANDS.map((c) => ({ cmd: c.cmd, desc: c.description })));
onMounted(() => {
  void fetch('/api/agent/commands')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((b: { commands?: Array<{ cmd: string; description: string }> }) => {
      if (b.commands?.length) SKILLS.value = b.commands.map((c) => ({ cmd: c.cmd, desc: c.description }));
    })
    .catch((e) => console.warn('[composer] command registry fetch failed — using defaults', e));
});
const REGISTERED = (c: string): boolean => SKILLS.value.some((s) => s.cmd === c);

/** ── slash palette = SAME interaction as @ (operator: 'make the slash behavior
 *  the same as @'): caret-anchored, typed-in-place query, ghost chip while
 *  typing, pick inserts an INLINE ATOMIC cmd token; Backspace-as-unit; Esc.
 *  activeCmd (leading-chip model) is derived from the token for send(). */
const slashOpen = ref(false);
const slashStart = ref(-1);
const slashQuery = ref('');
const activeIdx = ref(0);

const skillMatches = computed<Array<{ cmd: string; desc: string }>>(() => {
  const q = slashQuery.value;
  if (!q) return SKILLS.value;
  return SKILLS.value.filter((s) => s.cmd.startsWith(`/${q}`) || s.cmd.slice(1).startsWith(q));
});

/** active command = the first cmd token (legacy leading position wins) */
const activeCmd = computed<string | null>(() => {
  const t = tokens.value.find((x) => x.kind === 'cmd');
  if (!t) return null;
  // only a leading token (at text start, modulo whitespace) counts as THE command
  return text.value.trimStart().startsWith(t.label) ? t.label : null;
});

/** caret-based '/' token detection — mirrors onTextForPalette */
function onTextForSlash(): void {
  if (reverting) return;
  const el = ta();
  if (!el) return;
  const caret = el.selectionStart ?? 0;
  const before = text.value.slice(0, caret);
  const m = /(^|\s)\/([A-Za-z0-9-]*)$/.exec(before);
  if (!m) { if (slashOpen.value) closeSlash(); return; }
  const startIdx = caret - (m[2]?.length ?? 0) - 1;
  if (!slashOpen.value) { slashOpen.value = true; slashStart.value = startIdx; activeIdx.value = 0; }
  else slashStart.value = startIdx;
  slashQuery.value = m[2] ?? '';
}

function closeSlash(): void {
  slashOpen.value = false;
  slashStart.value = -1;
  slashQuery.value = '';
}

/** pick: replace '/query' with the command as an inline atomic token */
function acceptSkill(idx?: number): void {
  const pick = skillMatches.value[idx ?? activeIdx.value];
  if (!pick) return;
  const el = ta();
  if (!el || slashStart.value < 0) { closeSlash(); return; }
  const at = slashStart.value;
  const end = el.selectionStart ?? at;
  const insert = `${pick.cmd} `;
  const removedLen = end - at;
  const newToken: TokenRange = { start: at, end: at + pick.cmd.length, kind: 'cmd', locator: pick.cmd, label: pick.cmd };
  applyEdit(text.value.slice(0, at) + insert + text.value.slice(end), at + insert.length, (t) => {
    if (t.start >= end) return { ...t, start: t.start - removedLen + insert.length, end: t.end - removedLen + insert.length };
    return t;
  });
  tokens.value = [...tokens.value, newToken].sort((a, b) => a.start - b.start);
  closeSlash();
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
interface TokenRange { start: number; end: number; kind: Ref['kind'] | 'cmd'; locator: string; label: string }

const atOpen = ref(false);
const atQuery = ref('');
const atStart = ref(-1);          // index of '@' in text
const atIdx = ref(0);
const paletteRows = ref<PaletteRow[]>([]);
const paletteLoading = ref(false);
const jiraRows = ref<PaletteRow[]>([]);   // async tier
const jiraSearching = ref(false);
const tokens = ref<TokenRange[]>([]);     // MR1: ranges, never sentinels
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
/** snap: a caret placed strictly INSIDE a chip jumps to its end (the chip is atomic) */
function snapCaretOutOfTokens(): void {
  const el = ta();
  if (!el || el.selectionStart !== el.selectionEnd) return;
  const c = el.selectionStart ?? -1;
  const inside = tokens.value.find((t) => t.start < c && c < t.end);
  if (inside) el.setSelectionRange(inside.end, inside.end);
}

/** caret-based @ token detection: opens while typing; query = '@'+… to caret */
function onTextForPalette(): void {
  if (reverting) return;
  const el = ta();
  if (!el) return;
  snapCaretOutOfTokens();
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


/** ── imperative edit primitive (the Slack chip model) ────────────────────
 *  Every programmatic edit sets el.value + el.setSelectionRange SYNCHRONOUSLY,
 *  then dispatches an input event so v-model syncs FROM the element. There is
 *  no re-render window for the caret to drift in. Tokens shift atomically. */
function applyEdit(newValue: string, caret: number, tokenEdit: (t: TokenRange) => TokenRange | null): void {
  const el = ta();
  if (!el) { text.value = newValue; return; }
  el.value = newValue;
  const pos = Math.max(0, Math.min(caret, newValue.length));
  el.focus();
  el.setSelectionRange(pos, pos);
  // shift/drop token ranges through this edit
  const oldTokens = [...tokens.value].sort((a, b) => a.start - b.start);
  tokens.value = oldTokens.map(tokenEdit).filter((t): t is TokenRange => t !== null);
  el.dispatchEvent(new Event('input', { bubbles: true })); // v-model syncs from the element
}

/** find the token the caret relates to: 'inside' (start<caret<end incl. selection),
 *  'before' (caret === start), 'after' (caret === end) */
function tokenAtCaret(el: HTMLTextAreaElement): { token: TokenRange; side: 'before' | 'after' | 'inside' } | null {
  const c = el.selectionStart ?? -1;
  const sel = (el.selectionEnd ?? c) - c;
  for (const t of tokens.value) {
    if (sel > 0 && c < t.end && (el.selectionEnd ?? c) > t.start) return { token: t, side: 'inside' };
    if (c === t.start) return { token: t, side: 'before' };
    // 'after' includes the swallowed trailing space position — Backspace right after a chip+space
    // deletes the CHIP (what every mention UI does), not the lone space first
    const spaceAfter = text.value[t.end] === ' ' ? 1 : 0;
    if (c === t.end || c === t.end + spaceAfter) return { token: t, side: 'after' };
    if (c > t.start && c < t.end) return { token: t, side: 'inside' };
  }
  return null;
}

/** remove one token (chip) entirely: text span + one adjacent space + its ref */
function removeToken(t: TokenRange, caretTarget: number): void {
  let start = t.start;
  let end = t.end;
  const v = text.value;
  if (v[end] === ' ') end += 1;          // swallow the trailing space
  else if (v[start - 1] === ' ') start -= 1; // or a leading one
  const cutLen = end - start;
  const removedToken = t;
  applyEdit(v.slice(0, start) + v.slice(end), start, (tok) => {
    if (tok === removedToken) return null;
    if (tok.start >= end) return { ...tok, start: tok.start - cutLen, end: tok.end - cutLen };
    return tok;
  });
  const ref = refs.value.find((r) => r.kind === t.kind && r.locator === t.locator);
  if (ref) refs.value = refs.value.filter((r) => r !== ref);
  void caretTarget;
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
  const atPos = atStart.value;
  const end = el.selectionStart ?? atPos;
  const removedLen = end - atPos;
  const newToken: TokenRange = { start: atPos, end: atPos + label.length, kind: row.ref.kind, locator: row.ref.locator, label };
  applyEdit(text.value.slice(0, atPos) + insert + text.value.slice(end), atPos + insert.length, (t) => {
    if (t.start >= end) return { ...t, start: t.start - removedLen + insert.length, end: t.end - removedLen + insert.length };
    return t;
  });
  tokens.value = [...tokens.value, newToken].sort((a, b) => a.start - b.start);
  const pickedRef: Ref = { kind: row.ref.kind, locator: row.ref.locator, label };
  if (refs.value.length < REF_CAP && !refs.value.some((r) => r.kind === pickedRef.kind && r.locator === pickedRef.locator)) refs.value.push(pickedRef);
  pushRecent(pickedRef);
  closePalette();
}

/** overlay model: plain text + chip ranges → render segments */
const overlaySegments = computed<Array<{ text: string; token?: TokenRange; active?: boolean }>>(() => {
  const segs: Array<{ text: string; token?: TokenRange; active?: boolean }> = [];
  let pos = 0;
  for (const t of [...tokens.value].sort((a, b) => a.start - b.start)) {
    if (t.start > pos) segs.push({ text: text.value.slice(pos, t.start) });
    segs.push({ text: text.value.slice(t.start, t.end), token: t });
    pos = t.end;
  }
  const tail = text.value.slice(pos);
  if (tail) {
    // the in-flight '@query' (palette open) renders as a ghost chip — mention
    // mode is visibly live before anything is picked
    if (atOpen.value && atStart.value >= pos) {
      const q = text.value.slice(atStart.value);
      segs.push({ text: q, active: true });
    } else {
      segs.push({ text: tail });
    }
  }
  return segs;
});

const taEl = ref<HTMLTextAreaElement | null>(null);
function ta(): HTMLTextAreaElement | null {
  // component-scoped first (tests don't attach to document); document fallback for safety
  return taEl.value ?? (document.querySelector('.composer textarea') as HTMLTextAreaElement | null);
}

/** overlay mirrors the textarea's scroll (long drafts) — caret needs no restore:
 *  applyEdit sets value+selection synchronously and lets v-model sync FROM the
 *  element, so no re-render ever moves the caret. */
watch(() => [text.value, tokens.value.length], () => {
  void nextTick(() => {
    const el = taEl.value;
    const ov = document.querySelector('.ta-overlay') as HTMLElement | null;
    if (el && ov) ov.scrollTop = el.scrollTop;
  });
});


function onKey(e: KeyboardEvent): void {
  // ── atomic chip keys (the Slack model, complete — refs AND commands) ──
  const el = ta();
  if (el) {
    const hit = tokenAtCaret(el);

    // Backspace: caret right AFTER a chip (or a selection touching it) → delete the chip whole
    if (e.key === 'Backspace' && (hit?.side === 'after' || hit?.side === 'inside')) {
      e.preventDefault();
      removeToken(hit.token, hit.token.start);
      return;
    }
    // Backspace: caret just BEFORE a chip → select the chip first (Slack's two-stage), second press deletes
    if (e.key === 'Backspace' && hit?.side === 'before') {
      e.preventDefault();
      if (el.selectionStart === el.selectionEnd) {
        el.setSelectionRange(hit.token.start, hit.token.end); // stage 1: highlight
      } else {
        removeToken(hit.token, hit.token.start);              // stage 2: delete
      }
      return;
    }
    // Delete (forward): caret just BEFORE a chip → remove it whole
    if (e.key === 'Delete' && (hit?.side === 'before' || hit?.side === 'inside')) {
      e.preventDefault();
      removeToken(hit.token, hit.token.start);
      return;
    }
    // ArrowLeft/ArrowRight over a chip with no selection → jump the WHOLE chip (atomic)
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && el.selectionStart === el.selectionEnd && hit) {
      e.preventDefault();
      const pos = e.key === 'ArrowLeft' ? hit.token.start : hit.token.end;
      el.setSelectionRange(pos, pos);
      return;
    }
    // any printable/editing key with a selection covering a chip → delete the chip first (atomic replace)
    if (hit?.side === 'inside' && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      removeToken(hit.token, hit.token.start);
      // let the character land after the chip removal
      const insert = e.key;
      const at = hit.token.start;
      applyEdit(text.value.slice(0, at) + insert + text.value.slice(at), at + insert.length, (t) => {
        if (t.start >= at) return { ...t, start: t.start + insert.length, end: t.end + insert.length };
        return t;
      });
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
  } else if (slashOpen.value && skillMatches.value.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx.value = (activeIdx.value + 1) % skillMatches.value.length; return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx.value = (activeIdx.value - 1 + skillMatches.value.length) % skillMatches.value.length; return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptSkill(); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
  }
  if (e.key === 'Enter' && e.shiftKey) return; // newline (default)
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    // ⌘↵ sends like ↵ (common convention) — the PAGE routes a busy turn
    // into the visible queue, so this is also the explicit queue path
    e.preventDefault();
    submit();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
}

function submit(): void {
  if (!ready.value) return;
  const t = text.value.trim();
  // ALL command chips (anywhere in the text) ride the skill call; the ENGINE
  // decides execution order (planning → breakdown → author), not typing order.
  // commands-as-chat-turns: command chips ride the SAME chat turn (no skill path)
  const cmdTokens = tokens.value.filter((x) => x.kind === 'cmd').sort((a, b) => a.start - b.start);
  let stripped = text.value;
  for (const ct of [...cmdTokens].reverse()) stripped = stripped.slice(0, ct.start) + stripped.slice(ct.end);
  const ask = stripped.replace(/\s+/g, ' ').trim() || (cmdTokens.length ? text.value.trim() : '');
  const cmds = cmdTokens.map((x) => x.label);
  emit('send', ask, refs.value.map((r) => ({ ...r })), (appBundle.value ?? '').trim(), cmds, props.model);
  clearDraft();
}
function clearDraft(): void {
  text.value = ''; refs.value = []; tokens.value = [];
  closePalette(); closeSlash();
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

      <!-- slash palette — same interaction as @ (one flat list above the caret) -->
      <div v-if="slashOpen && skillMatches.length" class="slash-menu palette">
        <div class="menu-rows">
          <div v-for="(s, i) in skillMatches" :key="s.cmd" class="slash-row" :class="{ active: i === activeIdx }" @mousedown.prevent="acceptSkill(i)" @mousemove="activeIdx = i">
            <span class="pk cmd">cmd</span>
            <span class="slash-name">{{ s.cmd }}</span>
            <span class="slash-desc">{{ s.desc }}</span>
          </div>
        </div>
        <div class="p-foot"><span>/ command</span><span>↑↓ ↵ esc</span></div>
      </div>

      <!-- model picker (sketch 035-B): segmented chips — combos ember, models gray -->
      <div v-if="modelOptions && modelOptions.length" class="model-row">
        <button
          v-for="opt in modelOptions" :key="opt.id" type="button"
          class="mchip" :class="{ on: opt.id === model, combo: opt.kind === 'combo', dead: opt.healthy === false }"
          :title="opt.kind === 'combo' ? (opt.members ?? []).join(' → ') : opt.id"
          @click="emit('model-change', opt.id)"
        >{{ opt.kind === 'combo' ? '◆' : '●' }} {{ opt.label ?? opt.id }}<i v-if="opt.healthy === false" class="d dot-off" /></button>
        <router-link to="/settings" class="mchip add" title="manage models">＋</router-link>
      </div>

      <div class="input-line">
        <div class="ta-wrap">
          <div class="ta-overlay" aria-hidden="true"><template v-for="(seg, i) in overlaySegments" :key="i"><span v-if="seg.token" class="chip inline" :class="seg.token.kind">{{ seg.token.label }}</span><span v-else-if="seg.active" class="chip inline querying">@{{ seg.text }}</span><template v-else>{{ seg.text }}</template></template></div>
          <textarea ref="taEl" v-model="text" :placeholder="activeCmd ? 'describe what you want from this command…' : 'ask about cases, runs, or draft new tests…  ·  @ to reference'" @keydown="onKey" @click="onTextForPalette" @keyup="onTextForPalette" @select="snapCaretOutOfTokens"></textarea>
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
/* model chips (sketch 035-B) */
.model-row { display: flex; gap: 8px; align-items: center; margin: 0 2px 8px; flex-wrap: wrap; }
.mchip { display: inline-flex; align-items: center; gap: 6px; background: var(--ag-surface, #1f1f1f); border: 1px solid var(--ag-line-2, #3a3a3a); border-radius: 20px; padding: 3px 11px; font: 12px/1.4 inherit; color: var(--color-fog, #b4b4b4); cursor: pointer; text-decoration: none; }
.mchip:hover { color: var(--color-paper, #eee); }
.mchip.combo { border-color: rgba(218, 92, 44, .45); }
.mchip.combo.on { border-color: var(--color-ember, #da5c2c); color: var(--color-paper, #eee); }
.mchip.on { color: var(--color-paper, #eee); box-shadow: inset 0 0 0 1px var(--ag-line-2, #3a3a3a); }
.mchip.dead { opacity: .55; }
.mchip.add { border-style: dashed; }
.mchip .dot-off { background: var(--color-steel, #606060); }

.composer { position: relative; pointer-events: auto; width: calc(100% - 2 * var(--s-4)); max-width: 720px; margin: 0 auto; border: 1px solid var(--ag-line-2); border-radius: var(--r-sm); padding: var(--s-2) var(--s-3); background: var(--ag-surface); }
.composer:focus-within { border-color: var(--color-ember-dim); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: var(--s-2); align-items: center; }
.chip { border: 1px solid var(--ag-line); border-radius: 999px; padding: 1px var(--s-2); font-size: var(--text-caption); color: var(--color-fog); background: var(--ag-panel); cursor: pointer; font-family: var(--font-mono); max-width: 280px; display: inline-flex; align-items: center; gap: 4px; }
.ref-kind { color: var(--color-ember); flex: none; }
.ref-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.jira { color: var(--color-ember); border-color: var(--color-ember-dim); }
.chip:hover { background: var(--color-graphite); }
textarea { width: 100%; background: none; border: none; outline: none; color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-body); resize: none; min-height: 30px; }
.row { display: flex; align-items: center; gap: var(--s-2); margin-top: 6px; flex-wrap: wrap; min-width: 0; }
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
.slash-row .slash-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slash-row .slash-desc { flex: 1; }
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
/* LAYER ORDER (the fix for both screenshots): overlay paints ALL text+chips at
 *  z-index 1 — BELOW the textarea. The textarea sits ABOVE (z-index 2) with
 *  transparent text: its native CARET therefore paints OVER chips (17.39.55 —
 *  caret was hidden behind chip backgrounds), and its SELECTION uses a fully
 *  transparent selected-text color so the browser's forced contrast text can't
 *  mirror under the overlay (17.39.50) — only the tinted bar shows. */
.ta-overlay { position: absolute; inset: 0; color: var(--color-paper); pointer-events: none; overflow: hidden; z-index: 1; }
.ta-wrap textarea { position: relative; z-index: 2; background: transparent; caret-color: var(--color-paper); color: transparent; }
.ta-wrap textarea::placeholder { color: var(--color-steel); opacity: .8; }
.ta-wrap textarea::selection { color: transparent; background: rgba(179, 84, 44, .30); }
/* WIDTH-NEUTRAL chips: the overlay must be metrically IDENTICAL to the textarea
 *  or the caret drifts from the text (reported as "minus 1 letter" — 10px of chip
 *  padding ≈ one mono character). Chip-ness comes from background + radius + an
 *  inset ring ONLY: zero padding, zero margin, no border — the chip occupies
 *  exactly the width of its raw text. */
.chip.inline { display: inline; border-radius: 3px; padding: 0; margin: 0; font-size: inherit; line-height: inherit; background: #2c2c2c; box-shadow: inset 0 0 0 1px #3d3d3d; color: var(--color-paper); border: none; text-decoration: none; }
/* the in-flight @token is a REAL chip (operator feedback: the faint ghost read as
 *  plain text) — filled ember family, solid ring, same weight as picked chips;
 *  only the dashed ring says 'still being typed' */
.chip.inline.cmd { color: #f2a67f; background: rgba(232, 145, 109, .18); box-shadow: inset 0 0 0 1px rgba(232, 145, 109, .55); border-radius: 3px; padding: 0; font-weight: var(--weight-bold); }
.pk.cmd { color: #e8916d; }
.chip.inline.querying { color: #f2a67f; background: rgba(232, 145, 109, .22); box-shadow: inset 0 0 0 1px rgba(232, 145, 109, .7); border-radius: 3px; padding: 0; font-weight: var(--weight-bold); }
.chip.inline.jira { color: #7fb3d5; } .chip.inline.github-commit, .chip.inline.github-pr { color: #e8916d; } .chip.inline.case { color: #a8c58a; } .chip.inline.attachment { color: #b08ccf; }
</style>
