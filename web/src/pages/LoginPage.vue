<script setup lang="ts">
/** Login — sketch 005-a terminal pass: one compact card, email+password primary,
 *  Jira secondary, admin-provision footer. Axiom-only styling. */
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';

const router = useRouter();
const route = useRoute();
const email = ref('');
const password = ref('');
const err = ref('');
const busy = ref(false);
const jiraReady = ref(false);

onMounted(async () => {
  try {
    const r = await fetch('/api/auth/me');
    const b = await r.json() as { user: { name: string } | null; jiraConfigured: boolean };
    jiraReady.value = b.jiraConfigured;
    if (b.user) router.replace((route.query.redirect as string) ?? '/');
  } catch { /* server down — form still renders */ }
});

async function signIn(): Promise<void> {
  err.value = '';
  busy.value = true;
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.value.toLowerCase().trim(), password: password.value }),
    });
    const b = await r.json() as { error?: string };
    if (!r.ok) { err.value = b.error ?? 'sign in failed'; return; }
    router.replace((route.query.redirect as string) ?? '/');
  } catch {
    err.value = 'cannot reach server';
  } finally { busy.value = false; }
}
</script>

<template>
  <div class="login-wrap">
    <div class="card login-card">
      <div class="brand">
        <span class="mark"></span>
        <span class="nm">crucible</span>
        <span class="sub">internal · LAN</span>
      </div>

      <div class="field">
        <label for="email">email</label>
        <input id="email" v-model="email" type="email" placeholder="name@lionparcel.com" autocomplete="username" @keydown.enter="signIn" />
      </div>
      <div class="field">
        <label for="pw">password</label>
        <input id="pw" v-model="password" type="password" placeholder="••••••••" autocomplete="current-password" @keydown.enter="signIn" />
      </div>
      <div class="err">{{ err }}</div>
      <button class="btn btn-primary" :disabled="busy" @click="signIn">{{ busy ? 'signing in…' : 'sign in' }}</button>

      <div class="divider">or</div>
      <a class="jira" :class="{ off: !jiraReady }" :href="jiraReady ? '/api/auth/jira/start' : undefined"
        :title="jiraReady ? '' : 'Jira SSO not configured — set CRUCIBLE_JIRA_CLIENT_ID/SECRET'">
        ◈ continue with Jira
      </a>

      <div class="foot">first time? ask an admin to provision your account<br />local accounts only — no self-registration</div>
    </div>
  </div>
</template>

<style scoped>
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--color-void); }
.login-card { width: min(380px, 94vw); padding: 26px 26px 22px; }
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
.brand .mark { width: 12px; height: 12px; background: var(--color-ember); border-radius: 50%; }
.brand .nm { font-size: 14px; font-weight: 700; }
.brand .sub { font-size: 9px; color: var(--color-steel); margin-left: auto; }
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 9px; letter-spacing: .13em; text-transform: uppercase; color: var(--color-steel); margin-bottom: 6px; }
.field input { width: 100%; }
.err { color: var(--color-ember); font-size: 10px; margin: 10px 0 0; min-height: 14px; }
.login-card .btn-primary { width: 100%; margin-top: 8px; }
.divider { display: flex; align-items: center; gap: 10px; margin: 18px 0 14px; color: var(--color-steel); font-size: 9px; letter-spacing: .13em; text-transform: uppercase; }
.divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--color-iron); }
.jira { display: block; text-align: center; width: 100%; background: var(--color-void); border: 1px solid var(--color-slate); color: var(--color-fog); font-size: 11px; padding: 10px; text-decoration: none; }
.jira:hover { border-color: var(--color-fog); color: var(--color-paper); }
.jira.off { opacity: .45; pointer-events: none; }
.foot { margin-top: 18px; font-size: 9px; color: var(--color-steel); text-align: center; line-height: 1.8; }
</style>
