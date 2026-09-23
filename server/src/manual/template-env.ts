/** Maestro-style env templating: ${env.KEY} refs resolve at playback time.
 *  Missing key = null (caller fails the step BEFORE dispatch — never type a
 *  half-resolved string). Pure module: no db, no alloy. */
export interface SubstitutedStep {
  idx: number; action: 'tap' | 'scroll' | 'type' | 'runFlow' | 'expect' | 'alert' | 'location' | 'arrive' | 'refresh' | 'world' | 'expectScreen';
  x?: number; y?: number; direction?: 'up' | 'down' | 'left' | 'right'; text?: string;
  /** A6 element selector (label/type/identifier) — ${env.X} resolves in
   *  label/labelContains (variants assert per-world text through these);
   *  identifier/type are engine vocabulary, passed through untouched. */
    selector?: { identifier?: string; label?: string; labelContains?: string; type?: string };
  /** A5 subflow reference (runFlow) — expanded before execution */
  templateId?: string;
  /** expect-only cardinality (A9) — carried through substitution untouched */
  count?: number;
  atLeast?: number;
  /** set when an env ref could not be resolved */
  error?: string;
}

const REF = /\$\{env\.([A-Za-z0-9_]+)\}/g;

export function expandEnvText(text: string, env: Record<string, string>): string | null {
  let missing: string | null = null;
  const out = text.replace(REF, (_m, key: string) => {
    const v = env[key];
    if (v === undefined) { missing = key; return ''; }
    return v;
  });
  return missing ? null : out;
}

/** first ${env.X} key present in text but absent from env (error naming) */
function firstMissingKey(keys: string[], env: Record<string, string>): string {
  return keys.find((k) => env[k] === undefined) ?? '??';
}

export function substituteStep(s: { idx: number; action: 'tap' | 'scroll' | 'type' | 'runFlow' | 'expect' | 'alert' | 'location' | 'arrive' | 'refresh' | 'world' | 'expectScreen'; x?: number; y?: number; direction?: 'up' | 'down' | 'left' | 'right'; text?: string; optional?: boolean; selector?: { identifier?: string; label?: string; labelContains?: string; type?: string }; templateId?: string; count?: number; atLeast?: number }, env: Record<string, string>): SubstitutedStep {
  // selector label/labelContains resolve ${env.X} (variant-world assertions);
  // identifier/type stay literal. A missing key fails the step BEFORE
  // dispatch — the caller never asserts a half-resolved fragment.
  let sel: SubstitutedStep['selector'] | undefined;
  let selMissing: string | undefined;
  if (s.selector) {
    const resolved: Record<string, string> = {};
    if (s.selector.identifier !== undefined) resolved['identifier'] = s.selector.identifier;
    if (s.selector.type !== undefined) resolved['type'] = s.selector.type;
    for (const key of ['label', 'labelContains'] as const) {
      const raw = s.selector[key];
      if (raw === undefined) continue;
      const out = expandEnvText(raw, env);
      if (out === null) { selMissing = firstMissingKey([...raw.matchAll(REF)].map((m) => m[1] as string), env); break; }
      resolved[key] = out;
    }
    if (selMissing === undefined) sel = resolved;
  }
  if (selMissing !== undefined) {
    return { idx: s.idx, action: s.action, ...(s.x !== undefined ? { x: s.x } : {}), ...(s.y !== undefined ? { y: s.y } : {}), ...(s.direction ? { direction: s.direction } : {}), ...(s.templateId !== undefined ? { templateId: s.templateId } : {}), error: `missing env: ${selMissing}` };
  }
  const base: SubstitutedStep = { idx: s.idx, action: s.action, ...(s.x !== undefined ? { x: s.x } : {}), ...(s.y !== undefined ? { y: s.y } : {}), ...(s.direction ? { direction: s.direction } : {}), ...(sel !== undefined ? { selector: sel } : {}), ...(s.templateId !== undefined ? { templateId: s.templateId } : {}), ...(s.count !== undefined ? { count: s.count } : {}), ...(s.atLeast !== undefined ? { atLeast: s.atLeast } : {}) };
  if (s.text === undefined) return base;
  const expanded = expandEnvText(s.text, env);
  if (expanded !== null) return { ...base, text: expanded };
  const missingKey = [...s.text.matchAll(REF)].map((m) => m[1]).find((k) => env[k as string] === undefined) as string | undefined;
  return { ...base, error: `missing env: ${missingKey ?? '??'}` };
}
