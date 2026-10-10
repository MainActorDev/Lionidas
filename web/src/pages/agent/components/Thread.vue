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
      <span class="t">{{ title }}</span>
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
                <span v-for="r in m.refs" :key="r.name" class="att" :class="{ jira: r.kind === 'jira' }">{{ r.kind === 'jira' ? '◈' : '△' }} {{ r.name }}</span>
              </div>
            </div>
            <span class="who">you</span>
          </template>
          <template v-else-if="m.role === 'assistant'">
            
            <div class="body">
              <div class="who">butler</div>
              <div v-if="m.status" class="status">{{ m.status }}</div>
              <div class="txt">{{ m.text }}</div>
              <div v-if="m.toolTrace" class="tool">⌁ {{ m.toolTrace }}</div>
            </div>
          </template>
          <template v-else>
            <div class="sys">{{ m.text }}</div>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.th { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.head { display: flex; align-items: baseline; gap: var(--s-3); padding: var(--s-3) var(--s-4) var(--s-2); border-bottom: 1px solid var(--color-iron); }
.head .t { font-size: var(--text-heading-sm); color: var(--color-paper); }
.pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--color-iron); border-radius: var(--r-sm); padding: 1px var(--s-2); font-size: var(--text-caption); color: var(--color-fog); }
.pill.live { color: var(--color-ember); border-color: var(--color-ember-dim); }
.dot { width: 5px; height: 5px; border-radius: 50%; background: var(--color-ember); animation: agpulse 1.3s infinite; }
@keyframes agpulse { 50% { opacity: .3; } }

.scroll { flex: 1; overflow-y: auto; }
.inner { max-width: 720px; margin: 0 auto; padding: var(--s-4) var(--s-4) 150px; display: flex; flex-direction: column; gap: var(--s-4); }
.msg { display: flex; gap: var(--s-3); }
.msg.user { justify-content: flex-end; }
.who { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-steel); margin-bottom: 4px; }
.body { max-width: 82%; min-width: 0; }
.msg.user .body { background: var(--color-graphite); border: 1px solid var(--color-iron); border-radius: var(--r-sm); border-bottom-right-radius: 0; padding: var(--s-2) var(--s-3); }
.msg.assistant .body { max-width: 100%; }
.txt { white-space: pre-wrap; font-size: var(--text-body); color: var(--color-paper); }
.status { display: inline-flex; align-items: center; gap: 8px; font-size: var(--text-caption); color: var(--color-steel); border: 1px solid var(--color-iron); border-radius: var(--r-sm); padding: 1px var(--s-2); margin-bottom: 6px; }
.atts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: var(--s-2); }
.att { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--color-iron); border-radius: var(--r-sm); padding: 0 var(--s-2); font-size: var(--text-caption); color: var(--color-fog); background: var(--color-carbon); }
.att.jira { color: var(--color-ember); border-color: var(--color-ember-dim); }
.tool { font-size: var(--text-caption); color: var(--color-steel); margin-top: 6px; }
.sys { align-self: center; font-size: var(--text-caption); color: var(--color-steel); border: 1px dashed var(--color-iron); border-radius: var(--r-sm); padding: 4px var(--s-3); }
</style>
