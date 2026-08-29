import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

export function registerDeviceRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/devices', async () => {
    const rows = db.prepare('SELECT udid, name, state, lease_holder, lease_engine, last_seen FROM devices ORDER BY name').all();
    return { devices: rows };
  });
}
