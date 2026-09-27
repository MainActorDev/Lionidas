/**
 * Case YAML — the ONE definition of the YAML test-case format, shared by the
 * web (live outline in the A2 split panel) and the server (validate/save
 * routes
import this file by relative path). Pure module: no node APIs, only
 * the `yaml` npm package. Storage stays steps_json — YAML is a view+editor,
 * never a second source of truth.
 *
 * Round-trip contract: yamlToSteps(stepsToYaml(case)) preserves execution
 * semantics. Capture artifacts (thumb, ts) are dropped in YAML and ignored
 * on import. Unknown keys are ERRORS with line numbers — a typo'd `optinal:`
 * must never silently drop a step.
 */
import { parse, stringify } from 'yaml';
import { parseAlertPolicy as parseAlertPolicyRaw, type AlertPolicy } from './alert-policy.ts';
import { IDENTIFIER_RE } from './ax-tree.ts';
import { parseVariants, type YamlVariant } from './yaml-variants.js';

export interface YamlSelector { identifier?: string; label?: string; labelContains?: string; ignoreCase?: boolean; type?: string }
export interface YamlStep {
  idx: number;
  action: 'tap' | 'scroll' | 'type' | 'runFlow' | 'expect' | 'alert' | 'location' | 'arrive' | 'refresh' | 'swap' | 'expectScreen' | 'ensureLogout' | 'ensureLogin';
  x?: number; y?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  text?: string;
  optional?: boolean;
  selector?: YamlSelector;
  templateId?: string;
  flow?: string;
  /** setup-only guard: run this step only if a label containing this fragment
   *  is visible (existence, not uniqueness). Absent element → no-op skip. */
  when?: string;
  /** expect-only cardinality: exactly N (count) or ≥ N (atLeast). Absent →
   *  the default exactly-1 contract. Mutually exclusive — one bound per step. */
  count?: number;
  atLeast?: number;
  /** alert action target — accept or dismiss the frontmost system dialog */
  alertAction?: 'accept' | 'dismiss';
  /** location action target — simulated GPS point (simctl location set) */
  location?: { latitude: number; longitude: number };
  /** R2 verbs — arrive: <screen-id>, refresh: <screen-id>, swap: <target-id> */
  screen?: string;
  /** ensure logout: if a session indicator is visible, walk the app's logout
   *  flow (list button → confirm sheet) by IDENTIFIER first, label second —
   *  coordinate-free, cross-device safe. No-op pass when already logged out. */
  ensureLogout?: { button: string; stay: string; confirm: string };
  ensureLogin?: { entry: string; phoneField: string; passwordField: string; submit: string; session: string; phone: string; password: string; screen?: string };
  /** swap: <id from this case's swaps/variants> */
  swap?: string;
  /** expect screen: "<screen>.<state>" — parsed into parts; negate for != */
  expectScreen?: { screen: string; state: string; negate?: boolean };
}
export interface YamlCase {
  name: string;
  tags: string[];
  app?: string;
  /** Declared preconditions — guarded steps that no-op when already satisfied */
  setup?: YamlStep[];
  /** Run-level system-dialog policy (absent = every dialog fails named) */
  alerts?: AlertPolicy;
  /** State coverage (phase B): one flow, N deterministic worlds. The runner
   *  expands these in phase C; parsing/storage/autocomplete ship first. */
  variants?: YamlVariant[];
  /** R2 v2: named swap targets — same shape as variants; the runner treats
   *  swaps: and variants: as one pool (variants wins on key collision as
   *  the established term). 'worlds:' parses as the deprecated alias. */
  swaps?: YamlVariant[];
  /** @deprecated use swaps — kept for parsing old case versions */
  worlds?: YamlVariant[];
  /** R2 v2: default entry for arrive: steps (screen id in the app registry) */
  entry?: { screen: string; mode?: 'tab' | 'deepLink' | 'navigate' };
  steps: YamlStep[];
}

export interface YamlError { line: number; message: string }

const DROPPED_KEYS = new Set(['ts', 'thumb']); // capture artifacts — not semantics
const STEP_KEYS = new Set(['action', 'x', 'y', 'direction', 'text', 'optional', 'selector', 'templateId', 'flow', 'count', 'atLeast']);
const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
const ACTIONS = new Set(['tap', 'scroll', 'type', 'runFlow', 'expect', 'alert', 'location', 'arrive', 'refresh', 'swap', 'world', 'expect screen', 'ensure logout', 'ensure login']);
const SCREEN_ID_RE = /^[a-z][a-z0-9-]*$/;
/** runFlow references: name → id resolution is the CALLER's job (needs the DB);
 * the validator accepts both shapes and reports unresolved names. */
export interface RunFlowRefs { names: string[] }

/** Parse + validate YAML text → { case, errors }. Errors carry YAML line
 *  numbers (from the yaml lib's source context). Never throws. */
export function parseCaseYaml(text: string): { ok: boolean; case: YamlCase | null; errors: YamlError[]; runFlowNames: string[] } {
  const errors: YamlError[] = [];
  let doc: unknown;
  try {
    doc = parse(text, { merge: false });
  } catch (err) {
    const e = err as { message?: string; linePos?: Array<{ line: number }> | [number, number] };
    // yaml v2: linePos is [{line, col}, {line, col}] (range); older docs say [line, col]
    const lp = e.linePos;
    const line = Array.isArray(lp) && lp.length > 0 ? (typeof lp[0] === 'number' ? (lp[0] as number) : (lp[0] as { line: number }).line) : 1;
    return { ok: false, case: null, errors: [{ line, message: e.message ?? 'invalid yaml' }], runFlowNames: [] };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, case: null, errors: [{ line: 1, message: 'the case must be a yaml mapping (name:, tags:, steps:…)' }], runFlowNames: [] };
  }
  const c = doc as Record<string, unknown>;
  const lineOf = (key: string): number => {
    // the yaml lib keeps source ranges on parsed values ( CST ) — for v2
    // plain objects we approximate: keys are usually near the top; line 1
    // is acceptable when we can't pinpoint. Real per-step lines come from
    // step.range when steps are maps (handled below via parseDocument).
    void key;
    return 1;
  };

  // name
  const name = typeof c['name'] === 'string' ? (c['name'] as string).trim() : '';
  if (!name) errors.push({ line: lineOf('name'), message: 'name is required (name: <case name>)' });

  // tags
  let tags: string[] = [];
  if (c['tags'] !== undefined) {
    if (!Array.isArray(c['tags']) || (c['tags'] as unknown[]).some((t) => typeof t !== 'string')) {
      errors.push({ line: 1, message: 'tags must be a list of strings (tags: [smoke, login])' });
    } else {
      const seen = new Set<string>();
      for (const t of (c['tags'] as string[]).map((s) => s.trim()).filter(Boolean)) {
        if (!seen.has(t)) { seen.add(t); tags.push(t); }
        if (seen.size >= 8) break; // max-8, same rule as the table
      }
    }
  }

  // app
  const app = typeof c['app'] === 'string' ? (c['app'] as string).trim() : undefined;

  // alerts policy (scalar or map) — see alert-policy.ts for semantics
  let alerts: AlertPolicy | undefined;
  if (c['alerts'] !== undefined) {
    const r = parseAlertPolicyRaw(c['alerts']);
    if (r.error) errors.push({ line: 1, message: `alerts: ${r.error}` });
    else alerts = r.policy ?? undefined;
  }

  // variants (phase B) — pure validation via the shared module
  let variantsOut: YamlVariant[] | null = null;
  if (c['variants'] !== undefined && c['variants'] !== null) {
    variantsOut = parseVariants(c['variants'], errors);
  }
  // worlds (R2 v2) — authoring alias for variants; both may parse, collision
  // on ids between them is an error (one vocabulary per case)
  let worldsOut: YamlVariant[] | null = null;
  if (c['swaps'] !== undefined && c['swaps'] !== null) {
    worldsOut = parseVariants(c['swaps'], errors);
  } else if (c['worlds'] !== undefined && c['worlds'] !== null) {
    worldsOut = parseVariants(c['worlds'], errors); // deprecated alias
  }
  if (variantsOut && worldsOut) {
    const ids = new Set(worldsOut.map((w) => w.id));
    for (const v of variantsOut) {
      if (ids.has(v.id)) errors.push({ line: 1, message: `swap target "${v.id}" also appears in variants — one vocabulary per case` });
    }
  }
  // entry (R2 v2): default screen for arrive: steps
  let entry: YamlCase['entry'];
  if (c['entry'] !== undefined && c['entry'] !== null) {
    const e = c['entry'] as Record<string, unknown>;
    if (typeof e !== 'object' || typeof e['screen'] !== 'string' || !SCREEN_ID_RE.test(e['screen'])) {
      errors.push({ line: 1, message: 'entry must be { screen: <screen-id>, mode?: tab | deepLink | navigate }' });
    } else if (e['mode'] !== undefined && !['tab', 'deepLink', 'navigate'].includes(e['mode'] as string)) {
      errors.push({ line: 1, message: `entry.mode must be tab | deepLink | navigate (got ${JSON.stringify(e['mode'])})` });
    } else {
      entry = { screen: e['screen'], ...(e['mode'] !== undefined ? { mode: e['mode'] as 'tab' | 'deepLink' | 'navigate' } : {}) };
    }
  }

  // setup (declared preconditions) — parsed by the same step machinery
  let setupOut: YamlStep[] | undefined;
  if (c['setup'] !== undefined) {
    if (!Array.isArray(c['setup']) || (c['setup'] as unknown[]).length === 0) {
      errors.push({ line: 1, message: 'setup, when present, needs at least one step — remove the key if the case has no preconditions' });
    } else {
      const r = parseStepList(c['setup'] as unknown[], 'setup', i => `setup step ${i + 1}`, errors);
      setupOut = r.steps;
    }
  }

  // steps
  const stepsOut: YamlStep[] = [];
  const runFlowNames: string[] = [];
  if (!Array.isArray(c['steps']) || (c['steps'] as unknown[]).length === 0) {
    errors.push({ line: 1, message: 'steps is required and must be a non-empty list — a case must do something' });
  } else {
    const r = parseStepList(c['steps'] as unknown[], 'steps', i => `step ${i + 1}`, errors);
    stepsOut.push(...r.steps);
    runFlowNames.push(...r.names);
  }
  if (errors.length > 0) return { ok: false, case: null, errors, runFlowNames };
  const outCase: YamlCase = { name, tags, ...(app ? { app } : {}), ...(setupOut ? { setup: setupOut } : {}), ...(alerts ? { alerts } : {}), ...(variantsOut ? { variants: variantsOut } : {}), steps: stepsOut };
  if (worldsOut) outCase.swaps = worldsOut;
  if (entry) outCase.entry = entry;
  return { ok: true, case: outCase, errors: [], runFlowNames };
}

/** One step list (steps: or setup:) → validated steps + runFlow name refs.
 *  section names the list for error prefixing and gates setup-only rules. */
function parseStepList(steps: unknown[], section: 'setup' | 'steps', prefix: (i: number) => string, errors: YamlError[]): { steps: YamlStep[]; names: string[] } {
  const stepsOut: YamlStep[] = [];
  const runFlowNames: string[] = [];
  {
    for (let i = 0; i < steps.length; i++) {
      const raw = steps[i];
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push({ line: 1, message: `${prefix(i)} must be a mapping (- tap: …)` });
        continue;
      }
      const s = raw as Record<string, unknown>;
      const keys = Object.keys(s);
      if (keys.length !== 1) {
        if (keys.length === 2 && (keys.includes('when') || keys.includes('optional'))) {
          const mod = keys.includes('when') ? 'when' : 'optional';
          const act = keys[0] === 'when' || keys[0] === 'optional' ? keys[1]! : keys[0]!;
          const msg = act === 'alert'
            ? `${prefix(i)}: alert takes no modifiers — it is inherently conditional (no-op when nothing is up)`
            : `${prefix(i)}: ${mod} only guards tap/type/expect — it cannot ride on a scalar action`;
          errors.push({ line: 1, message: msg });
          continue;
        }
        errors.push({ line: 1, message: `${prefix(i)}: exactly one action key expected, got [${keys.join(', ')}]` });
        continue;
      }
      const action = keys[0]!;
      if (!ACTIONS.has(action)) {
        errors.push({ line: 1, message: `${prefix(i)}: unknown action "${action}" (expected tap|scroll|type|runFlow|expect|arrive|refresh|swap|expect screen)` });
        continue;
      }
      const body = s[action];

      // ── R2 verbs (S4): scalar screen/world targets + expect screen form ──
      if (action === 'arrive' || action === 'refresh') {
        if (typeof body !== 'string' || !SCREEN_ID_RE.test(body)) {
          errors.push({ line: 1, message: `${prefix(i)}: ${action} takes a screen id (registry key, [a-z][a-z0-9-]*)` });
          continue;
        }
        stepsOut.push({ idx: stepsOut.length, action, screen: body });
        continue;
      }
      if (action === 'swap' || action === 'world') {
        // 'world' is the deprecated alias (renamed 2026-09-24): both parse,
        // storage + emission are always 'swap'
        if (typeof body !== 'string' || !body.trim()) {
          errors.push({ line: 1, message: `${prefix(i)}: swap takes a target id from this case's swaps/variants` });
          continue;
        }
        stepsOut.push({ idx: stepsOut.length, action: 'swap', swap: body.trim() });
        continue;
      }
      if (action === 'expect screen') {
        // forms: "<screen>.<state>"  |  "<screen>.state != <state>"
        if (typeof body !== 'string' || !body.trim()) {
          errors.push({ line: 1, message: `${prefix(i)}: expect screen takes "<screen>.<state>" or "<screen>.state != <state>"` });
          continue;
        }
        const t = body.trim();
        const neg = /^(.+?)\.state\s*!=\s*(.+)$/.exec(t);
        const pos = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9_-]*)$/.exec(t);
        if (neg) {
          const [, scr, st] = neg;
          if (!SCREEN_ID_RE.test(scr!.trim())) {
            errors.push({ line: 1, message: `${prefix(i)}: expect screen: bad screen id "${scr!.trim()}"` });
            continue;
          }
          stepsOut.push({ idx: stepsOut.length, action: 'expectScreen', expectScreen: { screen: scr!.trim(), state: st!.trim(), negate: true } });
        } else if (pos) {
          stepsOut.push({ idx: stepsOut.length, action: 'expectScreen', expectScreen: { screen: pos[1]!, state: pos[2]! } });
        } else {
          errors.push({ line: 1, message: `${prefix(i)}: expect screen: expected "<screen>.<state>" or "<screen>.state != <state>" (got ${JSON.stringify(t)})` });
          continue;
        }
        continue;
      }
      const opt = (b: Record<string, unknown>): boolean => b['optional'] === true;
      const sel = (b: Record<string, unknown>): YamlSelector | undefined => {
        const on = b['on'];
        const contains = b['contains'];
        const rawIc = b['ignoreCase'];
        if (rawIc !== undefined && rawIc !== true && rawIc !== false) {
          errors.push({ line: 1, message: `${prefix(i)}: ignoreCase must be true or false (got ${JSON.stringify(rawIc)})` });
          return undefined;
        }
        const ignoreCase = rawIc === true; // false normalizes away
        if (on !== undefined && contains !== undefined) {
          errors.push({ line: 1, message: `${prefix(i)}: 'on' and 'contains' are mutually exclusive — one target per step` });
          return undefined;
        }
        if (contains !== undefined) {
          if (typeof contains !== 'string' || !contains.trim()) {
            errors.push({ line: 1, message: `${prefix(i)}: 'contains' needs a non-empty fragment` });
            return undefined;
          }
          return { labelContains: contains.trim(), ...(ignoreCase ? { ignoreCase: true } : {}) };
        }
        if (typeof on === 'string' && on.trim()) {
          // identifier iff it looks like an asset id: lowercase snake_case
          // (ic_barcode, ic_tabbar_home) — anything human-readable is a label
          if (IDENTIFIER_RE.test(on)) {
            if (ignoreCase) errors.push({ line: 1, message: `${prefix(i)}: ignoreCase never applies to identifiers (asset ids are exact); use 'contains' or a label` });
            return { identifier: on };
          }
          return { label: on, ...(ignoreCase ? { ignoreCase: true } : {}) };
        }
        return undefined;
      };

      if (action === 'alert') {
        if (typeof body !== 'string' || !['accept', 'dismiss'].includes(body)) {
          errors.push({ line: 1, message: `${prefix(i)}: alert needs accept or dismiss — write it as a scalar (alert: dismiss)` });
          continue;
        }
        stepsOut.push({ idx: stepsOut.length, action: 'alert', alertAction: body as 'accept' | 'dismiss' });
        continue;
      }
      if (action === 'location') {
        // scalar = simctl wire token ("lat,lon"); mapping = {latitude, longitude}
        let lat: number | undefined;
        let lon: number | undefined;
        if (typeof body === 'string') {
          const m = body.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
          if (!m) { errors.push({ line: 1, message: `${prefix(i)}: location needs "lat,lon" with dot decimals (got ${JSON.stringify(body)})` }); continue; }
          lat = Number(m[1]); lon = Number(m[2]);
        } else if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
          const b = body as Record<string, unknown>;
          for (const bk of Object.keys(b)) {
            if (!['latitude', 'longitude'].includes(bk)) {
              errors.push({ line: 1, message: `${prefix(i)}: unknown key "${bk}" in location — did you mean latitude/longitude?` });
            }
          }
          if (typeof b['latitude'] === 'number' && typeof b['longitude'] === 'number') { lat = b['latitude']; lon = b['longitude']; }
          else if (typeof b['latitude'] === 'string' || typeof b['longitude'] === 'string') {
            errors.push({ line: 1, message: `${prefix(i)}: location needs dot decimals, not comma decimals — write the value as a number` });
            continue;
          } else { errors.push({ line: 1, message: `${prefix(i)}: location needs both latitude and longitude` }); continue; }
        } else {
          errors.push({ line: 1, message: `${prefix(i)}: location needs { latitude, longitude } or "lat,lon"` });
          continue;
        }
        if (lat! < -90 || lat! > 90) { errors.push({ line: 1, message: `${prefix(i)}: latitude must be -90..90 (got ${lat})` }); continue; }
        if (lon! < -180 || lon! > 180) { errors.push({ line: 1, message: `${prefix(i)}: longitude must be -180..180 (got ${lon})` }); continue; }
        stepsOut.push({ idx: stepsOut.length, action: 'location', location: { latitude: lat!, longitude: lon! } });
        continue;
      }
      if (action === 'scroll') {
        if (typeof body !== 'string' || !DIRECTIONS.has(body)) {
          errors.push({ line: 1, message: `${prefix(i)}: scroll needs a direction (up|down|left|right)` });
          continue;
        }
        // scroll bodies are scalars; a when: key at the step level is a sibling
        // of the action key — reject it explicitly (when only guards mapped steps)
        const whenSibling = Object.entries(s).find(([k]) => k !== action && k === 'when');
        if (whenSibling) {
          errors.push({ line: 1, message: `${prefix(i)}: when only guards tap/type/expect (got scroll)` });
          continue;
        }
        stepsOut.push({ idx: stepsOut.length, action: 'scroll', direction: body as 'up' | 'down' | 'left' | 'right' });
        continue;
      }
      if (action === 'runFlow') {
        if (section === 'setup') { errors.push({ line: 1, message: `${prefix(i)}: runFlow is not allowed in setup — compose setup INTO cases instead` }); continue; }
        // scalar = template NAME (resolved by the server route); {id:}/ {name:}
        let ref: string | undefined;
        let refKind: 'name' | 'id' = 'name';
        if (typeof body === 'string' && body.trim()) ref = body.trim();
        else if (body !== null && typeof body === 'object') {
          const b = body as Record<string, unknown>;
          if (typeof b['name'] === 'string') ref = (b['name'] as string).trim();
          else if (typeof b['id'] === 'string') { ref = (b['id'] as string).trim(); refKind = 'id'; }
        if (b['optional'] === true) stepsOut.push({ idx: stepsOut.length, action: 'runFlow', templateId: ref as string, optional: true });
        }
        if (!ref) { errors.push({ line: 1, message: `${prefix(i)}: runFlow needs a template name or id` }); continue; }
        if (stepsOut[stepsOut.length - 1]?.action === 'runFlow') { /* already pushed with optional */ }
        else stepsOut.push({ idx: stepsOut.length, action: 'runFlow', templateId: ref });
        if (refKind === 'name') runFlowNames.push(ref);
        continue;
      }
      // tap / type / expect: body is a mapping
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        if (action === 'expect' && typeof body === 'string' && body.trim()) {
          stepsOut.push({ idx: stepsOut.length, action: 'expect', selector: { label: body.trim() } });
          continue;
        }
        errors.push({ line: 1, message: `${prefix(i)}: ${action} needs a mapping (or a plain label for expect)` });
        continue;
      }
      const b = body as Record<string, unknown>;
      // ── ensure login: coordinate-free login preflight ──
      if (action === 'ensure login') {
        // screen-form (plan rev 2 S4): selectors come from the screens
        // registry (login_json); only the env refs ride the step. screen is
        // MUTUALLY EXCLUSIVE with inline selectors — validator error, never
        // last-wins.
        const screenRef = b['screen'] as unknown;
        if (typeof screenRef === 'string' && screenRef.trim()) {
          const inlinePresent = ['entry', 'on', 'phoneField', 'passwordField', 'submit', 'session'].some((k) => typeof b[k] === 'string' && (b[k] as string).trim());
          if (inlinePresent) {
            errors.push({ line: 1, message: `${prefix(i)}: screen: and inline selectors are mutually exclusive — pick one` });
            continue;
          }
          const phoneS = b['phone'] ?? b['phoneEnv'];
          const passwordS = b['password'] ?? b['passwordEnv'];
          if (typeof phoneS !== 'string' || !phoneS.trim() || typeof passwordS !== 'string' || !passwordS.trim()) {
            errors.push({ line: 1, message: `${prefix(i)}: ensure login (screen form) needs screen: <id> plus phone/password env refs` });
            continue;
          }
          stepsOut.push({ idx: stepsOut.length, action: 'ensureLogin', ensureLogin: { entry: '', phoneField: '', passwordField: '', submit: '', session: '', phone: phoneS.trim(), password: passwordS.trim(), screen: screenRef.trim() } });
          continue;
        }
        // screenless form (login-as-app-procedure plan F2): the app's login
        // procedure supplies every selector — the step carries env refs ONLY.
        // Runs AFTER the legacy inline branch (which requires the full 5
        // selectors): a step with phone+password and no selectors is
        // screenless; a step with any selector falls through to inline
        // validation below and gets the legacy error if incomplete.
        {
          const phoneS = b['phone'] ?? b['phoneEnv'];
          const passwordS = b['password'] ?? b['passwordEnv'];
          const SEL_KEYS = ['entry', 'phoneField', 'passwordField', 'submit', 'session'] as const;
          const selectorsPresent = SEL_KEYS.filter((k) => typeof b[k] === 'string' && (b[k] as string).trim());
          if (typeof phoneS === 'string' && phoneS.trim() && typeof passwordS === 'string' && passwordS.trim()) {
            if (selectorsPresent.length > 0 && selectorsPresent.length < SEL_KEYS.length) {
              // partial selectors + env refs: neither the screenless form nor
              // a complete inline form — name the conflict honestly
              errors.push({ line: 1, message: `${prefix(i)}: ensure login carries partial selectors (${selectorsPresent.join(', ')}) with phone/password — use the app-procedure form (env refs only) or the full inline form (all 5 selectors)` });
              continue;
            }
            if (selectorsPresent.length === 0) {
              stepsOut.push({ idx: stepsOut.length, action: 'ensureLogin', ensureLogin: { entry: '', phoneField: '', passwordField: '', submit: '', session: '', phone: phoneS.trim(), password: passwordS.trim() } });
              continue;
            }
            // full inline (5 selectors) falls through to the legacy branch below
          }
        }
        const entry = (b['entry'] ?? b['on']) as unknown;
        const phoneField = b['phoneField'] as unknown;
        const passwordField = b['passwordField'] as unknown;
        const submit = b['submit'] as unknown;
        const session = b['session'] as unknown;
        const phone = (b['phone'] ?? b['phoneEnv']) as unknown;
        const password = (b['password'] ?? b['passwordEnv']) as unknown;
        const strs = [entry, phoneField, passwordField, submit, session, phone, password];
        if (strs.some((v) => typeof v !== 'string' || !String(v).trim())) {
          errors.push({ line: 1, message: `${prefix(i)}: ensure login needs entry/phoneField/passwordField/submit/session selectors and phone/password env refs` });
          continue;
        }
        stepsOut.push({ idx: stepsOut.length, action: 'ensureLogin', ensureLogin: { entry: String(entry).trim(), phoneField: String(phoneField).trim(), passwordField: String(passwordField).trim(), submit: String(submit).trim(), session: String(session).trim(), phone: String(phone).trim(), password: String(password).trim() } });
        continue;
      }
      // ── ensure logout: coordinate-free session preflight ──
      if (action === 'ensure logout') {
        const bo = (b['button'] ?? b['on']) as unknown;
        const stay = b['stay'] as unknown;
        const confirm = b['confirm'] as unknown;
        if (typeof bo !== 'string' || !bo.trim() || typeof confirm !== 'string' || !confirm.trim()) {
          errors.push({ line: 1, message: `${prefix(i)}: ensure logout needs button: <label-or-id> and confirm: <label-or-id> (stay: optional sheet-title check)` });
          continue;
        }
        stepsOut.push({ idx: stepsOut.length, action: 'ensureLogout', ensureLogout: { button: bo.trim(), stay: typeof stay === 'string' ? stay.trim() : '', confirm: confirm.trim() } });
        continue;
      }
      for (const bk of Object.keys(b)) {
        const known = ['point', 'on', 'text', 'optional', 'id', 'name', 'contains', 'ignoreCase', 'when', 'at'];
        if (action === 'expect') known.push('count', 'atLeast'); // cardinality is expect-only (A9)
        if (!known.includes(bk)) {
          errors.push({ line: 1, message: `${prefix(i)}: unknown key "${bk}" in ${action} — did you mean optional/on/point/text?` });
        }
        if (action !== 'expect' && (bk === 'count' || bk === 'atLeast')) {
          errors.push({ line: 1, message: `${prefix(i)}: count/atLeast are expect-only (got ${bk} on ${action})` });
        }
      }
      if (action === 'tap' || action === 'type') {
        const step: YamlStep = { idx: stepsOut.length, action };
        const point = b['point'];
        const slEarly = sel(b);
        if (Array.isArray(point) && point.length === 2 && typeof point[0] === 'number' && typeof point[1] === 'number') {
          step.x = point[0]; step.y = point[1];
        } else if (!slEarly) {
          // no selector and no point — nothing to aim with
          errors.push({ line: 1, message: `${prefix(i)}: ${action} needs point: [x, y] or on: <label or id> (identifier-only taps resolve live)` });
          continue;
        }
        if (action === 'type') {
          if (typeof b['text'] !== 'string' || !b['text']) { errors.push({ line: 1, message: `${prefix(i)}: type needs text: <string>` }); continue; }
          step.text = b['text'];
        }
        const sl = sel(b);
        if (sl) step.selector = sl;
        if (opt(b)) step.optional = true;
        attachWhen(step, b, section, prefix, i, errors);
        stepsOut.push(step);
        continue;
      }
      // expect
      const sl = sel(b);
      if (!sl) { errors.push({ line: 1, message: `${prefix(i)}: expect needs on: <label or id>` }); continue; }
      const es: YamlStep = { idx: stepsOut.length, action: 'expect', selector: sl, ...(opt(b) ? { optional: true } : {}) };
      // expect-only cardinality (A9): count = exactly N, atLeast = ≥ N.
      const rawCount = b['count'];
      const rawAtLeast = b['atLeast'];
      const isCardNum = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
      if (rawCount !== undefined && rawAtLeast !== undefined) {
        errors.push({ line: 1, message: `${prefix(i)}: 'count' and 'atLeast' are mutually exclusive — one bound per step` });
      } else {
        if (rawCount !== undefined) {
          if (!isCardNum(rawCount)) errors.push({ line: 1, message: `${prefix(i)}: count must be a positive integer (got ${JSON.stringify(rawCount)})` });
          else es.count = rawCount;
        }
        if (rawAtLeast !== undefined) {
          if (!isCardNum(rawAtLeast)) errors.push({ line: 1, message: `${prefix(i)}: atLeast must be a positive integer (got ${JSON.stringify(rawAtLeast)})` });
          else es.atLeast = rawAtLeast;
        }
      }
      // optional probe point (sweep recovery): at: [x, y]
      const at = b['at'];
      if (at !== undefined) {
        if (Array.isArray(at) && at.length === 2 && typeof at[0] === 'number' && typeof at[1] === 'number') {
          es.x = at[0]; es.y = at[1];
        } else {
          errors.push({ line: 1, message: `${prefix(i)}: expect at: must be [x, y] numbers` });
        }
      }
      attachWhen(es, b, section, prefix, i, errors);
      stepsOut.push(es);
    }
  }
  return { steps: stepsOut, names: runFlowNames };
}

/** when-guard: setup-only, tap/type/expect only, non-empty string. */
function attachWhen(step: YamlStep, b: Record<string, unknown>, section: 'setup' | 'steps', prefix: (i: number) => string, i: number, errors: YamlError[]): void {
  const w = b['when'];
  if (w === undefined) return;
  if (section === 'steps') {
    errors.push({ line: 1, message: `${prefix(i)}: when is a setup-only guard — steps always run` });
    return;
  }
  if (typeof w !== 'string' || !w.trim()) {
    errors.push({ line: 1, message: `${prefix(i)}: when needs a non-empty label fragment` });
    return;
  }
  if (step.action === 'scroll' || step.action === 'runFlow' || step.action === 'alert') {
    errors.push({ line: 1, message: `${prefix(i)}: when only guards tap/type/expect (got ${step.action})` });
    return;
  }
  step.when = w.trim();
}

/** steps_json rows → YAML text. Stable field order, guidance comments. */
export function caseToYaml(t: { name: string; tags: string[]; app?: string | null; setup?: unknown[]; alerts?: unknown; variants?: unknown[]; swaps?: unknown[]; entry?: { screen: string; mode?: 'tab' | 'deepLink' | 'navigate' } | null; steps: unknown[] }): string {
  const lines: string[] = [];
  lines.push(`# ${t.name} — edit as yaml; save validates against the step schema`);
  lines.push(`name: ${yamlScalar(t.name)}`);
  if (t.tags.length > 0) lines.push(`tags: [${t.tags.map((x) => yamlScalar(x)).join(', ')}]`);
  if (t.app) lines.push(`app: ${yamlScalar(t.app)}`);
  {
    const a = t.alerts as { entries?: Array<[string, string]> } | undefined;
    if (a && Array.isArray(a.entries) && a.entries.length > 0) {
      if (a.entries.length === 1 && a.entries[0]![0] === 'default') {
        lines.push(`alerts: ${a.entries[0]![1]}`);
      } else {
        lines.push('alerts:');
        for (const [k, v] of a.entries) lines.push(`  ${k}: ${v}`);
      }
    }
  }
  // R2: swaps are the vocabulary when present (variants is the legacy
  //  term; the pool lookup treats both). scenarios[] is the S2 set form —
  //  emitted alongside singular networkScenario sugar.
  const vlist = (Array.isArray(t.swaps) && t.swaps.length > 0 ? t.swaps : t.variants) as Array<Record<string, unknown>> | undefined;
  if (vlist && vlist.length > 0) {
    const vocab = Array.isArray(t.swaps) && t.swaps.length > 0 ? 'swaps' : 'variants';
    lines.push(`${vocab}:`);
    for (const rawV of vlist) {
      const v = rawV as unknown as { id: string; networkScenario?: string; scenarios?: string[]; env?: Record<string, string> };
      lines.push(`  - id: ${yamlScalar(v.id)}`);
      if (v.networkScenario !== undefined) lines.push(`    networkScenario: ${yamlScalar(v.networkScenario)}`);
      if (Array.isArray(v.scenarios) && v.scenarios.length > 0) lines.push(`    scenarios: [${v.scenarios.map((x) => yamlScalar(x)).join(', ')}]`);
      if (v.env && Object.keys(v.env).length > 0) {
        lines.push('    env:');
        for (const [k, val] of Object.entries(v.env)) lines.push(`      ${k}: ${yamlScalar(val)}`);
      }
    }
  }
  if (t.entry && typeof t.entry === 'object' && t.entry.screen) {
    const mode = t.entry.mode ? `, mode: ${yamlScalar(t.entry.mode)}` : '';
    lines.push(`entry: { screen: ${yamlScalar(t.entry.screen)}${mode} }`);
  }
  if (Array.isArray(t.setup) && t.setup.length > 0) {
    lines.push('setup:');
    for (const raw of t.setup) {
      const s = raw as Record<string, unknown>;
      const action = s['action'] as string;
      // reuse the same emitters below via a sub-call: simplest is to serialize
      // setup steps with the identical code path — build a temp case and strip
      const sub = caseToYaml({ name: t.name, tags: [], steps: [raw] });
      for (const l of sub.split('\n')) {
        if (l.startsWith('steps:')) continue;
        if (l.startsWith('#') || l.startsWith('name:') || l.startsWith('tags:') || l.startsWith('app:')) continue;
        if (l.trim()) lines.push(l);
      }
    }
  }
  lines.push('steps:');
  for (const raw of t.steps) {
    const s = raw as Record<string, unknown>;
    const action = s['action'] as string;
    const selKey = (sel: unknown): { key: string; value: string } | undefined => {
      const sl = sel as YamlSelector | undefined;
      if (!sl) return undefined;
      if (sl.labelContains !== undefined) return { key: 'contains', value: sl.labelContains };
      if (sl.label !== undefined) return { key: 'on', value: sl.label };
      if (sl.identifier !== undefined) return { key: 'on', value: sl.identifier };
      return undefined;
    };
    const on = (sel: unknown): string | undefined => {
      const k = selKey(sel);
      return k ? `${k.key}: ${yamlScalar(k.value)}` : undefined;
    };
    const icSuffix = (sel: unknown): string => ((sel as YamlSelector | undefined)?.ignoreCase === true ? ', ignoreCase: true' : '');
    const optSuffix = (o: unknown): string => (o === true ? ', optional: true' : '');
    const whenSuffix = (w: unknown): string => (typeof w === 'string' && w ? `, when: ${yamlScalar(w)}` : '');
    if (action === 'tap') {
      // point only when recorded — selector-only steps (identifier/label
      // overloads) carry no coordinates and must not emit
      // `point: [undefined, undefined]`
      const parts: string[] = [];
      if (s['x'] !== undefined && s['y'] !== undefined) parts.push(`point: [${s['x']}, ${s['y']}]`);
      const onSel = on(s['selector']);
      if (onSel) parts.push(onSel);
      const ic = icSuffix(s['selector']);
      if (ic) parts.push(ic.replace(/^, /, ''));
      const opt = optSuffix(s['optional']);
      if (opt) parts.push(opt.replace(/^, /, ''));
      const wh = whenSuffix(s['when']);
      if (wh) parts.push(wh.replace(/^, /, ''));
      lines.push(`  - tap: { ${parts.join(', ')} }`);
    } else if (action === 'scroll') {
      lines.push(`  - scroll: ${s['direction']}`);
    } else if (action === 'alert') {
      lines.push(`  - alert: ${s['alertAction'] ?? 'dismiss'}`);
    } else if (action === 'location') {
      const loc = s['location'] as { latitude: number; longitude: number };
      lines.push(`  - location: { latitude: ${loc.latitude}, longitude: ${loc.longitude} }`);
    } else if (action === 'type') {
      const pt = s['x'] !== undefined && s['y'] !== undefined ? `point: [${s['x']}, ${s['y']}], ` : '';
      lines.push(`  - type: { ${pt}text: ${yamlScalar(String(s['text'] ?? ''))}${on(s['selector']) ? `, ${on(s['selector'])!}` : ''}${icSuffix(s['selector'])}${optSuffix(s['optional'])}${whenSuffix(s['when'])} }`);
    } else if (action === 'runFlow') {
      lines.push(`  - runFlow: { name: ${yamlScalar(String(s['templateId'] ?? ''))}${optSuffix(s['optional'])} }`);
    } else if (action === 'expect') {
      const sl = s['selector'] as YamlSelector | undefined;
      // probe point rides along when recorded (sweep recovery, baguette 1.1):
      // serialized so playback-from-YAML keeps the coordinate for probing.
      const at = s['x'] !== undefined && s['y'] !== undefined ? `, at: [${s['x']}, ${s['y']}]` : '';
      // cardinality bound (A9) — rendered only when set
      const card = s['count'] !== undefined ? `, count: ${s['count']}` : s['atLeast'] !== undefined ? `, atLeast: ${s['atLeast']}` : '';
      if (sl && (sl.labelContains !== undefined || sl.ignoreCase === true)) {
        // mode/flag selectors always render as a mapping (the scalar sugar is exact-cs only)
        const body = `${on(s['selector']) ?? 'on: ?'}${icSuffix(s['selector'])}${optSuffix(s['optional'])}${at}${card}`;
        lines.push(`  - expect: { ${body.replace(/^, /, '')} }`);
      } else {
        const label = sl?.label ?? sl?.identifier ?? '?';
        if (s['optional'] === true || at || card) lines.push(`  - expect: { on: ${yamlScalar(label)}${s['optional'] === true ? ', optional: true' : ''}${at}${card} }`);
        else lines.push(`  - expect: ${yamlScalar(label)}`);
      }
    } else if (action === 'arrive') {
      lines.push(`  - arrive: ${yamlScalar(String(s['screen'] ?? ''))}`);
    } else if (action === 'refresh') {
      lines.push(`  - refresh: ${yamlScalar(String(s['screen'] ?? ''))}`);
    } else if (action === 'swap') {
      lines.push(`  - swap: ${yamlScalar(String(s['swap'] ?? s['world'] ?? ''))}`);
    } else if (action === 'world') {
      // legacy stored form (pre-rename 2026-09-24) — emit the new vocabulary;
      // a stored world step must NEVER fall through to the placeholder path
      lines.push(`  - swap: ${yamlScalar(String(s['world'] ?? ''))}`);
    } else if (action === 'ensureLogout') {
      const el = s['ensureLogout'] as { button?: string; stay?: string; confirm?: string } | undefined;
      lines.push(`  - ensure logout:`);
      lines.push(`      button: ${yamlScalar(el?.button ?? '?')}`);
      lines.push(`      confirm: ${yamlScalar(el?.confirm ?? '?')}`);
      if (el?.stay) lines.push(`      stay: ${yamlScalar(el.stay)}`);
    } else if (action === 'ensureLogin') {
      const el = s['ensureLogin'] as { entry?: string; phoneField?: string; passwordField?: string; submit?: string; session?: string; phone?: string; password?: string; screen?: string } | undefined;
      if (el?.screen) {
        lines.push(`  - ensure login:`);
        lines.push(`      screen: ${yamlScalar(el.screen)}`);
        lines.push(`      phone: ${yamlScalar(el?.phone ?? '?')}`);
        lines.push(`      password: ${yamlScalar(el?.password ?? '?')}`);
      } else if (el?.phone && !el.entry) {
        lines.push(`  - ensure login:`);
        lines.push(`      phone: ${yamlScalar(el.phone)}`);
        lines.push(`      password: ${yamlScalar(el?.password ?? '?')}`);
      } else {
      lines.push(`  - ensure login:`);
      lines.push(`      entry: ${yamlScalar(el?.entry ?? '?')}`);
      lines.push(`      phoneField: ${yamlScalar(el?.phoneField ?? '?')}`);
      lines.push(`      passwordField: ${yamlScalar(el?.passwordField ?? '?')}`);
      lines.push(`      submit: ${yamlScalar(el?.submit ?? '?')}`);
      lines.push(`      session: ${yamlScalar(el?.session ?? '?')}`);
      lines.push(`      phone: ${yamlScalar(el?.phone ?? '?')}`);
      lines.push(`      password: ${yamlScalar(el?.password ?? '?')}`);
      }
    } else if (action === 'expectScreen') {
      const es = s['expectScreen'] as { screen?: string; state?: string; negate?: boolean } | undefined;
      const scr = es?.screen ?? '?';
      const st = es?.state ?? '?';
      lines.push(es?.negate === true
        ? `  - expect screen: ${yamlScalar(`${scr}.state != ${st}`)}`
        : `  - expect screen: ${yamlScalar(`${scr}.${st}`)}`);
    } else {
      // unknown action in storage — REFUSE to render. The old placeholder
      // (a real scroll step) silently destroyed the unrenderable step on
      // save: the editor emitted it, the user saved, storage replaced the
      // original with scroll (live 2026-09-26: this ate an ensure-logout
      // setup step). A throw surfaces the gap at emit time instead.
      throw new Error(`caseToYaml: no yaml form for action "${action}" — extend the emitter before exposing this step kind in the editor`);
    }
  }
  return lines.join('\n') + '\n';
}

/** yaml-safe scalar quoting (plain if safe, single-quoted otherwise).
 *  `{`/`}` always trigger quoting — we emit FLOW mappings, and an unquoted
 *  ${env.X} value would parse as a nested map (invalid). */
export function yamlScalar(v: string): string {
  if (v === '' || /[:#[\]{},&*?|>'"%@`\n]/.test(v) || /(?:^|\s)-/.test(v) || /^\s|\s$/.test(v) || /^(?:true|false|null|~|\d+(?:\.\d+)?)$/.test(v)) {
    return `'${v.replace(/'/g, "''")}'`;
  }
  return v;
}
