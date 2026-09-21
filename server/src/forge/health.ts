/** T7 — forge chain health: ONE read for "can a scenario run actually
 *  intercept?". The chain is three manually-armed switches (mitm proxy
 *  process, host sim-routing, per-sim CA trust) that die silently on
 *  restarts; without this check a scenario run plays the FULL case against
 *  the real network and fails as `not found: <text>` — minutes of wasted
 *  playback pointing at the wrong layer.
 *
 *  Pure module: the two probes are injectable for tests. Null = healthy. */
import { mitmRunning } from './mitm/manager.ts';
import { simRoutingState } from './sim-routing.ts';

export interface ForgeHealthOverride { mitmRunning: boolean; routingEnabled: boolean }

/** test seam: when set, both probes read from this instead of the host. */
let override: ForgeHealthOverride | null = null;
export function __setForgeHealthForTest(o: ForgeHealthOverride | null): void { override = o; }

export interface ForgePreflightFailure { message: string; hint: string }

/** Pre-flight for a run that resolved a networkScenario. Returns null when
 *  the chain can plausibly intercept; otherwise a failure whose message is
 *  the honest reason (names every dead switch, plus the fix). */
export function forgePreflight(scenarioName: string): ForgePreflightFailure | null {
  const mitm = override ? override.mitmRunning : !!mitmRunning();
  const routing = override ? override.routingEnabled : !!simRoutingState().enabled;
  if (mitm && routing) return null;
  const dead: string[] = [];
  if (!mitm) dead.push('proxy down');
  if (!routing) dead.push('routing off');
  return {
    message: `scenario "${scenarioName}" cannot run: forge ${dead.join(' + ')} — start the proxy and routing (forge page → start proxy → route sims)`,
    hint: 'POST /api/forge/mitm/start then POST /api/forge/sim-routing {enabled:true}',
  };
}
