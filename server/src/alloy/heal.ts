/** Engine self-heal: the two recurring engine-staleness failure classes
 *  (dead tool-server → "fetch failed"; stale session binding → "already
 *  bound") previously required a manual Crucible restart. withEngineHeal
 *  catches the known signatures, resets the cached engine clients (forcing a
 *  fresh spawn chain), retries ONCE, and ALWAYS logs — silent recovery is a
 *  lie when it papers over a real problem. Unknown errors propagate
 *  untouched. */
import { resetEngineCache } from './client.ts';

const STALE_SIGNATURES = /fetch failed|already bound|ECONNREFUSED|COMMAND_FAILED/i;

export async function withEngineHeal<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!STALE_SIGNATURES.test(msg)) throw err;
    console.warn(`[engine heal] staleness signature "${msg.slice(0, 120)}" — resetting engine clients and retrying once`);
    resetEngineCache();
    await new Promise((r) => setTimeout(r, 250));
    return await fn();
  }
}
