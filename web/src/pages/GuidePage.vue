<script setup lang="ts">
import { ref, computed } from 'vue';
import PageHeader from '../components/PageHeader.vue';
import GuideSlices from '../components/GuideSlices.vue';

type SectionId = 'yourday' | 'quickstart' | 'wall' | 'runs' | 'status' | 'suites' | 'overview' | 'matrix' | 'triage' | 'cases' | 'screens' | 'env' | 'forge' | 'cockpit' | 'shortcuts';

const active = ref<SectionId>('yourday');

const sections: Array<{ id: SectionId; label: string; group: string }> = [
  { id: 'yourday', label: 'your day', group: 'basics' },
  { id: 'quickstart', label: 'quick start', group: 'basics' },
  { id: 'wall', label: 'devices', group: 'basics' },
  { id: 'runs', label: 'runs log', group: 'basics' },
  { id: 'status', label: 'status vocabulary', group: 'basics' },
  { id: 'suites', label: 'suites', group: 'verify' },
  { id: 'overview', label: 'overview', group: 'verify' },
  { id: 'matrix', label: 'acceptance criteria', group: 'verify' },
  { id: 'triage', label: 'triage a failure', group: 'verify' },
  { id: 'cases', label: 'test cases', group: 'library' },
  { id: 'screens', label: 'screens', group: 'library' },
  { id: 'env', label: 'env variables', group: 'library' },
  { id: 'forge', label: 'network control', group: 'library' },
  { id: 'cockpit', label: 'cockpit', group: 'control' },
  { id: 'shortcuts', label: 'keyboard', group: 'control' },
];

const groups = computed(() => {
  const out: Array<{ label: string; items: Array<{ id: SectionId; label: string }> }> = [];
  for (const s of sections) {
    let g = out.find((x) => x.label === s.group);
    if (!g) { g = { label: s.group, items: [] }; out.push(g); }
    g.items.push(s);
  }
  return out;
});
</script>

<template>
  <div>
    <PageHeader title="guide" desc="how the pieces fit — verified against the app as it ships today" />

    <div class="guide-grid">
      <!-- section nav (self-styled — shell nav classes belong to the sidebar) -->
      <nav class="g-nav">
        <div v-for="g in groups" :key="g.label" class="g-group">
          <div class="g-label">{{ g.label }}</div>
          <a v-for="s in g.items" :key="s.id" class="g-item" :class="{ active: active === s.id }"
             href="#" @click.prevent="active = s.id">{{ s.label }}</a>
        </div>
      </nav>

      <!-- content -->
      <div class="g-body">
        <!-- ═══ YOUR DAY ═══ -->
        <div v-if="active === 'yourday'">
          <div class="page-title">your day</div>
          <p class="lede">What you actually do with Lionidas, as three tasks. Every page exists to serve one of them.</p>

          <div class="section-label">1 · check the app</div>
          <div class="card">
            <div class="meta-row"><span class="k">path</span><b class="mono">overview → run all cases → read verdicts</b></div>
            <p>Open <b>overview</b>. It answers the build-level question — is the app safe right now — from the newest
              play batch: health word, pass rate, what needs eyes first. Press <b>run all cases</b> and every case
              replays back-to-back. A passing case needs nothing from you; the attention list ranks the rest.</p>
          </div>

          <div class="section-label">2 · author a test</div>
          <div class="card">
            <div class="meta-row"><span class="k">path</span><b class="mono">test cases → edit the yaml (or record on a device)</b></div>
            <p>A case is a yaml document — steps, executor, and evidence in one artifact. Write it directly in the
              editor (it autocompletes your app's labels and icons), or record a flow on a booted device and save the
              recording as a case. Every run pins the exact case version it executed; a case can declare
              <b>variants</b> — one flow tested against several deterministic worlds, each replay its own run.</p>
          </div>

          <div class="section-label">3 · test bad network days</div>
          <div class="card">
            <div class="meta-row"><span class="k">path</span><b class="mono">network → freeze or edit a preset → scenario → run with it</b></div>
            <p>On the <b>network</b> page: start the proxy, use the app so real traffic appears, then <b>freeze</b>
              any response to make it replay forever — or edit what it serves (a 500, a 3-second delay, a broken
              connection). Group fakes into a named <b>scenario</b> and pick it when you run a case or suite. The
              fakes apply for that run only; live traffic is restored after.</p>
          </div>

          <div class="card card-accent">
            <p>That's the whole tool. Everything else — suites, trends, blocked verdicts — is detail you can look up
              in the other sections when you need it.</p>
          </div>
        </div>

        <!-- ═══ QUICKSTART ═══ -->
        <div v-if="active === 'quickstart'">
          <div class="page-title">how to use lionidas</div>
          <p class="lede">Lionidas verifies that your app works on a real device. It runs test flows on simulators,
            records evidence (video, screenshots, logs), and shows you exactly what passed or failed — with the
            proof one click away.</p>

          <div class="section-label">first 10 minutes — do this once</div>
          <div class="card card-accent">
            <div class="meta-row"><span class="k">1</span><b>Open <span class="mono">/devices</span></b> — boot a simulator with the boot button</div>
            <div class="meta-row"><span class="k">2</span><b>Drive it</b> — the wall's <b>drive</b> button opens the cockpit; tap the screen directly</div>
            <div class="meta-row"><span class="k">3</span><b>Write a case</b> — <span class="mono">/templates</span> → yaml (or record on the device) with one <span class="mono">expect</span> step</div>
            <div class="meta-row"><span class="k">4</span><b>Replay it</b> — run → watch it go green in the runs log</div>
            <div class="meta-row"><span class="k">5</span><b>Break the network</b> — <span class="mono">/forge</span> → start proxy → freeze a response → replay against it</div>
          </div>

          <div class="section-label">the ideas behind it</div>
          <div class="card">
            <div class="meta-row"><span class="k">the document is the test</span><b>steps, executor, and evidence come from one artifact — not three documents three people maintain</b></div>
            <div class="meta-row"><span class="k">manual never counts</span><b>your own driving reproduces and records, but structurally never changes a verdict</b></div>
            <div class="meta-row"><span class="k">verdicts are honest</span><b>blocked (infra failed) is never mixed with failed (app broke) — a red means investigate</b></div>
          </div>

          <div class="section-label">who does what</div>
          <div class="card">
            <div class="meta-row"><span class="k">QA</span><b>authors cases, reads verdicts, reproduces by hand in the cockpit</b></div>
            <div class="meta-row"><span class="k">engineer</span><b>opens the failed run — screenshot, network traffic, what the selector resolved against</b></div>
            <div class="meta-row"><span class="k">agent/lioclaw</span><b>queues runs via the API (agent token — yields to humans)</b></div>
          </div>

          <div class="section-label">freshness — read this once</div>
          <div class="card">
            <p>Every run checks whether the app binary is older than the source code. If it is, the run fails fast
              with a <span class="badge badge-accent">⚠ stale</span> badge — because testing an old build proves
              nothing. Fix: rebuild, then re-queue. No src path given = <span class="badge">unchecked</span> (no gate).</p>
          </div>
        </div>

        <!-- ═══ WALL ═══ -->
        <div v-if="active === 'wall'">
          <div class="page-title">devices</div>
          <p class="lede">The wall is your live view of every simulator.</p>

          <div class="slice-demo"><GuideSlices show="wall" /></div>

          <div class="section-label">reading a tile</div>
          <div class="card">
            <div class="meta-row"><span class="k">status + kind</span><b>booted/shutdown, and simulator vs physical — the two live on different rows</b></div>
            <div class="meta-row"><span class="k">lease: free</span><b>nobody's driving it — safe to queue a run</b></div>
            <div class="meta-row"><span class="k">lease: ▸ manual</span><b>a human is driving it right now</b></div>
            <div class="meta-row"><span class="k">lease: other</span><b>an automated run holds it — the holder name tells you which</b></div>
            <div class="meta-row"><span class="k">📌 pin</span><b>pin the devices you care about — pinned rows sort first</b></div>
            <div class="meta-row"><span class="k">mem</span><b>host memory the simulator process is using</b></div>
          </div>

          <div class="section-label">actions</div>
          <div class="card">
            <div class="meta-row"><span class="k">watch</span><b>live MJPEG video stream of the screen (read-only — takes no lease, blocks nothing)</b></div>
            <div class="meta-row"><span class="k">stream stopped?</span><b>click retry stream — the server rebuilds its connection automatically. "reconnecting…" means it is already retrying</b></div>
            <div class="meta-row"><span class="k">drive</span><b>opens the cockpit — full manual control of that device (its own guide section)</b></div>
            <div class="meta-row"><span class="k">shut down / boot / restart</span><b>power-cycle a simulator (blocked while a run or manual session holds it)</b></div>
          </div>
        </div>

        <!-- ═══ RUNS ═══ -->
        <div v-if="active === 'runs'">
          <div class="page-title">runs log</div>
          <p class="lede">A run is one execution: this app build × this device × this case version. The runs page is a dense, day-grouped log — not a table.</p>

          <div class="slice-demo"><GuideSlices show="queue" /></div>

          <div class="section-label">reading a row</div>
          <div class="card">
            <div class="meta-row"><span class="k">HH:MM</span><b>when it started; rows group under local-day dividers with the day's counts</b></div>
            <div class="meta-row"><span class="k">case / variant</span><b>the case name (and variant when the run is one lane of a multi-world play)</b></div>
            <div class="meta-row"><span class="k">r⚠ chip</span><b>the case revision it ran — ⚠ when it's not the current one</b></div>
            <div class="meta-row"><span class="k">duration</span><b>ticks live while running; ⚠ ember over 30 minutes — the avg-vs-max spread is the signal</b></div>
            <div class="meta-row"><span class="k">status</span><b>passed / failed / blocked / aborted / running</b></div>
          </div>

          <div class="section-label">working the log</div>
          <div class="card">
            <div class="meta-row"><span class="k">filters</span><b>status chips filter server-side; everything loads by default — nothing is hidden</b></div>
            <div class="meta-row"><span class="k">in flight</span><b>running + queued rows float at top regardless of timestamp</b></div>
            <div class="meta-row"><span class="k">load earlier</span><b>walks history with a cursor — one page at a time</b></div>
            <div class="meta-row"><span class="k">abort</span><b>stop a running or queued run; remaining steps skip, the device frees</b></div>
            <div class="meta-row"><span class="k">queueing</span><b>one run per device at a time — manual clicks run first, agent API yields</b></div>
          </div>
        </div>

        <!-- ═══ STATUS ═══ -->
        <div v-if="active === 'status'">
          <div class="page-title">status vocabulary</div>
          <p class="lede">Symbols, not colors — the shape carries the meaning.</p>

          <div class="slice-demo"><GuideSlices show="status" /></div>

          <div class="card">
            <div class="meta-row"><span class="k">✓ pass</span><b>the flow proved it — evidence recorded</b></div>
            <div class="meta-row"><span class="k">✕ fail</span><b>assertion broke — click for the triage bundle</b></div>
            <div class="meta-row"><span class="k">◆ blocked</span><b>infrastructure failed — the app never got tested; not an app failure</b></div>
            <div class="meta-row"><span class="k">⌫ aborted</span><b>a human stopped it — verdict intentionally withheld</b></div>
            <div class="meta-row"><span class="k">◌ quarantined</span><b>this flow is too flaky to trust — excluded from roll-ups until released</b></div>
            <div class="meta-row"><span class="k">· no coverage</span><b>nobody wrote a flow for this yet</b></div>
          </div>

          <div class="card card-accent">
            <p><b>blocked ≠ failed.</b> A red always means the app broke. Infra trouble reports as blocked —
              the run detail tells you how to fix it, and it never counts against pass rate.</p>
          </div>
        </div>

        <!-- ═══ SUITES ═══ -->
        <div v-if="active === 'suites'">
          <div class="page-title">suites</div>
          <p class="lede">A named, ordered group of cases — the regression pack you actually run, not every case you have.</p>

          <div class="card">
            <div class="meta-row"><span class="k">path</span><b class="mono">suites → + suite → pick cases → run</b></div>
            <p>Overview runs <b>every</b> case. A suite runs <b>the ones you choose</b>, in the order you set. For a
              case with variants, pin the worlds you care about — <b>sg my</b> — or leave it loose to run them all.
              Press <b>run</b> and each row flips to its fresh verdict as its run finishes.</p>
          </div>

          <div class="card">
            <div class="meta-row"><span class="k">truth</span><b class="mono">live reads, never a snapshot</b></div>
            <p>A suite stores <b>membership</b> — which cases, which variants, what order. It never stores results.
              Verdicts are read live from each case's latest run, so they can't drift from the truth on any other
              page. Delete a suite and its runs survive untouched.</p>
          </div>

          <div class="card">
            <div class="meta-row"><span class="k">scope</span><b class="mono">one app per suite — bundle-locked</b></div>
            <p>A suite answers "is <b>this app</b> OK" — you pick the app (its bundle id) at creation, and only that
              app's cases can join. If a case's app changes after joining, the board flags it and the next run skips
              it with a named reason — nothing silently disappears.</p>
          </div>

          <div class="card">
            <div class="meta-row"><span class="k">markers</span><b class="mono">members changed · stale · drift</b></div>
            <p>After you edit members or a case changes, the board shows named markers with the reason on hover.
              The next play reconciles them.</p>
          </div>
        </div>

        <!-- ═══ OVERVIEW ═══ -->
        <div v-if="active === 'overview'">
          <div class="page-title">overview</div>
          <p class="lede">The build-level answer: is the app safe right now, and what needs eyes first.</p>

          <div class="section-label">what it reads</div>
          <div class="card">
            <div class="meta-row"><span class="k">unit</span><b>a batch — every play-all or variant play is one stamped set</b></div>
            <div class="meta-row"><span class="k">current</span><b>the newest batch in scope</b></div>
            <div class="meta-row"><span class="k">previous</span><b>the last batch on the same build — different builds never compared</b></div>
            <div class="meta-row"><span class="k">solo runs</span><b>shown in latest runs, never in the health math</b></div>
          </div>

          <div class="section-label">how health is computed</div>
          <div class="card">
            <div class="meta-row"><span class="k">running</span><b>any member still running — checked first, always</b></div>
            <div class="meta-row"><span class="k">failed</span><b>any failed case — one case, one observation (worst variant lane wins)</b></div>
            <div class="meta-row"><span class="k">degraded</span><b>infra blocked cases — the app never got tested</b></div>
            <div class="meta-row"><span class="k">pass rate</span><b>passed ÷ (passed + failed) — blocked never counts as failure</b></div>
            <div class="meta-row"><span class="k">no data</span><b>no batch yet in range — shown as no data, never 0%</b></div>
          </div>

          <div class="card">
            <p>A case that failed its previous batch too is <b>recurring</b>; one that failed without any comparable
              previous batch is <b>no baseline</b>. Cases not run in 7 days surface as <b>stale</b>. The attention
              list ranks: new failures first, then infra blocks, then recurring, then stale.</p>
          </div>
        </div>

        <!-- ═══ MATRIX ═══ -->
        <div v-if="active === 'matrix'">
          <div class="page-title">acceptance criteria</div>
          <p class="lede">The per-ticket scorecard: every acceptance criterion, its status, and which flows cover it. Reached from run rows and ⌘K — it has no sidebar entry.</p>

          <div class="slice-demo"><GuideSlices show="matrix" /></div>

          <div class="section-label">how status is computed</div>
          <div class="card">
            <div class="meta-row"><span class="k">per AC</span><b>AND over its flows' latest results — any fail = fail</b></div>
            <div class="meta-row"><span class="k">per ticket</span><b>AND over ACs — all green or it's red</b></div>
            <div class="meta-row"><span class="k">manual runs</span><b>never count — structurally excluded, always</b></div>
            <div class="meta-row"><span class="k">quarantined</span><b>flows drop out of the roll-up — gray, not counted</b></div>
          </div>

          <div class="card">
            <p>Click any AC row → jumps to the run that produced it (evidence one click away).</p>
          </div>
        </div>

        <!-- ═══ TRIAGE ═══ -->
        <div v-if="active === 'triage'">
          <div class="page-title">triage a failure</div>
          <p class="lede">When a step fails, everything you need to understand why lands in one place — the run detail page.</p>

          <div class="slice-demo"><GuideSlices show="triage" /></div>

          <div class="section-label">the bundle</div>
          <div class="card">
            <div class="meta-row"><span class="k">verdict line</span><b>exit word + code — ✕ failed exit 1, ◆ blocked, ▶ running</b></div>
            <div class="meta-row"><span class="k">reason</span><b>REASON: the engine's failure message (what wasn't found / didn't match)</b></div>
            <div class="meta-row"><span class="k">context block</span><b>case · device · build · duration · by — exactly what ran</b></div>
            <div class="meta-row"><span class="k">steps</span><b>step log lines, all expanded by default — network and raw sections below</b></div>
            <div class="meta-row"><span class="k">evidence</span><b>screenshots per step, the whole-run video strip, logs — from the case row's evidence viewer</b></div>
          </div>
        </div>

        <!-- ═══ CASES ═══ -->
        <div v-if="active === 'cases'">
          <div class="page-title">test cases</div>
          <p class="lede">A case is three things at once: the steps, the executor, and the evidence. It lives as a yaml document grouped by app, in folders if you want them.</p>

          <div class="section-label">author — two paths</div>
          <div class="card">
            <div class="meta-row"><span class="k">write it</span><b>open the yaml editor and type — the format is Maestro-style steps; autocomplete knows your app's labels, icons, cases, and tags</b></div>
            <div class="meta-row"><span class="k">record it</span><b>on a booted device: record turns your taps/scrolls/typing into steps; assert saves a label check; save as case</b></div>
          </div>

          <div class="section-label">the case table</div>
          <div class="card">
            <div class="meta-row"><span class="k">groups</span><b>one section per app; folders collect related cases (navigation, never disclosure)</b></div>
            <div class="meta-row"><span class="k">trend</span><b>momentum dots — last 3 plays (pass=ember, fail=paper, blocked=ash, abort=hollow) + a delta arrow; full history in the tooltip</b></div>
            <div class="meta-row"><span class="k">verdict</span><b>last result + which build + when</b></div>
            <div class="meta-row"><span class="k">row actions</span><b>icon buttons — run, evidence, yaml, duplicate, ⋯ lifecycle</b></div>
            <div class="meta-row"><span class="k">expand</span><b>click a row — read-only preview: steps, per-member verdicts for suites, links to runs</b></div>
          </div>

          <div class="section-label">case lifecycle</div>
          <div class="card">
            <div class="meta-row"><span class="k">draft</span><b>unfinished — still runs; the dashed pill marks it</b></div>
            <div class="meta-row"><span class="k">active</span><b>the default — runs everywhere</b></div>
            <div class="meta-row"><span class="k">deprecated</span><b>retired — filters and suites skip it with a named reason. Manual run still works: intent beats lifecycle</b></div>
          </div>

          <div class="section-label">yaml editing</div>
          <div class="card">
            <div class="meta-row"><span class="k">the format</span><b>name, tags, app, then <span class="mono">steps:</span> — tap, scroll, type, runFlow, expect</b></div>
            <div class="meta-row"><span class="k">on:</span><b>the element a step targets — its label or an asset id; replay resolves it live first, coordinates are the fallback</b></div>
            <div class="meta-row"><span class="k">contains:</span><b>matches any label containing the value — still needs exactly one match to pass</b></div>
            <div class="meta-row"><span class="k">variants:</span><b>id + network scenario + env per variant — playing runs every variant, each its own run</b></div>
            <div class="meta-row"><span class="k">same data</span><b>yaml and the step outline are one storage — edit either, the other follows; saving validates with line numbers</b></div>
            <div class="meta-row"><span class="k">‹ › hop</span><b>move between filtered cases without leaving the editor — ⌘↵ save, hop, repeat</b></div>
          </div>

          <div class="section-label">missing app</div>
          <div class="card">
            <div class="meta-row"><span class="k">pre-check</span><b>a case whose app is not installed on the booted simulator refuses to start — no wasted run</b></div>
            <div class="meta-row"><span class="k">install hint</span><b>the refusal carries a one-click fix: install the last-known package, then the case auto-runs</b></div>
            <div class="meta-row"><span class="k">packages</span><b>installs come from the packages dir (CI-dropped .ipa files) — pick one from the chooser; the dir is shown in the picker</b></div>
          </div>

          <div class="section-label">running</div>
          <div class="card">
            <div class="meta-row"><span class="k">▶ run</span><b>watch opens the live companion panel; background runs without it. ■ abort replaces ▶ while it runs</b></div>
            <div class="meta-row"><span class="k">run filtered</span><b>runs every case matching the filter, sequentially — ■ stop all aborts the running case and the queue</b></div>
            <div class="meta-row"><span class="k">network</span><b>live = real network; a scenario fakes endpoints for the run's duration, then restores</b></div>
          </div>
        </div>

        <!-- ═══ SCREENS ═══ -->
        <div v-if="active === 'screens'">
          <div class="page-title">screens</div>
          <p class="lede">The per-app screen registry — what each screen is, how to enter and refresh it, and the states cases assert on. It's the dictionary the case yaml references.</p>

          <div class="section-label">the loop</div>
          <div class="card">
            <div class="meta-row"><span class="k">1 · register</span><b><span class="mono">+ screen</span> on an app section — name it, give the entry and refresh facets</b></div>
            <div class="meta-row"><span class="k">2 · define states</span><b>each screen holds named states with asserts — what proves the screen is in that state</b></div>
            <div class="meta-row"><span class="k">3 · verify</span><b>per-state verify live checks the state against a booted device (✓ holds / ✗ not on screen)</b></div>
            <div class="meta-row"><span class="k">4 · use</span><b>cases reference states: <span class="mono">expect screen: home.world-sg</span></b></div>
          </div>

          <div class="card">
            <div class="meta-row"><span class="k">document</span><b>each screen is a yaml document — form left, live yaml right, one save</b></div>
            <div class="meta-row"><span class="k">login</span><b>an app-level procedure with its own panel — never part of a screen document; reference it as a step</b></div>
            <div class="meta-row"><span class="k">probe</span><b>probe device proposes identifiers from the live screen — selector-preferred, never coordinates</b></div>
          </div>
        </div>

        <!-- ═══ ENV ═══ -->
        <div v-if="active === 'env'">
          <div class="page-title">env variables</div>
          <p class="lede">Play-time secrets and config — scoped, never stored in the case.</p>

          <div class="card">
            <div class="meta-row"><span class="k">scope order</span><b class="mono">global &lt; app &lt; plan &lt; request &lt; variant</b></div>
            <p>A variable resolves from all scopes that define it — the narrowest wins. Cases reference them
              by name in steps (the <code>env.*</code> badge on a run counts the keys in effect); values
              arrive at play time.</p>
          </div>

          <div class="card">
            <div class="meta-row"><span class="k">usage strip</span><b>the page flags env references in stored steps that no variable satisfies — missing keys surface before a run does</b></div>
            <div class="meta-row"><span class="k">effective view</span><b>pick an app + plan → the resolved rows with source badges</b></div>
            <div class="meta-row"><span class="k">secrets</span><b>editing leaves a blank to keep the stored value — the UI never needs to show one</b></div>
          </div>
        </div>

        <!-- ═══ FORGE ═══ -->
        <div v-if="active === 'forge'">
          <div class="page-title">network control</div>
          <p class="lede">Forge controls what the app sees from the network — fake responses, failure injection, live inspection.</p>

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
            <div class="meta-row"><span class="k">edit</span><b>change what a preset serves, slow it, break it — saving updates the live proxy immediately</b></div>
            <div class="meta-row"><span class="k">test pattern</span><b>paste a URL to check whether the preset would match it — same matcher the proxy uses</b></div>
            <div class="meta-row"><span class="k">scenario</span><b>a named set of presets in a foldered document; pick it when running a case or suite</b></div>
            <div class="meta-row"><span class="k">freeze</span><b>see a real response in traffic → freeze it as a preset with one click</b></div>
          </div>

          <div class="card card-accent">
            <p><b>HTTPS included.</b> With the CA trusted (one-time setup), presets work on https endpoints exactly
              like http. Certificate-pinned apps pass through untouched.</p>
          </div>
        </div>

        <!-- ═══ COCKPIT ═══ -->
        <div v-if="active === 'cockpit'">
          <div class="page-title">cockpit</div>
          <p class="lede">Full manual control of one device — spacious, tabbed, inspectable. Open it from the wall's drive button.</p>

          <div class="section-label">the surface</div>
          <div class="card">
            <div class="meta-row"><span class="k">tabs</span><b>one tab per open device — switch re-binds view and control; ✕ releases and shuts down</b></div>
            <div class="meta-row"><span class="k">menubar</span><b>device + app menus — boot/install modals, run app, erase, environment shaping</b></div>
            <div class="meta-row"><span class="k">stage</span><b>the real device bezel — tap, type, scroll (the sim owns the wheel inside the screen); zoom re-sizes, never stretches</b></div>
            <div class="meta-row"><span class="k">rail</span><b>watch | chat — the live stream and an agent chat pane beside the stage</b></div>
            <div class="meta-row"><span class="k">inspect</span><b>the drawer's tree + geometry — sample elements, copy selectors/specs, measure. Recording does not live here</b></div>
            <div class="meta-row"><span class="k">overlays</span><b>environment shaping and tools render over the rail — one at a time, ✕ restores the rail</b></div>
          </div>

          <div class="card card-accent">
            <p><b>Manual never counts.</b> The badge says it, the database enforces it — a manual session reproduces
              and records, but structurally never changes a verdict. Reproduce freely; the ticket status stays
              untouched.</p>
          </div>
        </div>

        <!-- ═══ SHORTCUTS ═══ -->
        <div v-if="active === 'shortcuts'">
          <div class="page-title">keyboard</div>
          <div class="card">
            <div class="meta-row"><span class="k">⌘K</span><b>command palette — jump to any page, watch a booted device, or open a recent ticket</b></div>
            <div class="meta-row"><span class="k">↑ ↓</span><b>navigate palette results</b></div>
            <div class="meta-row"><span class="k">↵</span><b>open the selected result</b></div>
            <div class="meta-row"><span class="k">esc</span><b>close the palette</b></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.guide-grid { display: grid; grid-template-columns: 180px 1fr; gap: var(--s-5); }
.g-group { margin-bottom: var(--s-4); }
.g-label {
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-steel);
  padding: 0 var(--s-4);
  margin-bottom: var(--s-2);
}
.g-item {
  display: block;
  padding: var(--s-2) var(--s-4);
  font-family: var(--font-mono);
  font-size: var(--text-body);
  color: var(--color-fog);
  cursor: pointer;
  text-decoration: none;
  border-left: 2px solid transparent;
  transition: color var(--t), background var(--t);
}
.g-item:hover { color: var(--color-paper); background: var(--color-carbon); }
.g-item.active {
  color: var(--color-paper);
  background: var(--color-carbon);
  border-left-color: var(--color-ember);
}
.lede { color: var(--color-ash); margin: var(--s-2) 0 var(--s-4); font-size: var(--text-body); line-height: 1.6; }
.g-body .card p { color: var(--color-fog); font-size: var(--text-body); line-height: 1.6; margin: var(--s-2) 0 0; }
.slice-demo { margin: var(--s-3) 0; }
</style>
