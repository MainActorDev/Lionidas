/** A5 subflows: flatten runFlow steps into a flat executable list at playback
 *  time. Child steps get flow = child template name (run_steps.flow_name shows
 *  provenance) and inherit the runFlow step's optional flag. Cycle guard walks
 *  the DFS path only — the same subflow may be referenced twice. */
export interface FlowStep { idx: number; action: string; flow?: string; templateId?: string; optional?: boolean; [k: string]: unknown }

export function expandFlows(
  steps: FlowStep[],
  loadTemplate: (id: string) => { name: string; steps: FlowStep[] } | null,
  path: string[] = [],
  depth = 0,
): FlowStep[] {
  if (depth > 5) throw new Error('subflow nesting > 5');
  const out: FlowStep[] = [];
  for (const s of steps) {
    if (s.action !== 'runFlow') { out.push(s); continue; }
    const id = String(s.templateId ?? '');
    if (path.includes(id)) throw new Error(`subflow cycle: ${[...path, id].join(' → ')}`);
    const child = loadTemplate(id);
    if (!child) throw new Error(`subflow template not found: ${id}`);
    const childSteps = expandFlows(child.steps, loadTemplate, [...path, id], depth + 1)
      .map((cs) => ({ ...cs, flow: cs.flow ?? child.name, ...(s.optional || cs.optional ? { optional: true } : {}) }));
    out.push(...childSteps);
  }
  return out.map((s, i) => ({ ...s, idx: i }));
}
