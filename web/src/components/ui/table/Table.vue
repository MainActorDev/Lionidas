<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div data-slot="table-container" class="relative w-full overflow-auto" tabindex="0">
    <table data-slot="table" :class="cn('w-full caption-bottom text-sm', props.class)">
      <slot />
    </table>
  </div>
</template>
<style scoped>
/* keyboard-scrollable region (axe scrollable-region-focusable):
   focusable when it actually scrolls; ring matches app focus treatment */
div[data-slot='table-container']:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
</style>
