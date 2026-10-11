/** rev23 F2: attachments store — sha-deduped files + manifest rows.
 *  Upload route lives in refs-routes.ts (operator-gated); this module owns
 *  storage + text extraction. Binary formats return an honest manifest line
 *  ("binary — not extracted"), never a silent empty string. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

export interface AttachmentRow {
  id: string;          // att_<sha12>
  fileName: string;
  bytes: number;
  sha256: string;
  kind: 'text' | 'binary';
  created_at: string;
}

export const ATTACHMENT_CAP_BYTES = 10 * 1024 * 1024; // 10 MB

export class AttachmentStore {
  private readonly dir: string;
  private readonly db: Database;

  private dirReady: Promise<void> | undefined;
  constructor(db: Database, artifactsDir: string) {
    this.db = db;
    this.dir = path.join(artifactsDir, 'attachments');
    // dir created lazily (ensureDir) — constructors cannot await
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_attachments (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`);
  }

  /** ensures the store dir exists before file ops (constructor cannot await) */
  private ensureDir(): Promise<void> {
    this.dirReady ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.dirReady;
  }

  /** dedupe by content hash; returns the manifest row (existing or new) */
  async save(fileName: string, buf: Buffer): Promise<AttachmentRow> {
    if (buf.byteLength > ATTACHMENT_CAP_BYTES) {
      throw new Error(`attachment too large: ${buf.byteLength} > ${ATTACHMENT_CAP_BYTES}`);
    }
    await this.ensureDir();
    const sha = createHash('sha256').update(buf).digest('hex');
    const id = `att_${sha.slice(0, 12)}`;
    const kind: AttachmentRow['kind'] = isTextName(fileName) ? 'text' : 'binary';
    const existing = this.db.prepare('SELECT * FROM agent_attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
    if (existing) return existing; // content-identical → same id
    await writeFile(path.join(this.dir, sha), buf);
    this.db.prepare('INSERT INTO agent_attachments (id, file_name, bytes, sha256, kind) VALUES (?,?,?,?,?)')
      .run(id, fileName, buf.byteLength, sha, kind);
    return { id, fileName, bytes: buf.byteLength, sha256: sha, kind, created_at: new Date().toISOString() };
  }

  get(id: string): AttachmentRow | undefined {
    return this.db.prepare('SELECT * FROM agent_attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
  }

  /** text for compile/tooling: text-kind passthrough; binary → honest manifest line */
  async readText(id: string): Promise<string | null> {
    const row = this.get(id);
    if (!row) return null;
    await this.ensureDir();
    const buf = await readFile(path.join(this.dir, row.sha256)).catch(() => null);
    if (!buf) return null;
    if (row.kind === 'text') return buf.toString('utf8');
    return `[attachment ${row.fileName}] binary ${row.bytes} bytes (sha256 ${row.sha256.slice(0, 12)}) — not extracted`;
  }
}

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.csv', '.log', '.xml', '.html', '.ts', '.js', '.py', '.swift', '.sh']);
function isTextName(name: string): boolean { return TEXT_EXT.has(path.extname(name).toLowerCase()); }
