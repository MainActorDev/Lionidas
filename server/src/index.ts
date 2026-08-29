/** App factory — tests use the instance; only main.ts listens (M0 invariant). */
import Fastify, { type FastifyInstance } from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { loadConfig, type Config } from './config.ts';
import { openDb, type Db } from './db/client.ts';
import { migrateM1 } from './db/schema.ts';
import { createEventBus, type TypedEventBus, type AppEvents } from './ws/bus.ts';
import { registerHealthRoute } from './routes/health.ts';
import { registerDeviceRoutes } from './routes/devices.ts';
import { registerRunRoutes } from './routes/runs.ts';
import { registerMatrixRoute } from './routes/matrix.ts';
import { registerEvidenceRoute } from './routes/evidence.ts';
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
  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });
  const bus = createEventBus<AppEvents>();
  const db = openDb(cfg.dbPath);
  migrateM1(db.raw);

  registerHealthRoute(app);
  registerDeviceRoutes(app, db.raw);
  registerRunRoutes(app, db.raw);
  registerMatrixRoute(app, db.raw);
  registerEvidenceRoute(app, db.raw);

  app.addHook('onRequest', async (req) => {
    req.id = crypto.randomUUID();
  });

  const forgeState = createForgeState();
  registerForgeRoutes(app, db.raw, forgeState);

  let stopPoller: (() => void) | null = null;
  let stopDispatcher: (() => void) | null = null;
  if (process.env['VITEST'] !== 'true') {
    // Poller + dispatcher need a live Alloy; lazy-start so health fails soft.
    import('./alloy/runtime.ts')
      .then(async ({ initAlloyRuntime }) => {
        const rt = await initAlloyRuntime(); // may throw — logged, routes still serve
        stopPoller = startDevicePoller(db.raw, bus);
        stopDispatcher = startDispatcher({ db: db.raw, bus, artifactsDir: cfg.artifactsDir, dispatchDeps: rt.deps });
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
      await app.close();
      db.close();
    },
  };
}
