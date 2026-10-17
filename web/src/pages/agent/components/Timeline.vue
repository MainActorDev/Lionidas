<script setup lang="ts">
/** Timeline — the v2 turn-item renderer (Phase 5 step 4, sketch 042-A).
 *  Container semantics follow ai-elements `Conversation`: role="log" live
 *  region, damped stick-to-bottom (vue-stick-to-bottom) with anchor:'none'
 *  anti-yank, jump pill only while scrolled up. UI renders ITEMS only —
 *  never raw events (Phase 5 invariant). */
import { StickToBottom } from 'vue-stick-to-bottom';
import type { TurnItem } from './timelineTypes';
import MessageBubble from './MessageBubble.vue';
import WorkRow from './WorkRow.vue';
import TimelineError from './TimelineError.vue';
import TimelineUsage from './TimelineUsage.vue';
import ScrollPill from './ScrollPill.vue';

withDefaults(defineProps<{ items: TurnItem[]; emptyTitle?: string; emptyDescription?: string }>(), {
  emptyTitle: 'no messages yet',
  emptyDescription: 'ask about cases, runs, or draft new tests…',
});
</script>

<template>
  <StickToBottom class="tl-scroll" role="log" aria-label="conversation" anchor="none" :damping="0.7" :stiffness="0.05" :mass="1.25" initial="instant" resize="instant">
    <div class="tl-inner">
      <div v-if="!items.length" class="tl-empty">
        <h3>{{ emptyTitle }}</h3>
        <p>{{ emptyDescription }}</p>
      </div>
      <template v-for="item in items" :key="item.id">
        <MessageBubble
          v-if="item.kind === 'message'"
          :role="item.role"
          :text="item.text"
          :streaming="item.streaming"
          :intent="item.intent"
          :turn-meta="item.turnMeta"
          :status="item.status === 'completed' || item.status === 'running' ? item.status : item.status === 'failed' ? 'failed' : 'cancelled'"
        />
        <WorkRow
          v-else-if="item.kind === 'mcp_tool_call'"
          :name="item.name"
          :arg="item.arg"
          :result="item.result"
          :is-error="item.isError"
          :status="item.status"
          :duration-ms="item.completedAt !== null ? item.completedAt - item.startedAt : null"
        />
        <div v-else-if="item.kind === 'error'" class="indent"><TimelineError :class-name="item.class" :message="item.message" /></div>
        <div v-else-if="item.kind === 'usage'" class="indent"><TimelineUsage :cost="item.cost" :context-used="item.contextUsed" :context-window="item.contextWindow" /></div>
        <div v-else-if="item.kind === 'compaction'" class="indent tl-compaction">· context compacted — {{ item.summary }}</div>
      </template>
    </div>
    <ScrollPill />
  </StickToBottom>
</template>

<style scoped>
.tl-scroll { position: relative; flex: 1; min-height: 0; overflow: visible; }
/* ONE scroller: vue-stick-to-bottom's internal wrapper is overflow:auto —
 *  .tl-scroll must not also scroll or two bars render (the lib wrapper +
 *  ours). We only position (relative, for the scroll pill). */
.tl-inner { display: flex; flex-direction: column; justify-content: flex-end; gap: 14px; padding: 20px 24px 28px; max-width: 820px; margin: 0 auto; width: 100%; box-sizing: border-box; min-width: 0; overflow-wrap: anywhere; }
/* work rows sit under the turn rail (sketch A: rail 19px + gap 14px) */
.indent { padding-left: 33px; min-width: 0; }
.tl-empty { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 48px 0; text-align: center; margin: auto 0; }
.tl-empty h3 { font-size: 13px; font-weight: 500; color: var(--ag-ink, #eae6e1); }
.tl-empty p { font-size: 12px; color: var(--ag-ink-dim, #a39d95); }
.tl-compaction { font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 10px; color: var(--ag-ink-dim, #a39d95); padding: 2px 0; }
</style>

<style>
/* bottom-anchor (the common chat behavior): short conversations hug the
 * composer — no dead void after the last message. vue-stick-to-bottom's
 * content wrapper is a bare block; make it a full-height flex column so
 * .tl-inner's justify-content:flex-end applies. Long chats overflow
 * normally (min-height, not height). Global selector is .tl-scoped. */
.tl-scroll > div > div > div { display: flex; flex-direction: column; min-height: 100%; }
</style>
