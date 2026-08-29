/** Entry: build + listen + graceful shutdown (SIGTERM/SIGINT → drain → close). */
import { buildApp } from './index.ts';
import { VERSION } from './routes/health.ts';

const app = await buildApp();

try {
  await app.app.listen({ port: app.cfg.port, host: app.cfg.host });
  app.bus.emit('app.ready', { version: VERSION });
} catch (err) {
  app.app.log.error(err, 'listen failed');
  await app.close();
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.app.log.info({ signal }, 'shutting down');
  await app.close(); // Fastify close drains in-flight requests
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
