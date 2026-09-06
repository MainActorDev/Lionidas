/** Lane planner for parallel template batches (device-lane pool, 2026-09-06 plan).
 *
 *  PURE and deterministic: same input → same lanes. Cases pack
 *  duration-greedy onto the least-loaded lane (we have real cost history
 *  via run_steps.duration_ms — better than count-split, Maestro's own
 *  caveat). A lane stays strictly serial; B5's one-run-per-device guard
 *  is untouched. Duplicate templateIds dedupe to the first occurrence —
 *  never two lanes racing one template (prunePreviousRunArtifacts keys
 *  evidence by templateId and a same-template overlap would delete it). */
export interface PlanCase {
  templateId: string;
  /** last-run total duration; null = unknown → default weight */
  costMs: number | null;
}

export interface PlanDevice {
  udid: string;
  name: string | null;
}

export interface Lane {
  device: PlanDevice;
  cases: PlanCase[];
  /** packed cost (known costs + defaults) — reporting only */
  costMs: number;
}

/** weight for unknown-cost cases (median template run ≈ 30s in this suite) */
export const DEFAULT_COST_MS = 30_000;

export function planLanes(input: {
  cases: PlanCase[];
  devices: PlanDevice[];
  maxLanes?: number;
}): Lane[] {
  const devices = input.maxLanes !== undefined ? input.devices.slice(0, Math.max(1, input.maxLanes)) : input.devices;
  const lanes: Lane[] = devices.map((device) => ({ device, cases: [], costMs: 0 }));

  // dedupe by templateId (first occurrence wins) — deterministic input order
  const seen = new Set<string>();
  const unique = input.cases.filter((c) => {
    if (seen.has(c.templateId)) return false;
    seen.add(c.templateId);
    return true;
  });

  // heaviest first; equal cost → templateId asc (stability under re-sorts)
  const ordered = [...unique].sort((a, b) => {
    const ca = a.costMs ?? DEFAULT_COST_MS;
    const cb = b.costMs ?? DEFAULT_COST_MS;
    if (cb !== ca) return cb - ca;
    return a.templateId < b.templateId ? -1 : a.templateId > b.templateId ? 1 : 0;
  });

  for (const c of ordered) {
    // least-loaded lane; ties → first device (input order = mirror order)
    let target = lanes[0]!;
    for (const l of lanes) if (l.costMs < target.costMs) target = l;
    target.cases.push(c);
    target.costMs += c.costMs ?? DEFAULT_COST_MS;
  }
  return lanes;
}
