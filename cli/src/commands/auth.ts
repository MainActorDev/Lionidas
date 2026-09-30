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
  auth.option('--password <password>', 'login password (prompted when omitted on a TTY)');
  auth.action(async (action: string, opts: { email?: string; password?: string }) => {
    if (action === 'login') {
      const email = opts.email ?? process.env['LIONIDAS_EMAIL'];
      let password = opts.password ?? process.env['LIONIDAS_PASSWORD'];
      if (!email || !password) {
        throw new CliError('auth login needs --email and --password (or LIONIDAS_EMAIL/LIONIDAS_PASSWORD env) until PAT lands in phase 1', 'AUTH_ARGS');
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
