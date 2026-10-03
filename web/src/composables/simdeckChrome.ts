/** simdeck chrome adapter — converts the wrapped surface's definition.json
 *  (chrome-px rect + viewport + per-button PNGs) into crucible's BezelDefinition
 *  (screen %, radius %, rest images), so the pre-wrap bezel markup renders the
 *  child's chrome in OUR canvas stage. Pure conversion; fetch lives below. */

export interface BezelDefinition {
  identifier: string;
  scale: number;
  bezel: { width: number; height: number; url: string };
  screen: { xPct: number; yPct: number; wPct: number; hPct: number };
  screenRadius: { pctW: number; pctH: number };
  buttons: Array<{
    name: string;
    anchor: string;
    onTop: boolean;
    boxPct: { left: number; top: number; width: number; height: number };
    transform: { rest: string; hover: string; pressed: string };
    imageUrl: string;
    pressedImageUrl: string;
  }>;
}

interface ChildButton {
  id: string;
  box: { leftPct: number; topPct: number; widthPct: number; heightPct: number };
  envelope: { button: string };
  images: { rest: string; pressed: string };
  transform: { rest: string; hover: string; pressed: string };
  z: string;
}

export interface ChildDefinition {
  buttons: ChildButton[];
  identity: { model: string; name: string; udid: string };
  keyboard: Record<string, unknown>;
  screen: {
    bezelImage: { bare: string; rest: string };
    clipRadius: number;
    rect: { x: number; y: number; width: number; height: number };
    viewport: { width: number; height: number };
  };
}

export function adaptChromeDefinition(udid: string, c: ChildDefinition): BezelDefinition {
  const { rect, viewport, clipRadius } = c.screen;
  return {
    identifier: udid,
    scale: 1,
    // bare body (no baked buttons) — per-button PNGs layer on top via boxPct
    bezel: { width: viewport.width, height: viewport.height, url: c.screen.bezelImage.bare },
    screen: {
      xPct: (rect.x / viewport.width) * 100,
      yPct: (rect.y / viewport.height) * 100,
      wPct: (rect.width / viewport.width) * 100,
      hPct: (rect.height / viewport.height) * 100,
    },
    screenRadius: {
      pctW: (clipRadius / rect.width) * 100,
      pctH: (clipRadius / rect.height) * 100,
    },
    buttons: c.buttons.map((b) => ({
      name: b.envelope.button ?? b.id,
      anchor: 'left',
      onTop: b.z === 'above',
      boxPct: { left: b.box.leftPct, top: b.box.topPct, width: b.box.widthPct, height: b.box.heightPct },
      // child's transform strings verbatim — hover pop-out + pressed nudge
      // follow the child's chrome exactly (right-side buttons pop the other
      // way); empty strings degrade to 'none', never broken CSS
      transform: {
        rest: b.transform.rest || 'none',
        hover: b.transform.hover || 'none',
        pressed: b.transform.pressed || 'none',
      },
      imageUrl: b.images.rest,
      pressedImageUrl: b.images.pressed || b.images.rest,
    })),
  };
}

/** Fetch + adapt. Absent chrome (child down / no bundle for the model)
 *  degrades to null — the sidebar's bare-canvas branch, never an error. */
// Bezel-definition cache — tab switches remount StageBezel (:key=udid) and
// re-fetched the SAME definition + PNG every time: the bezel popped in late
// on every switch ("bezel not there initially", operator report). Defs are
// static per device; cache them so a RETURN switch is instant. PNG decode is
// awaited separately in StageBezel (b ChromeDecodesBeforeShow) so the first
// paint is whole.
const bezelDefCache = new Map<string, BezelDefinition | null>();

/** Sync peek for warm switches: StageBezel paints a cached def immediately
 *  (skeleton bezel) instead of an empty stage while the async load runs. */
export function peekBezelDefinition(udid: string): BezelDefinition | null | undefined {
  return bezelDefCache.get(udid);
}

export async function loadBezelDefinition(udid: string): Promise<BezelDefinition | null> {
  if (bezelDefCache.has(udid)) return bezelDefCache.get(udid) ?? null;
  try {
    const r = await fetch(`/simulators/${encodeURIComponent(udid)}/definition.json`);
    if (!r.ok) { bezelDefCache.set(udid, null); return null; }
    const def = adaptChromeDefinition(udid, await r.json() as ChildDefinition);
    bezelDefCache.set(udid, def);
    return def;
  } catch {
    return null;
  }
}
