/** G8: network-failure AC via Forge sequence — a client app hitting the proxy
 *  observes 200→500→500 and its retry path is visible in traffic rows.
 *  G9: MITM spike (3h box): determine feasibility signals, record GO/NO-GO. */
process.env['CRUCIBLE_DB_PATH'] = '/tmp/crucible-gate/m3b.db';
process.env['CRUCIBLE_ARTIFACTS_DIR'] = '/tmp/crucible-gate/artifacts';
process.env['VITEST'] = 'true';

const { buildApp } = await import('../src/index.ts');
const app = await buildApp();
const results: Array<[string, boolean, string]> = [];
const check = (n: string, ok: boolean, info = '') => { results.push([n, ok, info]); console.log(`${ok ? '✓' : '✗'} ${n}${info ? ' — ' + info : ''}`); };

// ── G8: sequence preset on the shared forge state; "app" = fetch loop with retry ──
{
  const { startForgeProxy } = await import('../src/forge/proxy.ts');
  const seq = (await app.app.inject({
    method: 'POST', url: '/api/forge/presets',
    payload: { pathPattern: '/v1/checkout', match: 'exact', status: 200, seq: [{ status: 200 }, { status: 500 }], createdBy: 'g8' },
  })).json() as { id: string };
  const sc = (await app.app.inject({
    method: 'POST', url: '/api/forge/scenarios',
    payload: { name: 'g8-netfail', presetIds: [seq.id], createdBy: 'g8' },
  })).json() as { id: string };
  await app.app.inject({ method: 'POST', url: `/api/forge/scenarios/${sc.id}/activate` });
  await app.app.inject({ method: 'POST', url: '/api/forge/mode', payload: { mode: 'intercept' } });

  const proxy = await startForgeProxy({ db: app.db.raw, bus: app.bus, artifactsDir: app.cfg.artifactsDir }, app.forgeState);
  // "app" model: two logical checkout attempts; each retries up to 3x on 5xx
  const observed: number[] = [];
  for (let logical = 0; logical < 2; logical++) {
    let status = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`http://127.0.0.1:${proxy.port}/v1/checkout`);
      status = r.status;
      observed.push(status);
      if (status < 500) break; // success path stops retrying
    }
  }
  await proxy.close();

  const traffic = app.db.raw.prepare(`SELECT status FROM traffic WHERE path = '/v1/checkout' ORDER BY ts`).all() as Array<{ status: number }>;
  check('G8 sequence observed 200→500 + retry visible in traffic',
    observed.length >= 2 && observed[0] === 200 && observed.slice(1).every((s) => s === 500) && traffic.length >= 2,
    `client saw ${observed.join(',')} | traffic rows ${traffic.map((t) => t.status).join(',')}`);
}

// ── G9: MITM spike (timeboxed evidence, decision recorded) ──
{
  const { execSync } = await import('node:child_process');
  const spike: string[] = [];
  // signal 1: does the platform expose a trusted-CA store for the simulator?
  try {
    execSync('ls /Library/Keychains/System.keychain', { stdio: 'pipe' });
    spike.push('system-keychain: present');
  } catch { spike.push('system-keychain: MISSING'); }
  // signal 2: does the sim trust the host keychain by default? (iOS 16+: yes for user-installed roots via simctl)
  try {
    execSync('xcrun simctl list udid 2>/dev/null | head -1', { stdio: 'pipe' });
    spike.push('simctl: available');
  } catch { spike.push('simctl: unavailable'); }
  // signal 3: is there a mitm tool on PATH already (mitmproxy/charles CLI)?
  let mitmTool = 'none';
  for (const t of ['mitmproxy', 'mitmdump', 'charles']) {
    try { execSync(`which ${t}`, { stdio: 'pipe' }); mitmTool = t; break; } catch { /* next */ }
  }
  spike.push(`mitm-tool: ${mitmTool}`);
  // signal 4: an HTTPS staging endpoint shape reachable (any TLS host)
  try {
    execSync('curl -sI --max-time 3 https://lionparcel.com > /dev/null', { stdio: 'pipe' });
    spike.push('tls-egress: ok');
  } catch { spike.push('tls-egress: blocked/timeout'); }

  console.log('G9 MITM spike evidence:', spike.join(' | '));
  // Decision rule (from M3 plan §4.3): GO requires all four positive.
  const go = spike.every((s) => !s.includes('MISSING') && !s.includes('unavailable') && !s.includes('blocked') && !s.includes('mitm-tool: none'));
  check('G9 MITM spike recorded', true, `${go ? 'GO' : 'NO-GO'} (${spike.join('; ')}) — decision: re-plan before building, nothing half-shipped`);
}

await app.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\nM3-FINAL GATE: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 2);
