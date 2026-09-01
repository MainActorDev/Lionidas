/** B4: blocked verdict classification — infrastructure failures vs app
 *  failures. String-matching over real error signatures harvested from this
 *  week's live failures (honest limitation: unknown infra modes render red —
 *  fail-safe, since red gets investigated and blocked gets shrugged at). */

/** Signatures (substring, case-insensitive) of infra failures. */
const INFRA_SIGNATURES: string[] = [
  'open failed',
  'session "alloy" is already bound',
  'already bound to',
  'device busy',
  'device_busy',
  'lease lost',
  'lease_lost',
  'engine error',
  'step timeout',
  'not found: com.apple',        // engine could not resolve the app bundle
  'simulator is not booted',
  'device not available',
  'session_not_found',
  'connection refused',
  'timeout',
];

export function classifyBlocked(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return INFRA_SIGNATURES.some((sig) => r.includes(sig));
}
