/** Run evidence recorder — extracted from playback.ts.
 *  Owns: whole-run video lifecycle (start ladder incl. wedged-recorder
 *  recovery, stop+ingest), per-expect screenshot capture, and the
 *  no-expect fallback frame. Verdicts never change here — evidence is
 *  best-effort by contract; absence is explainable (video note). */
import type Database from 'better-sqlite3';
import { ingestEvidence, type IngestDeps } from '../evidence/ingest.ts';
import { classifyEngineError, type DispatchResult } from '../alloy/responses.ts';

export type AlloyDispatch = (tool: string, input: unknown, deps: unknown) => Promise<DispatchResult>;

export interface EvidenceRecorderDeps extends IngestDeps {
  db: Database.Database;
  dispatch: AlloyDispatch;
  dispatchDeps: unknown;
  /** respawns engine-B tool-server (wedged-recorder recovery) */
  respawnToolServer: () => void;
}

export class EvidenceRecorder {
  private videoStarted = false;
  readonly notes: string[] = [];

  constructor(private readonly deps: EvidenceRecorderDeps, private readonly runId: string, private readonly udid: string) {}

  /** Whole-run video, started BEFORE the app opens. Best-effort:
   *  stop → start → on 'already active', respawn the tool-server once →
   *  start again (the wedged-recorder ladder — live-root-caused 2026-09-05).
   *  Failure is named in notes, never blocks. */
  async startVideo(): Promise<void> {
    await this.deps.dispatch('alloy_video', { udid: this.udid, action: 'stop' }, this.deps.dispatchDeps).catch(() => undefined);
    let vs = await this.startVideoOnce();
    if (!vs.ok && classifyEngineError(vs) === 'already-recording') {
      try {
        this.deps.respawnToolServer();
        vs = await this.startVideoOnce();
      } catch { /* respawn best-effort */ }
    }
    if (vs.ok) this.videoStarted = true;
    else {
      const msg = (vs as { error?: { message?: string } }).error?.message ?? 'engine error';
      this.deps.db.prepare(`UPDATE runs SET note = ? WHERE id = ?`).run(`video unavailable: ${msg}`, this.runId);
    }
  }

  private startVideoOnce(): Promise<DispatchResult> {
    return this.deps.dispatch('alloy_video', { udid: this.udid, action: 'start' }, this.deps.dispatchDeps)
      .catch((err: unknown) => ({ ok: false, error: { message: err instanceof Error ? err.message : String(err) } })) as Promise<DispatchResult>;
  }

  /** Per-expect screenshot → evidence id (null = capture failed; the step
   *  row then carries no evidence — verdict unchanged). */
  async captureExpectEvidence(): Promise<string | null> {
    try {
      const shot = (await this.deps.dispatch('alloy_screenshot', { udid: this.udid }, this.deps.dispatchDeps)) as
        | { ok: boolean; result?: { path: string } };
      if (shot.ok && shot.result) {
        const ev = ingestEvidence(this.deps, this.runId, this.runId, 'screenshot', shot.result.path);
        return ev?.id ?? null;
      }
    } catch { /* best-effort */ }
    return null;
  }

  /** finally-block: stop video (ingest + runs.video_path) and, only when
   *  no expect captured evidence, the fallback frame. */
  async finish(): Promise<void> {
    try {
      const expectEvidenceCount = (this.deps.db.prepare(`SELECT COUNT(*) c FROM run_steps WHERE run_id = ? AND evidence_ids_json != '[]'`).get(this.runId) as { c: number }).c;
      if (expectEvidenceCount === 0) {
        const shot = (await this.deps.dispatch('alloy_screenshot', { udid: this.udid }, this.deps.dispatchDeps)) as { ok: boolean; result?: { path: string } };
        if (shot.ok && shot.result) {
          const ev = ingestEvidence(this.deps, this.runId, this.runId, 'screenshot', shot.result.path);
          if (ev) this.deps.db.prepare(`UPDATE runs SET artifact_path = ? WHERE id = ?`).run(ev.path, this.runId);
        }
      }
    } catch { /* best-effort */ }
    if (this.videoStarted) {
      try {
        const stop = (await this.deps.dispatch('alloy_video', { udid: this.udid, action: 'stop', label: this.runId }, this.deps.dispatchDeps).catch(() => null)) as
          | { ok: boolean; result?: { video?: { hostPath?: string } } } | null;
        const hostPath = stop?.result?.video?.hostPath;
        if (stop?.ok && hostPath) {
          const ev = ingestEvidence(this.deps, this.runId, this.runId, 'video', hostPath);
          if (ev) this.deps.db.prepare(`UPDATE runs SET video_path = ? WHERE id = ?`).run(ev.path, this.runId);
        }
      } catch { /* best-effort */ }
    }
  }
}
