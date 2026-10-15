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
  action: 'tap' | 'scroll' | 'type' | 'runFlow' | 'expect' | 'alert' | 'location' | 'arrive' | 'refresh' | 'swap' | 'expectScreen' | 'ensureLogout' | 'ensureLogin' | 'doubleTap' | 'longPress' | 'shake' | 'paste' | 'wait';
  x?: number; y?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  text?: string;
  /** long-press dwell in ms (default 800 at playback) */
  dwellMs?: number;
  /** paste: false = pasteboard-only (apps reading UIPasteboard directly) */
  press?: boolean;
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
  /** OPTIONAL human acceptance-criteria line (Gherkin Given/When/Then/And/But).
   *  Display-only: rides parse→emit round-trip, persists on run_steps, renders
   *  in the run panel. Never affects matching, dispatch, or pass/fail. Single
   *  line; non-Gherkin text warns, never errors. */
  narrate?: string;
  /** location action target — simulated GPS point (simctl location set) */
  location?: { latitude: number; longitude: number };
  /** R2 verbs — arrive: <screen-id>, refresh: <screen-id>, swap: <target-id> */
  screen?: string;
  /** ensure logout: if a session indicator is visible, walk the app's logout
   *  flow (list button → confirm sheet) by IDENTIFIER first, label second —
   *  coordinate-free, cross-device safe. No-op pass when already logged out. */
  ensureLogout?: { recipe?: 'app'; button?: string; stay?: string; confirm?: string; via?: string; back?: string };
  ensureLogin?: { recipe?: 'app'; entry?: string; phoneField?: string; passwordField?: string; submit?: string; session?: string; phone?: string; password?: string; screen?: string };
  /** swap: <id from this case's swaps/variants> */
  swap?: string;
  /** expect screen: "<screen>.<state>" — parsed into parts; negate for != */
  expectScreen?: { screen: string; state: string; negate?: boolean };
  /** wait step (plan 20261015T221500Z): time form (ms, optional reason) or
   *  condition form — poll until the target holds or timeout. Bare until-string
   *  resolves identifier-first then label (the on: precedent). */
  wait?:
    | { mode: 'time'; ms: number; for?: string }
    | { mode: 'until'; target: { kind: 'identifier' | 'text' | 'screen'; value: string; state?: string }; timeoutMs: number };
}
export interface YamlCase {
  name: string;
  tags: string[];
  app?: string;
  /** folder path (a/b/c) — informational on export; the import resolves or
   *  creates the chain; the editor save path ignores it (F3) */
  folder?: string;
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
const ACTIONS = new Set(['tap', 'scroll', 'type', 'runFlow', 'expect', 'alert', 'location', 'arrive', 'refresh', 'swap', 'world', 'expect screen', 'ensure logout', 'ensure login', 'double-tap', 'long-press', 'shake', 'paste', 'wait']);
const SCREEN_ID_RE = /^[a-z][a-z0-9-]*$/;
/** wait durations: "500ms" | "1s" | bare 1500 (=ms). Bounds (review R3):
 *  time form ≤60s, condition timeout ≤120s. Returns ms or an error string. */
export function parseWaitDuration(raw: unknown, maxMs: number): number | string {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    if (raw > maxMs) return `duration ${raw}ms exceeds the ${maxMs}ms limit`;
    return Math.round(raw);
  }
  if (typeof raw === 'string') {
    const m = /^(\d+)(ms|s)?$/.exec(raw.trim());
    if (!m) return `bad duration ${JSON.stringify(raw)} — write like 500ms or 1s`;
    const n = Number(m[1]!);
    const ms = m[2] === 's' ? n * 1000 : n;
    if (ms > maxMs) return `duration ${raw} exceeds the ${maxMs}ms limit`;
    return ms;
  }
  return `bad duration ${JSON.stringify(raw)} — write like 500ms or 1s`;
}
/** runFlow references: name → id resolution is the CALLER's job (needs the DB);
 * the validator accepts both shapes and reports unresolved names. */
export interface RunFlowRefs { names: string[] }

/** Parse + validate YAML text → { case, errors }. Errors carry YAML line
 *  numbers (from the yaml lib's source context). Never throws. */
/** Parse a bare step LIST fragment (recipe steps — login-as-steps plan
 *  20260930T044550Z F3): same grammar as case steps, no document wrapper.
 *  Errors carry step-indexed prefixes. */
export function parseStepsFragment(steps: unknown[]): { steps: YamlStep[]; errors: YamlError[] } {
  const errors: YamlError[] = [];
  const warnings: YamlError[] = [];
  const r = parseStepList(steps, 'steps', (i) => `login step ${i + 1}`, errors, warnings);
  return { steps: r.steps, errors };
}

export function parseCaseYaml(text: string, opts?: { hasLogoutRecipe?: (appBundleId: string | null | undefined) => boolean; hasLoginRecipe?: (appBundleId: string | null | undefined) => boolean }): { ok: boolean; case: YamlCase | null; errors: YamlError[]; runFlowNames: string[]; warnings: YamlError[] } {
  const errors: YamlError[] = [];
  let doc: unknown;
  try {
    doc = parse(text, { merge: false });
  } catch (err) {
    const e = err as { message?: string; linePos?: Array<{ line: number }> | [number, number] };
    // yaml v2: linePos is [{line, col}, {line, col}] (range); older docs say [line, col]
    const lp = e.linePos;
    const line = Array.isArray(lp) && lp.length > 0 ? (typeof lp[0] === 'number' ? (lp[0] as number) : (lp[0] as { line: number }).line) : 1;
    return { ok: false, case: null, errors: [{ line, message: e.message ?? 'invalid yaml' }], runFlowNames: [], warnings: [] };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, case: null, errors: [{ line: 1, message: 'the case must be a yaml mapping (name:, tags:, steps:…)' }], runFlowNames: [], warnings: [] };
  }
  const c = doc as Record<string, unknown>;
  const warnings: YamlError[] = [];
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
  // folder path (a/b/c) — informational; accepted here so exports re-parse,
  // CONSUMED only by the import route (editor saves ignore it — F3)
  const folder = typeof c['folder'] === 'string' ? (c['folder'] as string).trim() : undefined;

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
      const r = parseStepList(c['setup'] as unknown[], 'setup', i => `setup step ${i + 1}`, errors, warnings, { app, hasLogoutRecipe: opts?.hasLogoutRecipe, hasLoginRecipe: opts?.hasLoginRecipe });
      setupOut = r.steps;
    }
  }

  // steps
  const stepsOut: YamlStep[] = [];
  const runFlowNames: string[] = [];
  if (!Array.isArray(c['steps']) || (c['steps'] as unknown[]).length === 0) {
    errors.push({ line: 1, message: 'steps is required and must be a non-empty list — a case must do something' });
  } else {
    const r = parseStepList(c['steps'] as unknown[], 'steps', i => `step ${i + 1}`, errors, warnings, { app, hasLogoutRecipe: opts?.hasLogoutRecipe, hasLoginRecipe: opts?.hasLoginRecipe });
    stepsOut.push(...r.steps);
    runFlowNames.push(...r.names);
  }
  if (errors.length > 0) return { ok: false, case: null, errors, runFlowNames, warnings };
  const outCase: YamlCase = { name, tags, ...(app ? { app } : {}), ...(folder ? { folder } : {}), ...(setupOut ? { setup: setupOut } : {}), ...(alerts ? { alerts } : {}), ...(variantsOut ? { variants: variantsOut } : {}), steps: stepsOut };
  if (worldsOut) outCase.swaps = worldsOut;
  if (entry) outCase.entry = entry;
  return { ok: true, case: outCase, errors: [], runFlowNames, warnings };
}

/** One step list (steps: or setup:) → validated steps + runFlow name refs.
 *  section names the list for error prefixing and gates setup-only rules. */
function parseStepList(steps: unknown[], section: 'setup' | 'steps', prefix: (i: number) => string, errors: YamlError[], warnings: YamlError[], ctx?: { app?: string | undefined; hasLogoutRecipe?: ((appBundleId: string | null | undefined) => boolean) | undefined; hasLoginRecipe?: ((appBundleId: string | null | undefined) => boolean) | undefined }): { steps: YamlStep[]; names: string[] } {
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
      // narrate (optional per-step AC line): lift BEFORE anything pushes, validate,
      // stamp on every step this iteration produces at iteration end (finally —
      // every `continue` path stamps too; review F1)
      const lenBefore = stepsOut.length;
      const rawNarrate = s['narrate'];
      let narrate: string | undefined;
      if (rawNarrate !== undefined) {
        if (typeof rawNarrate !== 'string' || !rawNarrate.trim()) {
          errors.push({ line: 1, message: `${prefix(i)}: narrate needs a non-empty single-line string (Gherkin Given/When/Then/And/But)` });
        } else if (rawNarrate.includes('\n')) {
          errors.push({ line: 1, message: `${prefix(i)}: narrate must be a single line — multi-line AC is a case-level feature` });
        } else {
          narrate = rawNarrate.trim();
          if (!/^(given|when|then|and|but)\b/i.test(narrate)) {
            warnings.push({ line: 1, message: `${prefix(i)}: narrate is not Gherkin (expected Given/When/Then/And/But) — prose accepted` });
          }
        }
      }
      const keys = Object.keys(s).filter((k) => k !== 'narrate');
      try {
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
      // narrate may ride INSIDE the action body (- tap: { point: …, narrate: … });
      // lift+strip it here, once, before ANY branch consumes the body (the
      // per-branch key whitelists must never see it)
      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        const bm = body as Record<string, unknown>;
        if (bm['narrate'] !== undefined) {
          const bn = bm['narrate'];
          if (narrate !== undefined) {
            errors.push({ line: 1, message: `${prefix(i)}: narrate appears twice (step-level and body-level) — keep one` });
          } else if (typeof bn !== 'string' || !bn.trim()) {
            errors.push({ line: 1, message: `${prefix(i)}: narrate needs a non-empty single-line string (Gherkin Given/When/Then/And/But)` });
          } else if (bn.includes('\n')) {
            errors.push({ line: 1, message: `${prefix(i)}: narrate must be a single line — multi-line AC is a case-level feature` });
          } else {
            narrate = bn.trim();
            if (!/^(given|when|then|and|but)\b/i.test(narrate)) {
              warnings.push({ line: 1, message: `${prefix(i)}: narrate is not Gherkin (expected Given/When/Then/And/But) — prose accepted` });
            }
          }
          delete bm['narrate'];
        }
      }

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

      if (action === 'wait') {
        // forms: 500ms | 1s | 1500 | {for: reason, time: 7s} | {until: target[, timeout: 8s]}
        // until-value shape rule (review R1): bare string OR map with exactly
        // ONE of text:/screen: (screen dotted a.b — never doubly nested)
        if (typeof body === 'string' || typeof body === 'number') {
          const ms = parseWaitDuration(body, 60_000);
          if (typeof ms === 'string') { errors.push({ line: 1, message: `${prefix(i)}: wait: ${ms}` }); continue; }
          stepsOut.push({ idx: stepsOut.length, action: 'wait', wait: { mode: 'time', ms } });
          continue;
        }
        if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
          const b = body as Record<string, unknown>;
          const known = ['for', 'time', 'until', 'timeout', 'text', 'screen'];
          for (const bk of Object.keys(b)) {
            if (!known.includes(bk)) errors.push({ line: 1, message: `${prefix(i)}: unknown key "${bk}" in wait — allowed: for, time, until, timeout` });
          }
          const hasUntil = b['until'] !== undefined;
          const hasTime = b['time'] !== undefined;
          const hasText = b['text'] !== undefined;
          const hasScr = b['screen'] !== undefined;
          const hasCondition = hasUntil || hasText || hasScr;
          if (hasCondition && hasTime) { errors.push({ line: 1, message: `${prefix(i)}: wait: condition and 'time' are mutually exclusive — condition form or time form, not both` }); continue; }
          if (hasUntil && (hasText || hasScr)) { errors.push({ line: 1, message: `${prefix(i)}: wait: 'until' cannot combine with text:/screen: — write { until: <string> } or { text: … } / { screen: a.b }` }); continue; }
          if (hasText && hasScr) { errors.push({ line: 1, message: `${prefix(i)}: wait: 'text' and 'screen' are mutually exclusive — one target per wait` }); continue; }
          if (hasText || hasScr) {
            // FLAT condition form (YAML flow style cannot nest maps — live parser lesson):
            // { text: "Go" } | { screen: splash.dismissed } [, timeout: 8s]
            const timeoutMs = b['timeout'] === undefined ? 10_000 : parseWaitDuration(b['timeout'], 120_000);
            if (typeof timeoutMs === 'string') { errors.push({ line: 1, message: `${prefix(i)}: wait timeout: ${timeoutMs}` }); continue; }
            let target: { kind: 'identifier' | 'text' | 'screen'; value: string; state?: string };
            if (hasText) {
              const v = b['text'];
              if (typeof v !== 'string' || !v.trim()) { errors.push({ line: 1, message: `${prefix(i)}: wait text: needs a non-empty string` }); continue; }
              target = { kind: 'text', value: v.trim() };
            } else {
              const v = b['screen'];
              const pos = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9_-]*)$/.exec(typeof v === 'string' ? v.trim() : '');
              if (!pos) { errors.push({ line: 1, message: `${prefix(i)}: wait screen takes "<screen>.<state>" (got ${JSON.stringify(v)})` }); continue; }
              target = { kind: 'screen', value: pos[1]!, state: pos[2]! };
            }
            stepsOut.push({ idx: stepsOut.length, action: 'wait', wait: { mode: 'until', target, timeoutMs } });
            continue;
          }
          if (hasUntil) {
            const timeoutMs = b['timeout'] === undefined ? 10_000 : parseWaitDuration(b['timeout'], 120_000);
            if (typeof timeoutMs === 'string') { errors.push({ line: 1, message: `${prefix(i)}: wait timeout: ${timeoutMs}` }); continue; }
            const u = b['until'];
            let target: { kind: 'identifier' | 'text' | 'screen'; value: string; state?: string } | null = null;
            if (typeof u === 'string' && u.trim()) {
              const v = u.trim();
              target = IDENTIFIER_RE.test(v) ? { kind: 'identifier', value: v } : { kind: 'text', value: v };
            } else {
              // YAML flow style cannot nest maps (live parser lesson): the nested
              // until:{text:…} spelling is structurally unparseable — guide to the flat form
              errors.push({ line: 1, message: `${prefix(i)}: wait until takes a BARE string (or the flat form: wait: { text: … } / { screen: a.b }) — nesting inside until is not valid YAML flow` }); continue;
            }
            stepsOut.push({ idx: stepsOut.length, action: 'wait', wait: { mode: 'until', target: target!, timeoutMs } });
            continue;
          }
          if (hasTime) {
            const ms = parseWaitDuration(b['time'], 60_000);
            if (typeof ms === 'string') { errors.push({ line: 1, message: `${prefix(i)}: wait time: ${ms}` }); continue; }
            const reason = typeof b['for'] === 'string' && b['for'].trim() ? b['for'].trim() : undefined;
            stepsOut.push({ idx: stepsOut.length, action: 'wait', wait: { mode: 'time', ms, ...(reason ? { for: reason } : {}) } });
            continue;
          }
          errors.push({ line: 1, message: `${prefix(i)}: wait needs a duration (wait: 500ms) or a condition (wait: { until: … })` });
          continue;
        }
        errors.push({ line: 1, message: `${prefix(i)}: wait takes a duration (wait: 500ms) or a mapping (wait: { until: …, timeout: 8s })` });
        continue;
      }
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
          // scalar sugar classifies EXACTLY like the on: mapping path
          // (identifier iff IDENTIFIER_RE) — a divergence here silently
          // downgrades identifier→label on one editor save, and the expect
          // starts matching accessibility labels instead of asset ids
          // (live 2026-09-29: run_c317a4ae failed on legal_doc_terms_screen)
          stepsOut.push({ idx: stepsOut.length, action: 'expect', selector: IDENTIFIER_RE.test(body.trim()) ? { identifier: body.trim() } : { label: body.trim() } });
          continue;
        }
        // bare registry form: `- ensure login:` with empty/null body → the
        // app's steps-recipe resolves (credentials live in the recipe as env refs)
        if (action === 'ensure login' && (body === null || (typeof body === 'string' && !body.trim()))) {
          const hasIt = ctx?.hasLoginRecipe;
          if (hasIt && ctx?.app !== undefined && !hasIt(ctx.app)) {
            errors.push({ line: 1, message: `${prefix(i)}: this app has no login flow registered — register it on the screens page (login flow)` });
            continue;
          }
          stepsOut.push({ idx: stepsOut.length, action: 'ensureLogin', ensureLogin: { recipe: 'app' } });
          continue;
        }
        // bare registry form: `- ensure logout:` with empty/null body
        if (action === 'ensure logout' && (body === null || (typeof body === 'string' && !body.trim()))) {
          const hasIt = ctx?.hasLogoutRecipe;
          if (hasIt && ctx?.app !== undefined && !hasIt(ctx.app)) {
            errors.push({ line: 1, message: `${prefix(i)}: this app has no logout flow registered — register it on the screens page (logout flow) or inline button/confirm here` });
            continue;
          }
          stepsOut.push({ idx: stepsOut.length, action: 'ensureLogout', ensureLogout: { recipe: 'app' } });
          continue;
        }
        errors.push({ line: 1, message: `${prefix(i)}: ${action} needs a mapping (or a plain label for expect)` });
        continue;
      }
      const b = body as Record<string, unknown>;
      // ── ensure login: coordinate-free login preflight ──
      if (action === 'ensure login') {
        // bare mapping `{}` → app steps-recipe (login-as-steps plan 20260930T044550Z);
        // narrate may ride alongside (display-only)
        const bareKeys = Object.keys(b).filter((k) => k !== 'narrate');
        if (bareKeys.length === 0 || b['recipe'] === 'app') {
          if (b['recipe'] === 'app' && bareKeys.length > 1) {
            errors.push({ line: 1, message: `${prefix(i)}: ensure login is bare (registry recipe) — extra keys don't ride it` });
            continue;
          }
          const hasIt = ctx?.hasLoginRecipe;
          if (hasIt && ctx?.app !== undefined && !hasIt(ctx.app)) {
            errors.push({ line: 1, message: `${prefix(i)}: this app has no login flow registered — register it on the screens page (login flow)` });
            continue;
          }
          stepsOut.push({ idx: stepsOut.length, action: 'ensureLogin', ensureLogin: { recipe: 'app' } });
          continue;
        }
        // screen-form (back-compat): resolves the app recipe now that the
        // procedure is canonical; env refs on the step are legacy — accepted
        // pre-migration, the migration rewrites these cases to bare form.
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
        // full inline selectors are GONE (login-as-steps plan): the recipe owns
        // the form shape now — point the author at it
        errors.push({ line: 1, message: `${prefix(i)}: inline login selectors are gone — the app's login flow (screens page) owns the form; write bare 'ensure login: {}' or the screen form with env refs` });
        continue;
        continue;
      }
      // ── ensure logout: coordinate-free session preflight ──
      if (action === 'ensure logout') {
        // registry (bare) form: `ensure logout:` with no keys → the app's
        // recipe resolves at run time (app_logout table). Inline keys + bare
        // is ambiguous — one form per step.
        // back is CASE-owned (where the case's first step starts), never recipe — a back-only body is the bare form + return target
        const inlineKeys = ['button', 'on', 'stay', 'confirm', 'via'].filter((k) => b[k] !== undefined);
        const hasRecipeMarker = (b['recipe'] as unknown) === 'app';
        if (inlineKeys.length === 0 && (Object.keys(b).length === 0 || hasRecipeMarker)) {
          const hasIt = ctx?.hasLogoutRecipe;
          if (hasIt && ctx?.app !== undefined && !hasIt(ctx.app)) {
            errors.push({ line: 1, message: `${prefix(i)}: this app has no logout flow registered — register it on the screens page (logout flow) or inline button/confirm here` });
            continue;
          }
          const backOnly = b['back'];
          const backVal = typeof backOnly === 'string' && backOnly.trim() ? backOnly.trim() : undefined;
          if (backOnly !== undefined && !backVal) {
            errors.push({ line: 1, message: `${prefix(i)}: back needs a non-empty label-or-id (the screen to return to after the preflight)` });
            continue;
          }
          stepsOut.push({ idx: stepsOut.length, action: 'ensureLogout', ensureLogout: { recipe: 'app', ...(backVal ? { back: backVal } : {}) } });
          continue;
        }
        if (hasRecipeMarker && inlineKeys.length > 0) {
          errors.push({ line: 1, message: `${prefix(i)}: ensure logout is either bare (registry recipe) or inline (button/confirm) — not both` });
          continue;
        }
        const bo = (b['button'] ?? b['on']) as unknown;
        const stay = b['stay'] as unknown;
        const confirm = b['confirm'] as unknown;
        const via = b['via'] as unknown;
        const back = b['back'] as unknown;
        if (back !== undefined && (typeof back !== 'string' || !back.trim())) {
          errors.push({ line: 1, message: `${prefix(i)}: back needs a non-empty label-or-id (the screen to return to after the preflight)` });
          continue;
        }
        if (typeof bo !== 'string' || !bo.trim() || typeof confirm !== 'string' || !confirm.trim()) {
          // back-only body = bare registry form + case-owned return target
          if (inlineKeys.length === 0 && b['back'] !== undefined) {
            const bval = typeof b['back'] === 'string' && (b['back'] as string).trim() ? (b['back'] as string).trim() : undefined;
            if (b['back'] !== undefined && !bval) {
              errors.push({ line: 1, message: `${prefix(i)}: back needs a non-empty label-or-id (the screen to return to after the preflight)` });
              continue;
            }
            const hasIt2 = ctx?.hasLogoutRecipe;
            if (hasIt2 && ctx?.app !== undefined && !hasIt2(ctx.app)) {
              errors.push({ line: 1, message: `${prefix(i)}: this app has no logout flow registered — register it on the screens page (logout flow) or inline button/confirm here` });
              continue;
            }
            stepsOut.push({ idx: stepsOut.length, action: 'ensureLogout', ensureLogout: { recipe: 'app', ...(bval ? { back: bval } : {}) } });
            continue;
          }
          errors.push({ line: 1, message: `${prefix(i)}: ensure logout needs button: <label-or-id> and confirm: <label-or-id> (stay: optional sheet-title check)` });
          continue;
        }
        stepsOut.push({
          idx: stepsOut.length,
          action: 'ensureLogout',
          ensureLogout: {
            button: bo.trim(),
            stay: typeof stay === 'string' ? stay.trim() : '',
            confirm: confirm.trim(),
            ...(typeof via === 'string' && via.trim() ? { via: via.trim() } : {}),
            ...(typeof back === 'string' && back.trim() ? { back: back.trim() } : {}),
          },
        });
        continue;
      }
      for (const bk of Object.keys(b)) {
        const known = ['point', 'on', 'text', 'optional', 'id', 'name', 'contains', 'ignoreCase', 'when', 'at'];
        if (action === 'long-press') known.push('dwell');
        if (action === 'paste') known.push('press');
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
      if (action === 'double-tap' || action === 'long-press') {
        // same targeting contract as tap: point and/or on — plus dwell for long-press
        const step: YamlStep = { idx: stepsOut.length, action: action === 'double-tap' ? 'doubleTap' : 'longPress' };
        const point = b['point'];
        const slEarly = sel(b);
        if (Array.isArray(point) && point.length === 2 && typeof point[0] === 'number' && typeof point[1] === 'number') {
          step.x = point[0]; step.y = point[1];
        } else if (!slEarly) {
          errors.push({ line: 1, message: `${prefix(i)}: ${action} needs point: [x, y] or on: <label or id>` });
          continue;
        }
        if (action === 'long-press') {
          const dwell = b['dwell'];
          if (dwell !== undefined) {
            if (typeof dwell !== 'number' || !Number.isInteger(dwell) || dwell <= 0 || dwell > 10000) {
              errors.push({ line: 1, message: `${prefix(i)}: dwell must be a positive integer of milliseconds (1..10000)` });
              continue;
            }
            step.dwellMs = dwell;
          }
        }
        const sl = sel(b);
        if (sl) step.selector = sl;
        stepsOut.push(step);
        continue;
      }
      if (action === 'shake') {
        // scalar verb — no body keys beyond narrate (already lifted)
        if (body !== null && typeof body === 'object') {
          errors.push({ line: 1, message: `${prefix(i)}: shake takes no body — write it as a bare \`- shake\`` });
          continue;
        }
        stepsOut.push({ idx: stepsOut.length, action: 'shake' });
        continue;
      }
      if (action === 'paste') {
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          errors.push({ line: 1, message: `${prefix(i)}: paste needs { text: <string> } (press: false optional for pasteboard-only)` });
          continue;
        }
        if (typeof b['text'] !== 'string' || !b['text']) {
          errors.push({ line: 1, message: `${prefix(i)}: paste needs text: <string> — any unicode; ${'${env.KEY}'} resolves at playback` });
          continue;
        }
        const press = b['press'];
        if (press !== undefined && press !== false) {
          errors.push({ line: 1, message: `${prefix(i)}: press only accepts false (pasteboard-only); default true needs no key` });
          continue;
        }
        stepsOut.push({ idx: stepsOut.length, action: 'paste', text: b['text'], ...(press === false ? { press: false } : {}) });
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
      } finally {
        if (narrate !== undefined) {
          for (let j = lenBefore; j < stepsOut.length; j++) stepsOut[j]!.narrate = narrate;
        }
      }
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
export function caseToYaml(t: { name: string; tags: string[]; app?: string | null; folder?: string | null; setup?: unknown[]; alerts?: unknown; variants?: unknown[]; swaps?: unknown[]; entry?: { screen: string; mode?: 'tab' | 'deepLink' | 'navigate' } | null; steps: unknown[] }): string {
  const lines: string[] = [];
  lines.push(`# ${t.name} — edit as yaml; save validates against the step schema`);
  lines.push(`name: ${yamlScalar(t.name)}`);
  if (t.tags.length > 0) lines.push(`tags: [${t.tags.map((x) => yamlScalar(x)).join(', ')}]`);
  if (t.app) lines.push(`app: ${yamlScalar(t.app)}`);
  // informational (plan 20260928T023000Z F3): the folder path rides exports;
  // the editor save path ACCEPTS-AND-IGNORES it — moves happen via rows
  if (t.folder) lines.push(`folder: ${yamlScalar(t.folder)}`);
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
      const v = rawV as unknown as { id: string; network?: string; networkScenario?: string; scenarios?: string[]; env?: Record<string, string> };
      lines.push(`  - id: ${yamlScalar(v.id)}`);
      if (v.network !== undefined) lines.push(`    network: ${yamlScalar(v.network)}`);
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
    const narrateSuffix = (n: unknown): string => (typeof n === 'string' && n ? `, narrate: ${yamlScalar(n)}` : '');
    /** multi-line forms (ensure logout/login): narrate rides as a sibling key line */
    const narrateLine = (n: unknown): string => (typeof n === 'string' && n ? `      narrate: ${yamlScalar(n)}\n` : '');
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
      lines.push(`  - tap: { ${parts.join(', ')}${narrateSuffix(s['narrate'])} }`);
    } else if (action === 'doubleTap') {
      const parts: string[] = [];
      if (s['x'] !== undefined && s['y'] !== undefined) parts.push(`point: [${s['x']}, ${s['y']}]`);
      const onSel = on(s['selector']);
      if (onSel) parts.push(onSel);
      lines.push(`  - double-tap: { ${parts.join(', ')}${narrateSuffix(s['narrate'])} }`);
    } else if (action === 'longPress') {
      const parts: string[] = [];
      if (s['x'] !== undefined && s['y'] !== undefined) parts.push(`point: [${s['x']}, ${s['y']}]`);
      parts.push(`dwell: ${s['dwellMs'] ?? 800}`);
      const onSel = on(s['selector']);
      if (onSel) parts.push(onSel);
      lines.push(`  - long-press: { ${parts.join(', ')}${narrateSuffix(s['narrate'])} }`);
    } else if (action === 'shake') {
      if (typeof s['narrate'] === 'string' && s['narrate']) { lines.push('  - shake'); lines.push(`    narrate: ${yamlScalar(s['narrate'])}`); } else lines.push('  - shake');
    } else if (action === 'paste') {
      const press = s['press'] === false ? ', press: false' : '';
      lines.push(`  - paste: { text: ${yamlScalar(String(s['text'] ?? ''))}${press}${narrateSuffix(s['narrate'])} }`);
    } else if (action === 'scroll') {
      if (typeof s['narrate'] === 'string' && s['narrate']) { lines.push(`  - scroll: ${s['direction']}`); lines.push(`    narrate: ${yamlScalar(s['narrate'])}`); } else lines.push(`  - scroll: ${s['direction']}`);
    } else if (action === 'wait') {
      const w = s['wait'] as YamlStep['wait'];
      if (w && w.mode === 'time') {
        const dur = w.ms % 1000 === 0 ? `${w.ms / 1000}s` : `${w.ms}ms`;
        if (w.for) lines.push(`  - wait: { for: ${yamlScalar(w.for)}, time: ${dur}${narrateSuffix(s['narrate'])} }`);
        else if (typeof s['narrate'] === 'string' && s['narrate']) { lines.push(`  - wait: ${dur}`); lines.push(`    narrate: ${yamlScalar(s['narrate'])}`); }
        else lines.push(`  - wait: ${dur}`);
      } else if (w && w.mode === 'until') {
        // FLAT spelling (YAML flow cannot nest maps — live parser lesson): text/screen
        // ride as top-level keys of the wait map; bare identifiers keep until:
        const tgt = w.target.kind === 'screen' ? `screen: ${w.target.value}.${w.target.state}` : w.target.kind === 'text' ? `text: ${yamlScalar(w.target.value)}` : `until: ${yamlScalar(w.target.value)}`;
        const to = w.timeoutMs !== 10_000 ? `, timeout: ${w.timeoutMs % 1000 === 0 ? `${w.timeoutMs / 1000}s` : `${w.timeoutMs}ms`}` : '';
        lines.push(`  - wait: { ${tgt}${to}${narrateSuffix(s['narrate'])} }`);
      }
    } else if (action === 'alert') {
      if (typeof s['narrate'] === 'string' && s['narrate']) { lines.push(`  - alert: ${s['alertAction'] ?? 'dismiss'}`); lines.push(`    narrate: ${yamlScalar(s['narrate'])}`); } else lines.push(`  - alert: ${s['alertAction'] ?? 'dismiss'}`);
    } else if (action === 'location') {
      const loc = s['location'] as { latitude: number; longitude: number };
      lines.push(`  - location: { latitude: ${loc.latitude}, longitude: ${loc.longitude}${narrateSuffix(s['narrate'])} }`);
    } else if (action === 'type') {
      const pt = s['x'] !== undefined && s['y'] !== undefined ? `point: [${s['x']}, ${s['y']}], ` : '';
      lines.push(`  - type: { ${pt}text: ${yamlScalar(String(s['text'] ?? ''))}${on(s['selector']) ? `, ${on(s['selector'])!}` : ''}${icSuffix(s['selector'])}${optSuffix(s['optional'])}${whenSuffix(s['when'])}${narrateSuffix(s['narrate'])} }`);
    } else if (action === 'runFlow') {
      lines.push(`  - runFlow: { name: ${yamlScalar(String(s['templateId'] ?? ''))}${optSuffix(s['optional'])}${narrateSuffix(s['narrate'])} }`);
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
        lines.push(`  - expect: { ${body.replace(/^, /, '')}${narrateSuffix(s['narrate'])} }`);
      } else {
        const label = sl?.label ?? sl?.identifier ?? '?';
        if (s['optional'] === true || at || card) lines.push(`  - expect: { on: ${yamlScalar(label)}${s['optional'] === true ? ', optional: true' : ''}${at}${card}${narrateSuffix(s['narrate'])} }`);
        else if (typeof s['narrate'] === 'string' && s['narrate']) lines.push(`  - expect: { on: ${yamlScalar(label)}, narrate: ${yamlScalar(s['narrate'])} }`);
      else lines.push(`  - expect: ${yamlScalar(label)}`);
      }
    } else if (action === 'arrive') {
      if (typeof s['narrate'] === 'string' && s['narrate']) { lines.push(`  - arrive: ${yamlScalar(String(s['screen'] ?? ''))}`); lines.push(`    narrate: ${yamlScalar(s['narrate'])}`); } else lines.push(`  - arrive: ${yamlScalar(String(s['screen'] ?? ''))}`);
    } else if (action === 'refresh') {
      if (typeof s['narrate'] === 'string' && s['narrate']) { lines.push(`  - refresh: ${yamlScalar(String(s['screen'] ?? ''))}`); lines.push(`    narrate: ${yamlScalar(s['narrate'])}`); } else lines.push(`  - refresh: ${yamlScalar(String(s['screen'] ?? ''))}`);
    } else if (action === 'swap') {
      if (typeof s['narrate'] === 'string' && s['narrate']) { lines.push(`  - swap: ${yamlScalar(String(s['swap'] ?? s['world'] ?? ''))}`); lines.push(`    narrate: ${yamlScalar(s['narrate'])}`); } else lines.push(`  - swap: ${yamlScalar(String(s['swap'] ?? s['world'] ?? ''))}`);
    } else if (action === 'world') {
      // legacy stored form (pre-rename 2026-09-24) — emit the new vocabulary;
      // a stored world step must NEVER fall through to the placeholder path
      if (typeof s['narrate'] === 'string' && s['narrate']) { lines.push(`  - swap: ${yamlScalar(String(s['world'] ?? ''))}`); lines.push(`    narrate: ${yamlScalar(s['narrate'])}`); } else lines.push(`  - swap: ${yamlScalar(String(s['world'] ?? ''))}`);
    } else if (action === 'ensureLogout') {
      const el = s['ensureLogout'] as { recipe?: string; button?: string; stay?: string; confirm?: string; via?: string } | undefined;
      if (el?.recipe === 'app') { lines.push(typeof s['narrate'] === 'string' && s['narrate'] ? `  - ensure logout: { back: ${yamlScalar(String((el as { back?: string }).back ?? ''))}, narrate: ${yamlScalar(s['narrate'])} }` : ((el as { back?: string }).back ? `  - ensure logout: { back: ${yamlScalar((el as { back?: string }).back!)} }` : `  - ensure logout: {}`)); }
      else {
      lines.push(`  - ensure logout:`);
      lines.push(`      button: ${yamlScalar(el?.button ?? '?')}`);
      lines.push(`      confirm: ${yamlScalar(el?.confirm ?? '?')}`);
      if (el?.stay) lines.push(`      stay: ${yamlScalar(el.stay)}`);
      if (el?.via) lines.push(`      via: ${yamlScalar(el.via)}`);
      if ((el as { back?: string }).back) lines.push(`      back: ${yamlScalar((el as { back?: string }).back!)}`);
      if (typeof s['narrate'] === 'string' && s['narrate']) lines.push(`      narrate: ${yamlScalar(s['narrate'])}`);
      }
    } else if (action === 'ensureLogin') {
      const elr = s['ensureLogin'] as { recipe?: string } | undefined;
      if (elr?.recipe === 'app') { lines.push(typeof s['narrate'] === 'string' && s['narrate'] ? `  - ensure login: { narrate: ${yamlScalar(s['narrate'])} }` : `  - ensure login: {}`); }
      else {
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
      if (typeof s['narrate'] === 'string' && s['narrate']) lines.push(`      narrate: ${yamlScalar(s['narrate'])}`);
      }
    } else if (action === 'expectScreen') {
      const es = s['expectScreen'] as { screen?: string; state?: string; negate?: boolean } | undefined;
      const scr = es?.screen ?? '?';
      const st = es?.state ?? '?';
      const nsc = narrateSuffix(s['narrate']);
      if (nsc) { lines.push(`  - expect screen: ${es?.negate === true ? yamlScalar(`${scr}.state != ${st}`) : yamlScalar(`${scr}.${st}`)}`); lines.push(`    narrate: ${yamlScalar(String(s['narrate']))}`); }
      else lines.push(es?.negate === true
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
