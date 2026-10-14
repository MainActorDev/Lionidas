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
import { LIONIDAS_SYSTEM_PROMPT } from './system-prompt.ts';

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

const server = new McpServer({ name: 'lionidas-agent', version: '0.1.0' }, { instructions: LIONIDAS_SYSTEM_PROMPT });
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
      // error fidelity (sess_e2e40228 lesson): an INVALID: verdict is the TOOL
      // speaking — actionable, reshape-and-retry. Anything else throwing here
      // is protocol-level; the SDK wraps it as -32602 and the model must NOT
      // burn context retrying payload shapes against it.
      return { content: [{ type: 'text' as const, text: out }] };
    },
  );
}

/** JSON-Schema → zod for the subset the registry uses: string/number/boolean/
 *  enum, arrays (of any supported item), and nested objects (recursive).
 *
 *  THE sess_e2e40228 BUG: this used to coerce every non-enum/number param to
 *  z.string() — array/object/boolean args (screens lists, suite members, seq
 *  rules, templateIds) died at the MCP boundary with -32602 "expected string,
 *  received array" BEFORE the tool ran. The model then burned 298k tokens
 *  retrying payload shapes against a protocol wall. Unknown shapes now fall
 *  back to z.any() — a wrong-but-typed value reaches the tool's own verbatim
 *  validation, which returns an actionable INVALID instead of a protocol kill. */
function propToZod(p: Record<string, unknown>): z.ZodTypeAny {
  if (Array.isArray(p['enum'])) return z.enum(p['enum'] as [string, ...string[]]);
  const t = p['type'];
  if (t === 'string') return z.string();
  if (t === 'number') return z.number();
  if (t === 'boolean') return z.boolean();
  if (t === 'array') {
    const items = p['items'] as Record<string, unknown> | undefined;
    return items ? z.array(propToZod(items)) : z.array(z.any());
  }
  if (t === 'object') {
    const props = (p['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    const req = new Set((p['required'] as string[] | undefined) ?? []);
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [name, sub] of Object.entries(props)) {
      shape[name] = req.has(name) ? propToZod(sub) : propToZod(sub).optional();
    }
    return z.object(shape).passthrough();
  }
  return z.any(); // permissive: let the TOOL validate, not the protocol
}

function schemaToZod(schema: Record<string, unknown>): z.ZodType<Record<string, unknown>> {
  const props = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema['required'] as string[] | undefined) ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, p] of Object.entries(props)) {
    const field = propToZod(p);
    shape[name] = required.has(name) ? field : field.optional();
  }
  return z.object(shape).passthrough() as unknown as z.ZodType<Record<string, unknown>>;
}

await server.connect(new StdioServerTransport());
console.error(`lionidas-mcp: serving ${ctx.registry.providerTools(ctx.policy).length} tools (v1 policy: read+draft) on stdio`);
