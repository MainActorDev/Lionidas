/** probeAt — the sweep's point-query dispatch. Wraps alloy_native_tree
 *  interactable-at (engine B injected-devtools hit-test) and translates
 *  the engine's UIView JSON into SnapNode so selector predicates apply
 *  unchanged. The devtools warm-up (restart → probe → restart) is a
 *  separate concern (playback Task 2b) — probeAt assumes warm app. */

/** Engine-B view JSON (subset we consume). */
interface EngineView {
  className?: string;
  label?: string;
  identifier?: string;
  frame?: { x: number; y: number; width: number; height: number };
  userInteractionEnabled?: boolean;
  hidden?: boolean;
}

export type ProbeFn = (x: number, y: number) => Promise<SnapNodeLike[]>;
export interface SnapNodeLike { type?: string; label?: string; identifier?: string; hittable?: boolean; rect?: { x: number; y: number; width: number; height: number } }

type Dispatch = (tool: string, input: unknown, deps: unknown) => Promise<{ ok: true; result: unknown } | { ok: false; error?: { message?: string } }>;

/** Build the injectable probe function. Returns [] on any engine miss —
 *  a dead probe is data ("nothing interactable here"), not an error. */
export function makeProbe(dispatch: Dispatch, deps: unknown, udid: string, bundleId: string): ProbeFn {
  return async (x: number, y: number): Promise<SnapNodeLike[]> => {
    let r: Awaited<ReturnType<Dispatch>>;
    try {
      r = await dispatch('alloy_native_tree', { udid, query: 'interactable-at', x, y, bundleId }, deps);
    } catch {
      return [];
    }
    if (!('ok' in r) || !r.ok) return [];
    const res = r.result as { status?: string; view?: EngineView & { children?: EngineView[] } };
    if (res.status !== 'ok' || !res.view) return [];
    // the hit view + its immediate children (buttons inside a bar)
    const views = [res.view, ...(res.view.children ?? [])];
    return views.map((v) => viewToNode(v));
  };
}

/** UIView JSON → SnapNode. className → type, frame → rect,
 *  userInteractionEnabled && !hidden → hittable. */
function viewToNode(v: EngineView): SnapNodeLike {
  const n: SnapNodeLike = { hittable: v.userInteractionEnabled !== false && v.hidden !== true };
  if (v.className !== undefined) n.type = v.className;
  if (v.label !== undefined) n.label = v.label;
  if (v.identifier !== undefined) n.identifier = v.identifier;
  if (v.frame !== undefined) n.rect = v.frame;
  return n;
}
