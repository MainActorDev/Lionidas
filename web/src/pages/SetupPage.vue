<script setup lang="ts">
/** First-run setup wizard (/setup): exists ONLY while the instance is
 *  unclaimed. Step 1 claims it — email + password + the token printed on the
 *  server console (proof of machine access, Jenkins-style). After that this
 *  route 404s/redirects to login forever. Axiom tokens only. */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const state = ref<'checking' | 'open' | 'closed'>('checking');
const email = ref('');
const name = ref('');
const password = ref('');
const confirm = ref('');
const token = ref('');
const err = ref('');
const busy = ref(false);

onMounted(async () => {
  try {
    const r = await fetch('/api/setup/state');
    if (r.ok) { state.value = 'open'; return; }
  } catch { /* fall through */ }
  state.value = 'closed';
  router.replace('/login?error=setup-complete');
});

async function claim(): Promise<void> {
  err.value = '';
  if (password.value !== confirm.value) { err.value = 'passwords do not match'; return; }
  if (password.value.length < 8) { err.value = 'password must be at least 8 characters'; return; }
  busy.value = true;
  try {
    const r = await fetch('/api/setup/admin', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.value.toLowerCase().trim(), name: name.value.trim() || undefined, password: password.value, token: token.value.trim() }),
    });
    const b = await r.json() as { ok?: boolean; error?: string };
    if (r.status === 404) { router.replace('/login?error=setup-complete'); return; } // claimed in another tab (R4)
    if (!r.ok) { err.value = b.error ?? 'claim failed'; return; }
    router.replace('/login?notice=setup-complete');
  } catch {
    err.value = 'cannot reach server';
  } finally { busy.value = false; }
}
</script>

<template>
  <div class="login-wrap">
    <div class="card login-card">
      <div class="brand">
        <img class="mark" src="/icons/lionidas-mascot-512.png" alt="" width="96" height="96" />
        <span class="nm">lionidas</span>
        <span class="sub">first-run setup</span>
      </div>

      <template v-if="state === 'open'">
        <p class="lead">This instance is unclaimed. Create the administrator account to finish setup.</p>

        <div class="field">
          <label for="su-email">email</label>
          <input id="su-email" v-model="email" type="email" placeholder="you@lionparcel.com" autocomplete="username" />
        </div>
        <div class="field">
          <label for="su-name">name <span class="opt">(optional)</span></label>
          <input id="su-name" v-model="name" type="text" placeholder="your name" autocomplete="nickname" />
        </div>
        <div class="field">
          <label for="su-pw">password <span class="opt">(min 8)</span></label>
          <input id="su-pw" v-model="password" type="password" placeholder="••••••••" autocomplete="new-password" />
        </div>
        <div class="field">
          <label for="su-pw2">confirm password</label>
          <input id="su-pw2" v-model="confirm" type="password" placeholder="••••••••" autocomplete="new-password" @keydown.enter="claim" />
        </div>
        <div class="field">
          <label for="su-token">setup token <span class="opt">— from the server console</span></label>
          <input id="su-token" v-model="token" type="text" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" class="mono" autocomplete="off" @keydown.enter="claim" />
        </div>

        <div class="err">{{ err }}</div>
        <button class="btn btn-primary" :disabled="busy" @click="claim">{{ busy ? 'claiming…' : 'claim this instance' }}</button>
        <div class="foot">the token proves you control the machine — it printed once on the server console at boot</div>
      </template>

      <template v-else-if="state === 'checking'">
        <p class="lead">checking this instance…</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--color-void); }
.login-card { width: min(380px, 94vw); padding: 26px 26px 22px; }
.brand { display: flex; flex-direction: column; align-items: center; gap: 6px; margin-bottom: 18px; }
.brand .mark { width: 96px; height: 96px; border-radius: 20px; }
.brand .nm { font-size: 14px; font-weight: 700; }
.brand .sub { font-size: 9px; color: var(--color-steel); }
.lead { font-size: 11px; color: var(--color-fog); margin-bottom: 18px; line-height: 1.6; }
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 9px; letter-spacing: .13em; text-transform: uppercase; color: var(--color-steel); margin-bottom: 6px; }
.field .opt { text-transform: none; letter-spacing: 0; }
.field input { width: 100%; }
.field input.mono { font-family: var(--font-mono, monospace); }
.err { color: var(--color-ember); font-size: 10px; margin: 10px 0 0; min-height: 14px; }
.login-card .btn-primary { width: 100%; margin-top: 8px; }
.foot { margin-top: 18px; font-size: 9px; color: var(--color-steel); text-align: center; line-height: 1.8; }
</style>
