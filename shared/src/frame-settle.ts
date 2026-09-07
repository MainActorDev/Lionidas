/** Settle detection from frame timestamps — pure, unit-testable, no DOM.
 *  The stream is change-gated: frames flow only while the screen changes
 *  (~10fps) and go silent when idle. "Quiet after busy" = the screen
 *  stopped moving = the right moment to re-snapshot the AX tree. */

export const QUIET_GAP_MS = 350;
export const MIN_BUSY_MS = 120;

export type SettleState = 'quiet' | 'busy';

export class SettleDetector {
  private lastAt = 0;
  private state: SettleState = 'quiet';
  /** ms spent busy before last quiet — exposed for diagnostics. */
  busyMs = 0;

  /** Feed a frame timestamp (ms). Returns the CURRENT state after the frame. */
  push(frameAt: number): SettleState {
    const gap = frameAt - this.lastAt;
    this.lastAt = frameAt;
    if (this.state === 'quiet') {
      if (gap > 0 && gap < QUIET_GAP_MS) { this.state = 'busy'; this.busyMs = gap; }
      // gap ≥ QUIET_GAP: a single frame after long idle — stay quiet (hysteresis)
    } else {
      this.busyMs += gap;
      if (gap >= QUIET_GAP_MS) { this.state = 'quiet'; this.busyMs = 0; }
      // gap < QUIET_GAP: frames keep flowing — stay busy
    }
    return this.state;
  }

  /** Call when time passes with NO frame — may transition busy → quiet. */
  tick(now: number): SettleState {
    if (this.state === 'busy' && now - this.lastAt >= QUIET_GAP_MS) {
      this.state = 'quiet';
      this.busyMs = 0;
    }
    return this.state;
  }
}
