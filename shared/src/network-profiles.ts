/** Network conditioner presets (plan 20260928T153608Z rev 2).
 *  Vocabulary borrowed wholesale from Baguette's VirtualNetwork profiles,
 *  which borrow from Network Link Conditioner — "3g" means what every iOS
 *  developer already means by 3G. Single source for the UI picker, the
 *  case-yaml variant validator, editor autocomplete, and run stamps. */

export interface NetworkProfile {
  id: string;
  label: string;
  /** downlink kbps */
  bandwidthKbps: number | null;
  /** whole round trip, ms */
  latencyMs: number | null;
  /** % of requests failed */
  lossPct: number;
}

export const NETWORK_PROFILES: NetworkProfile[] = [
  { id: 'wifi', label: 'wifi', bandwidthKbps: 40_000, latencyMs: 2, lossPct: 0 },
  { id: 'dsl', label: 'dsl', bandwidthKbps: 2_000, latencyMs: 10, lossPct: 0 },
  { id: 'lte', label: 'lte', bandwidthKbps: 50_000, latencyMs: 130, lossPct: 0 },
  { id: '3g', label: '3g', bandwidthKbps: 780, latencyMs: 200, lossPct: 0 },
  { id: 'edge', label: 'edge', bandwidthKbps: 240, latencyMs: 800, lossPct: 0 },
  { id: 'very-bad-network', label: 'very bad network', bandwidthKbps: 1_000, latencyMs: 1_000, lossPct: 10 },
  { id: '100-loss', label: '100% loss (offline-ish)', bandwidthKbps: null, latencyMs: null, lossPct: 100 },
];

export const NETWORK_PROFILE_IDS: string[] = NETWORK_PROFILES.map((p) => p.id);

export function isNetworkProfile(id: string): boolean {
  return NETWORK_PROFILE_IDS.includes(id);
}
