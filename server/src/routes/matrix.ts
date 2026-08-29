import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { deriveTicketMatrix } from '../domain/status.ts';

export function registerMatrixRoute(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/tickets/:key/matrix', async (req) => {
    const { key } = req.params as { key: string };
    const { acs, ticketStatus } = deriveTicketMatrix(db, key);
    return { ticket: key, status: ticketStatus, acs };
  });
}
