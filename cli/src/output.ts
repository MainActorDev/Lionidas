/** Output discipline: human tables by default, --json everywhere (plan).
 *  One choke point so every command has identical error/exit behavior. */

let jsonMode = false;

export function setJson(on: boolean): void { jsonMode = on; }
export function isJson(): boolean { return jsonMode; }

export function print(data: unknown, human?: () => void): void {
  if (jsonMode) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else human?.();
}

export function line(s: string): void { if (!jsonMode) process.stdout.write(s + '\n'); }

export function error(err: unknown): void {
  const e = err as { message?: string; code?: string; hint?: string; status?: number };
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ error: e?.message ?? String(err), code: e?.code, hint: e?.hint }) + '\n');
  } else {
    process.stderr.write(`error: ${e?.message ?? String(err)}\n`);
    if (e?.hint) process.stderr.write(`hint: ${e.hint}\n`);
  }
}
