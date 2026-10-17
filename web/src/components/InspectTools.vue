/** Inspector tool rail (A2 design, FINAL): vertical icon rail beside the props
 *  panel. Groups: Selection (inspect/measure) · View (tree/estimates) ·
 *  Actions (screenshot/copy). Icon-only; hover reveals name + shortcut via CSS
 *  (no synthetic-event traps). Emits semantic toggles; state lives in parent. */
<script setup lang="ts">
const props = defineProps<{
  mode: 'inspect' | 'measure';
  tree: boolean;
  estimates: boolean;
}>();
const emit = defineEmits<{
  (e: 'mode', m: 'inspect' | 'measure'): void;
  (e: 'tree', on: boolean): void;
  (e: 'estimates', on: boolean): void;
  (e: 'screenshot'): void;
  (e: 'copy'): void;
}>();
void props;
</script>

<template>
  <nav class="itools" aria-label="Inspector tools">
    <div class="igroup">
      <button class="tool" :class="{ on: mode === 'inspect' }" @click="emit('mode', 'inspect')">
        <svg viewBox="0 0 20 20"><path d="M3 3h6v2H5v4H3V3zm8 0h6v6h-2V5h-4V3zM3 11h2v4h4v2H3v-6zm14 0v6h-6v-2h4v-4h2z" fill="currentColor"/></svg>
        <span class="tip">inspect <kbd>i</kbd></span>
      </button>
      <button class="tool" :class="{ on: mode === 'measure' }" @click="emit('mode', 'measure')">
        <svg viewBox="0 0 20 20"><path d="M2 14L14 2l4 4L6 18l-4-4zm3.2.4l1.4 1.4 8.4-8.4-1.4-1.4-8.4 8.4z" fill="currentColor"/></svg>
        <span class="tip">measure <kbd>m</kbd></span>
      </button>
    </div>
    <div class="igroup">
      <button class="tool" :class="{ on: tree }" @click="emit('tree', !tree)" :aria-pressed="tree">
        <svg viewBox="0 0 20 20"><path d="M4 2h6v3H4V2zm2 5h4v3H6V7zm2 5h4v3H8v-3zM9 2h7v3H9V2zm6 10h3v3h-3v-3z" fill="currentColor"/></svg>
        <span class="tip">tree <kbd>t</kbd></span>
      </button>
      <button class="tool" :class="{ on: estimates }" @click="emit('estimates', !estimates)" :aria-pressed="estimates">
        <svg viewBox="0 0 20 20"><path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 2a6 6 0 110 12 6 6 0 010-12zm-1 2h2v4l3 2-1 1.7-4-2.4V6z" fill="currentColor"/></svg>
        <span class="tip">estimates <kbd>e</kbd></span>
      </button>
    </div>
    <div class="igroup">
      <button class="tool" @click="emit('screenshot')">
        <svg viewBox="0 0 20 20"><path d="M7 3l-1 2H3v10h14V5h-3l-1-2H7zm3 4a4 4 0 110 8 4 4 0 010-8zm0 2a2 2 0 100 4 2 2 0 000-4z" fill="currentColor"/></svg>
        <span class="tip">screenshot <kbd>s</kbd></span>
      </button>
      <button class="tool" @click="emit('copy')">
        <svg viewBox="0 0 20 20"><path d="M6 2h9v11h-2V4H6V2zm-3 3h9v13H3V5zm2 2v9h5V7H5z" fill="currentColor"/></svg>
        <span class="tip">copy spec <kbd>⌘⇧C</kbd></span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.itools {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  width: 44px;
  padding: 10px 0;
  border-left: 1px solid var(--color-iron, #222);
  background: var(--color-carbon, #111);
  flex: none;
}
.igroup {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.igroup + .igroup {
  padding-top: 8px;
  border-top: 1px solid var(--color-iron, #222);
  margin-top: auto;
}
.igroup:first-child + .igroup { margin-top: 0; }
.tool {
  position: relative;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: var(--color-mist, #9aa4b2);
  cursor: pointer;
}
.tool:hover { color: var(--color-snow, #e8edf4); background: var(--color-graphite, #191919); }
.tool.on {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
}
.tool svg { width: 17px; height: 17px; }
.tip {
  position: absolute;
  left: calc(100% + 10px);
  top: 50%;
  translate: 0 -50%;
  white-space: nowrap;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--color-graphite, #191919);
  border: 1px solid var(--color-iron, #222);
  color: var(--color-snow, #e8edf4);
  font: 500 11px var(--font-ui, ui-sans-serif);
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
  z-index: 30;
}
.tool:hover .tip, .tool:focus-visible .tip { opacity: 1; }
.tip kbd {
  margin-left: 6px;
  padding: 1px 4px;
  border-radius: 4px;
  border: 1px solid var(--color-iron, #222);
  color: var(--color-mist, #9aa4b2);
  font: 500 10px var(--font-mono, ui-monospace);
}
</style>
