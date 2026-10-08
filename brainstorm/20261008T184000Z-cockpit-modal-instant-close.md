# Cockpit modals: close on action click, not on success

- Source prompt: "Every operation in cockpit from the modal entry points,
  should closes the modal immediately after the button is clicked. Check
  each one of them. Do you know what are they that I'm talking about?"
- Created: 2026-10-08T18:40:00Z (approx; session)
- Status: Direction selected (single real option — see Exploration)

## Goal and context

Today most cockpit modals close only AFTER the awaited API call succeeds
(`if (b.ok) { XOpen.value = false; … }`). While the request is in flight the
modal sits open on a busy/disabled button — for slow ops (install of a big
ipa, suite fan-out) that feels stuck, and a failure leaves the modal up with
an error. The user wants the inverse contract: clicking the action button
closes the modal IMMEDIATELY; the outcome arrives as a toast (flash) either
way. (Direct statement of intent from the prompt; the toast-already-exists
mechanism is a verified fact — `flash()` at CockpitPage.vue:40, 5s toasts.)

## Confirmed inputs and decisions

- Verified modal inventory (CockpitPage.vue, read 2026-10-08):

| # | Modal | Entry | Action handler | Closes today |
|---|---|---|---|---|
| 1 | boot device | device menu ⌘⇧D | `bootSelected` (~370) | on success only |
| 2 | test case (play) | run menu ⌘P | `playPicked` (~490) | on success only (fan-out/runId branches) |
| 3 | suite | run menu | suite handler (~440) | on success only (queued/runIds branches) |
| 4 | run app | app menu | `launchApp` (282) | on success only |
| 5 | install (PackagePicker) | app menu | `runInstall` (307) | on success only |
| 6 | uninstall | app menu | `runUninstall` (344) | on success only |

- PackagePicker is shared by DeviceSidebar + TestCasesPage (3 importers) —
  its confirm button does NOT close itself; the parent closes on success.
- `flash()` toasts exist and are the outcome surface (ok/err kinds).
- Env drawer / inspect overlay / boot picker are NOT modal-scrim flows
  (drawer/overlay chrome) — out of scope unless the user says otherwise.

## Exploration

There is really one design here (the prompt prescribes it); the real choices
are at the edges:

**Core change per modal**: move `XOpen.value = false` from the success
branch to the TOP of the handler (before the fetch). Failure outcome →
`flash(msg, 'err')` instead of an in-modal error line. Keep busy-guards.

**Edge choices:**

1. **Validation BEFORE close** (bundle picked? boot device chosen?):
   preconditions still block (no close, inline hint) — clicking the action
   with an INVALID selection isn't an "operation". Only a well-formed action
   click closes. (Proposal — feels like the only sane reading.)
2. **Where do errors go?** In-modal error lines disappear with the instant
   close → ALL failure outcomes become err-toasts. Toasts live 5s; a long
   simctl stderr may overflow — cap/truncate the toast text (already
   `overflow-wrap` in hint-err; toast styling to check).
3. **PackagePicker (install)**: parent closes instantly on confirm; the
   picker's own confirm button already disables while busy — the modal
   closing immediately makes that moot. Confirm button click = close +
   `runInstall` proceeds in background; success/failure → toast. Other
   PackagePicker consumers (DeviceSidebar, TestCasesPage) keep their current
   behavior (they are not cockpit; not in the prompt's scope).
4. **Uninstall nuance**: it has an explicit destructive confirm step; the
   click that closes is the CONFIRM click (second step), not the row pick.
5. **Double-click protection**: once the modal closes instantly, nothing
   visually blocks re-opening + re-firing the same op. Handlers already have
   `if (busy) return` guards — keep them; the busy flag also feeds a
   "still working…" toast if the op is long (proposal, optional).

**Rejected alternative**: keep modals open with a progress state — that is
exactly what the user is asking to remove.

## Open questions

1. Error text length in toasts: truncate to ~1 line (proposal) vs full text?
   Low stakes; rec: truncate with the full text only in logs.
2. Should the boot modal ALSO switch device immediately on click (it waits
   for boot success today before switching stages)? Rec: keep current
   switch-on-success logic; only the modal close moves to click-time.

## Next step

Apply to all 6 modals in one pass (mechanical, one handler each), keep
busy-guards, add err-toasts, then live-drill the three slowest (install,
suite, uninstall) to feel the instant close.
