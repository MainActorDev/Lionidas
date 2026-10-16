<script setup lang="ts">
/** ScrollPill — jump-to-bottom affordance (ai-elements ConversationScrollButton
 *  pattern): rendered only while scrolled up; aria-labelled. */
import { useStickToBottomContext } from 'vue-stick-to-bottom';
const stick = useStickToBottomContext();
</script>

<template>
  <button
    v-if="!stick.isAtBottom.value"
    class="scroll-pill"
    type="button"
    aria-label="Scroll to bottom"
    @click="stick.scrollToBottom()"
  >
    ↓
  </button>
</template>

<style scoped>
.scroll-pill {
  position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
  width: 30px; height: 30px; border-radius: 50%;
  background: var(--agent-carbon, #1d1a18); border: 1px solid var(--agent-line, #2a2724);
  color: var(--color-ash, #a39d95); font-size: 13px; line-height: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center; z-index: 5;
}
.scroll-pill:hover { color: var(--color-fg, #eae6e1); border-color: var(--color-dim, #6b665e); }
.scroll-pill:focus-visible { outline: 1px solid var(--color-ember, #ee6018); outline-offset: 2px; }
</style>
