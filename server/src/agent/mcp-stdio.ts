#!/usr/bin/env node
/** lionidas-mcp — stdio MCP wrapper (breakdown steps_006 §6b F2 fallback).
 *  Hermes (and any stdio MCP client) mounts THIS instead of the HTTP /mcp
 *  endpoint when the client cannot send Authorization headers. The wrapper
 *  authenticates IN-PROCESS: it loads the same registry against the same
 *  crucible.db, resolving the operator from LIONIDAS_PAT (a drill PAT minted
 *  via the tokens panel) — no network, no HTTP auth needed at all.
 *
 *  Hermes config (~/.hermes/config.yaml):
 *    mcp_servers:
 *      lionidas:
 *        command: /bin/bash
 *        args: [ <repo>/server/src/agent/mcp-stdio.sh ]
 *        enabled: true
 *  The shell script cds into server/ and execs this file with tsx. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb } from '../db/client.ts';
import { migrateM1 } from '../db/schema.ts';
import { hashToken } from '../routes/auth-cli.ts';
import { buildAgentContext } from './context.ts';

const dbPath = process.env['CRUCIBLE_DB_PATH'] ?? './crucible.db';
const artifactsDir = process.env['CRUCIBLE_ARTIFACTS_DIR'] ?? './artifacts';

// ── resolve the operator from LIONIDAS_PAT (in-process, mirrors roles.ts) ──
const pat = process.env['LIONIDAS_PAT'] ?? '';
if (!pat.startsWith('lion_')) {
  console.error('lionidas-mcp: LIONIDAS_PAT must be set to a lion_… token (mint one in Users → api tokens)');
  process.exit(2);
}
const db = openDb(dbPath);
migrateM1(db.raw);
{
  // verify the PAT against api_tokens (same join as resolvePat) and refuse non-operator
  const { randomBytes, scryptSync, timingSafeEqual } = await import('node:crypto');
  const verify = (plain: string, stored: string): boolean => {
    const [saltHex, dkHex] = stored.split(':');
    if (!saltHex || !dkHex) return false;
    const dk = scryptSync(plain, Buffer.from(saltHex, 'hex'), 32);
    return timingSafeEqual(dk, Buffer.from(dkHex, 'hex'));
  };
  void hashToken; // parity import (verify implemented locally to avoid minting)
  const rows = db.raw.prepare('SELECT t.id, t.token_hash, u.role FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.revoked_at IS NULL AND u.active = 1').all() as Array<{ id: string; token_hash: string; role: string }>;
  const hit = rows.find((r) => verify(pat, r.token_hash));
  if (!hit) {
    console.error('lionidas-mcp: LIONIDAS_PAT is unknown or revoked');
    process.exit(2);
  }
  if (hit.role !== 'operator' && hit.role !== 'admin') {
    console.error(`lionidas-mcp: PAT role is ${hit.role}; operator required`);
    process.exit(2);
  }
}

const ctx = await buildAgentContext(db.raw, { dbPath, artifactsDir, env: process.env as Record<string, string | undefined> });
// Seeding runs in the BACKGROUND — tools/list must answer immediately;
// sources.search returns its honest "no documents" until seeding lands.
void ctx.seedPromise;

const server = new McpServer({ name: 'lionidas-agent', version: '0.1.0' });
for (const tool of ctx.registry.providerTools(ctx.policy)) {
    // REAL per-tool schema (not an args envelope) — models must see the actual
  // parameter names (idOrName, runId…) or they guess and the tools misfire.
  // Minimal JSON-Schema→zod for the subset the registry uses
  // (object/string/number/enum + required). description lives on the tool.
  const inputSchema = schemaToZod(tool.function.parameters);
  server.registerTool(
    tool.function.name,
    { description: tool.function.description ?? '', inputSchema },
    async (input: Record<string, unknown>) => {
      const out = await ctx.registry.execute(tool.function.name, input ?? {}, { sessionId: 'mcp-stdio', signal: undefined }, ctx.policy);
      return { content: [{ type: 'text' as const, text: out }] };
    },
  );
}

/** minimal JSON-Schema subset → zod (object properties: string/number/enum) */
function schemaToZod(schema: Record<string, unknown>): z.ZodType<Record<string, unknown>> {
  const props = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema['required'] as string[] | undefined) ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, p] of Object.entries(props)) {
    let field: z.ZodTypeAny;
    if (Array.isArray(p['enum'])) field = z.enum(p['enum'] as [string, ...string[]]);
    else if (p['type'] === 'number') field = z.number();
    else field = z.string();
    if (!required.has(name)) field = field.optional();
    shape[name] = field;
  }
  return z.object(shape) as unknown as z.ZodType<Record<string, unknown>>;
}

await server.connect(new StdioServerTransport());
console.error(`lionidas-mcp: serving ${ctx.registry.providerTools(ctx.policy).length} tools (v1 policy: read+draft) on stdio`);
