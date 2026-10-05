/** App factory — tests use the instance; only main.ts listens (M0 invariant). */
import Fastify, { type FastifyInstance } from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { loadConfig, type Config } from './config.ts';
import { openDb, type Db } from './db/client.ts';
import { migrateM1 } from './db/schema.ts';
import { startBackupLoop } from './db/backup.ts';
import { join } from 'node:path';
import { createEventBus, type TypedEventBus, type AppEvents } from './ws/bus.ts';
import { registerHealthRoute } from './routes/health.ts';
import { registerDeviceRoutes } from './routes/devices.ts';
import { registerAppScreenRoutes } from './routes/app-screens.ts';
import { registerEnvVarRoutes } from './routes/env-vars.ts';
import { registerRunRoutes } from './routes/runs.ts';
import { registerMatrixRoute } from './routes/matrix.ts';
import { registerEvidenceRoute } from './routes/evidence.ts';
// registerMonitoringRoutes hidden with the monitoring page (design cleanup
// 2026-10-05): routes/monitoring.ts + tests stay in the tree — restoring is
// re-registering this line + the web route/nav/page (git history has both).
import { registerAuthRoutes } from './routes/auth.ts';
import { registerUserResolution } from './auth/roles.ts';
import { seedUsers } from './auth/users.ts';
import { registerManualRoutes } from './routes/manual.ts';
import { stopMitmIfRunning } from './forge/mitm/manager.ts';
import { healStaleProxies } from './forge/sim-routing.ts';
import { registerTemplateRoutes } from './routes/templates.ts';
import { registerFolderRoutes } from './routes/folders.ts';
import { registerScenarioFolderRoutes } from './routes/scenario-folders.ts';
import { registerPresetFolderRoutes } from './routes/preset-folders.ts';
import { registerSuiteRoutes } from './routes/suites.ts';
import { registerOverviewRoutes } from './routes/overview.ts';
import { registerEventsWs } from './routes/events-ws.ts';
import { startGcLoop } from './gc/retention.ts';
import { bootReconcile } from './alloy/reconcile.ts';
import { startIdleWatchdog } from './manual/session.ts';
import * as runtimeMod from './alloy/runtime.ts';
import { startDevicePoller } from './poll/devices.ts';
import { startDispatcher } from './queue/dispatcher.ts';
import { createForgeState, type ForgeState } from './forge/proxy.ts';
import { forgeStateService } from './forge/state.ts';
import { registerForgeRoutes } from './forge/routes.ts';
import { buildAgentContext } from './agent/context.ts';
import { registerAgentRoutes } from './agent/routes.ts';

export interface App {
  app: FastifyInstance<import('node:http').Server<typeof import('node:http').IncomingMessage, typeof import('node:http').ServerResponse>, import('node:http').IncomingMessage, import('node:http').ServerResponse<import('node:http').IncomingMessage>, FastifyBaseLogger>;
  bus: TypedEventBus<AppEvents>;
  db: Db;
  cfg: Config;
  forgeState: ForgeState;
  agent: ReturnType<typeof buildAgentContext>;
  close(): Promise<void>;
}

export async function buildApp(env: NodeJS.ProcessEnv = process.env): Promise<App> {
  const cfg = loadConfig(env);
  const logger = pino({
    level: process.env['VITEST'] === 'true' || process.env['CRUCIBLE_SILENT'] === '1' ? 'silent' : cfg.logLevel,
  });
  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger, bodyLimit: 8 * 1024 * 1024 });
  const bus = createEventBus<AppEvents>();
  const db = openDb(cfg.dbPath);
  migrateM1(db.raw);

  registerHealthRoute(app);
  registerDeviceRoutes(app, db.raw);
  registerAppScreenRoutes(app, db.raw);
  registerEnvVarRoutes(app, db.raw);
  registerRunRoutes(app, db.raw, bus);
  registerMatrixRoute(app, db.raw);
  registerEvidenceRoute(app, db.raw);
  await registerEventsWs(app, bus);

  app.addHook('onRequest', async (req) => {
    req.id = crypto.randomUUID();
  });

  seedUsers(db.raw, process.env['CRUCIBLE_PIN'] || null);
  registerUserResolution(app, db.raw);
  const { registerAuthCliRoutes } = await import('./routes/auth-cli.ts');
  registerAuthCliRoutes(app, db.raw);
  registerAuthRoutes(app, db.raw);

  // Hard read gate: with CRUCIBLE_REQUIRE_AUTH (default ON), every route except
  // the auth surface and health requires a session. Set CRUCIBLE_REQUIRE_AUTH=0
  // to return to the open-read transition mode.
  if ((env['CRUCIBLE_REQUIRE_AUTH'] ?? '1') === '1') { // env param wins (buildApp contract)
    app.addHook('onRequest', async (req, reply) => {
      const open = req.url.startsWith('/api/auth') || req.url.startsWith('/api/health') || req.url === '/'
        || (!req.url.startsWith('/api/') && !req.url.startsWith('/simdeck/')); // simdeck = authed device surface
      if (open || req.user) return;
      await reply.code(401).send({ error: 'sign in required' });
    });
  }

  const forgeState = createForgeState();
  registerForgeRoutes(app, db.raw, forgeState, bus);
  registerManualRoutes(app, db.raw, {
    bus,
    artifactsDir: cfg.artifactsDir,
    forgeState,
    get dispatchDeps() { return runtimeMod.alloyDispatchDepsSync(); },
  } as never);
  registerTemplateRoutes(app, db.raw);
  const agent = buildAgentContext(db.raw, {
    dbPath: cfg.dbPath, artifactsDir: cfg.artifactsDir, env,
    // F2: preset tool-writes sync the live forge proxy (same call the routes make)
    syncPresets: () => forgeStateService({ db: db.raw, forgeState }).sync(),
  });
  registerAgentRoutes(app, agent, bus);
  registerFolderRoutes(app, db.raw);
  registerScenarioFolderRoutes(app, db.raw);
  registerPresetFolderRoutes(app, db.raw);
  registerSuiteRoutes(app, db.raw);
  registerOverviewRoutes(app, db.raw); // clock injectable; default Date.now
  app.decorate('crucibleBus', bus);

  // stream relay needs sharp (native module) — register only in production,
  // not under vitest (its native binding hangs the test runner)
  if (process.env['VITEST'] !== 'true') {
    const { registerSimdeckHolds } = await import('./simdeck/holds.ts');
    await registerSimdeckHolds(app, bus);
    // simdeck gated proxy (wrapped device surface): authed proxy with the
    // drive/watch mode gate. isDriving = live manual session row for the udid;
    // session finish demotes, run start detaches (see simdeck/proxy.ts).
    const { registerSimdeckProxy } = await import('./simdeck/proxy.ts');
    const { ensureSimdeck } = await import('./simdeck/supervisor.ts');
    const drivingUdids = new Set<string>();
    bus.on('manual.session.open', ((p: { udid?: string }) => {
      if (p?.udid) drivingUdids.add(p.udid);
    }) as never);
    registerSimdeckProxy(app, {
      base: () => {
        // supervisor spawn is lazy-failed-soft: a down child surfaces as the
        // proxy's own 502, not a boot-time crash
        void ensureSimdeck().catch(() => undefined);
        const port = Number(process.env['CRUCIBLE_SIMDECK_PORT'] ?? 8422);
        return `http://127.0.0.1:${port}`;
      },
      // The WS leg MUST NOT dial upstream while the child is still spawning —
      // ECONNREFUSED kills the leg in milliseconds and the client reconnect
      // loop (1.5s) races the spawn forever. Await readiness, THEN dial.
      baseReady: () => ensureSimdeck().then(() => {
        const port = Number(process.env['CRUCIBLE_SIMDECK_PORT'] ?? 8422);
        return `http://127.0.0.1:${port}`;
      }),
      isDriving: (udid) => drivingUdids.has(udid),
      onSessionEvent: (cb) => {
        const offFinish = bus.on('manual.session.finish', ((p: { udid?: string }) => {
          const u = p?.udid ?? '';
          if (u) drivingUdids.delete(u);
          if (u) cb({ udid: u, kind: 'finished' });
        }) as never);
        const offRun = bus.on('run.started', ((p: { udid?: string }) => {
          if (p?.udid) cb({ udid: p.udid, kind: 'run-start' });
        }) as never);
        return () => { offFinish(); offRun(); };
      },
    });
  }

  let stopPoller: (() => void) | null = null;
  let stopDispatcher: (() => void) | null = null;
  let stopWatchdog: (() => void) | null = null;
  let stopGc: (() => void) | null = null;
  let stopBackup: (() => void) | null = null;
  if (process.env['VITEST'] !== 'true') {
    // Poller + dispatcher need a live Alloy; lazy-start so health fails soft.
    import('./alloy/runtime.ts')
      .then(async ({ initAlloyRuntime }) => {
        stopGc = startGcLoop(db.raw, cfg.artifactsDir);
        stopBackup = startBackupLoop(db.raw, join(cfg.artifactsDir, '..', 'db-backups'));
        const rt = await initAlloyRuntime(); // may throw — logged, routes still serve
        // crash recovery BEFORE serving traffic: clear orphaned claims/sessions/queue
        try {
          const rec = await bootReconcile(db.raw, bus, rt.deps);
          if (rec.queueAborted > 0 || rec.sessionsClosed > 0) {
            app.log.warn(rec, 'boot reconciliation cleaned stale state');
          }
        } catch (err) { app.log.warn({ err }, 'boot reconciliation skipped (alloy unavailable)'); }
        stopPoller = startDevicePoller(db.raw, bus);
        stopDispatcher = startDispatcher({ db: db.raw, bus, artifactsDir: cfg.artifactsDir, dispatchDeps: rt.deps });
        stopWatchdog = startIdleWatchdog({ db: db.raw, bus, dispatchDeps: rt.deps });
      })
      .catch((err: unknown) => {
        app.log.warn({ err }, 'alloy runtime unavailable — device wall degraded (alloy_health for details)');
      });
  }

  return {
    app,
    agent,
    bus,
    db,
    cfg,
    forgeState,
    close: async () => {
      stopPoller?.();
      stopDispatcher?.();
      stopWatchdog?.();
      stopGc?.();
      stopBackup?.();
      // Graceful shutdown must restore the host's internet: stop MITM first
      // (kills the proxy listener), then clear the OS proxy setting — otherwise
      // macOS keeps funneling traffic into a dead port across restarts.
      try { await stopMitmIfRunning(); } catch { /* already dead */ }
      try {
        // all-service heal (not just the default-route service): if the
        // default route MOVED between enable and close (Wi-Fi↔Ethernet, VPN),
        // the old single-service disable cleared the wrong one and left the
        // internet broken. The watchdog covers anything this misses.
        const healed = healStaleProxies();
        if (healed.length > 0) app.log.warn({ healed }, 'cleared stale proxies on close');
      } catch { /* networksetup unavailable — watchdog will */ }
      await app.close();
      db.close();
    },
  };
}
