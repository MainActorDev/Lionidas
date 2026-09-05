import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);

/** Spawner contract (injected for tests): run, resolve exit code. */
export type SpawnFn = (cmd: string, args: string[]) => Promise<number>;

/** The device's TCC database — per-simulator permission store. */
export function tccDbPath(udid: string): string {
  return join(homedir(), 'Library/Developer/CoreSimulator/Devices', udid, 'data/Library/TCC/TCC.db');
}

const SVC = 'kTCCServiceLocation';

export type OpenDb = (path: string) => Database.Database;

/** Grant CoreLocation permission to an app by writing the TCC row
 *  directly — the workaround for `simctl privacy grant location` being
 *  a verified no-op on this Xcode (exit 0, no row; live-checked
 *  2026-09-05, research docs/research/2026-09-05-tier2.3-capability-pipes.md).
 *  Row first, THEN kickstart locationd so it re-reads TCC (the USER
 *  agent — the system one warns rdar://78126471). The app picks the row
 *  up on next launch; callers grant BEFORE open. Idempotent: an existing
 *  allow row performs no writes and no spawns.
 *  DB lifecycle: openDb owns the connection — the grant NEVER closes it
 *  (the default opener uses a local handle; injected openers (tests,
 *  shared pools) keep ownership). */
export async function ensureLocationGrant(
  udid: string,
  bundleId: string,
  openDb: OpenDb = () => new Database(tccDbPath(udid)),
  spawn: SpawnFn = async (cmd, args) => {
    await execFileAsync(cmd, args, { timeout: 10_000 });
    return 0;
  },
): Promise<{ granted: true; inserted: boolean }> {
  const db = openDb(tccDbPath(udid));
  const row = db.prepare('SELECT auth_value FROM access WHERE service = ? AND client = ? AND client_type = 0').get(SVC, bundleId) as { auth_value: number } | undefined;
  if (row && row.auth_value === 2) return { granted: true, inserted: false };

  db.prepare(`INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, last_modified)
    VALUES (?, ?, 0, 2, 4, 1, CAST(strftime('%s','now') AS INTEGER))`).run(SVC, bundleId);

  const code = await spawn('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'kickstart', '-k', 'user/foreground/com.apple.locationd']);
  if (code !== 0) throw new Error(`locationd kickstart failed (exit ${code}) — TCC row written; relaunch the app to pick it up`);
  return { granted: true, inserted: true };
}
