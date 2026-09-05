/** Run-level system-dialog policy engine — extracted from playback.ts.
 *  One place for: policy parse, storm cap, drain loop, audit-note collection.
 *  The dispatch seam stays injected so tests drive it with fakes. */
import { resolveAlertPolicy, type AlertPolicy } from '@crucible/shared/alert-policy';

/** dialog present under fail-policy, or cap exceeded */
export class AlertStormError extends Error {
  constructor(public dialogText: string) { super(`alert storm: ${dialogText}`); }
}

export const ALERT_CAP = 3; // auto-handlings per run — storms fail named, never loop

/** Parse the stored alerts_policy column → policy. Garbage → null (honest
 *  default: every dialog fails named). */
export function parseAlertPolicyColumn(raw: string | null | undefined): AlertPolicy | null {
  try {
    const parsed = raw ? JSON.parse(raw) as { entries?: unknown } : null;
    if (parsed && Array.isArray(parsed.entries)) return parsed as AlertPolicy;
  } catch { /* garbage column → null */ }
  return null;
}

export interface DialogDrainDeps {
  dispatch: (tool: 'alloy_alert', input: { udid: string; action: string }) => Promise<
    | { ok: true; result: { message?: string } }
    | { ok: false; error?: { message?: string } }
  >;
}

/** Mutable per-run state: handlings counter + audit note lines. */
export class RunDialogPolicy {
  private handledCount = 0;
  readonly noteLines: string[] = [];

  constructor(private readonly policy: AlertPolicy | null, private readonly deps: DialogDrainDeps) {}

  get isNull(): boolean { return this.policy === null; }
  get handlings(): number { return this.handledCount; }
  get cap(): number { return ALERT_CAP; }

  note(line: string): void { this.noteLines.push(line); }

  /** Drain dialogs at a site. Returns handled count this call; throws
   *  AlertStormError on storm (cap/fail-policy) — caller converts to a
   *  named case-failure. */
  async drain(udid: string, site: string): Promise<number> {
    let handled = 0;
    for (;;) {
      const insp = await this.deps.dispatch('alloy_alert', { udid, action: 'inspect' });
      if (!insp.ok || !insp.result?.message) return handled;
      const text = insp.result.message;
      const act = resolveAlertPolicy(this.policy, text);
      if (act === 'fail') throw new AlertStormError(text);
      if (this.handlings >= ALERT_CAP) throw new AlertStormError(text);
      const clr = await this.deps.dispatch('alloy_alert', { udid, action: act });
      if (!clr.ok) throw new Error(`alert ${act} failed: ${clr.error?.message ?? 'engine error'}`);
      this.handledCount++;
      handled++;
      this.note(`alert-handled (${act}): "${text}" @ ${site}`);
    }
  }
}
