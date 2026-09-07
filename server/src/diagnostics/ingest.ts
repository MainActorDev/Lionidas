/** Guvnor ingest — MetricKit payloads extracted from devices (pull model).
 *  The app NEVER pushes over the network; Crucible pulls JSON files out of the
 *  app container on demand (simctl / devicectl) and posts them here.
 *
 *  Envelope: { appId, appVersion?, deviceId?, payloadKind: 'metric'|'diagnostic',
 *              payloadJson, capturedAt?, source? }
 *  Summary derivation is SERVER-side so the list view never parses raw JSON
 *  (plan B1) — mx_payloads.summary_json is the only thing the feed reads. */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface IngestEnvelope {
  appId: string;
  appVersion?: string;
  deviceId?: string;
  payloadKind: 'metric' | 'diagnostic';
  payloadJson: string;
  capturedAt?: number;
  source?: string;
}

export interface IngestResult {
  ok: boolean;
  id?: string;
  skipped?: 'duplicate';
  error?: string;
}

/** Parse Apple's payload JSON into the display summary (plain-language feed).
 *  Defensive by design — a malformed payload must never 500 the ingest; it
 *  still lands raw (payload_json) with an empty summary. */
export function deriveSummary(payloadJson: string, kind: 'metric' | 'diagnostic'): Record<string, unknown> {
  let p: Record<string, unknown>;
  try { p = JSON.parse(payloadJson) as Record<string, unknown>; } catch { return {}; }
  if (kind === 'diagnostic') {
    const d = p as { crashDiagnostics?: unknown[]; hangDiagnostics?: unknown[]; cpuExceptionDiagnostics?: unknown[]; diskWriteExceptionDiagnostics?: unknown[] };
    return {
      crashes: d.crashDiagnostics?.length ?? 0,
      hangs: d.hangDiagnostics?.length ?? 0,
      cpuExceptions: d.cpuExceptionDiagnostics?.length ?? 0,
      diskWriteExceptions: d.diskWriteExceptionDiagnostics?.length ?? 0,
    };
  }
  // metric payload: pull headline numbers where present (all optional)
  const s: Record<string, unknown> = {};
  const meta = p as { metaData?: { deviceType?: string; osVersion?: string; applicationBuildVersion?: string } };
  if (meta.metaData?.deviceType) s.deviceModel = meta.metaData.deviceType;
  if (meta.metaData?.osVersion) s.osVersion = meta.metaData.osVersion;
  const launch = p as { applicationLaunchMetrics?: { histogrammedTimeToFirstDraw?: { histogramValue?: Record<string, { bucketStart?: string; bucketCount?: number }> } } };
  const launchBuckets = launch.applicationLaunchMetrics?.histogrammedTimeToFirstDraw?.histogramValue;
  if (launchBuckets) {
    let total = 0; let weighted = 0;
    for (const b of Object.values(launchBuckets)) {
      const ms = b.bucketStart ? parseFloat(b.bucketStart) : NaN;
      const n = b.bucketCount ?? 0;
      if (!Number.isNaN(ms)) { total += n; weighted += ms * n; }
    }
    if (total > 0) s.launchAvgMs = Math.round(weighted / total);
  }
  const mem = p as { memoryMetrics?: { peakMemoryUsage?: string; averageMemoryUsage?: { averageValue?: string } } };
  const peak = mem.memoryMetrics?.peakMemoryUsage;
  if (peak) s.peakMemory = peak;
  const avg = mem.memoryMetrics?.averageMemoryUsage?.averageValue;
  if (avg) s.avgMemory = avg;
  const disk = p as { diskIOMetrics?: { totalLogicalWrites?: string } };
  const writes = disk.diskIOMetrics?.totalLogicalWrites;
  if (writes) s.diskWrites = writes;
  return s;
}

export function ingestPayload(db: Database.Database, env: IngestEnvelope): IngestResult {
  if (!env.appId || typeof env.appId !== 'string') return { ok: false, error: 'appId required' };
  if (env.payloadKind !== 'metric' && env.payloadKind !== 'diagnostic') return { ok: false, error: 'payloadKind must be metric|diagnostic' };
  if (!env.payloadJson || typeof env.payloadJson !== 'string') return { ok: false, error: 'payloadJson required' };
  if (env.payloadJson.length > 8_000_000) return { ok: false, error: 'payload too large' };

  const capturedAt = env.capturedAt ?? null;
  // Idempotency: same device + same capture window + same kind = already ingested.
  // (deviceId may be absent for hand-injected payloads — then no dedupe applies.)
  if (env.deviceId && capturedAt !== null) {
    const dupe = db
      .prepare('SELECT id FROM mx_payloads WHERE device_id = ? AND captured_at = ? AND kind = ? LIMIT 1')
      .get(env.deviceId, capturedAt, env.payloadKind) as { id: string } | undefined;
    if (dupe) return { ok: true, id: dupe.id, skipped: 'duplicate' };
  }

  // Pull identity fields out of the payload when the envelope didn't carry them
  let payloadMeta: { metaData?: { deviceType?: string; osVersion?: string; applicationBuildVersion?: string } } = {};
  try { payloadMeta = JSON.parse(env.payloadJson) as typeof payloadMeta; } catch { /* raw stays raw */ }

  const id = `mx_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO mx_payloads(id, app_id, app_version, device_id, device_model, os_version, kind, received_at, captured_at, source, payload_json, summary_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    env.appId,
    env.appVersion ?? payloadMeta.metaData?.applicationBuildVersion ?? null,
    env.deviceId ?? null,
    payloadMeta.metaData?.deviceType ?? null,
    payloadMeta.metaData?.osVersion ?? null,
    env.payloadKind,
    Date.now(),
    capturedAt,
    env.source ?? null,
    env.payloadJson,
    JSON.stringify(deriveSummary(env.payloadJson, env.payloadKind)),
  );
  return { ok: true, id };
}
