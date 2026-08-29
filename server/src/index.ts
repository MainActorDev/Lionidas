/** App factory — tests use the instance; only main.ts listens (M0 invariant). */
import Fastify, { type FastifyInstance } from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { loadConfig, type Config } from './config.ts';
import { openDb, type Db } from './db/client.ts';
import { createEventBus, type TypedEventBus, type AppEvents } from './ws/bus.ts';
import { registerHealthRoute } from './routes/health.ts';

export interface App {
  app: FastifyInstance<import('node:http').Server<typeof import('node:http').IncomingMessage, typeof import('node:http').ServerResponse>, import('node:http').IncomingMessage, import('node:http').ServerResponse<import('node:http').IncomingMessage>, FastifyBaseLogger>;
  bus: TypedEventBus<AppEvents>;
  db: Db;
  cfg: Config;
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

  registerHealthRoute(app);

  app.addHook('onRequest', async (req) => {
    req.id = crypto.randomUUID();
  });

  return {
    app,
    bus,
    db,
    cfg,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}
