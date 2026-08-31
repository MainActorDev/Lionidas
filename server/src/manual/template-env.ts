/** Maestro-style env templating: ${env.KEY} refs resolve at playback time.
 *  Missing key = null (caller fails the step BEFORE dispatch — never type a
 *  half-resolved string). Pure module: no db, no alloy. */
export interface SubstitutedStep {
  idx: number; action: 'tap' | 'scroll' | 'type' | 'runFlow';
  x?: number; y?: number; direction?: 'up' | 'down' | 'left' | 'right';
  text?: string;
  /** A6 element selector (label/type/identifier) — passes through untouched */
  selector?: { identifier?: string; label?: string; type?: string };
  /** A5 subflow reference (runFlow) — expanded before execution */
  templateId?: string;
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

export function substituteStep(s: { idx: number; action: 'tap' | 'scroll' | 'type' | 'runFlow'; x?: number; y?: number; direction?: 'up' | 'down' | 'left' | 'right'; text?: string; optional?: boolean; selector?: { identifier?: string; label?: string; type?: string }; templateId?: string }, env: Record<string, string>): SubstitutedStep {
  const base: SubstitutedStep = { idx: s.idx, action: s.action, ...(s.x !== undefined ? { x: s.x } : {}), ...(s.y !== undefined ? { y: s.y } : {}), ...(s.direction ? { direction: s.direction } : {}), ...(s.selector ? { selector: s.selector } : {}), ...(s.templateId !== undefined ? { templateId: s.templateId } : {}) };
  if (s.text === undefined) return base;
  const expanded = expandEnvText(s.text, env);
  if (expanded !== null) return { ...base, text: expanded };
  const missingKey = [...s.text.matchAll(REF)].map((m) => m[1]).find((k) => env[k as string] === undefined) as string | undefined;
  return { ...base, error: `missing env: ${missingKey ?? '??'}` };
}
