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
          :status="item.status === 'completed' || item.status === 'running' ? item.status : item.status === 'failed' ? 'failed' : 'cancelled'"
        />
        <WorkRow
          v-else-if="item.kind === 'mcp_tool_call'"
          :name="item.name"
          :arg="item.arg"
          :result="item.result"
          :is-error="item.isError"
          :status="item.status"
        />
        <TimelineError v-else-if="item.kind === 'error'" :class-name="item.class" :message="item.message" />
        <TimelineUsage v-else-if="item.kind === 'usage'" :cost="item.cost" :context-used="item.contextUsed" :context-window="item.contextWindow" />
        <div v-else-if="item.kind === 'compaction'" class="tl-compaction">· context compacted — {{ item.summary }}</div>
      </template>
    </div>
    <ScrollPill />
  </StickToBottom>
</template>

<style scoped>
.tl-scroll { position: relative; flex: 1; overflow-y: auto; min-height: 0; }
.tl-inner { display: flex; flex-direction: column; gap: 10px; padding: 20px 24px 28px; max-width: 820px; margin: 0 auto; width: 100%; box-sizing: border-box; }
.tl-empty { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 48px 0; text-align: center; }
.tl-empty h3 { font-size: 13px; font-weight: 500; color: var(--color-fg, #eae6e1); }
.tl-empty p { font-size: 12px; color: var(--color-dim, #6b665e); }
.tl-compaction { font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 10px; color: var(--color-dim, #6b665e); padding: 2px 0; }
</style>
