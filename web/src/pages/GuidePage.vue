<script setup lang="ts">
import { ref, computed } from 'vue';
import GuideSlices from '../components/GuideSlices.vue';

type SectionId = 'yourday' | 'quickstart' | 'wall' | 'runs' | 'matrix' | 'triage' | 'baselines' | 'forge' | 'templates' | 'drive' | 'flakes' | 'status' | 'suites' | 'shortcuts';

const active = ref<SectionId>('quickstart');

const sections: Array<{ id: SectionId; label: string; group: string }> = [
  { id: 'yourday', label: 'your day', group: 'basics' },
  { id: 'quickstart', label: 'quick start', group: 'basics' },
  { id: 'wall', label: 'devices', group: 'basics' },
  { id: 'runs', label: 'runs & queue', group: 'basics' },
  { id: 'status', label: 'status vocabulary', group: 'basics' },
  { id: 'suites', label: 'suites', group: 'verify' },
  { id: 'matrix', label: 'acceptance criteria', group: 'verify' },
  { id: 'triage', label: 'triage a failure', group: 'verify' },
  { id: 'baselines', label: 'approvals', group: 'verify' },
  { id: 'flakes', label: 'flaky tests', group: 'verify' },
  { id: 'forge', label: 'network control', group: 'control' },
  { id: 'templates', label: 'test cases', group: 'control' },
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
  <div style="display: grid; grid-template-columns: 180px 1fr; gap: var(--s-5);">
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
      
<div v-if="active === 'yourday'">
  <div class="page-title">your day</div>
  <p style="color: var(--color-ash); margin: var(--s-2) 0 var(--s-4); font-size: var(--text-body); line-height: 1.6;">
    What you actually do with Crucible, as three tasks. Every page exists to serve one of them.
  </p>

  <div class="section-label">1 · check the app</div>
  <div class="card">
    <div class="meta-row"><span class="k">path</span><b class="mono">home page → run all cases → read verdicts</b></div>
    <p style="color: var(--color-fog); font-size: var(--text-body); line-height: 1.6; margin: var(--s-2) 0 0;">
      Open Crucible. The home page lists every test case as a card with its latest verdict. Press <b>run all cases</b>
      and every case replays back-to-back — cards flip to their new verdict as runs finish. A passing card needs
      nothing from you. Click a red one to see exactly which step broke, with the screenshot at the moment it broke.
    </p>
  </div>

  <div class="section-label">2 · capture a new test</div>
  <div class="card">
    <div class="meta-row"><span class="k">path</span><b class="mono">devices → take control → record → assert → save</b></div>
    <p style="color: var(--color-fog); font-size: var(--text-body); line-height: 1.6; margin: var(--s-2) 0 0;">
      Have a flow worth keeping? Go to <b>devices</b>, boot a simulator, click <b>take control</b>, and turn on
      <b>record</b>. Now just use the app — every tap, scroll, and typed text becomes a step in the sidebar as you go.
      Before saving, add a check with <b>assert</b>: type something you can see on screen ("Login"), and Crucible
      confirms it points at exactly one element. Save the recording, name it, tag it — it's now a test case that
      replays forever.
    </p>
    <p style="color: var(--color-fog); font-size: var(--text-body); line-height: 1.6; margin: var(--s-2) 0 0;">
      Every run pins the <b>exact version</b> of the case it executed — edit the case later and past runs still
      resolve the yaml, steps, and network setup that actually ran. A case's <b>history</b> (in its editor) lists
      each version; a run row shows which version it executed (⚠ when it's not the current one).
    </p>
    <p style="color: var(--color-fog); font-size: var(--text-body); line-height: 1.6; margin: var(--s-2) 0 0;">
      A case can also declare <b>variants</b> — one flow tested against several deterministic worlds. Add a
      <b>variants:</b> block to the yaml (id + network scenario + env per variant; the editor autocompletes it).
      Playing the case runs <b>every variant, sequentially — each is its own run</b>: its own evidence, its own
      version pin, its own verdict. Play-all expands variant cases the same way, and the runs page tags each
      variant run with a <code>▸ variant</code> chip. One variant alone? Play with
      <code>?variant=its-id</code> (or the picker next to Play).
    </p>
  </div>

  <div class="section-label">3 · test bad network days</div>
  <div class="card">
    <div class="meta-row"><span class="k">path</span><b class="mono">network → freeze or edit a preset → scenario → run with it</b></div>
    <p style="color: var(--color-fog); font-size: var(--text-body); line-height: 1.6; margin: var(--s-2) 0 0;">
      Does the app survive when the API is down or slow? On the <b>network</b> page: start the proxy, use the app so
      real traffic appears, then <b>freeze</b> any response to make it replay forever — or press <b>edit</b> to
      rewrite what it serves (a 500, a 3-second delay, a broken connection). Group fakes into a named
      <b>scenario</b> ("tariff API down") and pick it next to the run button on the test cases page. The fakes apply
      for that run only; live traffic is restored after.
    </p>
  </div>

  <div class="card card-accent">
    <p style="color: var(--color-fog); font-size: var(--text-body); line-height: 1.6;">
      That's the whole tool. Everything else — runs, trends, blocked verdicts, approvals — is detail you can
      look up in the other sections of this guide when you need it.
    </p>
  </div>
</div>

<div v-if="active === 'quickstart'">
        <div class="page-title">how to use crucible</div>
        <p style="color: var(--color-ash); margin: var(--s-2) 0 var(--s-4); font-size: var(--text-body); line-height: 1.6;">
          Crucible verifies that your app works on a real device. It runs test flows on simulators,
          records evidence (video, screenshots, logs), and shows you exactly what passed or failed —
          with the proof one click away.
        </p>

        <div class="section-label">first 10 minutes — do this once</div>
        <div class="card card-accent">
          <div class="meta-row"><span class="k">1</span><b>Open <span class="mono">/devices</span></b> — boot a simulator with the boot button</div>
          <div class="meta-row"><span class="k">2</span><b>Take control</b> — pick the app, drive the screen by clicking it</div>
          <div class="meta-row"><span class="k">3</span><b>Record + assert</b> — turn on record, do a short flow, add one assert, save as a case</div>
          <div class="meta-row"><span class="k">4</span><b>Replay it</b> — <span class="mono">/templates</span> → run — watch it go green</div>
          <div class="meta-row"><span class="k">5</span><b>Break the network</b> — <span class="mono">/forge</span> → start proxy → route sims → freeze a response → replay the case against it</div>
        </div>

        <div class="section-label">the ideas behind it</div>
        <div class="card">
          <div class="meta-row"><span class="k">record once</span><b>a recording IS the test — steps, executor, and evidence come from the same artifact, not three documents three people maintain</b></div>
          <div class="meta-row"><span class="k">manual never counts</span><b>your own driving reproduces and records, but structurally never changes a verdict</b></div>
          <div class="meta-row"><span class="k">verdicts are honest</span><b>blocked (infra failed) is never mixed with failed (app broke) — a red means investigate</b></div>
        </div>

        <div class="section-label">who does what</div>
        <div class="card">
          <div class="meta-row"><span class="k">QA</span><b>records cases, reads verdicts, judges visual approvals, reproduces by hand</b></div>
          <div class="meta-row"><span class="k">engineer</span><b>opens the failed step — screenshot, network traffic, what the selector resolved against</b></div>
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
          <div class="meta-row"><span class="k">stream stopped?</span><b>if the overlay shows an error with a retry stream button, click it — the server rebuilds its connection to the device engine automatically (no restart needed). "reconnecting…" means it is already retrying on its own</b></div>
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
      <div v-if="active === 'suites'">
  <div class="page-title">suites</div>
  <p style="color: var(--color-ash); margin: var(--s-2) 0 var(--s-4); font-size: var(--text-body); line-height: 1.6;">
    A named, ordered group of cases — the regression pack you actually run, not every case you have.
  </p>

  <div class="card">
    <div class="meta-row"><span class="k">path</span><b class="mono">suites → + new → pick cases → run suite</b></div>
    <p style="color: var(--color-fog); font-size: var(--text-body); line-height: 1.6; margin: var(--s-2) 0 0;">
      The home page runs <b>every</b> case. A suite runs <b>the ones you choose</b>, in the order you set. Go to
      <b>suites</b>, press <b>+ new</b>, name it, and click cases into it. For a case with variants, pin the
      countries you care about — <b>sg my</b> — or leave it loose to run them all. Press <b>▶ run suite</b>
      and the board replays the pack back-to-back; each row flips to its fresh verdict as its run finishes.
    </p>
  </div>

  <div class="card">
    <div class="meta-row"><span class="k">truth</span><b class="mono">live reads, never a snapshot</b></div>
    <p style="color: var(--color-fog); font-size: var(--text-body); line-height: 1.6; margin: var(--s-2) 0 0;">
      A suite stores <b>membership</b> — which cases, which variants, what order. It never stores results.
      The board's verdicts are read live from each case's latest run, so they can't drift from the truth
      on any other page. Delete a suite and its runs survive untouched — the history is the runs', not the suite's.
    </p>
  </div>

  <div class="card">
    <div class="meta-row"><span class="k">scope</span><b class="mono">one app per suite — bundle-locked</b></div>
    <p style="color: var(--color-fog); font-size: var(--text-body); line-height: 1.6; margin: var(--s-2) 0 0;">
      A suite answers "is <b>this app</b> OK" — so you pick the app (its bundle id) when you create the
      suite, and only that app's cases can join. The scope locks at creation; a Lion Parcel suite can
      never swallow a Maps case. If a case's app is <b>changed after joining</b>, the board flags it
      <b>drifted</b> and the next run skips it with a named reason — nothing silently disappears.
    </p>
  </div>

  <div class="card">
    <div class="meta-row"><span class="k">also</span><b class="mono">runs from this suite → the stamped history</b></div>
    <p style="color: var(--color-fog); font-size: var(--text-body); line-height: 1.6; margin: var(--s-2) 0 0;">
      Every run a suite spawns is stamped with it. <b>runs from this suite →</b> at the bottom of the board
      opens the runs page filtered to that stamp — the audit trail of everything this pack has ever done,
      separate from verdicts, which follow the case wherever it ran.
    </p>
  </div>
</div>

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
          <div class="meta-row"><span class="k">preset</span><b>one endpoint's fake behavior: status, body, delay, throttle, or a failure (timeout/reset/malformed)</b></div>
          <div class="meta-row"><span class="k">edit</span><b>every preset is editable in the dashboard — change what it serves, slow it down, break it; saving updates the live proxy immediately</b></div>
          <div class="meta-row"><span class="k">test pattern</span><b>in the editor, paste a URL to check whether the preset would match it — same matcher the proxy uses</b></div>
          <div class="meta-row"><span class="k">sequence</span><b>200 → 500 → 500… — for testing retry paths</b></div>
          <div class="meta-row"><span class="k">scenario</span><b>a named set of presets — create, rename, and check presets in on the network page; pick it when running a test case</b></div>
          <div class="meta-row"><span class="k">freeze</span><b>see a real response in traffic → freeze it as a preset with one click; edit it afterwards like any preset</b></div>
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
        <div class="page-title">test cases</div>
        <p style="color: var(--color-ash); margin: var(--s-2) 0;">Record a flow once, add assertions, replay it as a regression any time — under any network conditions. A case is three things at once: the steps, the executor, and the evidence.</p>

        <div class="section-label">author — the loop</div>
        <div class="card">
          <div class="meta-row"><span class="k">1 · record</span><b>devices, take control, record toggle — every tap/scroll/type becomes a step (with the element it hit, when identifiable)</b></div>
          <div class="meta-row"><span class="k">2 · assert</span><b>recorder's "assert screen contains…" — type a label, CHECK proves exactly 1 match, ASSERT saves it. Replay fails red if that element ever disappears</b></div>
          <div class="meta-row"><span class="k">3 · save</span><b>"save as case" — name it, tag it (tags group cases for plans)</b></div>
        </div>

        <div class="section-label">the case table</div>
        <div class="card">
          <div class="meta-row"><span class="k">case</span><b>name + ticket + tag chips (click a tag to filter)</b></div>
          <div class="meta-row"><span class="k">app</span><b>the app this case runs against — bound at save time; replay launches it first</b></div>
          <div class="meta-row"><span class="k">trend</span><b>last 5 runs as glyphs — ✓ pass · ✕ fail · ◆ blocked · ◌ aborted (oldest to newest)</b></div>
          <div class="meta-row"><span class="k">verdict</span><b>last result + which build + when. hover a row for run / edit / delete</b></div>
          <div class="meta-row"><span class="k">expand</span><b>click a row — steps with kind chips (tap/scroll/type/assert/flow), per-step switches: "param" turns typed text into a play-time secret, "optional" makes a miss a skip instead of a failure; + subflow / + assert append steps</b></div>
        </div>

        <div class="section-label">missing app</div>
        <div class="card">
          <div class="meta-row"><span class="k">pre-check</span><b>a case whose app is not installed on the booted simulator refuses to start — no wasted run, no cryptic engine error</b></div>
          <div class="meta-row"><span class="k">install hint</span><b>the refusal carries a one-click fix: install the last-known build, then the case auto-runs once</b></div>
          <div class="meta-row"><span class="k">choose artifact…</span><b>pick any build found on disk (ios-consumer build folders, Xcode DerivedData, or Crucible's own store) — each row shows version, origin, and age</b></div>
          <div class="meta-row"><span class="k">own store</span><b>whatever you pick is cloned into Crucible's storage first — a repo clean or Xcode cache prune can never break installed apps or recorded history</b></div>
          <div class="meta-row"><span class="k">device panel</span><b>take control → "install app" — the same picker, standalone, for any booted simulator</b></div>
        </div>

        <div class="section-label">run and plans</div>
        <div class="card">
          <div class="meta-row"><span class="k">▶ run · watch / background</span><b>the button states its mode: watch opens the live stream panel, background runs without it and the verdict lands in the row. ▾ switches the sticky default (remembered per browser)</b></div>
          <div class="meta-row"><span class="k">■ abort</span><b>replaces ▶ while a case runs (row) and sits in the stream panel header — single click; lands after the current step finishes</b></div>
          <div class="meta-row"><span class="k">run filtered</span><b>runs every case matching the filter, sequentially — one device at a time. While it plays, ■ stop all aborts the running case and every queued one</b></div>
          <div class="meta-row"><span class="k">+ plan</span><b>saves the current filter + network choice + env as a named chip — "regression-rc1" replays that exact suite forever</b></div>
          <div class="meta-row"><span class="k">network</span><b>live = real network; a scenario fakes endpoints for each run's duration, then restores</b></div>
          <div class="meta-row"><span class="k">env</span><b>play-time secrets (KEY=value lines) sent with every run — never stored in the case. The badge counts keys in effect</b></div>
        </div>

        <div class="section-label">yaml editing</div>
        <div class="card">
          <div class="meta-row"><span class="k">yaml</span><b>row action on any case — the case opens as an editable yaml file (Maestro-style) in a split panel: steps outline left, syntax-highlighted editor right</b></div>
          <div class="meta-row"><span class="k">the format</span><b>name, tags, app, then steps: — each step is one action: tap (point + on), scroll (direction), type (text + on), runFlow (a case name), expect (on)</b></div>
          <div class="meta-row"><span class="k">on:</span><b>the element a step targets — its label, or an asset id like ic_barcode. It rides along with coordinates: replay resolves the element live first, coordinates are the fallback</b></div>
          <div class="meta-row"><span class="k">contains:</span><b>instead of on: — matches any label CONTAINING the value (contains: 'DATA COLLECTION' catches the heading II. DATA COLLECTION); still needs exactly one match to pass. on: and contains: never combine</b></div>
          <div class="meta-row"><span class="k">ignoreCase:</span><b>true — capitalization stops mattering for label matches (on: beranda, ignoreCase: true); never applies to asset ids</b></div>
          <div class="meta-row"><span class="k">same data</span><b>yaml and the step rows are one storage — edit either, the other follows. Saving validates: unknown keys and bad shapes error with line numbers, nothing is silently dropped</b></div>
          <div class="meta-row"><span class="k">live outline</span><b>the left panel re-parses as you type — it freezes (marked stale) when the yaml has errors, and error lines highlight in the editor</b></div>
          <div class="meta-row"><span class="k">autocomplete</span><b>the editor knows the format AND your app — labels, icon ids, case names, bundle ids, and tags come from your own recorded cases as you type; values insert pre-quoted</b></div>
          <div class="meta-row"><span class="k">‹ › hop</span><b>move between the filtered cases without leaving the editor — edit, ⌘↵ save, hop, repeat</b></div>
        </div>

        <div class="section-label">reading results</div>
        <div class="card">
          <div class="meta-row"><span class="k">pass / fail</span><b>the app worked / the app is broken — click the run for step-by-step evidence (screenshots, video, network)</b></div>
          <div class="meta-row"><span class="k">blocked</span><b>infrastructure failed — device offline, engine busy, session bound. NOT an app failure; the run detail tells you how to fix it</b></div>
          <div class="meta-row"><span class="k">stop</span><b>runs page — abort a stuck run; remaining steps skip, the device frees immediately</b></div>
          <div class="meta-row"><span class="k">never run</span><b>a case with no runs yet — it counts as neither green nor red</b></div>
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
