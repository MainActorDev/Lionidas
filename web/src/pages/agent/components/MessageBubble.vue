<script setup lang="ts">
/** MessageBubble — one message item in the timeline (Phase 5, sketch 042-A).
 *  User: full-width bordered bubble, `/cmd` ember + `@ref` sage chips parsed
 *  from the transport conventions (never rendered raw). Assistant: unboxed
 *  prose (sans) with the house markdown renderer + turn meta line; streaming
 *  = coalesced snapshot + cursor. Turn-group grammar: rail segment + node. */
import { computed } from 'vue';
import { renderMarkdown } from '../markdown';

const props = defineProps<{
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  intent?: 'queued' | 'steering';
  status?: 'completed' | 'failed' | 'cancelled' | 'running';
  turnMeta?: { durationMs: number | null; cost: number | null };
}>();

const html = computed(() => renderMarkdown(props.text));

/** transport-convention parse (mirrors the v1 user-bubble round): split
 *  [cmds:] / [refs:] suffixes into chips; the ask stays prose. */
interface ParsedUser { ask: string; cmds: string[]; refs: Array<{ kind: string; locator: string }> }
const parsed = computed<ParsedUser>(() => {
  if (props.role !== 'user') return { ask: props.text, cmds: [], refs: [] };
  let rest = props.text;
  const cmds: string[] = [];
  const refs: Array<{ kind: string; locator: string }> = [];
  const cmdM = /\s*\[cmds:\s*([^\]]+)\]\s*/.exec(rest);
  if (cmdM) { cmds.push(...cmdM[1]!.split(/\s+/).filter((c) => c.startsWith('/'))); rest = rest.replace(cmdM[0], ' '); }
  const refM = /\s*\[refs:\s*([^\]]+)\]\s*/.exec(rest);
  if (refM) {
    for (const part of refM[1]!.split(/,\s*/)) {
      const [kind, locator] = part.split(':');
      if (kind && locator) refs.push({ kind, locator });
    }
    rest = rest.replace(refM[0], ' ');
  }
  return { ask: rest.replace(/\s+/g, ' ').trim(), cmds, refs };
});

const durationLabel = computed(() => {
  const ms = props.turnMeta?.durationMs;
  if (ms === null || ms === undefined) return null;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
});
const costLabel = computed(() => {
  const c = props.turnMeta?.cost;
  return typeof c === 'number' && c > 0 ? `$${c < 0.005 ? c.toFixed(4) : c.toFixed(3)}` : null;
});
const copy = (): void => { void window.navigator.clipboard?.writeText(props.text); };
const metaParts = computed(() => [durationLabel.value, costLabel.value].filter(Boolean) as string[]);
</script>

<template>
  <div class="turngroup" :class="`is-${role}`">
    <span class="node" aria-hidden="true"></span>
    <div class="turnbody">
      <div class="meta">
        <span class="who">{{ role === 'user' ? 'you' : 'agent' }}</span>
        <span v-if="role === 'assistant' && streaming" class="run">running</span>
        <span v-for="p in metaParts" :key="p" class="dim">{{ p }}</span>
        <span v-if="intent" class="intent-tag" :class="`t-${intent}`">{{ intent }}</span>
        <span v-if="status === 'failed'" class="fail-tag">failed</span>
        <span v-else-if="status === 'cancelled'" class="off-tag">aborted</span>
      </div>
      <div v-if="role === 'user'" class="bubble-user">
        <span v-for="c in parsed.cmds" :key="c" class="chip cmd">{{ c }}</span>
        <span class="ask">{{ parsed.ask }}</span>
        <span v-for="r in parsed.refs" :key="r.kind + r.locator" class="chip ref">@{{ r.locator }}</span>
      </div>
      <div v-else class="assistant">
        <!-- eslint-disable-next-line vue/no-v-html — house renderer escapes-first (markdown.ts) -->
        <div class="txt" v-html="html"></div>
        <span v-if="streaming" class="cursor" aria-hidden="true"></span>
        <span v-if="streaming" class="sr-only">response streaming</span>
      </div>
      <div v-if="role === 'assistant' && !streaming" class="foot">
        <button type="button" class="fbtn" @click="copy">copy</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.turngroup { display: grid; grid-template-columns: 19px 1fr; column-gap: 14px; position: relative; padding: 2px 0; min-width: 0; }
.node { width: 11px; height: 11px; border-radius: 50%; background: var(--ag-bg, #141414); border: 2px solid var(--ag-line-2, #3a3a3a); justify-self: center; margin-top: 4px; }
.is-user .node { border-color: var(--ag-ink-dim, #a39d95); }
.turngroup::before { content: ''; position: absolute; left: 9px; top: 0; bottom: 0; width: 1px; background: var(--ag-line, #2a2a2a); }
.turngroup:first-child::before { top: 14px; }
.turngroup:last-child::before { bottom: calc(100% - 15px); }
.turnbody { min-width: 0; }
.meta { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 10px; color: var(--ag-ink-dim, #a39d95); margin-bottom: 6px; min-width: 0; }
.meta .run { color: var(--color-ember, #ee6018); }
.intent-tag { color: var(--color-gold, #d9b06a); }
.intent-tag.t-steering { color: var(--color-ember, #ee6018); }
.fail-tag { color: var(--color-danger, #d97a6a); }
.off-tag { color: var(--ag-ink-dim, #a39d95); }
.bubble-user { background: var(--ag-surface, #1d1a18); border: 1px solid var(--ag-line, #2a2a2a); border-radius: 2px; padding: 9px 13px; font-size: 13px; font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif); color: var(--ag-ink, #eae6e1); min-width: 0; overflow-wrap: anywhere; }
.ask { min-width: 0; }
.chip { font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 11px; border-radius: 2px; padding: 1px 5px; margin-right: 5px; white-space: nowrap; }
.chip.cmd { background: rgba(238, 96, 24, .14); color: #f2732e; /* lifted ember: 4.8:1 on the tinted chip bg */ }
.chip.ref { background: rgba(160, 202, 146, .12); color: var(--color-sage, #a0ca92); }
.assistant { font-size: 13.5px; font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif); color: var(--ag-ink, #eae6e1); min-width: 0; }
.txt { min-width: 0; overflow-wrap: anywhere; }
.txt :deep(p) { margin: 0 0 8px; }
.txt :deep(p:last-child) { margin-bottom: 0; }
/* GFM tables: scroll instead of squeeze — a wide table must not compress
 * cells to the chat width; it keeps its natural width and the bubble
 * scrolls (display:block on the table wrapper = scroll container).
 * Narrow tables still fill 100% (no visual change for the common case). */
.txt :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.txt :deep(th), .txt :deep(td) { border: 1px solid var(--ag-line, #2a2a2a); padding: 5px 10px; text-align: left; white-space: nowrap; }
.txt :deep(th) { font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 11px; color: var(--ag-ink-dim, #a39d95); }
.txt :deep(td) { font-size: 12.5px; color: var(--ag-ink, #eae6e1); }
.txt :deep(code) {
  font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 12px;
  background: var(--ag-surface, #1d1a18); border: 1px solid #232120; border-radius: 2px; padding: 1px 5px;
}
.cursor { display: inline-block; width: 7px; height: 13px; margin-left: 3px; background: var(--color-ember, #ee6018); vertical-align: text-bottom; animation: agblink .9s infinite; }
@keyframes agblink { 50% { opacity: 0; } }
.foot { display: flex; gap: 12px; margin-top: 8px; }
.fbtn { font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 10px; color: var(--ag-ink-dim, #a39d95); background: none; border: none; cursor: pointer; padding: 0; }
.fbtn:hover { color: var(--ag-ink, #eae6e1); }
.fbtn:focus-visible { outline: 1px solid var(--color-ember, #ee6018); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>
