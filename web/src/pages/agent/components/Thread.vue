<script setup lang="ts">
/** P3 agent chat — thread: user bubbles + agent prose, refs rows, tool
 *  traces, status line (sketch b1-warm anatomy). Read-only rendering. */
interface Ref { kind: string; name: string }
interface Msg { role: 'user' | 'assistant' | 'system'; text: string; refs?: Ref[]; toolTrace?: string; status?: string; aborted?: boolean; displaced?: boolean; triesLabel?: string }

import { ref, watch, nextTick } from 'vue';
import { renderMarkdown } from '../markdown.ts';

/** user-bubble renderer (mention-palette round): the '[refs: kind:loc]' suffix is
 *  a transport artifact — never show it raw. Ref labels render as kind-tinted
 *  inline chips (same palette as the composer); plain text keeps markdown. Works
 *  for live-sent messages (m.refs) AND reloaded history (kinds parsed from the
 *  suffix). Bare locators from pre-kind history still chip via m.refs. */
interface BubbleRef { kind: string; locator: string }
function parseRefSuffix(text: string): { clean: string; refs: BubbleRef[] } {
  const m = /\s*\[refs:\s*([^\]]+)\]\s*$/.exec(text);
  if (!m) return { clean: text, refs: [] };
  const refs = (m[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const at = x.indexOf(':');
    return at > 0 ? { kind: x.slice(0, at), locator: x.slice(at + 1) } : { kind: 'doc', locator: x };
  });
  return { clean: text.slice(0, m.index).trimEnd(), refs };
}
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function chip(kind: string, label: string): string {
  const cls = kind === 'jira' ? 'jira' : kind === 'case' ? 'case' : kind === 'github-commit' || kind === 'github-pr' ? 'repo' : kind === 'attachment' ? 'file' : 'doc';
  return `<span class="uchip ${cls}">@${esc(label)}</span>`;
}
function refLabel(kind: string, locator: string): string {
  if (kind === 'jira' || kind === 'case') return locator;
  return locator;
}
/** command tags: from the [cmds: /a /b] convention first (chat-turn commands,
 *  review CR2), falling back to a leading '/cmd' token (legacy skill rows) */
import { DEFAULT_COMMANDS } from '../commandRegistry.ts';
const KNOWN_CMDS = DEFAULT_COMMANDS.map((c) => c.cmd);
function userCommands(text: string): string[] {
  const m = /\[cmds:\s*([^\]]+)\]/.exec(text);
  if (m) return (m[1] ?? '').split(/\s+/).filter((c) => KNOWN_CMDS.includes(c));
  const first = text.trim().split(/\s+/)[0] ?? '';
  return KNOWN_CMDS.includes(first) ? [first] : [];
}
function renderUserText(m: { text: string; refs?: Array<{ kind: string; name: string }> }): string {
  // strip BOTH transport suffixes ([cmds:] handled as tags above, [refs:] chipped below)
  const noCmds = m.text.replace(/\s*\[cmds:\s*[^\]]+\]\s*/g, ' ').trim();
  const { clean, refs: parsed } = parseRefSuffix(noCmds);
  const all: BubbleRef[] = [
    ...parsed,
    ...(m.refs ?? []).filter((r) => !parsed.some((p) => p.locator === r.name)).map((r) => ({ kind: r.kind, locator: r.name })),
  ];
  let out = renderMarkdown(clean);
  // chip parsed refs by their label appearance in the text (live: labels were inserted by picks)
  for (const r of all) {
    const label = esc(refLabel(r.kind, r.locator));
    if (label && out.includes(label)) out = out.split(label).join(chip(r.kind, r.locator));
  }
  // refs that never appeared inline (bare suffix history) render as trailing chips
  const missing = all.filter((r) => !clean.includes(refLabel(r.kind, r.locator)));
  if (missing.length) out += `<span class="uchip-row">${missing.map((r) => chip(r.kind, refLabel(r.kind, r.locator))).join('')}</span>`;
  return out;
}

const props = defineProps<{ messages: Msg[]; title: string; live: boolean; waiting: boolean; streaming: string | null; sessionId?: string | null; toolStops?: Array<{ name: string; arg?: string; result?: string; isError?: boolean; live: boolean }> }>();
const copied = ref(false);
function copySessionId(): void {
  const id = props.sessionId ?? '';
  void navigator.clipboard.writeText(id).then(() => {
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1200);
  });
}
const emit = defineEmits<{ resend: [msg: Msg], 'queue-edit': [msg: Msg], 'queue-delete': [msg: Msg] }>();
const scrollEl = ref<HTMLElement | null>(null);

/** rev7: keep the newest message in view — on send, while the indicator
 *  shows, and when the response lands. Sticks to bottom unless the user
 *  scrolled up to read (then never yanks them down). */
function stickToBottom(force = false): void {
  const el = scrollEl.value;
  if (!el) return;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (!force && distance > 240) return; // user scrolled away — respect it
  void nextTick(() => { el.scrollTop = el.scrollHeight; });
}

// 1. new user message → jump immediately
watch(() => props.messages.length, () => { stickToBottom(true); });
// 2. loading indicator appears / 3. response replaces it
watch(() => props.waiting, (now) => { if (now) stickToBottom(true); });
watch(() => props.messages[props.messages.length - 1]?.text, (t, was) => { if (t && t !== was) stickToBottom(); });
watch(() => props.streaming, () => { if (props.streaming !== null) stickToBottom(); }); // rev10: follow the stream
</script>

<template>
  <section class="th">
    <div class="head">
      <span class="t">{{ title }}</span>
      <button v-if="sessionId" class="sid" :title="`copy ${sessionId}`" @click="copySessionId">{{ sessionId }}<span v-if="copied" class="cok">✓ copied</span></button>
      <span v-if="live" class="pill live"><span class="dot"></span>authoring</span>
      <span v-else-if="messages.length" class="pill">idle</span>
    </div>
    <div ref="scrollEl" class="scroll">
      <div class="inner">
        <div v-for="(m, i) in messages.filter((x) => (x.text ?? '').trim())" :key="i" class="msg" :class="m.role">
          <template v-if="m.role === 'user'">
            <div class="body" :class="{ aborted: m.aborted, displaced: m.displaced }">
              <span v-for="c in userCommands(m.text)" :key="c" class="cmd-tag">{{ c }}</span>
              <div class="txt" v-html="renderUserText(m)"></div>
              <div v-if="m.triesLabel" class="tries-tag">{{ m.triesLabel }}</div>
              <div v-if="m.aborted" class="ab-actions" @click.stop>
                <span class="ab-tag">aborted</span>
                <button v-if="!(waiting || streaming !== null)" class="ab-btn" @click="emit('resend', m)">resend</button>
              </div>
              <div v-else-if="m.status === 'unsent'" class="ab-actions" @click.stop>
                <span class="ab-tag unsent">unsent</span>
                <button v-if="!(waiting || streaming !== null)" class="ab-btn" @click="emit('resend', m)">send</button>
              </div>
              <div v-else-if="m.status === 'queued'" class="ab-actions" @click.stop>
                <span class="ab-tag queued">queued</span>
                <button class="ab-btn" @click="emit('queue-edit', m)">edit</button>
                <button class="ab-btn" @click="emit('queue-delete', m)">delete</button>
              </div>
            </div>
          </template>
          <template v-else-if="m.role === 'assistant'">
            
            <div class="body">
              <div v-if="m.status" class="status">{{ m.status }}</div>
              <div class="txt" v-html="renderMarkdown(m.text)"></div>
              <div v-if="m.toolTrace" class="tool">⌁ {{ m.toolTrace }}</div>
            </div>
          </template>
          <template v-else>
            <div class="sys">{{ m.text }}</div>
          </template>
        </div>
        <div v-if="toolStops && toolStops.length" class="msg assistant toolrail-msg">
          <div class="body">
            <div class="rail">
              <div v-for="(t, i) in toolStops" :key="i" class="stop" :class="{ live: t.live, err: t.isError }">
                <span class="name">{{ t.name.replace(/^mcp__lionidas__/, '') }}</span> <span v-if="t.arg" class="arg">{{ t.arg }}</span><span class="dur">{{ t.live ? 'running…' : '' }}</span>
                <span v-if="t.result" class="out">⎿ {{ t.result }}</span>
              </div>
            </div>
            <div v-if="streaming" class="txt" v-html="renderMarkdown(streaming)"></div>
          </div>
        </div>
        <div v-else-if="streaming !== null" class="msg assistant streaming"><div class="body"><div class="txt" v-html="renderMarkdown(streaming)"></div><span class="cursor"></span></div></div>
        <div v-if="waiting" class="msg assistant waiting"><div class="body"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></div>
      </div>
      <slot></slot>
    </div>
  </section>
</template>

<style scoped>
.th { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
/* fix #4: chat header = the shared 48px band */
.head { display: flex; align-items: center; gap: var(--s-3); height: var(--ag-head-h); flex: none; padding: 0 var(--s-4); border-bottom: 1px solid var(--ag-line); background: var(--ag-panel); }
.head .t { font-size: var(--text-body); color: var(--color-paper); }
.sid { font-size: 11px; color: var(--color-steel); background: none; border: 1px solid var(--ag-line); border-radius: var(--r-sm); padding: 1px 8px; cursor: pointer; font-family: var(--font-mono); position: relative; }
.sid:hover { color: var(--color-paper); border-color: var(--ag-line-2); }
.sid .cok { color: var(--color-ember); margin-left: 6px; }
.pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--ag-line); border-radius: var(--r-sm); padding: 1px var(--s-2); font-size: var(--text-caption); color: var(--color-fog); }
.pill.live { color: var(--color-ember); border-color: var(--color-ember-dim); }
.dot { width: 5px; height: 5px; border-radius: 50%; background: var(--color-ember); animation: agpulse 1.3s infinite; }
@keyframes agpulse { 50% { opacity: .3; } }

.scroll { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
/* fix #10: bottom padding clears the floating composer (120px + gap) — the
   last bubble never hides under the input */
/* alignment (fix #2): inner and the composer share ONE box rule — width
   calc(100% - 2*s-4), capped 720, centered — so the AI bubble's left edge
   and the user bubble's right edge sit exactly on the composer's edges */
.inner { flex: 1; width: calc(100% - 2 * var(--s-4)); max-width: 720px; margin: 0 auto; padding: var(--s-4) 0 var(--s-4); display: flex; flex-direction: column; justify-content: flex-end; gap: var(--s-4); }
.msg { display: flex; gap: var(--s-3); }
.msg.user { justify-content: flex-end; }
.who { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-steel); margin-bottom: 4px; }
.body { max-width: 82%; min-width: 0; }
.msg.user .body { background: var(--ag-user-bubble); border: 1px solid transparent; border-radius: 10px; border-bottom-right-radius: 3px; padding: var(--s-2) var(--s-3); }
.msg.user .txt { color: var(--color-paper); }
.msg.user .txt :deep(code) { background: rgba(0,0,0,.25); border-color: rgba(0,0,0,.25); }
/* rev9: aborted user message — dimmed, dashed, with resend */
.msg.user .body.aborted { background: transparent; border: 1px dashed var(--ag-line-2); }
.msg.user .body.displaced { opacity: .55; }
.msg.user .body.displaced .txt { text-decoration: line-through; text-decoration-color: var(--color-steel); }
.body.aborted .txt { color: var(--color-fog); }
.ab-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.ab-tag.queued { color: var(--color-ember); border-color: var(--ag-line); }
.ab-tag.unsent { color: var(--color-steel); border-color: var(--ag-line-2); }
.tries-tag { display: inline-block; margin-top: 3px; font-size: 11px; letter-spacing: .02em; color: var(--color-steel, #8a8f98); }
.ab-tag { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-ember); }
.ab-btn { border: 1px solid var(--ag-line-2); border-radius: var(--r-sm); background: var(--ag-panel); color: var(--color-fog); font-family: var(--font-mono); font-size: var(--text-caption); padding: 2px 10px; cursor: pointer; }
.ab-btn:hover { color: var(--color-paper); border-color: var(--color-ember-dim); }
.msg.user .txt :deep(a) { color: var(--color-paper); text-decoration: underline; }
.msg.assistant .body { max-width: 88%; background: #222; border: 1px solid var(--ag-line-2); border-radius: 10px; border-bottom-left-radius: 3px; padding: var(--s-2) var(--s-3); }
.msg.assistant .txt { color: var(--color-fog); }
/* loading dots (#3) — same bubble anatomy, three pulsing dots */
.msg.waiting .body { display: inline-flex; gap: 5px; align-items: center; padding: 10px 14px; }
.msg.streaming .body { display: flex; align-items: flex-end; }
/* rev15 design C: timeline rail — mirrors the run-panel stage flow */
.rail { position: relative; margin: 6px 0 10px; padding-left: 22px; }
.rail::before { content: ''; position: absolute; left: 7px; top: 6px; bottom: 6px; width: 1px; background: var(--ag-line-2); }
.stop { position: relative; padding: 4px 0; font-size: var(--text-caption); min-width: 0; overflow-wrap: anywhere; }
.stop::before { content: ''; position: absolute; left: -19px; top: 11px; width: 7px; height: 7px; border-radius: 2px; background: var(--color-fog); }
.stop.live::before { background: var(--color-ember); animation: agpulse 1.3s infinite; }
.stop .name { color: var(--color-paper); font-weight: var(--weight-bold); }
.stop .arg { color: var(--color-steel); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.stop .dur { float: right; color: var(--color-steel); font-size: 11px; }
.stop .out { display: block; color: var(--color-steel); font-size: 11px; padding-left: 14px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-all; }
.stop.err .out { color: var(--color-ember); }
.msg.streaming .cursor { display: inline-block; width: 7px; height: 14px; margin-left: 4px; background: var(--color-ember); animation: agblink 0.9s infinite; }
@keyframes agblink { 50% { opacity: 0; } }
.msg.waiting .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-steel); animation: agbounce 1.2s infinite; }
.msg.waiting .dot:nth-child(2) { animation-delay: .15s; }
.msg.waiting .dot:nth-child(3) { animation-delay: .3s; }
@keyframes agbounce { 0%, 60%, 100% { opacity: .25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
.txt { font-size: var(--text-body); color: var(--color-paper); overflow-wrap: break-word; }
/* markdown inside bubbles (fix #5) */
.txt :deep(p) { margin: 0 0 6px; }
.txt :deep(p:last-child) { margin-bottom: 0; }
.txt :deep(h3), .txt :deep(h4), .txt :deep(h5), .txt :deep(h6) { font-size: var(--text-body); color: var(--color-paper); margin: 8px 0 4px; }
.txt :deep(ul), .txt :deep(ol) { margin: 0 0 6px; padding-left: 18px; }
.txt :deep(li) { margin: 2px 0; }
.txt :deep(code) { font-family: var(--font-mono); font-size: var(--text-caption); background: var(--ag-panel); border: 1px solid var(--ag-line); border-radius: var(--r-sm); padding: 0 4px; }
.txt :deep(pre.code) { background: var(--ag-panel); border: 1px solid var(--ag-line); border-radius: var(--r-sm); padding: var(--s-3); margin: 0 0 8px; font-family: var(--font-mono); font-size: var(--text-caption); line-height: 1.7; white-space: pre-wrap; overflow-wrap: break-word; tab-size: 2; }
.txt :deep(pre.code code) { background: none; border: none; padding: 0; font-family: inherit; font-size: inherit; color: var(--color-fog); }
/* yaml: subtle per-level tint on keys/structure via injected spans happens in
   the renderer; here we only cap width so wrap keeps lines readable */
.txt :deep(pre.lang-yaml) { max-height: 420px; overflow-y: auto; }
.txt :deep(a) { color: var(--color-ember); }
/* evidence embeds: capped, bordered, in-bubble media */
.txt :deep(.ev-embed) { display: block; max-width: 100%; max-height: 320px; border: 1px solid var(--ag-line); border-radius: var(--r-sm); margin: 6px 0; }
.txt :deep(video.ev-embed) { width: 100%; }
.txt :deep(table) { border-collapse: collapse; margin: 0 0 8px; max-width: 100%; display: block; overflow-x: auto; font-size: var(--text-caption); }
.txt :deep(th), .txt :deep(td) { border: 1px solid var(--ag-line); padding: 4px 10px; text-align: left; }
.txt :deep(th) { background: var(--ag-panel); color: var(--color-paper); font-weight: var(--weight-bold); white-space: nowrap; }
.txt :deep(td) { color: var(--color-fog); }
.txt :deep(strong) { color: var(--color-paper); }
.status.inflight { color: #e8916d; border-color: rgba(232,145,109,.4); animation: agpulse 1.6s ease-in-out infinite; }
.status { display: inline-flex; align-items: center; gap: 8px; font-size: var(--text-caption); color: var(--color-steel); border: 1px solid var(--ag-line); border-radius: var(--r-sm); padding: 1px var(--s-2); margin-bottom: 6px; }
/* ── user bubble: command chip + inline ref chips (composer-parity) ── */
.cmd-tag { display: inline-block; margin: 0 0 4px; padding: 1px 8px; border: 1px solid rgba(232, 145, 109, .4); border-radius: 999px; color: #e8916d; background: rgba(232, 145, 109, .08); font-size: var(--text-caption); font-weight: var(--weight-bold); }
/* bubble chips — v-html content needs :deep() to match under <style scoped>
 *  (the whole reason earlier tweaks 'did nothing'). Kind-tinted fill + ring,
 *  matched to the composer's picked chips. */
.txt :deep(.uchip) { display: inline; border-radius: 3px; padding: 0 5px; font-family: var(--font-mono); font-weight: var(--weight-bold); background: rgba(0, 0, 0, .32); }
.txt :deep(.uchip.jira) { color: #9cc8e8; background: rgba(127, 179, 213, .18); box-shadow: inset 0 0 0 1px rgba(127, 179, 213, .55); }
.txt :deep(.uchip.repo) { color: #f2a67f; background: rgba(232, 145, 109, .18); box-shadow: inset 0 0 0 1px rgba(232, 145, 109, .55); }
.txt :deep(.uchip.case) { color: #bcd8a6; background: rgba(168, 197, 138, .16); box-shadow: inset 0 0 0 1px rgba(168, 197, 138, .5); }
.txt :deep(.uchip.file) { color: #c6aee0; background: rgba(176, 140, 207, .16); box-shadow: inset 0 0 0 1px rgba(176, 140, 207, .5); }
.txt :deep(.uchip.doc) { color: var(--color-fog); background: rgba(0, 0, 0, .32); box-shadow: inset 0 0 0 1px rgba(128, 128, 128, .4); }
.txt :deep(.uchip-row) { display: block; margin-top: 4px; }
.txt :deep(.cmd-tag) { display: inline-block; margin: 0 0 4px; padding: 1px 8px; border: 1px solid rgba(232, 145, 109, .5); border-radius: 999px; color: #f2a67f; background: rgba(0, 0, 0, .28); font-size: var(--text-caption); font-weight: var(--weight-bold); }
.uchip-row { display: block; margin-top: 4px; }
.msg.user .txt :deep(p) { margin: 0; }

.atts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: var(--s-2); }
.att { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--ag-line); border-radius: var(--r-sm); padding: 0 var(--s-2); font-size: var(--text-caption); color: var(--color-fog); background: var(--ag-panel); }
.att.jira { color: var(--color-ember); border-color: var(--color-ember-dim); }
.tool { font-size: var(--text-caption); color: var(--color-steel); margin-top: 6px; }
.sys { align-self: center; font-size: var(--text-caption); color: var(--color-steel); border: 1px dashed var(--ag-line); border-radius: var(--r-sm); padding: 4px var(--s-3); }
</style>
