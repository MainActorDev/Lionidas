/** Agent transports (breakdown steps_004): conversation API + MCP + bus bridge. */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

export interface AgentRouteDeps {
  storage: unknown;
  retriever: unknown;
  registry: unknown;
  bus: unknown;
  artifactsDir: string;
}

export function registerAgentRoutes(_app: FastifyInstance, _db: Database.Database, _deps: AgentRouteDeps): void {
  throw new Error('steps_004: mounts land here');
}
