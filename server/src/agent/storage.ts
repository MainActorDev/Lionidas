/** Butler storage on the Lionidas sqlite (breakdown steps_002 §2a).
 *  Consumer owns the DB: butler_* tables live in the same file, guarded +
 *  idempotent migrations; WAL permits the second (butler-side) handle.
 *  The double-open idempotency test is the F3 canary (review). */
import { SqliteStorage } from '@mainactordev/butler';

export function agentStorage(dbPath: string): SqliteStorage {
  return new SqliteStorage(dbPath);
}
