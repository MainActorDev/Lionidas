/** Fail-fast config: actionable messages, no silent defaults for required paths. */
export interface Config {
  port: number;
  host: string; // loopback default; remote worker later (decision 9)
  dbPath: string;
  artifactsDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`config: ${name} must be an integer in 1..65535 (got "${raw}")`);
  }
  return n;
}

function enumEnv<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`config: ${name} must be one of ${allowed.join('|')} (got "${raw}")`);
  }
  return raw as T;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env['CRUCIBLE_HOST'] ?? '127.0.0.1';
  if (!/^[a-zA-Z0-9.:_-]+$/.test(host)) {
    throw new Error(`config: CRUCIBLE_HOST contains invalid characters ("${host}")`);
  }
  const dbPath = env['CRUCIBLE_DB_PATH'] ?? './crucible.db';
  const artifactsDir = env['CRUCIBLE_ARTIFACTS_DIR'] ?? './artifacts';
  if (dbPath.length === 0 || artifactsDir.length === 0) {
    throw new Error('config: CRUCIBLE_DB_PATH / CRUCIBLE_ARTIFACTS_DIR must not be empty');
  }
  return {
    port: intEnv('CRUCIBLE_PORT', 8787),
    host,
    dbPath,
    artifactsDir,
    logLevel: enumEnv('CRUCIBLE_LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
  };
}
