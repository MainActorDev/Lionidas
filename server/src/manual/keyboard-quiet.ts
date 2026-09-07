/** QA keyboard quieting: system keyboard autocorrect/prediction animations are
 *  the classic XCUITest "app never idle" trap — rapid synthesized taps (typing
 *  credentials via keyboard) pile up quiescence waits until XCTest records a
 *  failure ("the action may not have been performed"). Disabling the three
 *  busy keyboard features on QA simulators removes the animator noise at the
 *  source, for manual driving AND recorded cases.
 *
 *  Applied at manual-session start (per simulator, idempotent, ~0.5s). Real
 *  devices are never touched — this is a simulator-only intervention. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const QUIET_KEYS = ['KeyboardAutocorrection', 'KeyboardPrediction', 'KeyboardSuggestion'] as const;

/** True only for UDIDs simctl actually knows (physical Apple devices use
 *  UUID-shaped identifiers too — shape alone cannot distinguish them). */
export async function isSimulator(udid: string): Promise<boolean> {
  try {
    const out = await exec('xcrun', ['simctl', 'list', 'devices', '-j'], { timeout: 10_000 });
    return out.stdout.includes(udid);
  } catch {
    return false;
  }
}

/** Best-effort quieting — failures never block the session (a chatty keyboard
 *  degrades UX, it must not break take-control). Physical devices are never
 *  touched: simctl spawn on them fails and the whole call no-ops. */
export async function quietKeyboard(udid: string): Promise<void> {
  if (!(await isSimulator(udid))) return;
  try {
    for (const key of QUIET_KEYS) {
      await exec('xcrun', ['simctl', 'spawn', udid, 'defaults', 'write', 'com.apple.Preferences', key, '-bool', 'false'], { timeout: 10_000 });
    }
  } catch { /* sim not booted / spawn failed — session proceeds with stock keyboard */ }
}
