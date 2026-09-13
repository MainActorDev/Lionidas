/** Inspect sampling: pixel-estimates (est.) for the properties rail — text/fill
 *  color, font size, corner radius — over the alloy_screenshot seam. Route
 *  policy: colors+size on ≤512-wide downscale, radius on native-res crops.
 *  Honesty: every null below reaches the UI as "—" (not knowable), never 0. */
import sharp from 'sharp';
import { ManualSessionError, dispatchWithAppHeal, type ManualDeps } from './session.ts';
import { dispatchWithHeal } from '../alloy/heal.ts';
import {
  fillOf, textColorsOf, estimateFontSizePt, estimateRadiusPt, nearestToken,
  regionRaster, downscaleTo, bgOf,
} from './inspect-sample.ts';

export interface InspectSample {
  text: { color: string | null; token: string | null; sizePt: number | null } | null;
  fill: { color: string; token: string | null } | null;
  radius: { pt: number } | null;
  scale: number;
  capturedAt: number;
}

const TEXT_TYPES = new Set(['StaticText', 'TextField', 'Button', 'StaticTexts']);

/** bg ring sampled just OUTSIDE the node rect (needed by the radius fit). */
async function ringBg(path: string, rect: { x: number; y: number; width: number; height: number }, scale: number): Promise<[number, number, number] | null> {
  const pad = Math.max(2, Math.round(2 * scale));
  const outer = {
    x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad),
    width: rect.width + pad * 2, height: rect.height + pad * 2,
  };
  try {
    return bgOf(await regionRaster(path, outer, scale));
  } catch { return null; }
}

export async function inspectSample(
  deps: ManualDeps,
  sessionId: string,
  rect: { x: number; y: number; width: number; height: number },
  logicalW: number,
  nodeType: string | null,
): Promise<InspectSample> {
  if (!rect || rect.width < 2 || rect.height < 2) throw new ManualSessionError('BAD_RECT', 'rect must be ≥2×2 pt');
  if (!logicalW || logicalW < 100) throw new ManualSessionError('BAD_RECT', 'logicalW must be a real screen width');
  const udid = (deps.db.prepare('SELECT udid FROM manual_sessions WHERE id = ? AND finished_at IS NULL').get(sessionId) as { udid: string } | undefined)?.udid;
  if (!udid) throw new ManualSessionError('SESSION_NOT_FOUND', 'session not found or finished');
  const shot = (await dispatchWithAppHeal('alloy_screenshot', { udid }, sessionId, deps)) as
    | { ok: true; result: { path: string } }
    | { ok: false; error?: { message?: string } };
  if (!shot.ok) throw new ManualSessionError('LEASE_LOST', `sample failed: ${shot.error?.message ?? 'screenshot dispatch failed'}`);
  const path = shot.result.path;

  const meta = await sharp(path).metadata();
  const scale = meta.width! / logicalW;
  const native = await regionRaster(path, rect, scale);

  // colors + size on a ≤512-wide downscale (bands are row facts)
  const small = await downscaleTo(native, 512);
  const isText = nodeType !== null && TEXT_TYPES.has(nodeType);
  const fill = await fillOf(small);
  const text = isText ? await textColorsOf(small, { isTextNode: true }) : null;
  const sizePt = isText ? await estimateFontSizePt(small) : null;

  // radius at native res; bg ring just outside the node
  const bg = await ringBg(path, rect, scale);
  const radiusPt = bg ? await estimateRadiusPt(native, { bg }) : null;

  deps.db.prepare('UPDATE manual_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), sessionId);
  deps.bus.emit('manual.session.inspect-sample', { sessionId });
  return {
    // size and color are INDEPENDENT estimates: a null color (phantom-ink
    // guard, honesty) must not discard an estimable size, and vice versa.
    text: isText ? {
      color: text?.hex ?? null,
      token: text ? nearestToken(text.hex)?.token ?? null : null,
      sizePt,
    } : null,
    fill: fill ? { color: fill.hex, token: nearestToken(fill.hex)?.token ?? null } : null,
    radius: radiusPt !== null ? { pt: radiusPt } : null,
    scale: Math.round(scale * 10) / 10,
    capturedAt: Date.now(),
  };
}
