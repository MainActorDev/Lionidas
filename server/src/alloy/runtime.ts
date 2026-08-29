/** One Alloy runtime per process: resolved state + registered tools + dispatch deps.
 *  Uses Alloy's own createRuntime (config loading + engine resolution). */
import { crucibleAlloy } from './client.ts';

let cached: { state: unknown; deps: unknown } | null = null;

export async function initAlloyRuntime(): Promise<{ state: unknown; deps: unknown }> {
  if (cached) return cached;
  const alloy = crucibleAlloy();
  // createRuntime: loads engines config → state.resolved, registers tools
  const runtime = (await (alloy as unknown as {
    createRuntime: (cfg?: string) => Promise<{ state: unknown; deps: unknown }>;
  }).createRuntime()) as { state: { resolved: unknown; configError: string | null; health: unknown; leases: unknown }; deps: unknown };
  cached = { state: runtime.state, deps: runtime.deps };
  return cached;
}

export function alloyDispatchDepsSync(): unknown {
  if (!cached) throw new Error('alloy runtime not initialized — await initAlloyRuntime() first');
  return cached.deps;
}

/** Test seam: drop the singleton so the next init re-registers fresh. */
export function resetAlloyRuntimeForTests(): void {
  cached = null;
}
