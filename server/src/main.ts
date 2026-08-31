/** Entry: build + listen + graceful shutdown (SIGTERM/SIGINT → drain → close). */
import { buildApp } from './index.ts';
import { VERSION } from './routes/health.ts';
import { simRoutingState, disableSimRouting } from './forge/sim-routing.ts';
import { execSync } from 'node:child_process';

const app = await buildApp();

// BOOT RECONCILIATION: a previous server instance may have died without
// clearing the OS proxy (kill -9, crash). If the system proxy points at a
// localhost port with no listener, restore the host's internet before
// anything else. (Port is dynamic — probe instead of matching a number.)
{
  const st = simRoutingState();
  if (st.enabled && st.host === '127.0.0.1' && st.port && !portHasListener(st.port)) {
    try {
      disableSimRouting();
      app.app.log.warn({ port: st.port }, 'cleared stale OS proxy from a previous instance — internet restored');
    } catch { /* networksetup unavailable — user must clear manually */ }
  }
}

function portHasListener(port: number): boolean {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().length > 0;
  } catch {
    return false; // lsof exits 1 with no match — no listener
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
