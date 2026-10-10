<script setup lang="ts">
/** P3 agent chat — thread: user bubbles + agent prose, refs rows, tool
 *  traces, status line (sketch b1-warm anatomy). Read-only rendering. */
interface Ref { kind: string; name: string }
interface Msg { role: 'user' | 'assistant' | 'system'; text: string; refs?: Ref[]; toolTrace?: string; status?: string }

defineProps<{ messages: Msg[]; title: string; live: boolean }>();
</script>

<template>
  <section class="th">
    <div class="head">
      <span class="t ag-serif">{{ title }}</span>
      <span v-if="live" class="pill live"><span class="dot"></span>authoring</span>
      <span v-else-if="messages.length" class="pill">idle</span>
    </div>
    <div class="scroll">
      <div class="inner">
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <template v-if="m.role === 'user'">
            <div class="body">
              <div class="txt">{{ m.text }}</div>
              <div v-if="m.refs?.length" class="atts">
                <span v-for="r in m.refs" :key="r.name" class="att ag-mono" :class="{ jira: r.kind === 'jira' }">{{ r.kind === 'jira' ? '◈' : '△' }} {{ r.name }}</span>
              </div>
            </div>
            <span class="avatar you">you</span>
          </template>
          <template v-else-if="m.role === 'assistant'">
            <span class="avatar agent">✦</span>
            <div class="body">
              <div class="who">butler</div>
              <div v-if="m.status" class="status ag-mono">{{ m.status }}</div>
              <div class="txt">{{ m.text }}</div>
              <div v-if="m.toolTrace" class="tool ag-mono">⌁ {{ m.toolTrace }}</div>
            </div>
          </template>
          <template v-else>
            <div class="sys ag-mono">{{ m.text }}</div>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.th { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
.head { display: flex; align-items: center; gap: 10px; padding: 16px 26px 8px; }
.head .t { font-size: 20px; }
.pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 3px 11px; font-size: 11.5px; color: var(--ag-ink-2); background: var(--ag-surface); box-shadow: inset 0 0 0 1px var(--ag-line); }
.pill.live { color: var(--ag-ember); box-shadow: inset 0 0 0 1px rgba(224,106,53,.4); }
.dot { width: 5px; height: 5px; border-radius: 50%; background: var(--ag-ember); animation: agpulse 1.3s infinite; }
@keyframes agpulse { 50% { opacity: .3; } }

.scroll { flex: 1; overflow-y: auto; }
.inner { max-width: 700px; margin: 0 auto; padding: 10px 22px 190px; display: flex; flex-direction: column; gap: 20px; }
.msg { display: flex; gap: 12px; }
.msg.user { justify-content: flex-end; }
.avatar { width: 28px; height: 28px; border-radius: 50%; flex: none; display: grid; place-items: center; font-size: 10.5px; }
.avatar.you { color: var(--ag-ink-2); background: var(--ag-surface); box-shadow: inset 0 0 0 1px var(--ag-line); }
.avatar.agent { color: var(--ag-ink); background: radial-gradient(circle at 35% 30%, var(--ag-ember), var(--ag-ember-dim) 75%); box-shadow: 0 0 12px rgba(224,106,53,.4); }
.body { max-width: 82%; min-width: 0; }
.msg.user .body { background: var(--ag-raise); border-radius: 17px 17px 4px 17px; padding: 10px 15px; }
.msg.assistant .body { max-width: 100%; }
.who { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--ag-ink-3); margin-bottom: 5px; }
.txt { white-space: pre-wrap; }
.status { display: inline-flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--ag-ink-3); border: 1px solid var(--ag-line); border-radius: 999px; padding: 3px 10px; margin-bottom: 6px; }
.atts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.att { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 2px 11px; font-size: 11px; color: var(--ag-ink-2); background: #1d1b18; box-shadow: inset 0 0 0 1px var(--ag-line); }
.att.jira { color: var(--ag-ember); box-shadow: inset 0 0 0 1px rgba(224,106,53,.45); }
.tool { font-size: 12.5px; color: var(--ag-ink-3); margin-top: 7px; font-style: italic; }
.sys { max-width: 700px; margin: 0 auto; align-self: center; font-size: 12px; color: var(--ag-ink-3); border: 1px dashed var(--ag-line); border-radius: 12px; padding: 6px 14px; }
</style>
