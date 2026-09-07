/** Extraction: copy Guvnor payload files out of a device's app container.
 *  Simulator: `xcrun simctl get_app_container <udid> <bundle> data` → read the
 *  Guvnor dir directly (same filesystem — no copy needed).
 *  Physical: `xcrun devicectl` — the container file-copy path is UNVERIFIED on
 *  paired devices (plan B3 honesty); the drill must prove it, fallback = Xcode
 *  Devices manual export + a folder-ingest entry (same envelope path).
 *
 *  File naming is the Guvnor contract: `metrics-<tsEnd>.json` /
 *  `diagnostics-<tsEnd>.json` — tsEnd doubles as capturedAt for dedupe. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IngestEnvelope } from './ingest.ts';

const exec = promisify(execFile);

export interface ExtractedFile { name: string; envelope: IngestEnvelope }
export interface ExtractResult { container: string; files: ExtractedFile[] }

const GUVNOR_DIR = 'Guvnor'; // Application Support/Guvnor — package contract

function run(cmd: string, args: string[]): Promise<string> {
  return exec(cmd, args, { timeout: 30_000 }).then((r) => r.stdout.trim());
}

/** Simulator extraction — proven path. Reads files straight from the container. */
async function extractFromSimulator(udid: string, appId: string): Promise<ExtractResult> {
  const container = await run('xcrun', ['simctl', 'get_app_container', udid, appId, 'data']);
  const dir = join(container, 'Library', 'Application Support', GUVNOR_DIR);
  let names: string[];
  try { names = await readdir(dir); } catch { return { container: dir, files: [] }; } // no payloads yet
  const files: ExtractedFile[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const kind = name.startsWith('metrics-') ? 'metric' : name.startsWith('diagnostics-') ? 'diagnostic' : null;
    if (!kind) continue;
    const tsMatch = name.match(/(\d{10,})\.json$/);
    const raw = await readFile(join(dir, name), 'utf8');
    files.push({
      name,
      envelope: {
        appId,
        deviceId: `sim-${udid.slice(0, 8)}`,
        payloadKind: kind,
        payloadJson: raw,
        ...(tsMatch ? { capturedAt: Number(tsMatch[1]!) * (tsMatch[1]!.length === 10 ? 1000 : 1) } : {}),
        source: `pull:${udid}`,
      },
    });
  }
  return { container: dir, files };
}

/** Physical-device extraction via devicectl. UNVERIFIED — see header. */
async function extractFromPhysical(udid: string, appId: string): Promise<ExtractResult> {
  // devicectl device info files --domain-type appDataContainer ... — shape varies
  // by Xcode version; the drill proves the exact invocation. Failure here is a
  // 502 to the UI with the tool's message, never a silent empty.
  throw new Error(`physical-device extraction not yet proven — dock via Xcode Devices and use folder ingest (udid ${udid.slice(0, 8)}, app ${appId})`);
}

export async function extractFromDevice(udid: string, appId: string): Promise<ExtractResult> {
  // sims are UUIDs with dashes; physical devices are too — distinguish by trying
  // simctl first (only booted/known sims resolve) and falling through.
  try {
    const devices = await run('xcrun', ['simctl', 'list', 'devices', '-j']);
    if (devices.includes(udid)) return await extractFromSimulator(udid, appId);
  } catch { /* simctl unavailable → physical */ }
  return await extractFromPhysical(udid, appId);
}

export interface GuvnorDevice { udid: string; name: string | null; kind: 'simulator' | 'physical'; state: string | null }

export async function listGuvnorDevices(): Promise<{ devices: GuvnorDevice[] }> {
  const devices: GuvnorDevice[] = [];
  try {
    const out = await run('xcrun', ['simctl', 'list', 'devices', '-j']);
    type SimRow = { udid: string; name: string; state: string };
    const parsed = JSON.parse(out) as { devices?: Record<string, SimRow[]> };
    for (const list of Object.values(parsed.devices ?? {})) {
      for (const d of list) devices.push({ udid: d.udid, name: d.name, kind: 'simulator', state: d.state });
    }
  } catch { /* sims unavailable */ }
  try {
    const out = await run('xcrun', ['devicectl', 'list', 'devices', '-j']);
    const parsed = JSON.parse(out) as { devices?: Array<{ udid: string; name?: string; state?: string } | undefined> };
    for (const d of parsed.devices ?? []) {
      if (d) devices.push({ udid: d.udid, name: d.name ?? null, kind: 'physical', state: d.state ?? null });
    }
  } catch { /* no physical devices paired */ }
  return { devices };
}
