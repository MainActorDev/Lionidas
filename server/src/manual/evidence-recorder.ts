/** Run evidence recorder — extracted from playback.ts.
 *  Owns: whole-run video lifecycle (start ladder incl. wedged-recorder
 *  recovery, stop+ingest), per-expect screenshot capture, and the
 *  no-expect fallback frame. Verdicts never change here — evidence is
 *  best-effort by contract; absence is explainable (video note). */
import type Database from 'better-sqlite3';
import { open } from 'node:fs/promises';
import { ingestEvidence, type IngestDeps } from '../evidence/ingest.ts';
import { classifyEngineError, type DispatchResult } from '../alloy/responses.ts';

/** mvhd (movie header) duration of an mp4, in ms. Walks the top-level atom
 *  table (ftyp/moov/free/mdat…), reads the mvhd box inside moov, and converts
 *  timescale→ms. Returns 0 when absent/malformed (caller treats as no-data —
 *  the legacy anchor stands). Same file the moov-scan in the engine reads;
 *  we parse it locally so precision never waits on an upstream engine PR. */
async function mvhdDurationMs(file: string): Promise<number> {
  try {
    const fh = await open(file, 'r');
    try {
      const head = Buffer.alloc(12);
      await fh.read(head, 0, 12, 0);
      let offset = 0;
      // walk top-level atoms until moov (or EOF-ish cap of 64MB of walking)
      for (let guard = 0; guard < 64; guard++) {
        const hdr = Buffer.alloc(8);
        const { bytesRead } = await fh.read(hdr, 0, 8, offset);
        if (bytesRead < 8) return 0;
        const size = hdr.readUInt32BE(0);
        const type = hdr.toString('ascii', 4, 8);
        if (size < 8) return 0;
        if (type === 'moov') {
          // mvhd is typically the FIRST child of moov: version(1) flags(3)
          // creation(4/8) modification(4/8) timescale(4) duration(4/8)
          // mvhd is the first child of moov; skip its 8-byte box header so
          // [0] = version, then v0: +12 timescale, +16 duration (v1: +20/+24)
          const mvhd = Buffer.alloc(40);
          await fh.read(mvhd, 0, 40, offset + 8);
          const mvhdOffset = 8;
          const version = mvhd[mvhdOffset]!;
          if (version === 1) {
            const timescale = mvhd.readUInt32BE(mvhdOffset + 20);
            const duration = Number(mvhd.readBigUInt64BE(mvhdOffset + 24));
            if (timescale > 0 && duration > 0) return Math.round((duration / timescale) * 1000);
          } else {
            const timescale = mvhd.readUInt32BE(mvhdOffset + 12);
            const duration = mvhd.readUInt32BE(mvhdOffset + 16);
            if (timescale > 0 && duration > 0) return Math.round((duration / timescale) * 1000);
          }
          return 0;
        }
        offset += size; // 64-bit sizes (size==1) never produced by the recorder; bail via guard
      }
      return 0;
    } finally {
      await fh.close();
    }
  } catch {
    return 0;
  }
}

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
   *  stop → start → on 'already active', respawn the tool-server, STOP
   *  AGAIN (the recording outlives the tool-server process — a respawned
   *  server still sees the device-session's active recording, so a bare
   *  start-retry hits the same error; the re-stop is what clears it),
   *  then start (the wedged-recorder ladder — live-root-caused
   *  2026-09-05, re-stop leg added 2026-09-07 after abort-leftovers
   *  wedged every later run on the device). Failure is named in notes,
   *  never blocks. */
  async startVideo(): Promise<void> {
    await this.deps.dispatch('alloy_video', { udid: this.udid, action: 'stop' }, this.deps.dispatchDeps).catch(() => undefined);
    let vs = await this.startVideoOnce();
    if (!vs.ok && classifyEngineError(vs) === 'fetch-failed') {
      // tool-server cold-start race (batch launch, post-restart): respawn
      // kicks the launcher's ensure-step; one backoff'd retry covers the
      // ~2s spawn. Same class the stream route heals (dispatchWithHeal).
      try {
        this.deps.respawnToolServer();
        await new Promise((r) => setTimeout(r, 1_500));
        vs = await this.startVideoOnce();
      } catch { /* respawn best-effort */ }
    }
    if (!vs.ok && classifyEngineError(vs) === 'already-recording') {
      try {
        this.deps.respawnToolServer();
        await this.deps.dispatch('alloy_video', { udid: this.udid, action: 'stop' }, this.deps.dispatchDeps).catch(() => undefined);
        vs = await this.startVideoOnce();
      } catch { /* respawn best-effort */ }
    }
    if (vs.ok) {
      this.videoStarted = true;
      // Tier 2.2 — alignment anchor: the video (best-effort) starts NOW;
      // evidence-player overlay times tap circles against this epoch ms.
      this.deps.db.prepare(`UPDATE runs SET video_started_at = ? WHERE id = ?`).run(Date.now(), this.runId);
    }
    else {
      const msg = (vs as { error?: { message?: string } }).error?.message ?? 'engine error';
      this.deps.db.prepare(`UPDATE runs SET note = ? WHERE id = ?`).run(`video unavailable: ${msg}`, this.runId);
    }
  }

  private startVideoOnce(): Promise<DispatchResult> {
    return this.deps.dispatch('alloy_video', { udid: this.udid, action: 'start' }, this.deps.dispatchDeps)
      .catch((err: unknown) => ({ ok: false, error: { message: err instanceof Error ? err.message : String(err) } })) as Promise<DispatchResult>;
  }

  /** Per-state screenshot for expect screen / expect screen-passing verbs —
   *  same contract as expect: the frame that PROVED the state holds. Used
   *  by R2 verbs (swap cases): each world's arrival evidence. */
  async captureStateEvidence(): Promise<string | null> {
    const shot = (await this.deps.dispatch('alloy_screenshot', { udid: this.udid }, this.deps.dispatchDeps)) as
      { ok: boolean; result?: { path?: string } };
    if (shot.ok && shot.result?.path) {
      const ev = ingestEvidence(this.deps, this.runId, this.runId, 'screenshot', shot.result.path);
      return ev?.id ?? null;
    }
    return null;
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
        const startedWall = (this.deps.db.prepare('SELECT video_started_at AS v FROM runs WHERE id = ?').get(this.runId) as { v: number | null }).v;
        const stop = (await this.deps.dispatch('alloy_video', { udid: this.udid, action: 'stop', label: this.runId }, this.deps.dispatchDeps).catch(() => null)) as
          | { ok: boolean; result?: { video?: { hostPath?: string }; durationMs?: number; mediaDurationMs?: number } } | null;
        const hostPath = stop?.result?.video?.hostPath;
        let videoDest: string | null = null;
        if (stop?.ok && hostPath) {
          const ev = ingestEvidence(this.deps, this.runId, this.runId, 'video', hostPath);
          if (ev) { this.deps.db.prepare(`UPDATE runs SET video_path = ? WHERE id = ?`).run(ev.path, this.runId); videoDest = ev.path; }
        }
        // Precision anchor (plan 20261009T000000Z T2 + reliability round
        // 2026-10-09): the engine's mediaDurationMs when provided; ELSE parse
        // the mp4's mvhd ourselves from the ingested file — the 3-5s lateness
        // the operator saw IS the encoder startup gap, and mvhd (true media
        // duration) vs wall time measures it exactly. No engine PR needed.
        // stopEpoch prefers the engine's own wall duration (clock-consistent);
        // fallback Date.now() only when absent (slightly late = safe direction).
        const wall = typeof stop?.result?.durationMs === 'number' && startedWall != null
          ? startedWall + stop!.result!.durationMs!
          : Date.now();
        let media = stop?.result?.mediaDurationMs;
        if ((typeof media !== 'number' || media <= 0) && videoDest) {
          media = await mvhdDurationMs(videoDest);
        }
        if (typeof media === 'number' && media > 0 && media <= wall - (startedWall ?? 0) + 2000 && startedWall != null) {
          this.deps.db.prepare('UPDATE runs SET video_anchor_ms = ? WHERE id = ?').run(Math.round(wall - media), this.runId);
        }
      } catch { /* best-effort */ }
    }
  }
}

export { mvhdDurationMs as mvhdDurationMsForTest };
