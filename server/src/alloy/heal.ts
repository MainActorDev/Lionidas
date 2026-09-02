/** Engine self-heal for the recurring engine-staleness failure classes
 *  (dead tool-server → "fetch failed"; stale session binding → "already
 *  bound").
 *
 *  ⚔ CONTRACT (2026-09-02 lesson): alloy's dispatch() NEVER throws engine
 *  errors — every handler failure returns IN-BAND as {ok:false, error}. The
 *  original withEngineHeal only caught thrown exceptions, so for the exact
 *  failure class it was built for it was a NO-OP (the error sailed through as
 *  a normal return value; "stream unavailable: simulator-stream: fetch
 *  failed" reached the UI on every stream request). Healing must inspect the
 *  ENVELOPE, not catch.
 *
 *  The reset is also real now: alloy exports resetEngineACache/BCache, which
 *  drop its module-level client caches. A fresh engine-B client re-runs the
 *  tool-server launcher's ensure step → sees the dead pid → RESPAWNS the
 *  tool-server.
 *  (The old resetEngineCache() only nulled OUR module pointer — Node's
 *  require cache handed back the same alloy instance with the same stale
 *  clients, which is why recovery used to require a full server restart.)
 *  Recovery is logged, never silent — silent healing papers over real
 *  problems. Unknown errors pass through untouched. */
import { crucibleAlloy, resetEngineCache } from './client.ts';

const STALE_SIGNATURES = /fetch failed|already bound|ECONNREFUSED|COMMAND_FAILED/i;

export interface DispatchResult {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown; engine?: string | null };
}

function resetEngineClients(): void {
  const alloy = crucibleAlloy();
  // alloy dist ≥ 2026-09-02: precise per-engine cache reset (fresh engine-B
  // client → tool-server respawn). Optional: older dists lack the exports.
  alloy.resetEngineACache?.();
  alloy.resetEngineBCache?.();
  // Local module-pointer reset — kept so the resolve path re-runs even on
  // dists without the seams above.
  resetEngineCache();
}

/** dispatch + one-shot staleness self-heal. Detects the known stale-engine
 *  signatures on BOTH paths (in-band envelope AND thrown — config-level
 *  errors can still throw), resets the engine clients, retries ONCE. */
export async function dispatchWithHeal(tool: string, input: unknown, deps: unknown): Promise<DispatchResult> {
  const run = () => crucibleAlloy().dispatch(tool, input, deps) as Promise<DispatchResult>;
  const heal = async (why: string): Promise<DispatchResult> => {
    console.warn(`[engine heal] staleness signature "${why.slice(0, 120)}" — resetting engine clients and retrying once`);
    resetEngineClients();
    await new Promise((r) => setTimeout(r, 250));
    return await run();
  };
  const first = await run().catch(async (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (!STALE_SIGNATURES.test(msg)) throw err;
    return await heal(msg);
  });
  if (first.ok || !first.error || !STALE_SIGNATURES.test(first.error.message)) return first;
  return await heal(first.error.message);
}
