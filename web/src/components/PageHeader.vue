<script setup lang="ts">
/** B-variant page header — THE one header system (sketch 015-B, real tokens).
 *  Row 1: title (18px) + actions right-aligned, vertically centered.
 *  Row 2: desc (13px steel) + status syms, above a hairline rule.
 *  Slots (not props) so each page keeps its own live bindings:
 *   - default slot → row-2 meta rail (desc, syms — no actions allowed)
 *   - #actions     → row-1 right side (buttons, chips, search, badges)
 */
defineProps<{ title: string }>();
</script>

<template>
  <header class="ph">
    <div class="ph-row1">
      <h1 class="ph-title">{{ title }}</h1>
      <div class="ph-actions"><slot name="actions" /></div>
    </div>
    <div v-if="$slots.default" class="ph-row2">
      <slot />
    </div>
  </header>
</template>

<style scoped>
.ph { margin-bottom: var(--s-5); }
.ph-row1 { display: flex; align-items: center; gap: var(--s-4); margin-bottom: var(--s-2); }
.ph-title {
  font-family: var(--font-mono);
  font-size: var(--text-heading-sm);
  font-weight: var(--weight-bold);
  color: var(--color-paper);
  letter-spacing: -0.01em;
  margin: 0;
}
.ph-actions { display: flex; gap: var(--s-2); align-items: center; margin-left: auto; flex-wrap: wrap; }
.ph-row2 { display: flex; align-items: baseline; gap: var(--s-4); padding-bottom: var(--s-4); border-bottom: 1px solid var(--color-iron); }
</style>
