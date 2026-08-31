/** Entry: build + listen + graceful shutdown (SIGTERM/SIGINT → drain → close). */
import { buildApp } from './index.ts';
import { VERSION } from './routes/health.ts';
import { healStaleProxies, defaultRouteExists } from './forge/sim-routing.ts';

const app = await buildApp();

// BOOT RECONCILIATION: a previous server instance may have died without
// clearing the OS proxy (kill -9, crash, power loss). The OLD check read only
// the DEFAULT-ROUTE service — at boot Wi-Fi may not have associated yet, so
// it silently no-oped exactly when it mattered (the "no internet every boot"
// bug). Scan ALL services instead; retry only while no default route exists
// (early boot — stale entries appear as interfaces come up; a normal dev
// restart has a route immediately and never retries).
{
  const healed = healStaleProxies();
  if (healed.length > 0) app.app.log.warn({ healed }, 'cleared stale localhost proxy — internet restored');
  if (healed.length === 0 && process.env.CRUCIBLE_SKIP_BOOT_HEAL_RETRY !== '1') {
    for (let i = 0; i < 10 && healStaleProxies().length === 0 && !defaultRouteExists(); i++) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

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
