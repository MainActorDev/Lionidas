/** Device-lane batch pool (2026-09-06 parallel-batches plan).
 *
 *  One worker per lane (lane = one booted device, strictly serial — B5's
 *  one-run-per-device contract intact). Lanes run CONCURRENTLY. A lane
 *  halts itself on DEVICE_BUSY / APP_NOT_INSTALLED / DEVICE_AMBIGUOUS
 *  (today's sequential batch semantics, scoped to the lane); siblings
 *  continue. Scenario requests with >1 lane are rejected up front — the
 *  forge preset set is global and would cross-contaminate. */
import { randomUUID } from 'node:crypto';
import type { Lane } from './plan.ts';

export interface BatchLaneResult {
  device: { udid: string; name: string | null };
  runIds: string[];
  skipped: string[]; // templateIds never dispatched (halt or abort)
  haltedAt?: string; // templateId whose failure halted the lane
  haltedReason?: string;
}

export interface BatchResult {
  batchId: string;
  runIds: string[];
  lanes: BatchLaneResult[];
  aborted: boolean;
}

type RunOne = (
  templateId: string,
  udid: string,
  opts: Record<string, unknown>,
) => Promise<{ runId: string; udid: string; done: Promise<void> }>;

interface PoolDeps { db: unknown; bus: { emit: (t: string, p: unknown) => void }; forgeState: { activeRunId: string | null } }

const HALT_CODES = new Set(['DEVICE_BUSY', 'APP_NOT_INSTALLED', 'DEVICE_AMBIGUOUS']);

interface Controller { abort(): void; aborted: boolean }
const batches = new Map<string, Controller>();

/** abort a batch: stop dispatching pending cases (in-flight runs use the
 *  existing run-abort between-steps semantics — the pool never kills one). */
export function abortBatch(batchId: string): boolean {
  const c = batches.get(batchId);
  if (!c) return false;
  c.aborted = true;
  return true;
}

export function getBatch(batchId: string): { aborted: boolean } | undefined {
  const c = batches.get(batchId);
  return c ? { aborted: c.aborted } : undefined;
}

export class ParallelScenarioError extends Error {
  code = 'PARALLEL_SCENARIO_UNSUPPORTED' as const;
}

export async function runParallelBatch(
  deps: PoolDeps,
  input: {
    lanes: Lane[];
    opts: Record<string, unknown>;
    runOne: RunOne;
  },
): Promise<BatchResult> {
  if (input.opts['scenarioId'] !== undefined && input.lanes.filter((l) => l.cases.length > 0).length > 1) {
    throw new ParallelScenarioError('network scenarios are not supported in parallel batches (global proxy state)');
  }
  const batchId = `batch_${randomUUID().slice(0, 8)}`;
  const controller: Controller = { abort() { this.aborted = true; }, aborted: false };
  batches.set(batchId, controller);

  const laneResults = await Promise.all(input.lanes.map(async (lane): Promise<BatchLaneResult> => {
    const result: BatchLaneResult = { device: lane.device, runIds: [], skipped: [] };
    for (const c of lane.cases) {
      if (controller.aborted) { result.skipped.push(c.templateId); continue; }
      try {
        const started = await input.runOne(c.templateId, lane.device.udid, { ...input.opts, udid: lane.device.udid });
        result.runIds.push(started.runId);
        await started.done; // lane is serial — next case only after settle
      } catch (err) {
        const code = (err as { code?: string }).code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code && HALT_CODES.has(code)) {
          result.haltedAt = c.templateId;
          result.haltedReason = msg;
          for (const rest of lane.cases.slice(lane.cases.indexOf(c) + 1)) result.skipped.push(rest.templateId);
          break;
        }
        // single-case hard failure (today's semantics): the RUN failed, the
        // BATCH moves on — record and continue the lane.
        result.runIds.push(`failed:${c.templateId}`);
      }
    }
    return result;
  }));

  const aborted = controller.aborted;
  batches.delete(batchId); // cleanup on every settle path
  const result: BatchResult = {
    batchId,
    runIds: laneResults.flatMap((l) => l.runIds),
    lanes: laneResults,
    aborted,
  };
  deps.bus.emit('batch.finished', { batchId, aborted });
  return result;
}

/** test seams */
export function __resetBatchRegistry(): void { batches.clear(); }
export function __batchesForTest(): Map<string, Controller> { return batches; }
