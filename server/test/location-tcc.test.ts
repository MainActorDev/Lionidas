import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** T4 (Tier 2.3): the CoreLocation permission grant — the workaround for
 *  `simctl privacy grant location` being a verified no-op on this Xcode.
 *  Writes the kTCCServiceLocation row directly + kickstarts locationd.
 *  All I/O injected: db factory + spawner. */

import {
  ensureLocationGrant, tccDbPath, type SpawnFn,
} from '../src/manual/location-tcc.js';

function freshDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tcc-'));
  const db = new Database(join(dir, 'TCC.db'));
  // minimal live-schema subset (NOT NULL columns only)
  db.exec(`CREATE TABLE access (
    service TEXT NOT NULL, client TEXT NOT NULL, client_type INTEGER NOT NULL DEFAULT 0,
    auth_value INTEGER NOT NULL DEFAULT 0, auth_reason INTEGER NOT NULL DEFAULT 0,
    auth_version INTEGER NOT NULL DEFAULT 1, last_modified INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (service, client, client_type))`);
  return { db, dir };
}

describe('tccDbPath', () => {
  it('resolves the device TCC db path', () => {
    expect(tccDbPath('UDID-1')).toBe(`${process.env.HOME}/Library/Developer/CoreSimulator/Devices/UDID-1/data/Library/TCC/TCC.db`);
  });
});

describe('ensureLocationGrant', () => {
  it('missing row → INSERT (auth 2) + kickstart locationd', async () => {
    const { db, dir } = freshDb();
    const spawns: string[][] = [];
    const spawn: SpawnFn = async (cmd, args) => { spawns.push([cmd, ...args]); return 0; };
    const openDb = (_p: string) => db;

    const r = await ensureLocationGrant('U1', 'com.foo.app', openDb, spawn);
    expect(r).toEqual({ granted: true, inserted: true });
    const row = db.prepare("SELECT auth_value FROM access WHERE service='kTCCServiceLocation' AND client='com.foo.app'").get() as { auth_value: number };
    expect(row.auth_value).toBe(2);
    // kickstart the USER agent (system one warns rdar://78126471 — verified live)
    expect(spawns.length).toBe(1);
    expect(spawns[0]!.join(' ')).toContain('user/foreground/com.apple.locationd');
    db.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('row already present (auth 2) → no writes, no kickstart (idempotent)', async () => {
    const { db, dir } = freshDb();
    db.prepare("INSERT INTO access (service, client, client_type, auth_value) VALUES ('kTCCServiceLocation','com.foo.app',0,2)").run();
    const spawns: string[][] = [];
    const spawn: SpawnFn = async (cmd, args) => { spawns.push([cmd, ...args]); return 0; };
    const before = (db.prepare('SELECT COUNT(*) c FROM access').get() as { c: number }).c;

    const r = await ensureLocationGrant('U1', 'com.foo.app', () => db, spawn);
    expect(r).toEqual({ granted: true, inserted: false });
    expect(spawns.length).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM access').get() as { c: number }).c).toBe(before);
    db.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('row present but DENIED (auth 0) → overwritten to allow', async () => {
    const { db, dir } = freshDb();
    db.prepare("INSERT INTO access (service, client, client_type, auth_value) VALUES ('kTCCServiceLocation','com.foo.app',0,0)").run();
    const spawn: SpawnFn = async () => 0;
    const r = await ensureLocationGrant('U1', 'com.foo.app', () => db, spawn);
    expect(r.inserted).toBe(true);
    const row = db.prepare("SELECT auth_value FROM access WHERE client='com.foo.app'").get() as { auth_value: number };
    expect(row.auth_value).toBe(2);
    db.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('kickstart failure → error surfaced (grant itself still in the db)', async () => {
    const { db, dir } = freshDb();
    const spawn: SpawnFn = async () => 1; // non-zero exit
    await expect(ensureLocationGrant('U1', 'com.foo.app', () => db, spawn)).rejects.toThrow('locationd');
    const row = db.prepare("SELECT auth_value FROM access WHERE client='com.foo.app'").get() as { auth_value: number } | undefined;
    expect(row?.auth_value).toBe(2); // row written before kickstart
    db.close(); rmSync(dir, { recursive: true, force: true });
  });
});
