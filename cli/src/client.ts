/** The ONE http client (plan architecture: the only code that talks to the
 *  server). Structured errors, --json discipline, id|name resolution. */
import { authHeaders, readConfig, resolveBaseUrl } from './config.ts';

export class CliError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number, readonly hint?: string) {
    super(message);
  }
}

export interface ClientOpts { json?: boolean }

export function makeClient(explicitUrl?: string): Client {
  return new Client(resolveBaseUrl(explicitUrl));
}

export class Client {
  constructor(private readonly baseUrl: string) {}

  get url(): string { return this.baseUrl; }

  async request<T>(method: string, path: string, body?: unknown, opts?: { raw?: boolean; timeoutMs?: number }): Promise<T> {
    const cfg = readConfig();
    const headers: Record<string, string> = { ...authHeaders(cfg) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(`cannot reach Lionidas at ${this.baseUrl} (${msg}) — is the stack up? try: lionidas stack up`, 'STACK_DOWN');
    }
    if (opts?.raw) return res as unknown as T;
    if (!res.ok) {
      let detail = '';
      let hint: string | undefined;
      try {
        const j = (await res.json()) as { error?: string; errors?: Array<{ message?: string } | string>; code?: string };
        detail = j.error ?? (j.errors ?? []).map((e) => (typeof e === 'string' ? e : e.message ?? '')).filter(Boolean).join(' · ');
        if (j.code === 'DEVICE_BUSY') hint = 'wait or abort the active run/session';
      } catch { detail = await res.text().catch(() => ''); }
      if (res.status === 401) hint = 'credentials rejected — lionidas auth login';
      throw new CliError(detail || `request failed (${res.status})`, res.status === 401 ? 'UNAUTHORIZED' : 'HTTP_' + res.status, res.status, hint);
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return await res.json() as T;
    return await res.text() as unknown as T;
  }

  get<T>(path: string): Promise<T> { return this.request<T>('GET', path); }
  post<T>(path: string, body?: unknown): Promise<T> { return this.request<T>('POST', path, body); }
  put<T>(path: string, body?: unknown): Promise<T> { return this.request<T>('PUT', path, body); }
  del<T>(path: string): Promise<T> { return this.request<T>('DELETE', path); }

  /** id|name resolution: exact id hit first, then unique name match. */
  async resolveCase(idOrName: string): Promise<string> {
    const byId = await this.get<{ id?: string }>(`/api/templates/${encodeURIComponent(idOrName)}`).catch(() => undefined);
    if (byId?.id) return byId.id;
    const list = await this.get<{ templates?: Array<{ id: string; name: string }> }>('/api/templates?limit=500');
    const hits = (list.templates ?? []).filter((t) => t.name === idOrName);
    if (hits.length === 1) return hits[0]!.id;
    if (hits.length > 1) throw new CliError(`multiple cases named "${idOrName}" — use an id: ${hits.map((h) => h.id).join(', ')}`, 'AMBIGUOUS');
    throw new CliError(`no case "${idOrName}"`, 'NOT_FOUND', 404);
  }
}
