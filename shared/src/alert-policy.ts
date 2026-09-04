/** Alert policy — run-level declaration of how system dialogs are answered.
 *  Shared by parser (validation), serializer (emit), and playback (resolve).
 *  Forms: scalar `alerts: dismiss` ≡ `{ default: dismiss }`; map with custom
 *  matchers and a REQUIRED default. Resolution = first matcher (declaration
 *  order) whose substring hits the dialog text, case-insensitive; default
 *  answers everything unmatched. Absent policy = every dialog fails named. */

export type AlertAction = 'accept' | 'dismiss' | 'fail';

/** Ordered matcher→action pairs; 'default' as matcher = the fallback. */
export interface AlertPolicy {
  entries: Array<[matcher: string, action: AlertAction]>;
}

/** Built-in matchers: dialog-text substrings (lowercased), EN locale. */
export const NAMED_MATCHERS: Record<string, string> = {
  location: 'use your location',
  notifications: 'notification',
  camera: 'camera',
  microphone: 'microphone',
  contacts: 'contacts',
  photos: 'photos',
  tracking: 'tracking',
  bluetooth: 'bluetooth',
  apple: 'apple account',
  network: 'local network',
};

const ACTIONS: ReadonlySet<string> = new Set(['accept', 'dismiss', 'fail']);

export function isAlertAction(v: unknown): v is AlertAction {
  return typeof v === 'string' && ACTIONS.has(v);
}

/** Resolve a dialog's answer under a policy. null policy → 'fail' (honesty default). */
export function resolveAlertPolicy(policy: AlertPolicy | null | undefined, dialogText: string): AlertAction {
  if (!policy) return 'fail';
  const text = dialogText.toLowerCase();
  let fallback: AlertAction | null = null;
  for (const [matcher, action] of policy.entries) {
    if (matcher === 'default') { fallback = action; continue; }
    const needle = (NAMED_MATCHERS[matcher.toLowerCase()] ?? matcher).toLowerCase();
    if (needle && text.includes(needle)) return action;
  }
  return fallback ?? 'fail';
}

/** Normalize a raw parsed value (string | record) → AlertPolicy; returns
 *  error message on invalid shape. Callers own error prefixing. */
export function parseAlertPolicy(raw: unknown): { policy: AlertPolicy | null; error: string | null } {
  if (raw === undefined || raw === null) return { policy: null, error: null };
  const finish = (entries: Array<[string, AlertAction]>): { policy: AlertPolicy | null; error: string | null } =>
    ({ policy: { entries }, error: null });
  if (typeof raw === 'string') {
    if (!isAlertAction(raw)) return { policy: null, error: `alerts needs accept, dismiss or fail (got "${raw}")` };
    return finish([['default', raw]]);
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length === 0) return { policy: null, error: 'alerts, when a map, needs at least one entry' };
    const entries: Array<[string, AlertAction]> = [];
    let defaults = 0;
    for (const k of keys) {
      const v = rec[k];
      if (!isAlertAction(v)) return { policy: null, error: `alerts entry "${k}" needs accept, dismiss or fail` };
      if (k === 'default') defaults++;
      entries.push([k, v]);
    }
    if (defaults !== 1) return { policy: null, error: 'alerts map needs exactly one default — every dialog must have a defined answer' };
    return finish(entries);
  }
  return { policy: null, error: 'alerts must be a scalar (accept|dismiss|fail) or a map of matchers' };
}
