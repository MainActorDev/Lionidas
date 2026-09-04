import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateM1 } from '../src/db/schema.ts';
import { lastArtifactFor, recordArtifact } from '../src/manual/app-catalog-store.ts';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  migrateM1(db);
  return db;
}

describe('app-catalog store', () => {
  it('returns null when nothing recorded', () => {
    const db = freshDb();
    expect(lastArtifactFor(db, 'com.lioparcel.services.consumer-dev')).toBeNull();
    db.close();
  });

  it('round-trips artifact, version, recordedAt (latest wins)', () => {
    const db = freshDb();
    recordArtifact(db, { bundleId: 'b', artifactPath: '/old.app', appVersion: '1.0.0' });
    recordArtifact(db, { bundleId: 'b', artifactPath: '/new.app', appVersion: '3.4.0' });
    const a = lastArtifactFor(db, 'b')!;
    expect(a.artifactPath).toBe('/new.app');
    expect(a.appVersion).toBe('3.4.0');
    expect(a.artifactSha).toBeNull();
    expect(a.recordedAt).toBeGreaterThan(0);
    db.close();
  });

  it('sha round-trips when provided', () => {
    const db = freshDb();
    recordArtifact(db, { bundleId: 'b', artifactPath: '/x.app', artifactSha: 'deadbeef', appVersion: null });
    expect(lastArtifactFor(db, 'b')!.artifactSha).toBe('deadbeef');
    db.close();
  });

  it('survives migrateM1 twice (idempotent DDL)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'appcat-'));
    const db = new Database(join(dir, 't.db'));
    migrateM1(db);
    recordArtifact(db, { bundleId: 'b', artifactPath: '/x.app' });
    migrateM1(db); // re-run on existing DB
    expect(lastArtifactFor(db, 'b')!.artifactPath).toBe('/x.app');
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
