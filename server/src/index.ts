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
import { registerRunRoutes } from './routes/runs.ts';
import { registerMatrixRoute } from './routes/matrix.ts';
import { registerEvidenceRoute } from './routes/evidence.ts';
import { registerBaselineRoutes } from './routes/baselines.ts';
import { registerMonitoringRoutes } from './routes/monitoring.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerUserResolution } from './auth/roles.ts';
import { seedUsers } from './auth/users.ts';
import { registerManualRoutes } from './routes/manual.ts';
import { stopMitmIfRunning } from './forge/mitm/manager.ts';
import { healStaleProxies } from './forge/sim-routing.ts';
import { registerTemplateRoutes } from './routes/templates.ts';
import { registerFlakeRoutes } from './routes/flakes.ts';
import { registerEventsWs } from './routes/events-ws.ts';
import { registerAuthStatus } from './auth/gate.ts';
import { startGcLoop } from './gc/retention.ts';
import { bootReconcile } from './alloy/reconcile.ts';
import { startIdleWatchdog } from './manual/session.ts';
import * as runtimeMod from './alloy/runtime.ts';
import { startDevicePoller } from './poll/devices.ts';
import { startDispatcher } from './queue/dispatcher.ts';
import { createForgeState, type ForgeState } from './forge/proxy.ts';
import { registerForgeRoutes } from './forge/routes.ts';

export interface App {
  app: FastifyInstance<import('node:http').Server<typeof import('node:http').IncomingMessage, typeof import('node:http').ServerResponse>, import('node:http').IncomingMessage, import('node:http').ServerResponse<import('node:http').IncomingMessage>, FastifyBaseLogger>;
  bus: TypedEventBus<AppEvents>;
  db: Db;
  cfg: Config;
  forgeState: ForgeState;
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
  registerRunRoutes(app, db.raw, bus);
  registerMatrixRoute(app, db.raw);
  registerEvidenceRoute(app, db.raw);
  await registerEventsWs(app, bus);

  registerAuthStatus(app);

  app.addHook('onRequest', async (req) => {
    req.id = crypto.randomUUID();
  });

  seedUsers(db.raw, process.env['CRUCIBLE_PIN'] || null);
  registerUserResolution(app, db.raw);
  registerAuthRoutes(app, db.raw);

  const forgeState = createForgeState();
  registerForgeRoutes(app, db.raw, forgeState, bus);
  registerMonitoringRoutes(app, db.raw);
  // baselines: dispatchDeps resolved lazily (approvals always run post-boot)
  registerBaselineRoutes(app, db.raw, {
    db: db.raw,
    bus,
    artifactsDir: cfg.artifactsDir,
    get dispatchDeps() { return runtimeMod.alloyDispatchDepsSync(); },
  } as never);
  registerManualRoutes(app, db.raw, {
    bus,
    artifactsDir: cfg.artifactsDir,
    forgeState,
    get dispatchDeps() { return runtimeMod.alloyDispatchDepsSync(); },
  } as never);
  registerTemplateRoutes(app, db.raw);
  registerFlakeRoutes(app, db.raw, bus);
  app.decorate('crucibleBus', bus);

  // stream relay needs sharp (native module) — register only in production,
  // not under vitest (its native binding hangs the test runner)
  if (process.env['VITEST'] !== 'true') {
    const { registerStreamRelay } = await import('./routes/stream-relay.ts');
    await registerStreamRelay(app, bus);
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
