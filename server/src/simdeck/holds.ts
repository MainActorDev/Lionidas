/** simdeck run holds + still feed — the surviving slice of the retired relay:
 *  while a run holds a device, the proxy DETACHES its client legs (input dies,
 *  honest hold) and a simctl still loop keeps run-panel watchers painted as
 *  JPEG-seed frames through the proxy legs (the child streams live through
 *  runs too — stills are the liveness floor, not the only picture). */
import type { FastifyInstance } from 'fastify';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { execFile as execFileCb } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

const RUN_STILL_INTERVAL_MS = Number(process.env['CRUCIBLE_RUN_STILL_MS'] ?? 1_000);
/** Still-capture backoff while a run's STEPS execute on the device: each
 *  simctl screenshot serializes against the XCUITest runner's AX snapshots
 *  on the same sim (measured 2026-09-26: settle steps took 5.2s with a
 *  1Hz still feed painting watchers vs 0.4s resolution with none). The
 *  panel stays live via the child stream + these slower stills. */
const RUN_STILL_STEPS_INTERVAL_MS = Number(process.env['CRUCIBLE_RUN_STILL_STEPS_MS'] ?? 5_000);

const runActiveDevices = new Set<string>();
const stillFeeds = new Set<string>();
/** runId → udid (run.started) and the devices whose runs are in the steps
 *  phase — drives the still-feed quiet window above. */
const runUdidById = new Map<string, string>();
const stepsActiveDevices = new Set<string>();

function wireStepsQuietWindow(bus: TypedEventBus<AppEvents>): void {
  bus.on('run.started', (p) => { if (p.udid) runUdidById.set(p.runId, p.udid); });
  bus.on('run.phase', (p) => {
    const udid = runUdidById.get(p.runId);
    if (!udid) return;
    if (p.phase === 'steps') stepsActiveDevices.add(udid);
    else stepsActiveDevices.delete(udid);
  });
  bus.on('run.finished', (p) => {
    const udid = runUdidById.get(p.runId);
    if (udid) stepsActiveDevices.delete(udid);
    runUdidById.delete(p.runId);
  });
}

let deckPaintPromise: Promise<(u: string, b: Buffer) => number> | null = null;
function deckPaint(): Promise<(u: string, b: Buffer) => number> {
  if (!deckPaintPromise) {
    deckPaintPromise = import('./proxy.ts').then((m) => m.paintStillToLegs);
  }
  return deckPaintPromise;
}

let deckLegsPromise: Promise<(u: string) => number> | null = null;
function deckLegsFor(udid: string): Promise<number> {
  if (!deckLegsPromise) {
    deckLegsPromise = import('./proxy.ts').then((m) => m.simdeckLegCount);
  }
  return deckLegsPromise.then((f) => f(udid));
}

function detachUdid(udid: string): void {
  void import('./proxy.ts').then((m) => m.detachUdid(udid)).catch(() => undefined);
}

function runStillFeed(udid: string): void {
  if (RUN_STILL_INTERVAL_MS <= 0) return; // disabled (tests)
  if (stillFeeds.has(udid)) return;
  stillFeeds.add(udid);
  console.log(`[run-still] feed start: ${udid}`);
  void (async () => {
    let idleTicks = 0;
    let painted = 0;
    let failCount = 0;
    let lastErr = '';
    try {
      while (runActiveDevices.has(udid)) {
        const deckLegCount = await deckLegsFor(udid).catch(() => 0);
        // quiet window: steps executing on this device — slow the stills so
        // the settle loops' AX snapshots don't queue behind screenshots
        const intervalMs = stepsActiveDevices.has(udid) ? RUN_STILL_STEPS_INTERVAL_MS : RUN_STILL_INTERVAL_MS;
        if (deckLegCount === 0) {
          if (++idleTicks >= Math.max(1, Math.round(60_000 / RUN_STILL_INTERVAL_MS))) {
            console.log(`[run-still] feed exit (no watchers for 60s): ${udid}`);
            return;
          }
          await new Promise((r) => setTimeout(r, intervalMs));
          continue;
        }
        idleTicks = 0;
        try {
          const tmp = join(tmpdir(), `crucible-still-${udid}.jpg`);
          await execFileAsync('xcrun', ['simctl', 'io', udid, 'screenshot', tmp]);
          const frame = readFileSync(tmp);
          if (frame.length > 500) {
            const deck = await deckPaint().then((f) => f(udid, frame)).catch(() => 0);
            painted++;
            if (painted === 1) console.log(`[run-still] painting ${deck} leg(s): ${udid}`);
            failCount = 0;
          } else if (++failCount === 1) {
            console.warn(`[run-still] suspiciously small frame (${frame.length}B), discarded: ${udid}`);
          }
        } catch (err) {
          if (++failCount === 1) {
            lastErr = err instanceof Error ? err.message : String(err);
            console.warn(`[run-still] capture failed (will keep retrying): ${udid}: ${lastErr}`);
          }
        }
        await new Promise((r) => setTimeout(r, RUN_STILL_INTERVAL_MS));
      }
      console.log(`[run-still] feed end (run finished, painted=${painted}${failCount > 0 ? `, lastErr=${lastErr}` : ''}): ${udid}`);
    } finally {
      stillFeeds.delete(udid);
    }
  })();
}

export async function registerSimdeckHolds(app: FastifyInstance, bus: TypedEventBus<AppEvents>): Promise<void> {
  void app;
  wireStepsQuietWindow(bus);
  bus.on('run.started', (p) => {
    if (!p.udid) return;
    runActiveDevices.add(p.udid);
    detachUdid(p.udid); // hold = detach legs (input dies; video recovers as watch legs)
    runStillFeed(p.udid);
  });
  bus.on('run.finished', (p) => {
    if (p.udid) runActiveDevices.delete(p.udid);
  });
}
