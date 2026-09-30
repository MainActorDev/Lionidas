/** R2 S3 — screen registry domain: pure validation for the app map.
 *
 *  A screen is HOW the runner reaches it (entry: tab tap / deep link /
 *  navigate steps), HOW it refreshes (gesture: pull | tab-retap |
 *  back-forward | deepLink | signal — a Darwin notification into the
 *  sim, consumed by the app's uitest seam), and WHAT its named states look like
 *  (selector-sets, reusing the case selector vocabulary). Shared shape for
 *  the shared/ case schema (S4) and the server API — validated identically
 *  on both write paths so the registry can never hold a screen the runner
 *  can't use. */

import { parseStepsFragment } from './case-yaml.js';

export interface ScreenSelector {
  identifier?: string;
  label?: string;
  labelContains?: string;
  ignoreCase?: boolean;
}

export type RefreshGesture = 'pull' | 'tab-retap' | 'back-forward' | 'deepLink' | 'signal';

export interface ScreenEntry {
  /** tap a tab-bar item by selector */
  tab?: ScreenSelector & { point?: [number, number] };
  /** app URL scheme route, e.g. shipments/{id} — params resolved per-case */
  deepLink?: string;
  /** explicit steps to replay (same shape as case steps, resolved by S5) */
  navigate?: Array<Record<string, unknown>>;
}

export interface ScreenRefresh {
  gesture: RefreshGesture;
  /** selector for tab-retap / pull anchor, or back-forward's AWAY leg */
  selector?: ScreenSelector & { point?: [number, number] };
  /** back-forward only: how to RETURN (tab bar is often hidden on pushed
   *  screens — the return leg needs its own anchor, e.g. the back button) */
  back?: ScreenSelector & { point?: [number, number] };
  /** deepLink route for gesture=deepLink */
  deepLink?: string;
}

export interface ScreenState {
  /** ALL selectors must hold (AND) */
  all?: ScreenSelector[];
  /** ANY selector holds (OR) — combined with all[] as AND(any-of-list) */
  any?: ScreenSelector[];
}

export interface AppScreen {
  id: string;
  entry: ScreenEntry;
  refresh?: ScreenRefresh | undefined;
  states: Record<string, ScreenState>;
}

const SCREEN_ID_RE = /^[a-z][a-z0-9-]*$/;
const STATE_ID_RE = /^[a-z][a-z0-9_-]*$/;
const GESTURES: ReadonlySet<string> = new Set(['pull', 'tab-retap', 'back-forward', 'deepLink', 'signal']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validSelector(v: unknown, err: (msg: string) => void): boolean {
  if (!isPlainObject(v)) { err('selector must be a mapping'); return false; }
  const keys = Object.keys(v);
  const known = keys.every((k) => k === 'identifier' || k === 'label' || k === 'labelContains' || k === 'ignoreCase' || k === 'point');
  if (!known) { err(`selector has unknown keys (${keys.join(', ')}) — allowed: identifier, label, labelContains, ignoreCase, point`); return false; }
  const hasMatcher = 'identifier' in v || 'label' in v || 'labelContains' in v;
  if (!hasMatcher) { err('selector needs one of identifier | label | labelContains'); return false; }
  return true;
}

/** Validate one screen definition. Returns error strings (empty = valid).
 *  Pure — no DB, no I/O; the API layer resolves cross-refs (S4 does
 *  case→screen resolution separately). */
export function validateScreen(screen: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(screen)) return ['screen must be a mapping'];
  const s = screen as Record<string, unknown>;
  // login no longer lives on screens (login-as-app-procedure plan): the
  // key is rejected for NEW data; stored legacy rows keep working through
  // playback's read-only fallback, and the procedure itself is validated
  // by validateAppLogin below.
  for (const k of Object.keys(s)) {
    if (k !== 'id' && k !== 'entry' && k !== 'refresh' && k !== 'states') {
      errors.push(`unknown key "${k}" — allowed: id, entry, refresh, states${k === 'login' ? " (login is app-level now — edit it via the app's login flow)" : ''}`);
    }
  }
  const id = s['id'];
  if (typeof id !== 'string' || !SCREEN_ID_RE.test(id)) {
    errors.push(`id must match [a-z][a-z0-9-]* (got ${JSON.stringify(id ?? null)})`);
  }
  // entry: exactly one of tab | deepLink | navigate
  const entry = s['entry'];
  if (!isPlainObject(entry)) {
    errors.push('entry must be a mapping with exactly one of: tab, deepLink, navigate');
  } else {
    const modes = ['tab', 'deepLink', 'navigate'].filter((m) => entry[m] !== undefined);
    if (modes.length === 0) errors.push('entry needs exactly one of: tab, deepLink, navigate (got none)');
    if (modes.length > 1) errors.push(`entry: use only one of tab/deepLink/navigate (got ${modes.join(' + ')})`);
    if (entry['tab'] !== undefined && !validSelector(entry['tab'], (m) => errors.push(`entry.tab: ${m}`))) { /* noted */ }
    if (entry['deepLink'] !== undefined && (typeof entry['deepLink'] !== 'string' || entry['deepLink'].length === 0)) {
      errors.push('entry.deepLink must be a non-empty string (app route)');
    }
    if (entry['navigate'] !== undefined) {
      if (!Array.isArray(entry['navigate']) || entry['navigate'].length === 0 || !entry['navigate'].every(isPlainObject)) {
        errors.push('entry.navigate must be a non-empty list of step mappings');
      } else {
        // each step: exactly one of `on: <selector-ref>` | `x`+`y` (D1 plan rev 2 —
        // selector steps replace coordinates for multi-hop entries)
        (entry['navigate'] as Array<Record<string, unknown>>).forEach((st, i) => {
          const hasOn = typeof st['on'] === 'string' && (st['on'] as string).trim().length > 0;
          const hasXY = typeof st['x'] === 'number' && typeof st['y'] === 'number';
          if (hasOn && hasXY) errors.push(`entry.navigate step ${i + 1}: use on: OR x/y, not both`);
          if (!hasOn && !hasXY) errors.push(`entry.navigate step ${i + 1}: needs on: <selector> or x/y`);
          for (const k of Object.keys(st)) {
            if (k !== 'on' && k !== 'x' && k !== 'y') errors.push(`entry.navigate step ${i + 1}: unknown key "${k}" — allowed: on, x, y`);
          }
        });
      }
    }
    for (const k of Object.keys(entry)) {
      if (k !== 'tab' && k !== 'deepLink' && k !== 'navigate') errors.push(`entry: unknown key "${k}"`);
    }
  }
  // refresh (optional)
  const refresh = s['refresh'];
  if (refresh !== undefined) {
    if (!isPlainObject(refresh)) {
      errors.push('refresh must be a mapping { gesture, selector? | deepLink? }');
    } else {
      const g = refresh['gesture'];
      if (typeof g !== 'string' || !GESTURES.has(g)) {
        errors.push(`refresh.gesture must be one of ${[...GESTURES].join(' | ')} (got ${JSON.stringify(g ?? null)})`);
      }
      if (g === 'tab-retap' && refresh['selector'] === undefined) errors.push('refresh: tab-retap needs a selector');
      if (g === 'deepLink' && typeof refresh['deepLink'] !== 'string') errors.push('refresh: deepLink gesture needs a deepLink route');
      if (g === 'pull' && refresh['selector'] !== undefined) errors.push('refresh: pull takes no selector (dragged from screen mid)');
      if (refresh['selector'] !== undefined) validSelector(refresh['selector'], (m) => errors.push(`refresh.selector: ${m}`));
      if (refresh['back'] !== undefined) {
        if (g !== 'back-forward') errors.push('refresh.back is only valid with the back-forward gesture');
        validSelector(refresh['back'], (m) => errors.push(`refresh.back: ${m}`));
      }
      if (g === 'back-forward' && refresh['selector'] === undefined) errors.push('refresh: back-forward needs a selector (the away anchor)');
      for (const k of Object.keys(refresh)) {
        if (k !== 'gesture' && k !== 'selector' && k !== 'deepLink' && k !== 'back') errors.push(`refresh: unknown key "${k}"`);
      }
    }
  }
  // states: ≥1 named state, each a non-empty selector-set
  const states = s['states'];
  if (!isPlainObject(states) || Object.keys(states).length === 0) {
    errors.push('states must be a mapping with at least one named state (loading, loaded, …)');
  } else {
    for (const [name, def] of Object.entries(states)) {
      if (!STATE_ID_RE.test(name)) errors.push(`state name "${name}" must match [a-z][a-z0-9_-]*`);
      if (!isPlainObject(def)) { errors.push(`state "${name}" must be a mapping { all?: […], any?: […] }`); continue; }
      const all = def['all'];
      const any = def['any'];
      if (all === undefined && any === undefined) {
        errors.push(`state "${name}" needs at least one selector (all and/or any)`);
        continue;
      }
      if (all !== undefined && (!Array.isArray(all) || all.length === 0 || !all.every((x) => validSelector(x, (m) => errors.push(`state "${name}".all: ${m}`))))) {
        if (!Array.isArray(all) || all.length === 0) errors.push(`state "${name}".all must be a non-empty list`);
      }
      if (any !== undefined && (!Array.isArray(any) || any.length === 0 || !any.every((x) => validSelector(x, (m) => errors.push(`state "${name}".any: ${m}`))))) {
        if (!Array.isArray(any) || any.length === 0) errors.push(`state "${name}".any must be a non-empty list`);
      }
      for (const k of Object.keys(def)) {
        if (k !== 'all' && k !== 'any') errors.push(`state "${name}": unknown key "${k}" — allowed: all, any`);
      }
    }
  }
  return errors;
}

/** Validate a whole registry document (list of screens) — duplicate ids
 *  named, every screen individually valid. */
export function validateRegistry(screens: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(screens) || screens.length === 0) return ['registry must be a non-empty list of screens'];
  const seen = new Map<string, number>();
  screens.forEach((scr, i) => {
    const errs = validateScreen(scr);
    for (const e of errs) errors.push(`screen ${i + 1}: ${e}`);
    const id = isPlainObject(scr) && typeof (scr as Record<string, unknown>)['id'] === 'string' ? (scr as Record<string, unknown>)['id'] as string : null;
    if (id) {
      if (seen.has(id)) errors.push(`screen ${i + 1}: duplicate id "${id}" (also screen ${seen.get(id)})`);
      else seen.set(id, i + 1);
    }
  });
  return errors;
}

// ─── Login as an app-level procedure (login-as-app-procedure plan) ───
// One per app: entry (full entry object), phone/password/submit controls,
// verify = (screen, state) REFERENCE — states stay screen facts.

export interface AppLogin {
  entry: { tab?: { identifier?: string; label?: string; point?: [number, number] }; deepLink?: string; navigate?: Array<Record<string, unknown>> };
  phone: string;
  password: string;
  submit: string;
  verify: { screen: string; state: string };
}

/** Logout as an app-level procedure (plan 20260929T080249Z F4): recipe
 *  shape {button, stay?, confirm, via?} — button/confirm non-empty strings,
 *  stay/via optional strings, unknown keys rejected. Mirrors
 *  validateAppLogin's strictness. */
export function validateAppLogout(logout: unknown): string[] {
  if (!isPlainObject(logout)) return ['logout flow must be a mapping'];
  const l = logout as Record<string, unknown>;
  const errors: string[] = [];
  const allowed = ['button', 'stay', 'confirm', 'via'];
  for (const k of Object.keys(l)) if (!allowed.includes(k)) errors.push(`logout flow: unknown key "${k}" — allowed: ${allowed.join(', ')}`);
  for (const req of ['button', 'confirm'] as const) {
    if (typeof l[req] !== 'string' || !(l[req] as string).trim()) errors.push(`logout flow needs ${req}: a non-empty label-or-id`);
  }
  for (const optKey of ['stay', 'via'] as const) {
    if (l[optKey] !== undefined && (typeof l[optKey] !== 'string' || !(l[optKey] as string).trim())) errors.push(`logout flow ${optKey}, when present, needs a non-empty label-or-id`);
  }
  return errors;
}

export function validateAppLogin(login: unknown, screens: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(login)) return ['login flow must be a mapping'];
  const l = login as Record<string, unknown>;
  const allowed = ['entry', 'steps', 'verify'];
  for (const k of Object.keys(l)) if (!allowed.includes(k)) errors.push(`login flow: unknown key "${k}" — allowed: ${allowed.join(', ')}`);

  // entry: reuse the screen entry rules (exactly one of tab/deepLink/navigate)
  const entry = l['entry'];
  if (!isPlainObject(entry)) errors.push('login flow needs an entry (tab / deepLink / navigate)');
  else {
    const modes = ['tab', 'deepLink', 'navigate'].filter((m) => (entry as Record<string, unknown>)[m] !== undefined);
    if (modes.length === 0) errors.push('login flow entry needs exactly one of: tab, deepLink, navigate');
    if (modes.length > 1) errors.push(`login flow entry: use only one of tab/deepLink/navigate (got ${modes.join(' + ')})`);
    if (modes.includes('tab')) {
      const t = (entry as Record<string, unknown>)['tab'];
      if (!isPlainObject(t) || !(('identifier' in t) || ('label' in t) || ('labelContains' in t))) errors.push('login flow entry.tab needs identifier | label | labelContains');
    }
    if (modes.includes('navigate')) {
      const nav = (entry as Record<string, unknown>)['navigate'];
      if (!Array.isArray(nav) || nav.length === 0 || !nav.every((st) => isPlainObject(st) && (typeof (st as Record<string, unknown>)['on'] === 'string' || (typeof (st as Record<string, unknown>)['x'] === 'number' && typeof (st as Record<string, unknown>)['y'] === 'number')))) {
        errors.push('login flow entry.navigate must be a non-empty list of steps (on: or x/y)');
      }
    }
  }

  // steps form (plan 20260930T044550Z): any app's login form is a step list.
  // Legacy 5-slot recipes are rejected post-migration with a pointing error —
  // the migration reshapes them (env names derived from referencing cases).
  const PRELOGIN_ALLOWED = new Set(['tap', 'type', 'expect']);
  if (l['steps'] !== undefined) {
    if (!Array.isArray(l['steps']) || l['steps'].length === 0) {
      errors.push('login flow.steps must be a non-empty list of steps (tap/type/expect)');
    } else {
      const frag = parseStepsFragment(l['steps']);
      for (const e of frag.errors) errors.push(`login flow: ${e.message}`);
      for (const st of frag.steps) {
        if (!PRELOGIN_ALLOWED.has(st.action)) {
          errors.push(`login flow: step ${st.idx + 1} action "${st.action}" is not allowed in a login recipe (allowed: tap, type, expect)`);
        }
      }
    }
  } else {
    errors.push('login flow needs steps: a list of tap/type/expect steps — the recipe-as-steps form (the old phone/password/submit slots are gone; stored recipes were reshaped by the migration)');
  }

  // verify: (screen, state[, via]) reference — cross-validated against the app's registry
  const verify = l['verify'];
  if (!isPlainObject(verify) || typeof (verify as Record<string, unknown>)['screen'] !== 'string' || typeof (verify as Record<string, unknown>)['state'] !== 'string') {
    errors.push('login flow.verify must be { screen: <id>, state: <name> }');
  } else if (Array.isArray(screens)) {
    const scr = (screens as Array<Record<string, unknown>>).find((x) => x['id'] === (verify as Record<string, unknown>)['screen']);
    if (!scr) errors.push(`login flow.verify.screen "${(verify as Record<string, unknown>)['screen']}" is not in this app's registry`);
    else {
      const states = scr['states'];
      const names = isPlainObject(states) ? Object.keys(states as Record<string, unknown>) : [];
      if (!names.includes((verify as Record<string, unknown>)['state'] as string)) errors.push(`login flow.verify.state "${(verify as Record<string, unknown>)['state']}" is not a state of "${(verify as Record<string, unknown>)['screen']}" (has: ${names.join(', ') || 'none'})`);
    }
  }
  return errors;
}

// ─── Live-match helpers (moved from server screen-runner, registry-UI F1) ───
// Pure: given an AX-tree node list, does a selector / state hold? Shared so
// the web probe (verify-against-live) and the server runner assert with the
// SAME logic — one definition of "state holds".

export interface SnapNode { type?: string; label?: string; identifier?: string; rect?: { x: number; y: number; width: number; height: number } }

/** countMatches sibling of playback's (same semantics: label/identifier/
 *  labelContains with optional ignoreCase). Kept local to avoid coupling. */
export function selectorMatches(nodes: SnapNode[], sel: ScreenSelector): number {
  let n = 0;
  for (const node of nodes) {
    const label = node.label ?? '';
    const ident = node.identifier ?? '';
    if (sel.identifier !== undefined) { if (ident === sel.identifier) n++; continue; }
    if (sel.label !== undefined) {
      const eq = sel.ignoreCase ? label.toLowerCase() === sel.label.toLowerCase() : label === sel.label;
      if (eq) n++; continue;
    }
    if (sel.labelContains !== undefined) {
      const has = sel.ignoreCase ? label.toLowerCase().includes(sel.labelContains.toLowerCase()) : label.includes(sel.labelContains);
      if (has) n++; continue;
    }
  }
  return n;
}

/** state holds when all[] selectors each match ≥1 AND any[] matches ≥1 total */
export function stateHolds(nodes: SnapNode[], state: { all?: ScreenSelector[]; any?: ScreenSelector[] }): boolean {
  if (state.all && state.all.some((sel) => selectorMatches(nodes, sel) === 0)) return false;
  if (state.any) {
    const total = state.any.reduce((sum, sel) => sum + selectorMatches(nodes, sel), 0);
    if (total === 0) return false;
  }
  return true;
}
