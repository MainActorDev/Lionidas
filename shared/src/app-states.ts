/**
 * App states registry domain (phase A S2, plan 20261017T112229Z) — the pure
 * validation + shape layer shared by the server routes and the web editor.
 * A state = probe (cheap identity check) + recipe (how to get there) +
 * verify (proof of arrival). Recipes store ${env.X} refs, never literal
 * credentials — resolution happens at play time through the existing
 * template-env seam.
 *
 * Pure module: no node APIs. Registry cross-checks (screen refs exist) are
 * the ROUTE's job — this file validates shape only.
 */
import { parseStepsFragment } from './case-yaml.ts';

export type StateProvenance = 'user' | 'ai+user' | 'import';

/** probe / verify selector — expect-shaped: exactly one targeting key. */
export interface StateSelector {
  identifier?: string;
  label?: string;
  labelContains?: string;
  screen?: string;
}

/** verify = selector + optional via (tap a control first, then poll — the
 *  login-domain `via` precedent: a control on the destination screen may be
 *  invisible from wherever the app currently is). */
export interface StateVerify extends StateSelector {
  via?: string;
}

export interface StateEntry {
  tab?: { identifier?: string; label?: string; labelContains?: string };
  deepLink?: string;
  navigate?: Array<{ on?: string; x?: number; y?: number }>;
}

export interface StateRecipe {
  entry?: StateEntry;
  actuator?: 'relaunch' | 'signal' | 'uninstallReinstall' | 'privacyGrant';
  launchArgs?: string[];
  signal?: string;
  permission?: string;
  steps?: unknown[];
}

export interface AppState {
  /** st_<rand> — server-assigned */
  id?: string;
  /** slug unique per bundle — the case-grammar reference (ensure state: X) */
  stateId: string;
  /** plain-English name for the web UI */
  label: string;
  probe: StateSelector;
  recipe: StateRecipe;
  verify: StateVerify;
  provenance?: StateProvenance;
  revision?: number;
}

const STATE_ID_RE = /^[a-z][a-z0-9_-]*$/;
/** actuator → the companion field it requires (S4 wires the executors) */
const ACTUATOR_FIELDS: Record<string, string[]> = {
  relaunch: ['launchArgs'],
  signal: ['signal'],
  uninstallReinstall: [],
  privacyGrant: ['permission'],
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateSelector(where: string, sel: unknown, allowScreen: boolean, errors: string[], extraKeys: string[] = []): void {
  if (!isPlainObject(sel)) {
    errors.push(`${where} must be a mapping`);
    return;
  }
  const allowed = ['identifier', 'label', 'labelContains', ...(allowScreen ? ['screen'] : []), ...extraKeys];
  for (const k of Object.keys(sel)) {
    if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}" — allowed: ${allowed.join(', ')}`);
    else if (typeof sel[k] !== 'string' || !(sel[k] as string).trim()) errors.push(`${where}.${k} needs a non-empty string`);
  }
  const targeting = ['identifier', 'label', 'labelContains', ...(allowScreen ? ['screen'] : [])].filter((k) => typeof sel[k] === 'string' && (sel[k] as string).trim());
  if (targeting.length === 0) errors.push(`${where} needs one of: ${allowScreen ? 'identifier, label, labelContains, screen' : 'identifier, label, labelContains'}`);
  if (targeting.length > 1) errors.push(`${where}: use exactly one targeting key (got ${targeting.join(' + ')}) — a probe must assert identity, not a set`);
}

/** Credential guard (plan edge 16): recipes carry ${env.X} refs only. A
 *  typed/pasted literal aimed at a password-ish field, or a bare
 *  phone-shaped literal, is rejected with a pointing error — the value
 *  belongs in an env field, never in the registry. */
function validateNoCredentialLiterals(steps: Array<{ action: string; text?: string; selector?: { identifier?: string; label?: string } }>, errors: string[]): void {
  for (const st of steps) {
    if ((st.action !== 'type' && st.action !== 'paste') || typeof st.text !== 'string') continue;
    const target = `${st.selector?.identifier ?? ''} ${st.selector?.label ?? ''}`.toLowerCase();
    const hasRef = st.text.includes('${env.');
    if (/password|passwd|secret|otp|pin\b/.test(target) && !hasRef) {
      errors.push(`recipe step: the text for "${st.selector?.identifier ?? st.selector?.label}" looks like a credential — use an \${env.NAME} ref (values live in env fields, never in the registry)`);
    } else if (!hasRef && /^\+?\d[\d\s-]{6,}$/.test(st.text.trim())) {
      errors.push(`recipe step: bare phone-like literal "${st.text.slice(0, 6)}…" — use an \${env.NAME} ref`);
    }
  }
}

/** Shape validation → error list (empty = valid). Route adds registry
 *  cross-checks (screen refs resolve against app_screens). */
export function validateAppState(state: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(state)) return ['state must be a mapping'];
  const s = state as Record<string, unknown>;
  const allowed = ['stateId', 'label', 'probe', 'recipe', 'verify'];
  for (const k of Object.keys(s)) if (!allowed.includes(k)) errors.push(`state: unknown key "${k}" — allowed: ${allowed.join(', ')}`);

  if (typeof s['stateId'] !== 'string' || !STATE_ID_RE.test(s['stateId'])) {
    errors.push('stateId must match [a-z][a-z0-9_-]* (e.g. fresh_install, logged_in, on_home)');
  }
  if (typeof s['label'] !== 'string' || !s['label'].trim()) {
    errors.push('label needs a non-empty plain-English name (shown in the web UI)');
  }

  // probe: REQUIRED — idempotence depends on detection; identity, not a set
  validateSelector('probe', s['probe'], true, errors);

  // verify: REQUIRED — expect-shaped + optional via
  validateSelector('verify', s['verify'], true, errors, ['via']);

  // recipe: at least one arm (entry | actuator | steps)
  const r = s['recipe'];
  if (!isPlainObject(r)) {
    errors.push('recipe must be a mapping');
  } else {
    const allowedR = ['entry', 'actuator', 'launchArgs', 'signal', 'permission', 'steps'];
    for (const k of Object.keys(r)) if (!allowedR.includes(k)) errors.push(`recipe: unknown key "${k}" — allowed: ${allowedR.join(', ')}`);
    const arms = ['entry', 'actuator', 'steps'].filter((k) => r[k] !== undefined);
    if (arms.length === 0) errors.push('recipe needs at least one arm: entry (tab/deepLink/navigate), actuator, or steps (the walk)');
    if (Array.isArray(arms) && arms.length > 1) {
      // legal but worth pinning the ORDER: entry → actuator → steps (executor contract)
    }

    // entry — same rules as the login/screen entry (one of tab/deepLink/navigate)
    if (r['entry'] !== undefined) {
      const entry = r['entry'];
      if (!isPlainObject(entry)) errors.push('recipe.entry must be a mapping (tab / deepLink / navigate)');
      else {
        const modes = ['tab', 'deepLink', 'navigate'].filter((m) => entry[m] !== undefined);
        if (modes.length === 0) errors.push('recipe.entry needs exactly one of: tab, deepLink, navigate');
        if (modes.length > 1) errors.push(`recipe.entry: use only one of tab/deepLink/navigate (got ${modes.join(' + ')})`);
        if (modes.includes('tab')) {
          const t = entry['tab'];
          if (!isPlainObject(t) || !('identifier' in t) && !('label' in t) && !('labelContains' in t)) errors.push('recipe.entry.tab needs identifier | label | labelContains');
        }
        if (modes.includes('deepLink')) {
          const d = entry['deepLink'];
          if (typeof d !== 'string' || !d.trim()) errors.push('recipe.entry.deepLink needs a non-empty url/path');
        }
        if (modes.includes('navigate')) {
          const nav = entry['navigate'];
          if (!Array.isArray(nav) || nav.length === 0 || !nav.every((st) => isPlainObject(st) && (typeof st['on'] === 'string' || (typeof st['x'] === 'number' && typeof st['y'] === 'number')))) {
            errors.push('recipe.entry.navigate must be a non-empty list of steps (on: or x/y)');
          }
        }
      }
    }

    // actuator + companion fields
    if (r['actuator'] !== undefined) {
      const a = r['actuator'];
      if (typeof a !== 'string' || !(a in ACTUATOR_FIELDS)) {
        errors.push(`recipe.actuator must be one of: ${Object.keys(ACTUATOR_FIELDS).join(', ')} (got ${JSON.stringify(a)})`);
      } else {
        for (const need of ACTUATOR_FIELDS[a]!) {
          if (typeof r[need] !== 'string' && !Array.isArray(r[need])) errors.push(`recipe: actuator "${a}" needs "${need}" set`);
        }
        // one actuator per recipe: a companion field of a DIFFERENT actuator
        // present while this actuator is active is a mixed recipe — reject it
        for (const other of Object.keys(ACTUATOR_FIELDS)) {
          if (other === a) continue;
          for (const companion of ACTUATOR_FIELDS[other]!) {
            if (r[companion] !== undefined) errors.push(`recipe: field "${companion}" belongs to actuator "${other}" but the actuator is "${a}" — one actuator per recipe`);
          }
        }
      }
    }
    if (r['launchArgs'] !== undefined && (!Array.isArray(r['launchArgs']) || !r['launchArgs'].every((x) => typeof x === 'string' && x.trim()))) {
      errors.push('recipe.launchArgs must be a list of non-empty strings');
    }
    if (r['signal'] !== undefined && (typeof r['signal'] !== 'string' || !r['signal'].trim())) errors.push('recipe.signal needs a non-empty Darwin notification name');
    if (r['permission'] !== undefined && (typeof r['permission'] !== 'string' || !r['permission'].trim())) errors.push('recipe.permission needs a non-empty service name (e.g. photos, camera)');

    // steps — the walk; same grammar as case steps (parseStepsFragment seam).
    // Allowed set matches what the S3 player executes: tap/type/expect + wait.
    const WALK_ALLOWED = new Set(['tap', 'type', 'expect', 'wait']);
    if (r['steps'] !== undefined) {
      if (!Array.isArray(r['steps']) || r['steps'].length === 0) {
        errors.push('recipe.steps must be a non-empty list of steps (the walk to this state)');
      } else {
        const frag = parseStepsFragment(r['steps']);
        for (const e of frag.errors) errors.push(`recipe: ${e.message}`);
        for (const st of frag.steps) {
          if (!WALK_ALLOWED.has(st.action)) errors.push(`recipe: step ${st.idx + 1} action "${st.action}" is not allowed in a state walk (allowed: tap, type, expect, wait)`);
        }
        validateNoCredentialLiterals(frag.steps as never, errors);
      }
    }
  }
  return errors;
}
