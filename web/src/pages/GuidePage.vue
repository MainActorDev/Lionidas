<script setup lang="ts">
import { ref, computed } from 'vue';
import GuideSlices from '../components/GuideSlices.vue';

type SectionId = 'quickstart' | 'wall' | 'runs' | 'matrix' | 'triage' | 'baselines' | 'forge' | 'templates' | 'drive' | 'flakes' | 'status' | 'shortcuts';

const active = ref<SectionId>('quickstart');

const sections: Array<{ id: SectionId; label: string; group: string }> = [
  { id: 'quickstart', label: 'quick start', group: 'basics' },
  { id: 'wall', label: 'devices', group: 'basics' },
  { id: 'runs', label: 'runs & queue', group: 'basics' },
  { id: 'status', label: 'status vocabulary', group: 'basics' },
  { id: 'matrix', label: 'acceptance criteria', group: 'verify' },
  { id: 'triage', label: 'triage a failure', group: 'verify' },
  { id: 'baselines', label: 'approvals', group: 'verify' },
  { id: 'flakes', label: 'flaky tests', group: 'verify' },
  { id: 'forge', label: 'network control', group: 'control' },
  { id: 'templates', label: 'test templates', group: 'control' },
  { id: 'drive', label: 'manual control', group: 'control' },
  { id: 'shortcuts', label: 'keyboard', group: 'control' },
];

const groups = computed(() => {
  const out: Array<{ label: string; items: Array<{ id: SectionId; label: string }> }> = [];
  for (const s of sections) {
    let g = out.find((x) => x.label === s.group);
    if (!g) { g = { label: s.group, items: [] }; out.push(g); }
    g.items.push({ id: s.id, label: s.label });
  }
  return out;
});
</script>

<template>
  <div style="display: grid; grid-template-columns: 180px 1fr; gap: var(--s-5); max-width: 1000px;">
    <!-- section nav -->
    <nav>
      <div v-for="g in groups" :key="g.label" class="nav-group" style="margin-bottom: var(--s-4);">
        <div class="nav-group-label">{{ g.label }}</div>
        <a v-for="s in g.items" :key="s.id" class="nav-item" :class="{ active: active === s.id }"
           style="text-decoration: none; display: block;" @click.prevent="active = s.id" href="#">{{ s.label }}</a>
      </div>
    </nav>

    <!-- content -->
    <div>
      <!-- ═══ QUICKSTART ═══ -->
      <div v-if="active === 'quickstart'">
        <div class="page-title">how to use crucible</div>
        <p style="color: var(--color-ash); margin: var(--s-2) 0 var(--s-4); font-size: var(--text-body); line-height: 1.6;">
          Crucible verifies that your app works on a real device. It runs test flows on simulators,
          records evidence (video, screenshots, logs), and shows you exactly what passed or failed —
          with the proof one click away.
        </p>

        <div class="section-label">the 60-second version</div>
        <div class="card card-accent">
          <div class="meta-row"><span class="k">1</span><b>Open devices</b> — see your devices, which are booted, who's using them</div>
          <div class="meta-row"><span class="k">2</span><b>Queue a run</b> — pick a ticket's flow set + device, click "queue run"</div>
          <div class="meta-row"><span class="k">3</span><b>Watch it execute live</b> — steps appear as they run (not after)</div>
          <div class="meta-row"><span class="k">4</span><b>Read the matrix</b> — green ✓ = proven, red ✕ = broken (click for evidence)</div>
          <div class="meta-row"><span class="k">5</span><b>Judge amber ◆</b> — visual changes need your approval before they count</div>
        </div>

        <div class="section-label">who does what</div>
        <div class="card">
          <div class="meta-row"><span class="k">QA</span><b>reads the matrix, judges baselines, drives manually to reproduce</b></div>
          <div class="meta-row"><span class="k">engineer</span><b>opens the failed step, reads logs/video/diff, re-runs the fragment</b></div>
          <div class="meta-row"><span class="k">agent/lioclaw</span><b>queues runs via the API (agent token, priority 2 — yields to humans)</b></div>
        </div>

        <div class="section-label">freshness — read this once</div>
        <div class="card">
          <p style="color: var(--color-fog); font-size: var(--text-body); line-height: 1.6;">
            Every run checks whether the app binary is older than the source code.
            If it is, the run fails fast with a <span class="badge badge-accent">⚠ stale</span> badge —
            because testing an old build proves nothing. Fix: rebuild, then re-queue.
            No src path given = <span class="badge">unchecked</span> (no gate).
          </p>
        </div>
      </div>

      <!-- ═══ WALL ═══ -->
      <div v-if="active === 'wall'">
        <div class="page-title">devices</div>
        <p style="color: var(--color-ash); margin: var(--s-2) 0;">The device page is your live view of every simulator.</p>

        <div class="slice-demo"><GuideSlices show="wall" /></div>

        <div class="section-label">reading a tile</div>
        <div class="card">
          <div class="meta-row"><span class="k">status + kind</span><b>booted/shutdown, and simulator vs physical — the two live on different rows</b></div>
          <div class="meta-row"><span class="k">lease: free</span><b>nobody's driving it — safe to queue a run</b></div>
          <div class="meta-row"><span class="k">lease: ▸ manual</span><b>a human is driving it right now (amber badge)</b></div>
          <div class="meta-row"><span class="k">lease: other</span><b>an automated run holds it — the holder name tells you which</b></div>
          <div class="meta-row"><span class="k">last run</span><b>ticket + outcome of the latest automated run on this device</b></div>
        </div>

        <div class="section-label">actions</div>
        <div class="card">
          <div class="meta-row"><span class="k">watch</span><b>live MJPEG video stream of the screen (read-only — takes no lease, blocks nothing). Simulators only — physical devices have no stream source</b></div>
          <div class="meta-row"><span class="k">take control</span><b>opens the drive cockpit — you tap the screen directly</b></div>
          <div class="meta-row"><span class="k">shut down / boot</span><b>power-cycle a simulator (blocked while a run or manual session holds it)</b></div>
          <div class="meta-row"><span class="k">+ new run</span><b>opens the run form (ticket, flows, device, app, artifact)</b></div>
          <div class="meta-row"><span class="k">ticket… box</span><b>type a ticket key + Enter → jump straight to its matrix</b></div>
        </div>
      </div>

      <!-- ═══ RUNS ═══ -->
      <div v-if="active === 'runs'">
        <div class="page-title">runs &amp; queue</div>
        <p style="color: var(--color-ash); margin: var(--s-2) 0;">A run is one execution: this app build × this device × these flows.</p>

        <div class="slice-demo"><GuideSlices show="queue" /></div>

        <div class="section-label">queueing</div>
        <div class="card">
          <div class="meta-row"><span class="k">priority 0</span><b>manual (your button clicks) — runs first</b></div>
          <div class="meta-row"><span class="k">priority 2</span><b>agent (lioclaw API) — yields if a human waited &gt;60s</b></div>
          <div class="meta-row"><span class="k">one rule</span><b>one run per device at a time — the queue serializes automatically</b></div>
          <div class="meta-row"><span class="k">abort</span><b>kills a waiting entry (dispatched ones are already running)</b></div>
        </div>

        <div class="section-label">click a run row</div>
        <div class="card">
          <p style="color: var(--color-fog); line-height: 1.6;">
            Opens the run detail: artifact hash + freshness badge, launch args, live step table
            (steps appear as they execute — not after), and the triage panel if anything failed.
            The <b>attach → jira</b> button posts the evidence summary as a comment on the ticket.
          </p>
        </div>
      </div>

      <!-- ═══ STATUS ═══ -->
      <div v-if="active === 'status'">
        <div class="page-title">status vocabulary</div>
        <p style="color: var(--color-ash); margin: var(--s-2) 0;">Symbols, not colors — the shape carries the meaning.</p>

        <div class="slice-demo"><GuideSlices show="status" /></div>

        <div class="card">
          <div class="meta-row"><span class="k">✓ pass</span><b>the flow proved it — evidence recorded</b></div>
          <div class="meta-row"><span class="k">✕ fail</span><b>assertion broke — click for the triage bundle</b></div>
          <div class="meta-row"><span class="k">◆ changes-pending</span><b>a visual change awaits YOUR judgment (approve or reject) — not red, not green: amber means "decide"</b></div>
          <div class="meta-row"><span class="k">◌ quarantined</span><b>this flow is too flaky to trust — excluded from the ticket status until released</b></div>
          <div class="meta-row"><span class="k">▸ running</span><b>executing right now — steps stream in live</b></div>
          <div class="meta-row"><span class="k">· no coverage</span><b>nobody wrote a flow for this yet</b></div>
        </div>

        <div class="card card-accent">
          <p style="color: var(--color-fog); line-height: 1.6;">
            <b>amber ≠ fail.</b> An assertion failure is always red, even if a screenshot diff exists.
            Amber only appears for visual drift on a passing flow — where the question genuinely is
            "did the UI change on purpose?"
          </p>
        </div>
      </div>

      <!-- ═══ MATRIX ═══ -->
      <div v-if="active === 'matrix'">
        <div class="page-title">acceptance criteria</div>
        <p style="color: var(--color-ash); margin: var(--s-2) 0;">The per-ticket scorecard: every acceptance criterion, its status, and which flows cover it.</p>

        <div class="slice-demo"><GuideSlices show="matrix" /></div>

        <div class="section-label">how status is computed</div>
        <div class="card">
          <div class="meta-row"><span class="k">per AC</span><b>AND over its flows' latest results — any fail = fail</b></div>
          <div class="meta-row"><span class="k">per ticket</span><b>AND over ACs — all green or it's red</b></div>
          <div class="meta-row"><span class="k">manual runs</span><b>never count — structurally excluded, always</b></div>
          <div class="meta-row"><span class="k">quarantined</span><b>flows drop out of the roll-up — gray, not counted</b></div>
        </div>

        <div class="card">
          <p style="color: var(--color-fog); line-height: 1.6;">
            Click any AC row → jumps to the run that produced it (evidence one click away).
            The ◆ card at the top links to approvals when anything needs your decision.
          </p>
        </div>
      </div>

      <!-- ═══ TRIAGE ═══ -->
      <div v-if="active === 'triage'">
        <div class="page-title">triage a failure</div>
        <p style="color: var(--color-ash); margin: var(--s-2) 0;">When a step fails, everything you need to understand why lands in one place.</p>

        <div class="slice-demo"><GuideSlices show="triage" /></div>

        <div class="section-label">the bundle</div>
        <div class="card">
          <div class="meta-row"><span class="k">reason</span><b>the engine's failure message (what wasn't found / didn't match)</b></div>
          <div class="meta-row"><span class="k">screenshot</span><b>what the screen looked like at the moment of failure</b></div>
          <div class="meta-row"><span class="k">diff</span><b>vs the approved baseline (if one exists for this flow)</b></div>
          <div class="meta-row"><span class="k">video</span><b>full MP4 of the run — playable, seekable, validated</b></div>
          <div class="meta-row"><span class="k">logs</span><b>the app's log up to the failure point</b></div>
          <div class="meta-row"><span class="k">context</span><b>artifact hash, freshness, launch args — exactly what ran</b></div>
        </div>

        <div class="section-label">actions</div>
        <div class="card">
          <div class="meta-row"><span class="k">re-run fragment</span><b>re-executes just this flow (kind: rerun, parent linked) — fast feedback on a fix</b></div>
          <div class="meta-row"><span class="k">copy cmd</span><b>puts the equivalent CLI repro on your clipboard</b></div>
        </div>
      </div>

      <!-- ═══ BASELINES ═══ -->
      <div v-if="active === 'baselines'">
        <div class="page-title">approvals</div>
        <p style="color: var(--color-ash); margin: var(--s-2) 0;">When a visual AC's screenshot differs from its approved baseline, you decide: intentional change or regression?</p>

        <div class="slice-demo"><GuideSlices show="baselines" /></div>

        <div class="card">
          <div class="meta-row"><span class="k">approve</span><b>the new screenshot becomes the baseline (re-runs the flow to capture it cleanly, records lineage)</b></div>
          <div class="meta-row"><span class="k">reject</span><b>the regression stands — the AC stays red, your decision is recorded</b></div>
          <div class="meta-row"><span class="k">effect</span><b>while pending, the AC shows ◆ amber — the ticket is neither green nor red until you decide</b></div>
        </div>

        <div class="card card-accent">
          <p style="color: var(--color-fog); line-height: 1.6;">
            Only <b>visual-category</b> ACs spawn approval rows. An interaction failure (button didn't work)
            is plain red with evidence — no approval needed, no amber noise.
          </p>
        </div>
      </div>

      <!-- ═══ FLAKES ═══ -->
      <div v-if="active === 'flakes'">
        <div class="page-title">flaky tests</div>
        <p style="color: var(--color-ash); margin: var(--s-2) 0;">A flaky flow passes and fails alternately — it makes the matrix lie. Crucible detects and sidelines them.</p>

        <div class="slice-demo"><GuideSlices show="flakes" /></div>

        <div class="card">
          <div class="meta-row"><span class="k">score</span><b>alternation rate over the last 10 runs (1.0 = flips every time)</b></div>
          <div class="meta-row"><span class="k">auto-quarantine</span><b>≥3 alternations within 7 days → the flow goes gray, excluded from roll-up</b></div>
          <div class="meta-row"><span class="k">release</span><b>YOU decide it's fixed — a reason is required (auditable decisions)</b></div>
          <div class="meta-row"><span class="k">marks</span><b>✓ pass · ✕ fail · the strip shows the actual recent history</b></div>
        </div>
      </div>

      <!-- ═══ FORGE ═══ -->
      <div v-if="active === 'forge'">
        <div class="page-title">network control</div>
        <p style="color: var(--color-ash); margin: var(--s-2) 0;">Forge controls what the app sees from the network — fake responses, failure injection, live inspection.</p>

        <div class="slice-demo"><GuideSlices show="forge" /></div>

        <div class="section-label">modes</div>
        <div class="card">
          <div class="meta-row"><span class="k">record</span><b>everything passes through + is logged — capture real behavior</b></div>
          <div class="meta-row"><span class="k">hybrid</span><b>default — matched endpoints get presets, everything else is real</b></div>
          <div class="meta-row"><span class="k">intercept</span><b>only presets answer — unmatched requests get 501 (fully deterministic)</b></div>
        </div>

        <div class="section-label">presets &amp; scenarios</div>
        <div class="card">
          <div class="meta-row"><span class="k">preset</span><b>one endpoint's fake behavior: status, body, delay, or a failure (timeout/reset/malformed)</b></div>
          <div class="meta-row"><span class="k">sequence</span><b>200 → 500 → 500… — for testing retry paths</b></div>
          <div class="meta-row"><span class="k">scenario</span><b>a named set of presets — attach one to a run for reproducible conditions</b></div>
          <div class="meta-row"><span class="k">freeze</span><b>see a real response in traffic → freeze it as a preset with one click</b></div>
        </div>

        <div class="card card-accent">
          <p style="color: var(--color-fog); line-height: 1.6;">
            <b>HTTPS included.</b> With the CA trusted (one-time setup), mitmproxy decrypts and re-encrypts
            TLS — presets work on https endpoints exactly like http. Certificate-pinned apps pass through
            untouched (shown as TLS-passthrough rows).
          </p>
        </div>
      </div>

      <!-- ═══ TEMPLATES ═══ -->
      <div v-if="active === 'templates'">
        <div class="page-title">test templates</div>
        <p style="color: var(--color-ash); margin: var(--s-2) 0;">Record a manual test once — replay it as a regression any time, with any network conditions.</p>

        <div class="section-label">record</div>
        <div class="card">
          <div class="meta-row"><span class="k">1 · take control</span><b>wall → control a simulator — you drive, the screen streams back</b></div>
          <div class="meta-row"><span class="k">2 · record</span><b>recorder toggle in the sidebar — every tap, scroll, and typed text becomes a step with a thumbnail</b></div>
          <div class="meta-row"><span class="k">3 · save</span><b>"save as template" — name it, tag it with a Jira ticket, done</b></div>
        </div>

        <div class="section-label">replay</div>
        <div class="card">
          <div class="meta-row"><span class="k">▶ run</span><b>replays the steps on a booted simulator — same taps, same order</b></div>
          <div class="meta-row"><span class="k">network: live</span><b>default — the app talks to the real network</b></div>
          <div class="meta-row"><span class="k">network: scenario</span><b>pick one and its presets fake endpoints for the run's duration — restored after</b></div>
          <div class="meta-row"><span class="k">truth</span><b>steps executed + final screenshot + the traffic the app produced — no image assertions</b></div>
        </div>

        <div class="section-label">regression</div>
        <div class="card">
          <div class="meta-row"><span class="k">ticket tag</span><b>filter templates by ticket key — rerun exactly what a story needs</b></div>
          <div class="meta-row"><span class="k">runs page</span><b>every replay is a run: steps, evidence, and attached network traffic</b></div>
        </div>
      </div>

      <!-- ═══ DRIVE ═══ -->
      <div v-if="active === 'drive'">
        <div class="page-title">manual control</div>
        <p style="color: var(--color-ash); margin: var(--s-2) 0;">Take control of a device yourself — tap the screen, scroll, reproduce by hand.</p>

        <div class="slice-demo"><GuideSlices show="drive" /></div>

        <div class="card">
          <div class="meta-row"><span class="k">start</span><b>opens a lease on the device (automated runs wait — you have priority)</b></div>
          <div class="meta-row"><span class="k">tap</span><b>click the canvas — the tap lands at the same point on the real screen, coordinates map exactly</b></div>
          <div class="meta-row"><span class="k">feedback</span><b>a ring shows your tap instantly; a fresh screenshot follows within a beat — you never wait on the stream's idle cadence</b></div>
          <div class="meta-row"><span class="k">scroll</span><b>dpad arrows scroll the screen in that direction</b></div>
          <div class="meta-row"><span class="k">finish</span><b>releases the device — queued runs start immediately</b></div>
          <div class="meta-row"><span class="k">idle 5min</span><b>auto-finish (crash safety — a dead browser can't hold a device forever)</b></div>
        </div>

        <div class="card card-accent">
          <p style="color: var(--color-fog); line-height: 1.6;">
            <b>Manual never counts.</b> The badge says it, the database enforces it — a manual session is
            a run row (kind: manual) that the matrix structurally ignores. Reproduce freely; the ticket
            status stays untouched.
          </p>
        </div>
      </div>

      <!-- ═══ SHORTCUTS ═══ -->
      <div v-if="active === 'shortcuts'">
        <div class="page-title">keyboard</div>
        <div class="card">
          <div class="meta-row"><span class="k">⌘K</span><b>command palette — jump to any page, watch a device, start a run, or open a recent ticket</b></div>
          <div class="meta-row"><span class="k">↑ ↓</span><b>navigate palette results</b></div>
          <div class="meta-row"><span class="k">↵</span><b>open the selected result</b></div>
          <div class="meta-row"><span class="k">esc</span><b>close the palette</b></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.slice-demo { margin: var(--s-3) 0; }
</style>
