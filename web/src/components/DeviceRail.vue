/** Device tool rail (sketch 007-A): grouped icon rail that swaps the sidebar
 *  panel. Pure presentational — availability comes in as props, state lives
 *  in DeviceSidebar. Mechanics mirror InspectTools.vue (32px tools, 6px hover
 *  radius, ember on-state = border + 12% mix, CSS tooltips with kbd hints). */
<script setup lang="ts">
defineProps<{
  active: string;                       // 'session' | 'install' | 'inspect' | 'record' | 'shot' | 'copy'
  canInstall: boolean;                  // watching phase only
  hasSession: boolean;                  // driving-phase tools unlocked
}>();
const emit = defineEmits<{ (e: 'select', tool: 'session' | 'install' | 'inspect' | 'record' | 'shot' | 'copy'): void }>();
</script>

<template>
  <nav class="drail" aria-label="Device tools">
    <div class="dgroup">
      <button class="dtool" :class="{ on: active === 'session' }" @click="emit('select', 'session')">
        <svg viewBox="0 0 20 20"><path d="M10 2a4 4 0 014 4v1h1a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2V9a2 2 0 012-2h1V6a4 4 0 014-4zm0 2a2 2 0 00-2 2v1h4V6a2 2 0 00-2-2z" fill="currentColor"/></svg>
        <span class="tip">session</span>
      </button>
      <button class="dtool" :class="{ on: active === 'install' }" :disabled="!canInstall" @click="emit('select', 'install')">
        <svg viewBox="0 0 20 20"><path d="M10 2l5 5h-3v6H8V7H5l5-5zm-6 13h12v3H4v-3z" fill="currentColor"/></svg>
        <span class="tip">install app</span>
      </button>
    </div>
    <div class="dgroup">
      <button class="dtool" :class="{ on: active === 'inspect' }" :disabled="!hasSession" @click="emit('select', 'inspect')">
        <svg viewBox="0 0 20 20"><path d="M3 3h6v2H5v4H3V3zm8 0h6v6h-2V5h-4V3zM3 11h2v4h4v2H3v-6zm14 0v6h-6v-2h4v-4h2z" fill="currentColor"/></svg>
        <span class="tip">inspect <kbd>i</kbd> · {{ hasSession ? '' : 'take control first' }}</span>
      </button>
    </div>
    <div class="dgroup">
      <button class="dtool" :class="{ on: active === 'record' }" :disabled="!hasSession" @click="emit('select', 'record')">
        <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="10" r="3" fill="currentColor"/></svg>
        <span class="tip">record <kbd>r</kbd> · {{ hasSession ? '' : 'take control first' }}</span>
      </button>
    </div>
    <div class="dgroup">
      <button class="dtool" :class="{ on: active === 'shot' }" :disabled="!hasSession" @click="emit('select', 'shot')">
        <svg viewBox="0 0 20 20"><path d="M7 3L6 5H3v10h14V5h-3l-1-2H7zm3 4a4 4 0 110 8 4 4 0 010-8z" fill="currentColor"/></svg>
        <span class="tip">screenshot <kbd>s</kbd> · {{ hasSession ? '' : 'take control first' }}</span>
      </button>
      <button class="dtool" :class="{ on: active === 'copy' }" :disabled="!hasSession" @click="emit('select', 'copy')">
        <svg viewBox="0 0 20 20"><path d="M6 2h9v11h-2V4H6V2zm-3 3h9v13H3V5z" fill="currentColor"/></svg>
        <span class="tip">copy spec <kbd>⌘⇧C</kbd> · {{ hasSession ? '' : 'take control first' }}</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.drail {
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  width: 44px; padding: 10px 0; flex: none;
  border-right: 1px solid var(--color-iron);
  background: var(--color-carbon);
  /* NO overflow here: overflow on one axis forces the other to auto and
     CLIPS the right-flying tooltips inside the 44px rail (they existed but
     were invisible). Rail content ≈280px tall — never scrolls. */
}
.dgroup { display: flex; flex-direction: column; gap: 6px; }
.dgroup + .dgroup { padding-top: 8px; border-top: 1px solid var(--color-iron); }
.dtool {
  position: relative; display: grid; place-items: center;
  width: 32px; height: 32px; border: 1px solid transparent; border-radius: 6px;
  background: none; color: var(--color-fog);
  transition: color var(--t), background var(--t);
}
.dtool svg { width: 16px; height: 16px; }
.dtool:hover { color: var(--color-paper); background: var(--color-graphite); }
.dtool.on {
  color: var(--color-ember); border-color: var(--color-ember);
  background: color-mix(in srgb, var(--color-ember) 12%, transparent);
}
.dtool:disabled { color: var(--color-steel); cursor: not-allowed; background: none; }
.dtool .tip {
  position: absolute; right: calc(100% + 10px); top: 50%; transform: translateY(-50%);
  background: var(--color-graphite); border: 1px solid var(--color-slate);
  color: var(--color-paper); padding: 3px 8px; border-radius: var(--r-sm);
  font-size: 11px; white-space: nowrap; opacity: 0; pointer-events: none;
  transition: opacity var(--t); z-index: 5;
}
.dtool .tip kbd { color: var(--color-ember); font-family: inherit; margin-left: 4px; }
/* disabled tools keep their tooltip (steel, explaining what's missing) —
   discovery beats a mute lock */
.dtool:disabled .tip { color: var(--color-fog); }
.dtool:disabled .tip kbd { color: var(--color-steel); }
.dtool:hover .tip { opacity: 1; }
</style>
