<script setup lang="ts">
/** P3 agent chat — thread: user bubbles + agent prose, refs rows, tool
 *  traces, status line (sketch b1-warm anatomy). Read-only rendering. */
interface Ref { kind: string; name: string }
interface Msg { role: 'user' | 'assistant' | 'system'; text: string; refs?: Ref[]; toolTrace?: string; status?: string }

import { ref, watch, nextTick } from 'vue';
import { renderMarkdown } from '../markdown.ts';

const props = defineProps<{ messages: Msg[]; title: string; live: boolean; waiting: boolean }>();
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
</script>

<template>
  <section class="th">
    <div class="head">
      <span class="t">{{ title }}</span>
      <span v-if="live" class="pill live"><span class="dot"></span>authoring</span>
      <span v-else-if="messages.length" class="pill">idle</span>
    </div>
    <div ref="scrollEl" class="scroll">
      <div class="inner">
        <div v-for="(m, i) in messages.filter((x) => (x.text ?? '').trim())" :key="i" class="msg" :class="m.role">
          <template v-if="m.role === 'user'">
            <div class="body">
              <div class="txt" v-html="renderMarkdown(m.text)"></div>
              <div v-if="m.refs?.length" class="atts">
                <span v-for="r in m.refs" :key="r.name" class="att" :class="{ jira: r.kind === 'jira' }">{{ r.kind === 'jira' ? '◈' : '△' }} {{ r.name }}</span>
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
.msg.user .txt :deep(a) { color: var(--color-paper); text-decoration: underline; }
.msg.assistant .body { max-width: 88%; background: #222; border: 1px solid var(--ag-line-2); border-radius: 10px; border-bottom-left-radius: 3px; padding: var(--s-2) var(--s-3); }
.msg.assistant .txt { color: var(--color-fog); }
/* loading dots (#3) — same bubble anatomy, three pulsing dots */
.msg.waiting .body { display: inline-flex; gap: 5px; align-items: center; padding: 10px 14px; }
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
.txt :deep(pre) { background: var(--ag-panel); border: 1px solid var(--ag-line); border-radius: var(--r-sm); padding: var(--s-2); overflow-x: auto; margin: 0 0 6px; }
.txt :deep(pre code) { background: none; border: none; padding: 0; font-size: var(--text-caption); }
.txt :deep(a) { color: var(--color-ember); }
.txt :deep(table) { border-collapse: collapse; margin: 0 0 8px; max-width: 100%; display: block; overflow-x: auto; font-size: var(--text-caption); }
.txt :deep(th), .txt :deep(td) { border: 1px solid var(--ag-line); padding: 4px 10px; text-align: left; }
.txt :deep(th) { background: var(--ag-panel); color: var(--color-paper); font-weight: var(--weight-bold); white-space: nowrap; }
.txt :deep(td) { color: var(--color-fog); }
.txt :deep(strong) { color: var(--color-paper); }
.status { display: inline-flex; align-items: center; gap: 8px; font-size: var(--text-caption); color: var(--color-steel); border: 1px solid var(--ag-line); border-radius: var(--r-sm); padding: 1px var(--s-2); margin-bottom: 6px; }
.atts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: var(--s-2); }
.att { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--ag-line); border-radius: var(--r-sm); padding: 0 var(--s-2); font-size: var(--text-caption); color: var(--color-fog); background: var(--ag-panel); }
.att.jira { color: var(--color-ember); border-color: var(--color-ember-dim); }
.tool { font-size: var(--text-caption); color: var(--color-steel); margin-top: 6px; }
.sys { align-self: center; font-size: var(--text-caption); color: var(--color-steel); border: 1px dashed var(--ag-line); border-radius: var(--r-sm); padding: 4px var(--s-3); }
</style>
