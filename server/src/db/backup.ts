/** Daily DB backup — snapshot-safe under WAL via better-sqlite3's backup API.
 *  Keeps the last N backups, prunes older ones. Returns a stop function. */
import type Database from 'better-sqlite3';
import { mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const KEEP = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function backupPath(dir: string): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return join(dir, `crucible-${stamp}.db`);
}

export async function backupDb(db: Database.Database, dir: string): Promise<string | null> {
  try {
    mkdirSync(dir, { recursive: true });
    const dest = backupPath(dir);
    if (existsSync(dest)) return dest; // already backed up today
    await db.backup(dest);
    // prune: keep the newest KEEP files
    const files = readdirSync(dir).filter((f) => /^crucible-\d{8}\.db$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
      try { unlinkSync(join(dir, f)); } catch { /* best-effort */ }
    }
    return dest;
  } catch {
    return null; // backup is best-effort — never blocks the server
  }
}

export function startBackupLoop(db: Database.Database, dir: string): () => void {
  void backupDb(db, dir); // one immediately on boot
  const timer = setInterval(() => { void backupDb(db, dir); }, DAY_MS);
  return () => clearInterval(timer);
}
