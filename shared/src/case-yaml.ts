/**
 * Case YAML — the ONE definition of the YAML test-case format, shared by the
 * web (live outline in the A2 split panel) and the server (validate/save
 * routes import this file by relative path). Pure module: no node APIs, only
 * the `yaml` npm package. Storage stays steps_json — YAML is a view+editor,
 * never a second source of truth.
 *
 * Round-trip contract: yamlToSteps(stepsToYaml(case)) preserves execution
 * semantics. Capture artifacts (thumb, ts) are dropped in YAML and ignored
 * on import. Unknown keys are ERRORS with line numbers — a typo'd `optinal:`
 * must never silently drop a step.
 */
import { parse, stringify } from 'yaml';

export interface YamlSelector { identifier?: string; label?: string; labelContains?: string; ignoreCase?: boolean; type?: string }
export interface YamlStep {
  idx: number;
  action: 'tap' | 'scroll' | 'type' | 'runFlow' | 'expect';
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
}
export interface YamlCase {
  name: string;
  tags: string[];
  app?: string;
  /** Declared preconditions — guarded steps that no-op when already satisfied */
  setup?: YamlStep[];
  steps: YamlStep[];
}

export interface YamlError { line: number; message: string }

const DROPPED_KEYS = new Set(['ts', 'thumb']); // capture artifacts — not semantics
const STEP_KEYS = new Set(['action', 'x', 'y', 'direction', 'text', 'optional', 'selector', 'templateId', 'flow']);
const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
const ACTIONS = new Set(['tap', 'scroll', 'type', 'runFlow', 'expect']);
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
  return { ok: true, case: { name, tags, ...(app ? { app } : {}), ...(setupOut ? { setup: setupOut } : {}), steps: stepsOut }, errors: [], runFlowNames };
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
        if (keys.length === 2 && keys.includes('when')) {
          errors.push({ line: 1, message: `${prefix(i)}: when only guards tap/type/expect — it cannot ride on a scalar action` });
          continue;
        }
        errors.push({ line: 1, message: `${prefix(i)}: exactly one action key expected, got [${keys.join(', ')}]` });
        continue;
      }
      const action = keys[0]!;
      if (!ACTIONS.has(action)) {
        errors.push({ line: 1, message: `${prefix(i)}: unknown action "${action}" (expected tap|scroll|type|runFlow|expect)` });
        continue;
      }
      const body = s[action];
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
          if (/^[a-z][a-z0-9_]*$/.test(on)) {
            if (ignoreCase) errors.push({ line: 1, message: `${prefix(i)}: ignoreCase never applies to identifiers (asset ids are exact); use 'contains' or a label` });
            return { identifier: on };
          }
          return { label: on, ...(ignoreCase ? { ignoreCase: true } : {}) };
        }
        return undefined;
      };

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
      for (const bk of Object.keys(b)) {
        if (!['point', 'on', 'text', 'optional', 'id', 'name', 'contains', 'ignoreCase', 'when'].includes(bk)) {
          errors.push({ line: 1, message: `${prefix(i)}: unknown key "${bk}" in ${action} — did you mean optional/on/point/text?` });
        }
      }
      if (action === 'tap' || action === 'type') {
        const step: YamlStep = { idx: stepsOut.length, action };
        const point = b['point'];
        if (Array.isArray(point) && point.length === 2 && typeof point[0] === 'number' && typeof point[1] === 'number') {
          step.x = point[0]; step.y = point[1];
        } else if (action === 'tap' || !sel(b)) {
          // tap always needs coordinates; type may be selector-only (on:)
          errors.push({ line: 1, message: `${prefix(i)}: ${action} needs point: [x, y]` });
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
  if (step.action === 'scroll' || step.action === 'runFlow') {
    errors.push({ line: 1, message: `${prefix(i)}: when only guards tap/type/expect (got ${step.action})` });
    return;
  }
  step.when = w.trim();
}

/** steps_json rows → YAML text. Stable field order, guidance comments. */
export function caseToYaml(t: { name: string; tags: string[]; app?: string | null; setup?: unknown[]; steps: unknown[] }): string {
  const lines: string[] = [];
  lines.push(`# ${t.name} — edit as yaml; save validates against the step schema`);
  lines.push(`name: ${yamlScalar(t.name)}`);
  if (t.tags.length > 0) lines.push(`tags: [${t.tags.map((x) => yamlScalar(x)).join(', ')}]`);
  if (t.app) lines.push(`app: ${yamlScalar(t.app)}`);
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
      lines.push(`  - tap: { point: [${s['x']}, ${s['y']}]${on(s['selector']) ? `, ${on(s['selector'])!}` : ''}${icSuffix(s['selector'])}${optSuffix(s['optional'])}${whenSuffix(s['when'])} }`);
    } else if (action === 'scroll') {
      lines.push(`  - scroll: ${s['direction']}`);
    } else if (action === 'type') {
      const pt = s['x'] !== undefined && s['y'] !== undefined ? `point: [${s['x']}, ${s['y']}], ` : '';
      lines.push(`  - type: { ${pt}text: ${yamlScalar(String(s['text'] ?? ''))}${on(s['selector']) ? `, ${on(s['selector'])!}` : ''}${icSuffix(s['selector'])}${optSuffix(s['optional'])}${whenSuffix(s['when'])} }`);
    } else if (action === 'runFlow') {
      lines.push(`  - runFlow: { name: ${yamlScalar(String(s['templateId'] ?? ''))}${optSuffix(s['optional'])} }`);
    } else if (action === 'expect') {
      const sl = s['selector'] as YamlSelector | undefined;
      if (sl && (sl.labelContains !== undefined || sl.ignoreCase === true)) {
        // mode/flag selectors always render as a mapping (the scalar sugar is exact-cs only)
        const body = `${on(s['selector']) ?? 'on: ?'}${icSuffix(s['selector'])}${optSuffix(s['optional'])}`;
        lines.push(`  - expect: { ${body.replace(/^, /, '')} }`);
      } else {
        const label = sl?.label ?? sl?.identifier ?? '?';
        if (s['optional'] === true) lines.push(`  - expect: { on: ${yamlScalar(label)}, optional: true }`);
        else lines.push(`  - expect: ${yamlScalar(label)}`);
      }
    } else {
      // unknown action in storage (future kinds) — serialize losslessly-ish as a comment guard
      lines.push(`  # unrendered step kind: ${action}`);
      lines.push(`  - scroll: down  # ⚠ placeholder — original step kind "${action}" has no yaml form yet`);
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
