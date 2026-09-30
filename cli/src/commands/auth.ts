/** auth login|status|logout — interim cookie auth (phase 0; PAT lands in
 *  phase 1 per plan decision 7). Credentials never appear in output. */
import cac from 'cac';
import type { CAC } from 'cac';
import { sub } from '../cmd.ts';
import { Client, CliError } from '../client.ts';
import { readConfig, writeConfig, configPath, DEFAULT_URL } from '../config.ts';
import { print, line } from '../output.ts';

function client(): Client {
  return new Client(process.env['LIONIDAS_URL'] ?? readConfig()?.baseUrl ?? DEFAULT_URL);
}

export function authCommand(cli: CAC): void {
  const auth = sub(cli, 'auth <action>', 'credentials');
  auth.option('--email <email>', 'login email');
  auth.option('--password <password>', 'login password (interim cookie auth)');
  auth.option('--token <token>', 'paste a lion_… personal access token (CI)');
  auth.action(async (action: string, opts: { email?: string; password?: string; token?: string }) => {
    if (action === 'login') {
      // paste flow: --token <lion_…> (CI) — store + verify
      if (opts.token) {
        const cfg0 = readConfig() ?? { baseUrl: DEFAULT_URL };
        writeConfig({ ...cfg0, token: opts.token });
        const me0 = await client().get<{ user?: { name?: string; role?: string } }>('/api/auth/me').catch(() => null);
        if (!me0?.user) {
          const cfg1 = readConfig() ?? { baseUrl: DEFAULT_URL };
          writeConfig({ ...cfg1 }); // drop the bad token
          throw new CliError('token rejected by the server', 'AUTH_FAILED');
        }
        print({ ok: true, user: me0.user, kind: 'pat', config: configPath() }, () => {
          line(`authenticated as ${me0.user?.name} (${me0.user?.role}) via pasted token — stored at ${configPath()}`);
        });
        return;
      }
      // approval flow (default): the web session mints the PAT — one click
      if (!opts.email && !opts.password) {
        const start = await client().post<{ code: string; url: string; expires_in_ms: number }>('/api/auth/cli/start');
        line(`open  ${client().url}${start.url}`);
        line(`code  ${start.code}  (approving as whoever is logged in on the web)`);
        const deadline = Date.now() + Math.min(start.expires_in_ms, 5 * 60_000);
        while (Date.now() < deadline) {
          await new Promise((res) => setTimeout(res, 2500));
          const ex = await client().post<{ token?: string; error?: string }>('/api/auth/cli/exchange', { code: start.code }).catch((e: { status?: number }) => e);
          if (ex && typeof ex === 'object' && 'token' in ex && ex.token) {
            const cfg = readConfig() ?? { baseUrl: DEFAULT_URL };
            writeConfig({ ...cfg, token: ex.token });
            const me = await client().get<{ user?: { name?: string; role?: string } }>('/api/auth/me').catch(() => null);
            print({ ok: true, user: me?.user ?? null, kind: 'pat', config: configPath() }, () => {
              line(`authenticated as ${me?.user?.name ?? '?'} (${me?.user?.role ?? '?'}) via PAT — stored at ${configPath()}`);
            });
            return;
          }
        }
        throw new CliError('approval timed out — run lionidas auth login again', 'AUTH_TIMEOUT');
      }
      // interim: email/password cookie auth (phase 0 path)
      const email = opts.email ?? process.env['LIONIDAS_EMAIL'];
      let password = opts.password ?? process.env['LIONIDAS_PASSWORD'];
      if (!email || !password) {
        throw new CliError('auth login needs --email and --password (or LIONIDAS_EMAIL/LIONIDAS_PASSWORD env)', 'AUTH_ARGS');
      }
      const res = (await client().request<Response>('POST', '/api/auth/login', { email, password }, { raw: true })) as unknown as Response;
      const setCookie = res.headers.get('set-cookie') ?? '';
      const m = /crucible_session=([a-f0-9]{64})/.exec(setCookie);
      if (!m?.[1]) throw new CliError('login rejected — check credentials', 'AUTH_FAILED', res.status);
      const cfg = readConfig() ?? { baseUrl: DEFAULT_URL };
      writeConfig({ ...cfg, sessionCookie: m[1], sessionExpiresAt: Date.now() + 12 * 60 * 60 * 1000, email });
      const body = await res.json().catch(() => ({})) as { user?: { name?: string; role?: string } };
      print({ ok: true, user: body.user ?? null, config: configPath() }, () => {
        line(`logged in as ${body.user?.name ?? email} (${body.user?.role ?? 'role?'}) — stored at ${configPath()}`);
      });
      return;
    }
    if (action === 'status') {
      const cfg = readConfig();
      const kind = process.env['LIONIDAS_TOKEN'] ? 'env-token' : cfg?.token ? 'pat' : cfg?.sessionCookie ? 'session-cookie' : 'none';
      if (kind === 'none' && !cfg) { print({ authenticated: false, config: null }, () => line('not logged in — lionidas auth login')); return; }
      let me: { name?: string; role?: string } | null = null;
      try { me = (await client().get<{ user?: { name?: string; role?: string } }>('/api/auth/me')).user ?? null; } catch { me = null; }
      const base = process.env['LIONIDAS_URL'] ?? cfg?.baseUrl ?? DEFAULT_URL;
      print({ authenticated: !!me, kind, email: cfg?.email ?? null, user: me, baseUrl: base, config: cfg ? configPath() : null }, () => {
        if (me) line(`authenticated as ${me.name} (${me.role}) via ${kind} → ${base}`);
        else line(`stored ${kind} is NOT valid against ${base} — lionidas auth login`);
      });
      return;
    }
    if (action === 'logout') {
      const cfg = readConfig();
      if (cfg?.sessionCookie) await client().post('/api/auth/logout').catch(() => undefined);
      if (cfg) writeConfig({ baseUrl: cfg.baseUrl });
      print({ ok: true }, () => line('logged out (local credentials cleared)'));
      return;
    }
    throw new CliError(`unknown auth action "${action}" (login | status | logout)`, 'USAGE');
  });
}
