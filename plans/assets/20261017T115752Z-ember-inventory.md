# Ember inventory — FINAL (post-sweep, 2026-10-17)

Sweep result: 134 chrome references now on --color-accent; 179 remaining references on ember/status-orange = SIGNAL (auto-vermilion via theme.css).
Unclassified: 0 — every remaining line is SIGNAL-by-decision (fail/degraded/live/queued/danger/state marks, inspect annotations, streaming cursors) or a token/theme definition.

## SIGNAL (kept on ember -> vermilion)

```
web/src/styles/components.css:90:.btn-danger { border-color: var(--color-ember); color: var(--color-ember); }
web/src/styles/components.css:91:.btn-danger:hover { border-color: var(--color-ember); color: var(--color-chalk); }
web/src/styles/components.css:154:.status-fail, .status-failed, .status-error { color: var(--color-ember); border-color: var(--color-ember); }
web/src/styles/components.css:156:.status-running { color: var(--color-ember); border-color: var(--color-ember); }
web/src/styles/components.css:162:.status-changes-pending { color: var(--color-ember); border-color: var(--color-ember); }
web/src/styles/components.css:218:.trend .dot.d-pass { background: var(--color-ember); }
web/src/styles/components.css:223:.trend .delta.up { color: var(--color-ember); }
web/src/components/EvidenceSheet.vue:200:.f-pill.fail.on { color: var(--color-ember); border-color: var(--color-ember); border-style: solid; }
web/src/components/RunPanel.vue:434:.rp-live { color: var(--color-ember); font-size: 11px; flex: none; }
web/src/components/RunPanel.vue:454:.rp-tap i { position: absolute; left: 0; top: 0; border-radius: 999px; translate: -50% -50%; border: 2px solid var(--color-ember, #f5a524); }
web/src/components/RunPanel.vue:455:.rp-tap i:first-child { width: 14px; height: 14px; background: var(--color-ember, #f5a524); opacity: 0.9; animation: rp-tap-pop 0.18s ease-out; }
web/src/components/RunPanel.vue:495:  color: var(--color-paper); background: color-mix(in srgb, var(--color-ember) 10%, transparent);
web/src/components/RunPanel.vue:496:  box-shadow: inset 2px 0 var(--color-ember);
web/src/components/RunPanel.vue:498:.rp-step.running .rp-kind { border-color: var(--color-ember); color: var(--color-ember); }
web/src/components/RunPanel.vue:506:.rp-bar i { display: block; height: 100%; background: var(--color-ember); transition: width 0.3s; }
web/src/components/RunPanel.vue:517:.rp-open { margin-left: auto; color: var(--color-ember); font-size: 11px; text-decoration: underline; background: none; border: none; cursor: pointer; flex: none; }
web/src/components/PresetDocPanel.vue:230:          <textarea v-model="headersText" rows="3" :style="{ borderColor: headersValid ? undefined : 'var(--color-ember)' }" />
web/src/components/PresetDocPanel.vue:249:      <span v-if="msg" class="mono" style="color: var(--color-ember);">{{ msg }}</span>
web/src/components/PresetDocPanel.vue:284:.hint.ok { color: var(--color-fog); } .hint.err { color: var(--color-ember); }
web/src/components/InspectOverlay.vue:61:  stroke: var(--color-ember, #ff9f40);
web/src/components/InspectProps.vue:209:.state.err { color: var(--color-ember); }
web/src/components/DeviceMiniPreview.vue:112:.mini-preview.live { border-color: var(--color-ember); }
web/src/components/CaseEditorPanel.vue:251:      <span class="meta">{{ stepsCount }} step{{ stepsCount === 1 ? '' : 's' }}<template v-if="savedAgo"> · saved {{ savedAgo }}</template><template v-if="updatedBy"> · by {{ updatedBy }}</template><template v-if="dirty"> · <span style="color: var(--color-ember);">unsaved</span></template></span>
web/src/components/CaseEditorPanel.vue:272:        <div class="outline-title">steps<template v-if="outlineStale"> · <span style="color: var(--color-ember);">stale</span></template></div>
web/src/components/InspectRedlines.vue:128:  stroke: var(--color-ember, #ff9f40);
web/src/components/InspectRedlines.vue:133:  stroke: var(--color-ember, #ff9f40);
web/src/components/InspectRedlines.vue:138:  fill: var(--color-ember, #ff9f40);
web/src/components/shared/WatcherSteps.vue:25:.s.live { color: var(--color-ember); }
web/src/components/shared/WatcherSteps.vue:30:.meter .fill { position: absolute; inset: 0 auto 0 0; height: 3px; background: var(--color-ember); }
web/src/components/cockpit/ToolsDrawer.vue:274:.state[data-state='aligned'] { border-color: var(--color-ember); color: var(--color-ember); }
web/src/components/cockpit/ToolsDrawer.vue:315:.tag.ok { border-color: var(--color-ember); color: var(--color-ember); }
web/src/components/cockpit/ChatPane.vue:91:.thinking { color: var(--color-ember); font-size: var(--text-caption); padding: 0 var(--s-3); }
web/src/components/cockpit/WatchPane.vue:180:.rs.fail .sym { color: var(--color-paper); } .rs.fail .nm { text-decoration: line-through; text-decoration-color: var(--color-ember); }
web/src/components/cockpit/WatchPane.vue:181:.rs.running { color: var(--color-ember); }
web/src/components/cockpit/WatchPane.vue:188:.meter .fill { position: absolute; inset: 0 auto 0 0; height: 3px; background: var(--color-ember); }
web/src/components/cockpit/WatchPane.vue:191:.verdict.failed { color: var(--color-ember); }
web/src/components/cockpit/EnvPanelContent.vue:85:.pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--color-ember); animation: pulse 2.4s infinite; flex: none; }
web/src/components/cockpit/StageBezel.vue:537:.runlock { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 8; background: var(--color-carbon); border: 1px solid var(--color-ember); color: var(--color-ember); font-size: 11px; letter-spacing: .04em; padding: 6px 14px; border-radius: var(--r); white-space: nowrap; }
web/src/components/cockpit/StageBezel.vue:544:.session-btn.abort { background: none; border: 1px solid var(--color-ember); color: var(--color-ember); }
web/src/components/cockpit/StageBezel.vue:545:.session-btn.abort:hover { background: var(--color-ember); color: var(--color-carbon); }
web/src/components/cockpit/StageBezel.vue:559:.restarting-veil { position: absolute; z-index: 6; display: flex; align-items: center; justify-content: center; gap: 7px; background: rgba(0,0,0,.72); color: var(--color-ember); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; border: 1px solid var(--color-iron); }
web/src/components/cockpit/StageBezel.vue:560:.restarting-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-ember); animation: restarting-pulse 1.1s infinite; }
web/src/components/cockpit/MenuBar.vue:102:.live { color: var(--color-ember); }
web/src/components/cockpit/MenuBar.vue:103:.session-chip-top { border: 1px solid var(--color-ember); color: var(--color-ember); padding: 1px 6px; }
web/src/components/cockpit/DeviceSwitcher.vue:88:.stab.live .dot { background: var(--color-ember); }
web/src/components/DeviceSidebar.vue:1011:.lease-on { color: var(--color-ember); }
web/src/components/DeviceSidebar.vue:1015:  color: var(--color-ember); background: color-mix(in srgb, var(--color-ember) 12%, transparent);
web/src/components/DeviceSidebar.vue:1016:  border-bottom: 1px solid color-mix(in srgb, var(--color-ember) 30%, transparent);
web/src/components/DeviceSidebar.vue:1098:.tree-badge[data-state='aligned'] { border-color: var(--color-ember); color: var(--color-ember); }
web/src/components/DeviceSidebar.vue:1105:.sect-state-on { color: var(--color-ember); }
web/src/components/DeviceSidebar.vue:1106:.sect-state-warn { color: var(--color-ember); }
web/src/components/DeviceSidebar.vue:1108:.form-err { color: var(--color-ember); font-size: 10px; margin-top: var(--s-2); }
web/src/components/DeviceSidebar.vue:1169:  border: 2px solid var(--color-ember);
web/src/components/GuideSlices.vue:31:        <div class="mini-meta"><span>lease</span><b style="color: var(--color-ember);">▸ manual</b></div>
web/src/components/NewRunModal.vue:88:        <div v-if="error" class="meta-row" style="color: var(--color-ember);">{{ error }}</div>
web/src/components/ScreenDocPanel.vue:238:.ed-err { color: var(--color-ember); font-size: var(--text-caption); margin-top: var(--s-2); }
web/src/components/ScenarioDocPanel.vue:241:.chip.changed { border: 1px solid color-mix(in srgb, var(--color-ember) 40%, transparent); color: var(--color-ember); font-family: var(--font-mono); font-size: 10px; padding: 2px 6px; border-radius: var(--r-sm); }
web/src/components/ScenarioDocPanel.vue:274:.ed-err { color: var(--color-ember); font-size: var(--text-caption); margin-top: var(--s-2); }
web/src/components/PackagePicker.vue:150:.pp-err { color: var(--color-ember); }
web/src/components/LoginFlowPanel.vue:122:.ed-err { color: var(--color-ember); font-size: var(--text-caption); margin-top: var(--s-2); white-space: pre-wrap; }
web/src/components/LoginFlowPanel.vue:124:.lfp-acts .danger { border: none; color: var(--color-ember); font-size: var(--text-caption); }
web/src/components/LoginFlowPanel.vue:125:.lfp-acts .danger:hover { color: var(--color-ember-dim); }
web/src/pages/CockpitPage.vue:854:.toast.err { border-color: var(--color-ember); }
web/src/pages/CockpitPage.vue:855:.toast.err .t-ico { border: 1px solid var(--color-ember); color: var(--color-ember); }
web/src/pages/CockpitPage.vue:865:.running-dot { color: var(--color-ember); font-size: 9px; margin-left: 5px; }
web/src/pages/CockpitPage.vue:876:.fanout-row input { width: 13px; height: 13px; flex: 0 0 auto; margin: 0; accent-color: var(--color-ember); cursor: pointer; }
web/src/pages/CockpitPage.vue:899:.hint-err { color: var(--color-paper); font-size: var(--text-caption); margin-top: 8px; border-left: 2px solid var(--color-ember); padding-left: 8px; overflow-wrap: anywhere; white-space: pre-wrap; max-height: 84px; overflow-y: auto; flex: none; }
web/src/pages/LoginPage.vue:93:.err { color: var(--color-ember); font-size: 10px; margin: 10px 0 0; min-height: 14px; }
web/src/pages/RunsPage.vue:209:        <span v-if="!live.connected" style="color: var(--color-ember);"> · live offline</span>
web/src/pages/RunsPage.vue:286:.dayline .bad { color:var(--color-ember); }
web/src/pages/RunsPage.vue:299:.dur-bad { color:var(--color-ember); }
web/src/pages/RunsPage.vue:303:.status-failed { color:var(--color-ember); font-weight:700; }
web/src/pages/RunsPage.vue:305:.status-blocked { color:var(--color-ember); }
web/src/pages/RunsPage.vue:312:.stop { background:none; border:none; color:var(--color-ember); cursor:pointer; font-size:11px; margin-left:6px; padding:0 2px; }
web/src/pages/ProjectsPage.vue:494:.pj-ws.dirty { color: var(--color-ember); }
web/src/pages/ProjectsPage.vue:501:.ed-manifest-bad { margin-left: auto; color: var(--color-ember); font-size: var(--text-caption); cursor: help; }
web/src/pages/ProjectsPage.vue:513:.ed-err { color: var(--color-ember); font-size: var(--text-caption); }
web/src/pages/ProjectsPage.vue:516:.pj-err { color: var(--color-ember); font-size: var(--text-label); margin-bottom: var(--s-3); }
web/src/pages/SettingsPage.vue:168:            <div v-if="modelsError" class="st-row empty" style="color: var(--color-ember)">{{ modelsError }}</div>
web/src/pages/SettingsPage.vue:212:.st-val.ok { color: var(--color-ember); }
web/src/pages/SettingsPage.vue:219:.st-err { color: var(--color-ember); font-size: var(--text-label); margin-bottom: var(--s-3); }
web/src/pages/ScreensPage.vue:604:.hint.err { color: var(--color-ember); }
web/src/pages/ScreensPage.vue:641:.c-act.danger:hover { color: var(--color-ember); }
web/src/pages/ScreensPage.vue:661:.st-vres.fails { color: var(--color-ember); }
web/src/pages/ScreensPage.vue:672:.save-line.err { color: var(--color-ember); }
web/src/pages/ScreensPage.vue:683:.probe-empty.err { color: var(--color-ember); }
web/src/pages/ScreensPage.vue:711:.ed-err { color: var(--color-ember); font-size: var(--text-caption); }
web/src/pages/UsersPage.vue:206:    <div v-if="err" class="meta-row" style="color: var(--color-ember); margin-bottom: 10px;">{{ err }}</div>
web/src/pages/UsersPage.vue:339:      <div v-if="cliApproveCode" class="tok-fresh" style="border-color: var(--color-ember);">
web/src/pages/UsersPage.vue:369:              <td><span class="badge" :style="l.event === 'login_failed' ? 'color: var(--color-ember);' : ''">{{ l.event }}</span></td>
web/src/pages/UsersPage.vue:385:.status-pending { color: var(--color-ember); font-size: var(--text-caption); }
web/src/pages/UsersPage.vue:399:.a2-group-head .health .warn { color: var(--color-ember); }
web/src/pages/UsersPage.vue:402:.tok-fresh { display: flex; align-items: center; gap: var(--s-2); border: 1px dashed var(--color-ember); border-radius: var(--r-sm); padding: var(--s-2) var(--s-3); font-size: var(--text-caption); }
web/src/pages/RunDetailPage.vue:374:.exit .sym.bad, .exit .word.bad { color:var(--color-ember); }
web/src/pages/RunDetailPage.vue:452:.st-failed, .st-fail { color:var(--color-ember); font-weight:700; }
web/src/pages/TestCasesPage.vue:1070:      <span v-if="installErr" style="color: var(--color-ember);">{{ installErr }}</span>
web/src/pages/TestCasesPage.vue:1189:.ibtn.danger:hover { color: var(--color-paper, #f5f2ea); background: var(--color-ember, #ff9f40); }
web/src/pages/TestCasesPage.vue:1207:.status-menu-pop button.warn b { color: var(--color-ember); }
web/src/pages/TestCasesPage.vue:1235:.steps-cov.warn { color: var(--color-ember, #e5484d); }
web/src/pages/TestCasesPage.vue:1244:.a2-crumbs .crumb.cur { color: var(--color-ember); cursor: default; }
web/src/pages/TestCasesPage.vue:1339:.a2-listings-err { display: flex; align-items: center; gap: 10px; padding: 8px 14px; color: var(--color-paper); background: var(--color-carbon); border-left: 2px solid var(--color-ember); font-size: var(--text-caption); }
web/src/pages/OverviewPage.vue:169:    <div v-else-if="error" class="empty" style="color: var(--color-ember);">{{ error }}</div>
web/src/pages/OverviewPage.vue:236:.ov-w-running { color: var(--color-ember); }
web/src/pages/OverviewPage.vue:247:.ov-strip .alert b { color: var(--color-ember); }
web/src/pages/OverviewPage.vue:259:.ov-kind.new_failure { color: var(--color-ember); }
web/src/pages/agent/AgentTimelinePage.vue:363:.pill.live { color: var(--color-ember, #ee6018); border-color: rgba(238, 96, 24, .4); }
web/src/pages/agent/components/WorkRow.vue:84:.st-run .wr-sym { color: var(--color-ember, #ee6018); }
web/src/pages/agent/components/WorkRow.vue:102:.st-run.wr-status { color: var(--color-ember, #ee6018); }
web/src/pages/agent/components/RunPanel.vue:167:.fnode.running .b { background: var(--color-ember); border-color: var(--color-ember); animation: agpulse 1.3s infinite; }
web/src/pages/agent/components/RunPanel.vue:173:.allfail { font-size: var(--text-caption); color: var(--color-ember); margin-top: 6px; }
web/src/pages/agent/components/RunPanel.vue:175:.gate { border: 1px solid var(--color-ember-dim); border-left: 2px solid var(--color-ember); border-radius: var(--r-sm); padding: var(--s-2) var(--s-3); background: var(--ag-panel); }
web/src/pages/agent/components/RunPanel.vue:176:.q { border: 1px solid var(--color-ember-dim); border-left: 2px solid var(--color-ember); border-radius: var(--r-sm); padding: var(--s-2) var(--s-3); background: var(--ag-surface); }
web/src/pages/agent/components/RunPanel.vue:177:.ql { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-ember); margin-bottom: 6px; }
web/src/pages/agent/components/RunPanel.vue:197:.reopen { position: absolute; right: var(--s-3); top: var(--s-2); display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--color-ember-dim); border-radius: var(--r-sm); padding: 3px var(--s-2); background: var(--ag-surface); color: var(--color-ember); font-family: var(--font-mono); font-size: var(--text-caption); cursor: pointer; z-index: 5; }
web/src/pages/agent/components/RunPanel.vue:198:.reopen .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--color-ember); animation: agpulse 1.3s infinite; }
web/src/pages/agent/components/MessageBubble.vue:98:.meta .run { color: var(--color-ember, #ee6018); }
web/src/pages/agent/components/MessageBubble.vue:100:.intent-tag.t-steering { color: var(--color-ember, #ee6018); }
web/src/pages/agent/components/MessageBubble.vue:124:.cursor { display: inline-block; width: 7px; height: 13px; margin-left: 3px; background: var(--color-ember, #ee6018); vertical-align: text-bottom; animation: agblink .9s infinite; }
web/src/pages/agent/components/SessionRail.vue:100:.new { border: 1px solid var(--color-ember-dim, #c24f13); border-radius: 2px; background: var(--color-ember, #ee6018); color: #141414; font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 12px; font-weight: 600; padding: 7px 10px; cursor: pointer; text-align: left; }
web/src/pages/agent/components/SessionRail.vue:114:.live-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--color-ember, #ee6018); margin-left: 5px; animation: railblink 1.2s infinite; vertical-align: baseline; }
web/src/pages/agent/components/SessionRail.vue:122:.live-n { color: var(--color-ember, #ee6018); }
web/src/pages/agent/components/Composer.vue:571:.slash-ico { color: var(--color-ember); flex: none; font-size: 12px; }
web/src/pages/agent/components/Composer.vue:577:.at-count { color: var(--color-ember); }
web/src/pages/agent/components/Composer.vue:604:.ref-kind { color: var(--color-ember); flex: none; }
web/src/pages/agent/components/Composer.vue:614:.send { min-height: 24px; padding: 2px var(--s-3); margin-left: auto; border: 1px solid var(--color-ember); border-radius: var(--r-sm); background: var(--color-ember); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); font-weight: var(--weight-bold); cursor: pointer; opacity: .35; }
web/src/pages/agent/components/ChatSidebar.vue:89:.new { margin: 0 var(--s-3) var(--s-2); border: 1px solid var(--color-ember-dim); border-radius: var(--r-sm); background: var(--color-ember); color: #141414; /* a11y: white-on-ember is 2.9:1 — canvas-dark text hits 5.5:1 */ font-family: var(--font-mono); font-size: var(--text-caption); font-weight: var(--weight-bold); padding: 6px 0; cursor: pointer; }
web/src/pages/agent/components/ChatSidebar.vue:109:.mi.danger:hover { color: var(--color-ember); }
web/src/pages/agent/components/ChatSidebar.vue:112:.op.danger:hover { color: var(--color-ember); }
web/src/pages/agent/components/Thread.vue:168:.pill.live { color: var(--color-ember); border-color: var(--color-ember-dim); }
web/src/pages/agent/components/Thread.vue:169:.dot { width: 5px; height: 5px; border-radius: 50%; background: var(--color-ember); animation: agpulse 1.3s infinite; }
web/src/pages/agent/components/Thread.vue:192:.ab-tag.queued { color: var(--color-ember); border-color: var(--ag-line); }
web/src/pages/agent/components/Thread.vue:209:.stop.live::before { background: var(--color-ember); animation: agpulse 1.3s infinite; }
web/src/pages/agent/components/Thread.vue:214:.stop.err .out { color: var(--color-ember); }
web/src/pages/agent/components/Thread.vue:215:.msg.streaming .cursor { display: inline-block; width: 7px; height: 14px; margin-left: 4px; background: var(--color-ember); animation: agblink 0.9s infinite; }
web/src/pages/EnvPage.vue:328:.gaps { background: var(--color-carbon); border: 1px solid var(--color-iron); border-left: 2px solid var(--color-ember); padding: var(--s-2) var(--s-3); margin-bottom: var(--s-3); display: none; align-items: center; gap: var(--s-2); flex-wrap: wrap; }
web/src/pages/EnvPage.vue:330:.gaps .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-ember); font-weight: var(--weight-bold); }
web/src/pages/EnvPage.vue:356:.env-meta.src.ovr { color: var(--color-ember); }
web/src/pages/EnvPage.vue:360:.env-acts button.danger:hover { color: var(--color-ember); }
web/src/pages/EnvPage.vue:363:.badge.ovr { color: var(--color-ember); border-color: var(--color-ember-dim); }
web/src/pages/WallPage.vue:200:        <span v-if="!live.connected" style="color: var(--color-ember);"> · live offline</span>
web/src/pages/WallPage.vue:248:              <td :style="{ color: (d.memoryRss ?? 0) > 1024 * 1024 * 1024 ? 'var(--color-ember)' : 'var(--color-fog)' }" title="host memory: every process referencing this device">{{ fmtBytes(d.memoryRss) }}</td>
web/src/pages/WallPage.vue:360:.restarting-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--color-ember); border: 1px solid var(--color-ember); padding: 1px 7px; border-radius: var(--r); }
web/src/pages/WallPage.vue:361:.restarting-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-ember); animation: restarting-pulse 1.1s infinite; }
web/src/pages/WallPage.vue:364:.holder-chip { color: var(--color-ember); font-weight: 600; }
web/src/pages/SetupPage.vue:106:.err { color: var(--color-ember); font-size: 10px; margin: 10px 0 0; min-height: 14px; }
web/src/pages/BuildsPage.vue:391:.ball.pass { color: var(--color-ember); }
web/src/pages/BuildsPage.vue:401:.b-err { color: var(--color-ember); font-size: var(--text-label); margin-bottom: var(--s-3); }
web/src/pages/BuildsPage.vue:416:.pk-err { padding: var(--s-3) var(--s-5); color: var(--color-ember); font-size: var(--text-caption); }
web/src/pages/BuildsPage.vue:420:.smoke-ok { color: var(--color-ember); }
web/src/pages/ForgePage.vue:790:.chip.used { color: var(--color-ember); border-color: color-mix(in srgb, var(--color-ember) 40%, transparent); }
web/src/pages/ForgePage.vue:791:.chip.changed { color: var(--color-ember); border-color: color-mix(in srgb, var(--color-ember) 40%, transparent); }
web/src/pages/ForgePage.vue:818:.a2-crumbs .crumb.cur { color: var(--color-ember); cursor: default; }
web/src/pages/ForgePage.vue:851:.row-selected { background: color-mix(in srgb, var(--color-ember) 8%, transparent); }
web/src/styles/tokens.css:32:  --color-ember:    var(--status-orange);  /* Vermilion — fail/degraded/live signal marks */
web/src/styles/tokens.css:33:  --color-ember-dim: var(--status-orange-dim, #c05645);  /* Hover/darker vermilion */
web/src/styles/tokens.css:41:  --color-err:      var(--status-orange);  /* Errors read as signal orange */
web/src/pages/StatusBoardPage.vue:169:.err { color: var(--status-orange); font: 12px var(--font-mono); padding: 12px 0; }
web/src/pages/StatusBoardPage.vue:178:.dot.degraded, .dot.down { background: var(--status-orange); }
web/src/pages/StatusBoardPage.vue:194:.sig.alert { color: var(--status-orange); }
web/src/pages/StatusBoardPage.vue:196:.state.degraded, .state.down { color: var(--status-orange); }
web/src/pages/StatusBoardPage.vue:213:.kv dd.alert { color: var(--status-orange); }
web/src/pages/OverviewPage.vue:233:.ov-dot.failed { background: var(--status-orange); }
web/src/pages/OverviewPage.vue:234:.ov-dot.running { background: var(--status-orange); }
web/src/pages/OverviewPage.vue:272:.ov-state.failed { color: var(--status-orange); }
web/src/pages/OverviewPage.vue:274:.ov-state.running { color: var(--status-orange); }
web/src/pages/AuditPage.vue:289:.facet.rbac .dot { background: var(--status-orange); }
web/src/pages/AuditPage.vue:319:.row .ev.rbac .dot { background: var(--status-orange); }
web/src/pages/AuditPage.vue:320:.row .ev.rbac { color: var(--status-orange); }
web/src/pages/AuditPage.vue:340:.err { color: var(--status-orange); font-size: 13px; }
web/src/pages/AuditPage.vue:345:.d-ev.rbac { color: var(--status-orange); }
web/src/pages/agent/AgentTimelinePage.vue:363:.pill.live { color: var(--color-ember, #ee6018); border-color: rgba(238, 96, 24, .4); }
web/src/pages/agent/components/WorkRow.vue:84:.st-run .wr-sym { color: var(--color-ember, #ee6018); }
web/src/pages/agent/components/WorkRow.vue:102:.st-run.wr-status { color: var(--color-ember, #ee6018); }
web/src/pages/agent/components/MessageBubble.vue:98:.meta .run { color: var(--color-ember, #ee6018); }
web/src/pages/agent/components/MessageBubble.vue:100:.intent-tag.t-steering { color: var(--color-ember, #ee6018); }
web/src/pages/agent/components/MessageBubble.vue:124:.cursor { display: inline-block; width: 7px; height: 13px; margin-left: 3px; background: var(--color-ember, #ee6018); vertical-align: text-bottom; animation: agblink .9s infinite; }
web/src/pages/agent/components/SessionRail.vue:100:.new { border: 1px solid var(--color-ember-dim, #c24f13); border-radius: 2px; background: var(--color-ember, #ee6018); color: #141414; font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 12px; font-weight: 600; padding: 7px 10px; cursor: pointer; text-align: left; }
web/src/pages/agent/components/SessionRail.vue:114:.live-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--color-ember, #ee6018); margin-left: 5px; animation: railblink 1.2s infinite; vertical-align: baseline; }
web/src/pages/agent/components/SessionRail.vue:122:.live-n { color: var(--color-ember, #ee6018); }
```

## CHROME (moved to --color-accent)

```
web/src/styles/tokens.css:37:  --color-chrome-accent: var(--color-accent); /* alias for scoped lookups */
web/src/styles/tokens.css:112::root ::selection { background: var(--color-accent); color: #fafafa; }
web/src/styles/tokens.css:113:.dark ::selection { background: var(--color-accent); color: #101010; }
web/src/styles/layout.css:44:  background: var(--color-accent);
web/src/styles/components.css:64:.card-accent { border-left: 2px solid var(--color-accent); }
web/src/styles/components.css:184:.badge-accent { border-color: var(--color-accent-dim); color: var(--color-accent); }
web/src/styles/components.css:340:.a2-tab.on { color: var(--color-accent); background: var(--color-graphite); }
web/src/styles/components.css:341:.a2-tab.on .n { color: var(--color-accent); }
web/src/components/EvidenceSheet.vue:198:.f-pill.on { color: var(--color-accent); border-color: var(--color-accent); }
web/src/components/EvidenceSheet.vue:260:.ci-chip.sel { border-color: var(--color-accent); }
web/src/components/CaseVersions.vue:130:.vstep:hover { border-color: var(--color-accent); color: var(--color-accent); }
web/src/components/CaseVersions.vue:131:.vstep.on { border-color: var(--color-accent); color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 8%, transparent); }
web/src/components/CaseVersions.vue:132:.vstep.cur.on { border-color: var(--color-accent); }
web/src/components/RunPanel.vue:462:  color: var(--color-accent, #e5484d); background: none;
web/src/components/RunPanel.vue:463:  border: 1px solid var(--color-accent, #e5484d); border-radius: 3px; padding: 1px 6px;
web/src/components/CmdPalette.vue:116:.palette-item.active { background: var(--color-carbon); color: var(--color-paper); border-left: 2px solid var(--color-accent); }
web/src/components/PresetDocPanel.vue:280:.fld input:focus, .fld textarea:focus { outline: 1px solid var(--color-accent); outline-offset: 0; }
web/src/components/InspectOverlay.vue:48:  stroke: var(--color-accent, #6ea8fe);
web/src/components/InspectOverlay.vue:55:  stroke: var(--color-accent, #6ea8fe);
web/src/components/InspectTree.vue:94:.trow.sel { background: var(--color-graphite); color: var(--color-paper); border-left: 2px solid var(--color-accent); padding-left: 4px; }
web/src/components/InspectProps.vue:165:.iid { color: var(--color-accent); font-size: 10px; word-break: break-all; }
web/src/components/InspectProps.vue:199:.v.tok { color: var(--color-accent); }
web/src/components/CaseEditorPanel.vue:337:.ce-field input:focus { outline: none; border-color: var(--color-accent); }
web/src/components/CaseEditorPanel.vue:348:.o-kind.k-expect { border-color: var(--color-accent); color: var(--color-accent); }
web/src/components/shared/OverlayPanel.vue:36:.ov-ico { width: 22px; height: 22px; border: 1px solid var(--color-slate); border-radius: var(--r); display: grid; place-items: center; font-size: 11px; color: var(--color-accent); flex: none; }
web/src/components/shared/OverlayPanel.vue:38:.ov-badge { font-size: 10px; color: var(--color-carbon); background: var(--color-accent); padding: 1px 6px; border-radius: var(--r); }
web/src/components/shared/OverlayPanel.vue:42:.ov-x:hover { border-color: var(--color-accent); color: var(--color-accent); }
web/src/components/shared/WatcherPanel.vue:40:.rtab.active { color: var(--color-paper); border-bottom-color: var(--color-accent); }
web/src/components/shared/WatcherPanel.vue:41:.rtab:focus-visible { outline: 1px solid var(--color-accent); outline-offset: -1px; }
web/src/components/shared/LogTail.vue:18:.hit { color: var(--color-accent); }
web/src/components/cockpit/ToolsDrawer.vue:270:.ico { width: 22px; height: 22px; border: 1px solid var(--color-slate); border-radius: var(--r); display: grid; place-items: center; font-size: 11px; color: var(--color-accent); flex: none; }
web/src/components/cockpit/ToolsDrawer.vue:304:.empty-mark { width: 30px; height: 30px; border: 1px solid var(--color-slate); border-radius: var(--r); display: grid; place-items: center; font-size: 14px; color: var(--color-accent); margin-bottom: 7px; }
web/src/components/cockpit/ToolsDrawer.vue:311:.eid { color: var(--color-accent); font-size: var(--text-caption); font-family: ui-monospace, monospace; }
web/src/components/cockpit/ToolsDrawer.vue:338:.act.primary { background: var(--color-accent); border-color: var(--color-accent); color: #000; font-weight: var(--weight-bold); flex: 0 0 64px; }
web/src/components/cockpit/ToolsDrawer.vue:340:.copymsg { font-size: 10px; color: var(--color-accent); text-align: center; }
web/src/components/cockpit/ChatPane.vue:90:.msg .who { color: var(--color-accent); font-size: 10px; margin-bottom: 2px; }
web/src/components/cockpit/ChatPane.vue:96:.chataree input:focus, .chatarea input:focus { border-color: var(--color-accent); }
web/src/components/cockpit/ChatPane.vue:97:.chatarea button { font-family: inherit; background: var(--color-accent); border: 1px solid var(--color-accent); color: #101010; font-weight: var(--weight-bold); font-size: var(--text-caption); padding: 4px 12px; border-radius: var(--r); cursor: pointer; }
web/src/components/cockpit/EnvPanelContent.vue:95:.scen.on { border-color: var(--color-accent); background: #131010; }
web/src/components/cockpit/EnvPanelContent.vue:99:.scen.on .scen-name { color: var(--color-accent); }
web/src/components/cockpit/EnvPanelContent.vue:101:.scen.on .radio { border-color: var(--color-accent); background: radial-gradient(circle, var(--color-accent) 0 3.5px, transparent 4px); }
web/src/components/cockpit/StageBezel.vue:543:.session-btn.primary { background: var(--color-accent); border-color: var(--color-accent); color: #101010; font-weight: var(--weight-bold); }
web/src/components/cockpit/StageBezel.vue:551:.zoombar button:hover:not(:disabled) { border-color: var(--color-accent); color: var(--color-accent); }
web/src/components/cockpit/StageBezel.vue:557:.inspect-chip { background: var(--color-carbon); border: 1px solid var(--color-accent); color: var(--color-accent); font-family: inherit; font-size: 9px; letter-spacing: .06em; text-transform: uppercase; padding: 2px 6px; border-radius: var(--r); cursor: pointer; text-align: center; white-space: nowrap; }
web/src/components/cockpit/StageBezel.vue:558:.inspect-chip:hover { background: var(--color-accent); color: var(--color-carbon); }
web/src/components/cockpit/MenuBar.vue:87:.brand { color: var(--color-accent); font-weight: var(--weight-bold); padding: 0 var(--s-2) 0 2px; }
web/src/components/cockpit/MenuBar.vue:97:.item.act { color: var(--color-accent); }
web/src/components/cockpit/DeviceSwitcher.vue:57:.stab:focus-visible { outline: 1px solid var(--color-accent); outline-offset: -1px; }
web/src/components/cockpit/DeviceSwitcher.vue:91:.stab.active .sub { color: var(--color-accent); }
web/src/components/DeviceSidebar.vue:1027:.sb-foot b { color: var(--color-accent); font-weight: 400; }
web/src/components/DeviceSidebar.vue:1134:.v-ember { color: var(--color-accent); }
web/src/components/DeviceSidebar.vue:1146:.step-idx { color: var(--color-accent); font-size: 10px; flex: none; }
web/src/components/GuideSlices.vue:154:          <span style="color: var(--color-accent); font-size: 10px;">p_seq1</span>
web/src/components/GuideSlices.vue:231:.mini-accent { border-left: 2px solid var(--color-accent); }
web/src/components/GuideSlices.vue:257:.mini-btn-primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-paper); }
web/src/components/ScreenDocPanel.vue:233:.fld .x:hover { color: var(--color-accent); }
web/src/components/ScenarioDocPanel.vue:266:.picker-search:focus { outline: 1px solid var(--color-accent); outline-offset: 0; }
web/src/components/InspectTools.vue:93:  color: var(--color-accent);
web/src/components/InspectTools.vue:94:  border-color: var(--color-accent);
web/src/components/InspectTools.vue:95:  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
web/src/components/PackagePicker.vue:158:.pp-row.picked { background: var(--color-carbon); color: var(--color-paper); box-shadow: inset 2px 0 0 var(--color-accent); }
web/src/components/PackagePicker.vue:163:.pp-chip.ipa { color: var(--color-accent); border-color: var(--color-accent-dim); }
web/src/components/DeviceRail.vue:72:  color: var(--color-accent); border-color: var(--color-accent);
web/src/components/DeviceRail.vue:73:  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
web/src/components/DeviceRail.vue:83:.dtool .tip kbd { color: var(--color-accent); font-family: inherit; margin-left: 4px; }
web/src/components/LoginFlowPanel.vue:127:.btn-primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-paper); font-weight: var(--weight-bold); }
web/src/pages/CockpitPage.vue:853:.toast.ok .t-ico { background: var(--color-accent); color: var(--color-carbon); }
web/src/pages/CockpitPage.vue:858:.toast .t-bar i { display: block; height: 2px; background: var(--color-accent); animation: toast-drain 5s linear forwards; }
web/src/pages/CockpitPage.vue:870:.pick-row.picked { border: 1px solid var(--color-accent); background: color-mix(in srgb, var(--color-accent) 8%, transparent); color: var(--color-paper); }
web/src/pages/CockpitPage.vue:871:.pick-row.picked .k { color: var(--color-accent); }
web/src/pages/CockpitPage.vue:880:.app-row.picked { border-color: var(--color-accent); }
web/src/pages/CockpitPage.vue:886:.case-row.picked { background: color-mix(in srgb, var(--color-accent) 8%, transparent); }
web/src/pages/CockpitPage.vue:894:.m-btn.primary { background: var(--color-accent); border-color: var(--color-accent); color: #101010; font-weight: var(--weight-bold); }
web/src/pages/CockpitPage.vue:902:.dev-row.picked { border-color: var(--color-accent); }
web/src/pages/RunsPage.vue:309:.rchip:hover { border-color:var(--color-accent); color:var(--color-accent); }
web/src/pages/ProjectsPage.vue:483:.pj-row-card.editing { border-color: var(--color-accent); }
web/src/pages/ProjectsPage.vue:484:.pj-row-card.editing .pj-row { background: color-mix(in srgb, var(--color-accent) 6%, transparent); }
web/src/pages/ProjectsPage.vue:491:.pj-auth.on { color: var(--color-accent); border-color: var(--color-accent-dim); }
web/src/pages/ScreensPage.vue:630:.scr-card.editing { border-color: var(--color-accent); }
web/src/pages/ScreensPage.vue:631:.scr-card.editing .scr-row { background: color-mix(in srgb, var(--color-accent) 6%, transparent); }
web/src/pages/ScreensPage.vue:663:.st-del:hover { color: var(--color-accent); }
web/src/pages/ScreensPage.vue:667:.as-add { border: 1px solid var(--color-accent); color: var(--color-accent); font-size: var(--text-label); padding: 4px var(--s-3); transition: all var(--t); }
web/src/pages/ScreensPage.vue:668:.as-add:hover { background: var(--color-accent); color: var(--color-paper); }
web/src/pages/ScreensPage.vue:692:.probe-node.sel { background: var(--color-carbon); border-left: 2px solid var(--color-accent); padding-left: calc(var(--s-2) - 2px); }
web/src/pages/ScreensPage.vue:694:.probe-node.sel .pn-dot { background: var(--color-accent); border-color: var(--color-accent); }
web/src/pages/ScreensPage.vue:703:.pp-add { border: 1px solid var(--color-accent); color: var(--color-accent); font-size: var(--text-label); padding: 4px var(--s-3); transition: all var(--t); }
web/src/pages/ScreensPage.vue:704:.pp-add:hover { background: var(--color-accent); color: var(--color-paper); }
web/src/pages/UsersPage.vue:383:.you { color: var(--color-accent); font-size: 10px; margin-left: 6px; }
web/src/pages/RunDetailPage.vue:401:.link:hover { color:var(--color-accent); border-bottom-color:var(--color-accent); }
web/src/pages/TestCasesPage.vue:1161:.a2-search:focus { outline: none; border-color: var(--color-accent); }
web/src/pages/TestCasesPage.vue:1164:.status-chip.on .n { color: var(--color-accent-dim); }
web/src/pages/TestCasesPage.vue:1188:.ibtn.accent:hover { color: var(--color-accent); }
web/src/pages/TestCasesPage.vue:1202:button.kebab.open { color: var(--color-accent); border-color: var(--color-accent); }
web/src/pages/TestCasesPage.vue:1222:.a2-row-card.editing { border-color: var(--color-accent); }
web/src/pages/TestCasesPage.vue:1223:.a2-row-card.editing .a2-row { background: color-mix(in srgb, var(--color-accent) 6%, transparent); }
web/src/pages/TestCasesPage.vue:1249:.a2-folder-row .f-glyph { color: var(--color-accent); width: 16px; height: 16px; flex: none; }
web/src/pages/TestCasesPage.vue:1265:.btn.on { border-color: var(--color-accent); color: var(--color-accent); }
web/src/pages/TestCasesPage.vue:1274:.a2-evidence-thumb:hover { border-color: var(--color-accent, #e5484d); }
web/src/pages/TestCasesPage.vue:1303:.run-menu-toggle.open { color: var(--color-accent, #e5484d); }
web/src/pages/TestCasesPage.vue:1316:.run-menu-pop button.sel { color: var(--color-accent, #e5484d); }
web/src/pages/agent/components/WorkRow.vue:82:.wr-head:focus-visible { outline: 1px solid var(--color-accent); outline-offset: 2px; }
web/src/pages/agent/components/RunPanel.vue:158:.ptab.on { color: var(--color-accent); border-color: var(--color-accent-dim); background: var(--ag-surface); }
web/src/pages/agent/components/RunPanel.vue:180:.q textarea:focus { border-color: var(--color-accent-dim); }
web/src/pages/agent/components/RunPanel.vue:184:.primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-paper); font-weight: var(--weight-bold); }
web/src/pages/agent/components/RunPanel.vue:185:.primary:hover { background: var(--color-accent-dim); }
web/src/pages/agent/components/ScrollPill.vue:29:.scroll-pill:focus-visible { outline: 1px solid var(--color-accent); outline-offset: 2px; }
web/src/pages/agent/components/MessageBubble.vue:129:.fbtn:focus-visible { outline: 1px solid var(--color-accent); outline-offset: 2px; }
web/src/pages/agent/components/SessionRail.vue:110:.sess:focus-visible { outline: 1px solid var(--color-accent); outline-offset: -1px; }
web/src/pages/agent/components/Composer.vue:561:.cmd-chip { display: inline-flex; align-items: center; gap: 6px; margin-top: 3px; color: var(--color-accent); border: 1px solid var(--color-accent-dim); background: var(--ag-panel); border-radius: 999px; padding: 2px 6px 2px 12px; font-size: var(--text-caption); font-weight: var(--weight-bold); flex: none; }
web/src/pages/agent/components/Composer.vue:581:.at-search:focus { border-color: var(--color-accent-dim); }
web/src/pages/agent/components/Composer.vue:584:.seg.on { color: var(--color-accent); border-color: var(--color-accent-dim); }
web/src/pages/agent/components/Composer.vue:594:.mchip.combo.on { border-color: var(--color-accent); color: var(--color-paper, #eee); }
web/src/pages/agent/components/Composer.vue:601:.composer:focus-within { border-color: var(--color-accent-dim); }
web/src/pages/agent/components/Composer.vue:606:.chip.jira { color: var(--color-accent); border-color: var(--color-accent-dim); }
web/src/pages/agent/components/Composer.vue:616:.send.ready:hover { background: var(--color-accent-dim); }
web/src/pages/agent/components/Composer.vue:618:.send.stop:hover { color: var(--color-accent); border-color: var(--color-accent-dim); }
web/src/pages/agent/components/ChatSidebar.vue:90:.new:hover { background: var(--color-accent); border-color: #141414; } /* full accent bg on hover — dim bg breaks 4.5:1 contrast */
web/src/pages/agent/components/ChatSidebar.vue:97:.conv.on { background: var(--ag-surface); border-left-color: var(--color-accent); }
web/src/pages/agent/components/Thread.vue:166:.sid .cok { color: var(--color-accent); margin-left: 6px; }
web/src/pages/agent/components/Thread.vue:195:.ab-tag { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-accent); }
web/src/pages/agent/components/Thread.vue:197:.ab-btn:hover { color: var(--color-paper); border-color: var(--color-accent-dim); }
web/src/pages/agent/components/Thread.vue:234:.txt :deep(a) { color: var(--color-accent); }
web/src/pages/agent/components/Thread.vue:263:.att.jira { color: var(--color-accent); border-color: var(--color-accent-dim); }
web/src/pages/SuitesPage.vue:479:.su-search:focus { outline: none; border-color: var(--color-accent); }
web/src/pages/SuitesPage.vue:494:.su-row-card.editing { border-color: var(--color-accent); }
web/src/pages/SuitesPage.vue:495:.su-row-card.editing .su-row { background: color-mix(in srgb, var(--color-accent) 6%, transparent); }
web/src/pages/SuitesPage.vue:522:.ed-name:focus { outline: none; border-color: var(--color-accent); }
web/src/pages/WallPage.vue:352:.pin.on { color:var(--color-accent); }
web/src/pages/WallPage.vue:353:.pin.on:hover { outline-color:var(--color-accent); }
web/src/pages/GuidePage.vue:487:  border-left-color: var(--color-accent);
web/src/pages/BuildsPage.vue:424:.suite-chip { font-size: 11px; padding: 1px 6px; border: 1px solid var(--color-iron); color: var(--color-accent); white-space: nowrap; }
web/src/pages/ForgePage.vue:823:.f-glyph { color: var(--color-accent); width: 16px; height: 16px; flex: none; }
web/src/pages/ForgePage.vue:833:.btn.on { border-color: var(--color-accent); color: var(--color-accent); }
web/src/pages/ForgePage.vue:850:.pre-hit { color: var(--color-accent); font-size: 10px; }
```
