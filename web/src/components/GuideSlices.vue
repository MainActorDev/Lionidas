<script setup lang="ts">
// Mini component slices — scaled-down static replicas of real UI elements.
// Pure presentation; no data fetching. Each mirrors its full-size counterpart's
// Axiom classes so visual drift is impossible (same tokens, same structure).
// Pass `show` to render ONE named slice; omit to render all.
export type SliceName = 'wall' | 'runs' | 'matrix' | 'status' | 'triage' | 'forge' | 'drive' | 'queue';
const props = defineProps<{ show?: SliceName }>();
</script>

<template>
  <!-- ═══ WALL SLICE ═══ -->
  <div v-if="!props.show || props.show === 'wall'" class="slice">
    <div class="slice-label">wall · device tiles</div>
    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
      <div class="mini-card mini-accent" style="width: 180px;">
        <div style="display: flex; justify-content: space-between; align-items: baseline;">
          <span class="mini-title">iPhone 16 Pro</span>
          <span class="status status-passed" style="font-size: 10px;">booted</span>
        </div>
        <div class="mini-meta"><span>lease</span><b>free</b></div>
        <div style="display: flex; gap: 4px; margin-top: 6px;">
          <span class="mini-btn">watch</span>
          <span class="mini-btn">take control</span>
        </div>
      </div>
      <div class="mini-card" style="width: 180px;">
        <div style="display: flex; justify-content: space-between; align-items: baseline;">
          <span class="mini-title">iPhone 14 Plus</span>
          <span class="status status-none" style="font-size: 10px;">shutdown</span>
        </div>
        <div class="mini-meta"><span>lease</span><b style="color: var(--color-ember);">▸ manual</b></div>
        <div style="display: flex; gap: 4px; margin-top: 6px;">
          <span class="mini-btn" style="opacity: 0.4;">watch</span>
        </div>
      </div>
    </div>
  </div>

  <!-- ═══ RUN ROW SLICE ═══ -->
  <div v-if="!props.show || props.show === 'runs'" class="slice">
    <div class="slice-label">runs · table row</div>
    <div class="mini-table">
      <div class="mini-tr">
        <span style="color: var(--color-steel);">run_a1b2c3</span>
        <span>CUST-1234</span>
        <span style="color: var(--color-ash);">automated</span>
        <span class="status status-passed" style="font-size: 10px;">passed</span>
        <span style="color: var(--color-steel);">14:32</span>
      </div>
      <div class="mini-tr">
        <span style="color: var(--color-steel);">run_d4e5f6</span>
        <span>CUST-1234</span>
        <span style="color: var(--color-ash);">automated</span>
        <span class="status status-fail" style="font-size: 10px;">failed</span>
        <span style="color: var(--color-steel);">14:28</span>
      </div>
      <div class="mini-tr">
        <span style="color: var(--color-steel);">run_g7h8i9</span>
        <span>CUST-1234</span>
        <span style="color: var(--color-ash);">automated</span>
        <span class="status status-changes-pending" style="font-size: 10px;">changes-pending</span>
        <span style="color: var(--color-steel);">14:20</span>
      </div>
    </div>
  </div>

  <!-- ═══ MATRIX SLICE ═══ -->
  <div v-if="!props.show || props.show === 'matrix'" class="slice">
    <div class="slice-label">matrix · AC status per ticket</div>
    <div class="mini-table">
      <div class="mini-tr" style="cursor: default;">
        <span style="color: var(--color-ash); font-size: 11px;">AC-1<br /><span style="color: var(--color-steel); font-size: 10px;">launch screen</span></span>
        <span class="status status-passed" style="font-size: 10px;">pass</span>
        <span style="color: var(--color-steel); font-size: 11px;">visual</span>
        <span style="color: var(--color-steel); font-size: 11px;">onboarding-smoke</span>
      </div>
      <div class="mini-tr" style="cursor: default;">
        <span style="color: var(--color-ash); font-size: 11px;">AC-2<br /><span style="color: var(--color-steel); font-size: 10px;">login navigation</span></span>
        <span class="status status-fail" style="font-size: 10px;">fail</span>
        <span style="color: var(--color-steel); font-size: 11px;">interaction</span>
        <span style="color: var(--color-steel); font-size: 11px;">login-nav</span>
      </div>
      <div class="mini-tr" style="cursor: default;">
        <span style="color: var(--color-ash); font-size: 11px;">AC-3<br /><span style="color: var(--color-steel); font-size: 10px;">FAQ link hidden</span></span>
        <span class="status status-changes-pending" style="font-size: 10px;">changes-pending</span>
        <span style="color: var(--color-steel); font-size: 11px;">data-dependent</span>
        <span style="color: var(--color-steel); font-size: 11px;">faq-check</span>
      </div>
    </div>
  </div>

  <!-- ═══ STATUS PILLS SLICE ═══ -->
  <div v-if="!props.show || props.show === 'status'" class="slice">
    <div class="slice-label">status vocabulary</div>
    <div style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center;">
      <span class="status status-passed">✓ pass</span>
      <span class="status status-fail">✕ fail</span>
      <span class="status status-changes-pending">◆ changes-pending</span>
      <span class="status status-quarantined">◌ quarantined</span>
      <span class="status status-running">▸ running</span>
      <span class="status status-skip">· skip</span>
      <span class="status status-none">· no coverage</span>
    </div>
  </div>

  <!-- ═══ TRIAGE SLICE ═══ -->
  <div v-if="!props.show || props.show === 'triage'" class="slice">
    <div class="slice-label">triage · failed step with evidence</div>
    <div class="mini-card mini-accent">
      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;">
        <span class="mini-title">login-nav · 18.7s</span>
        <div style="display: flex; gap: 4px;">
          <span class="mini-btn">re-run fragment</span>
          <span class="mini-btn mini-btn-ghost">copy cmd</span>
        </div>
      </div>
      <div class="mini-log">no element matched selector text="Daftar"</div>
      <div style="display: flex; gap: 8px; margin-top: 6px;">
        <div style="width: 80px; height: 60px; background: var(--color-void); border: 1px solid var(--color-iron); border-radius: 2px; display: flex; align-items: center; justify-content: center; font-size: 10px; color: var(--color-steel);">screenshot</div>
        <div style="width: 80px; height: 60px; background: var(--color-void); border: 1px solid var(--color-iron); border-radius: 2px; display: flex; align-items: center; justify-content: center; font-size: 10px; color: var(--color-steel);">diff</div>
        <div style="display: flex; flex-direction: column; gap: 2px; font-size: 10px; color: var(--color-steel);">
          <span>▸ video (9.5MB)</span>
          <span>▸ logs (2.9MB)</span>
          <span>▸ network</span>
        </div>
      </div>
    </div>
  </div>

  <!-- ═══ FORGE SLICE ═══ -->
  <div v-if="!props.show || props.show === 'forge'" class="slice">
    <div class="slice-label">forge · live traffic inspector</div>
    <div class="mini-card">
      <div style="display: flex; gap: 4px; margin-bottom: 4px;">
        <span class="mini-btn mini-btn-primary" style="font-size: 10px;">record</span>
        <span class="mini-btn" style="font-size: 10px;">hybrid</span>
        <span class="mini-btn" style="font-size: 10px;">intercept</span>
      </div>
      <div class="mini-table">
        <div class="mini-tr" style="cursor: default; font-size: 11px;">
          <span style="color: var(--color-steel);">14:32</span>
          <span>GET</span>
          <span>/v1/checkout</span>
          <span class="status status-passed" style="font-size: 10px;">200</span>
          <span style="color: var(--color-steel);">12ms</span>
          <span style="color: var(--color-steel); font-size: 10px;">mitm-hybrid</span>
        </div>
        <div class="mini-tr" style="cursor: default; font-size: 11px;">
          <span style="color: var(--color-steel);">14:32</span>
          <span>GET</span>
          <span>/v1/checkout</span>
          <span class="status status-fail" style="font-size: 10px;">500</span>
          <span style="color: var(--color-steel);">8ms</span>
          <span style="color: var(--color-accent); font-size: 10px;">p_seq1</span>
        </div>
        <div class="mini-tr" style="cursor: default; font-size: 11px;">
          <span style="color: var(--color-steel);">14:31</span>
          <span>POST</span>
          <span>/v1/auth</span>
          <span class="status status-passed" style="font-size: 10px;">201</span>
          <span style="color: var(--color-steel);">45ms</span>
          <span style="color: var(--color-steel); font-size: 10px;">mitm-hybrid</span>
        </div>
      </div>
      <div style="display: flex; gap: 4px; margin-top: 4px; align-items: center;">
        <span style="font-size: 10px; color: var(--color-steel);">freeze as preset</span>
        <span class="mini-btn" style="font-size: 10px;">freeze</span>
      </div>
    </div>
  </div>

  <!-- ═══ DRIVE SLICE ═══ -->
  <div v-if="!props.show || props.show === 'drive'" class="slice">
    <div class="slice-label">drive · manual cockpit</div>
    <div class="mini-card">
      <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
        <span class="mini-title">drive · 5640A847…</span>
        <span class="badge badge-accent" style="font-size: 10px;">manual — never counts</span>
      </div>
      <div style="width: 120px; height: 90px; background: var(--color-void); border: 1px solid var(--color-iron); border-radius: 2px; display: flex; align-items: center; justify-content: center; font-size: 10px; color: var(--color-steel); cursor: crosshair;">tap to drive</div>
      <div style="display: flex; gap: 4px; margin-top: 6px;">
        <span class="mini-btn" style="font-size: 10px;">refresh</span>
        <span class="mini-btn" style="font-size: 10px;">↑</span>
        <span class="mini-btn" style="font-size: 10px;">↓</span>
        <span style="flex: 1;"></span>
        <span class="mini-btn mini-btn-danger" style="font-size: 10px;">finish</span>
      </div>
    </div>
  </div>

  <!-- ═══ QUEUE SLICE ═══ -->
  <div v-if="!props.show || props.show === 'queue'" class="slice">
    <div class="slice-label">queue · waiting runs</div>
    <div class="mini-card mini-accent">
      <div class="mini-title" style="margin-bottom: 4px;">queue · 2 waiting</div>
      <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--color-ash); padding: 2px 0;">
        <span style="color: var(--color-steel);">q_a1b2c3</span>
        <span>by dashboard · priority 0</span>
        <span class="mini-btn mini-btn-danger" style="font-size: 10px;">abort</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--color-ash); padding: 2px 0;">
        <span style="color: var(--color-steel);">q_d4e5f6</span>
        <span>by lioclaw · priority 2</span>
        <span class="mini-btn mini-btn-danger" style="font-size: 10px;">abort</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.slice {
  background: var(--color-graphite);
  border: 1px solid var(--color-iron);
  border-radius: 2px;
  padding: 12px;
  margin: 12px 0;
}
.slice-label {
  font-size: 11px;
  color: var(--color-steel);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 8px;
}
.mini-card {
  background: var(--color-carbon);
  border: 1px solid var(--color-iron);
  border-radius: 2px;
  padding: 8px;
}
.mini-accent { border-left: 2px solid var(--color-accent); }
.mini-title {
  font-size: 11px;
  color: var(--color-fog);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.mini-meta {
  display: flex;
  gap: 6px;
  font-size: 10px;
  color: var(--color-steel);
  margin-top: 2px;
}
.mini-meta b { color: var(--color-ash); font-weight: normal; }
.mini-btn {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  background: var(--color-carbon);
  border: 1px solid var(--color-iron);
  border-radius: 2px;
  font-size: 10px;
  color: var(--color-fog);
  cursor: default;
}
.mini-btn-primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-paper); }
.mini-btn-danger { border-color: var(--color-slate); }
.mini-btn-ghost { background: transparent; border-color: transparent; }
.mini-table {
  background: var(--color-carbon);
  border: 1px solid var(--color-iron);
  border-radius: 2px;
  overflow: hidden;
}
.mini-tr {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 8px;
  border-bottom: 1px solid var(--color-iron);
  font-size: 11px;
  color: var(--color-fog);
}
.mini-tr:last-child { border-bottom: none; }
.mini-log {
  background: var(--color-void);
  border: 1px solid var(--color-iron);
  border-radius: 2px;
  padding: 4px 8px;
  font-size: 10px;
  color: var(--color-ash);
  font-family: var(--font-mono);
}
</style>
